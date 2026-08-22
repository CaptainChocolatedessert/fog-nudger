/**
 * The trace pipeline, and the two modes that run it.
 *
 * `runTrace` does the whole chain — pick a map, read pixels, binarise, label, trace, simplify,
 * place — and reports every stage to the dev log. It writes nothing to the scene; whether anything
 * is written is the caller's decision, which is what makes the dry run and the emit path *the same
 * code* rather than two implementations that will drift.
 *
 * That mattering is not hypothetical. The sibling's trace harness diagnosed a real bug only after
 * it and a real room disagreed **in direction**, because the harness never ran the world-placement
 * stage. Anything running a second copy of the chain re-opens that gap.
 *
 * ## Roadmap step 2 — the dry run
 *
 * Reads the scene's own map, reports what it finds, and **writes nothing to the scene**. This is
 * where tuning happens from here on, and it is what replaces the separate trace harness the roadmap
 * originally inherited from the sibling (DESIGN.md §9). The harness's advantage was a viewer nobody
 * used; its fatal weakness was that it never ran the world-placement stage, so it could disagree
 * with a real room *in direction* and did. A dry run inside the extension executes the same code
 * the emit path will, so that class of disagreement cannot arise here by construction.
 *
 * ## What it cannot report yet, said plainly
 *
 * The roadmap calls for a **region** census. Regions do not exist until steps 4 and 5, so this
 * reports the rig around the hole they will fill: which map, at what resolution, under what
 * transform, with what luminance. That is less than the word "census" promises, and it is better to
 * say so than to let a smaller set of numbers wear the name.
 *
 * ## Everything is reported on every run
 *
 * Including the boring values, and including the ones that look like bookkeeping. This project has
 * inherited one lesson more expensively than any other: a diagnostic that only speaks when
 * something is wrong cannot tell "fine" from "never ran". So the log line saying nothing was
 * emitted is not a formality — it is the difference between a dry run that worked and a button that
 * did nothing.
 */

import { devLog } from "./devlog";
import { loadMapRaster, resolveTraceMap } from "./map/mapImage";
import { megapixels } from "./map/rasterPlan";
import {
  absorbedDrift,
  aspectMismatch,
  createPlacement,
  toWorldPoint,
} from "./map/placement";
import {
  boundsCentre,
  fractionWithin,
  placeRegions,
  placedBounds,
  type PlacedRegion,
} from "./map/placeRegions";
import {
  describeHistogram,
  luminanceHistogram,
  meanLuminance,
  otsuSplit,
} from "./trace/luminance";
import { blur, luminanceField } from "./trace/field";
import { detectPolarity } from "./trace/polarity";
import { labelSpace } from "./trace/label";
import { describeInkBlobs, findInkBlobs } from "./trace/inkBlobs";
import { censusStats, describeCensus } from "./trace/regionCensus";
import { contourStats, describeContours, traceRegions } from "./trace/contours";
import { doubleSignedArea } from "./geometry/ring";
import {
  describeSimplification,
  simplifyRegions,
  simplifyStats,
  COMMAND_CAP,
} from "./trace/simplify";

/**
 * Beyond this the world bounds are not a scaled copy of the image and a uniform placement is wrong.
 * One percent absorbs rounding in the raster height without admitting a real rotation.
 */
const MAX_ASPECT_MISMATCH = 0.01;

/**
 * Gaussian blur before binarisation, in raster pixels. The texture-suppression control, and
 * deliberately its own stage rather than a side effect of raster size (DESIGN.md §5).
 */
const BLUR_SIGMA = 1;

/**
 * Sauvola's window radius, **as a fraction of a grid square**.
 *
 * Denominated this way on purpose. Tying it to raster pixels is exactly what left the sibling
 * unable to change its resolution afterwards, and a grid square is the one length that means the
 * same thing on every map — walls are drawn at a fairly consistent fraction of one. The window wants
 * to be comfortably wider than the linework is thick, and a quarter square is several times a
 * typical wall.
 *
 * Ink width would be the better unit still, and nothing measures it yet. When something does, this
 * should move to it.
 */
const SAUVOLA_RADIUS_SQUARES = 0.25;

/** Sauvola's sensitivity. The value his paper settles on; no reason yet to differ. */
const SAUVOLA_K = 0.34;

/**
 * How many times the ink's width the Sauvola *window* should be, at minimum.
 *
 * Below this a heavy stroke occupies enough of its own window to become the local ground, and
 * Sauvola stops calling it ink — which quietly loses the boldest linework on the map, the opposite
 * of what anyone would predict. Three is a floor rather than a target; the current settings put
 * this project's test map at about four and a half.
 */
const MIN_WINDOW_RATIO = 3;

/**
 * Smallest region to keep, as a fraction of a **grid square's area**.
 *
 * Denominated against the grid for the usual reason, and set low on purpose. §5's bias is toward
 * splitting rather than merging: a spurious extra region costs the GM one click, a room the filter
 * ate costs them a room, and they will not know it is missing. Raising this is how cross-hatching
 * gets killed, and it is also how a genuine closet eventually gets killed — there is no setting that
 * does one without risking the other, which is why the census reports what was dropped.
 */
const MIN_REGION_SQUARES = 0.1;

/**
 * Smallest solid ink shape worth naming in the log, in grid squares.
 *
 * A diagnostic threshold rather than a pipeline one — nothing behaves differently because of it, and
 * its only job is to keep a list a human reads down to things a human could find on a map.
 */
const MIN_BLOB_SQUARES = 0.05;

/**
 * How many measured ink widths across its narrow side a shape must be before it stops being
 * plausible as linework.
 *
 * Three, which is comfortably past any stroke and well below anything drawn as a filled feature.
 * The unit is the point: a stroke is one ink width across by definition, so this needs no tuning
 * per map (DESIGN.md §5).
 */
const BLOB_INK_WIDTHS = 3;

/**
 * Simplification tolerance, **as a fraction of the measured ink width**.
 *
 * The unit DESIGN.md §5 asks for, and here it is not merely portable — it is the safety argument.
 * Douglas–Peucker moves the boundary by at most the tolerance, so a tolerance below *half* the ink
 * width cannot carry a room's edge past the centre of the wall beside it and into the next room.
 * A quarter sits comfortably inside that, leaving room for the ink-width figure itself to be off.
 *
 * Set low on purpose for the other reason too: outward error is desirable up to half a wall and
 * harmful past it, and nobody looks at a fog region's vertex count (DESIGN.md §5).
 */
const SIMPLIFY_INK_WIDTHS = 0.25;

/**
 * Ceiling on the tolerance a region may be escalated to in order to fit the 8192-command cap, again
 * in ink widths.
 *
 * Far past the half-width safety bound, deliberately. Only a region whose boundary wraps most of the
 * map ever climbs this far, which in practice means the outside — and DESIGN.md §4 says the outside
 * can be simplified far harder than any room, since there is no room out there to clip. What this
 * setting cannot do is *know* that, so every region that escalates past the bound is named in the
 * log rather than trusted to be the exterior.
 */
const MAX_SIMPLIFY_INK_WIDTHS = 8;

/** One region, carrying everything the emit path needs and nothing it does not. */
export interface TracedRegion {
  readonly id: number;
  readonly placed: PlacedRegion;
  /** The region's true area in grid squares — its pixel count, not its bounding box. */
  readonly squares: number;
  readonly commands: number;
  readonly tolerance: number;
  /** Over the command cap even at the ceiling tolerance, so it cannot be emitted as it stands. */
  readonly overCap: boolean;
}

export interface TraceRun {
  readonly mapId: string;
  readonly mapName: string;
  readonly dpi: number;
  readonly regions: readonly TracedRegion[];
  /** One line for the panel. Detail is already in the dev log by the time this is returned. */
  readonly summary: string;
}

/**
 * Either the run, or the plain-words reason there is not one.
 *
 * A discriminated result rather than a thrown error, because "no map nominated" and "two maps look
 * alike" are ordinary answers a GM needs to read, not failures — and routing them through the same
 * channel as an SDK rejection would make the panel report both the same way.
 */
export type TraceOutcome =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly run: TraceRun };

/**
 * Trace the scene's map through every stage the pipeline has, and report each one.
 *
 * Writes nothing. Reports everything, including the boring values — a diagnostic that only speaks
 * when something is wrong cannot tell "fine" from "never ran".
 */
export async function runTrace(): Promise<TraceOutcome> {
  const started = performance.now();

  const map = await resolveTraceMap();
  if (!map) {
    // The resolver has already logged which case this was and named the candidates, so repeating
    // that here would only make the panel's one line unreadable.
    return {
      ok: false,
      message: "No map to trace — see dev.log for which case this was, or pick one above.",
    };
  }

  const raster = await loadMapRaster(map);
  if (!raster) {
    return {
      ok: false,
      message: `Could not read pixels from "${map.name || "map"}" — see the console.`,
    };
  }

  const { pixels, plan, bounds, dpi } = raster;

  // ## Resolution
  //
  // Reported whether or not the budget bit. A run that quietly halved the resolution and a run at
  // native size must not produce the same log, because the first is the one that can invent a leak
  // between two rooms by thinning the ink.
  devLog(
    "info",
    `trace: "${raster.name}" source ${plan.sourceWidth}x${plan.sourceHeight} ` +
      `(${megapixels(plan.sourceWidth, plan.sourceHeight).toFixed(1)} MP) -> raster ` +
      `${plan.width}x${plan.height} (${megapixels(plan.width, plan.height).toFixed(1)} MP), ` +
      (plan.capped
        ? `REDUCED by ${plan.factor}x to fit the megapixel budget — thin ink may have been ` +
          `averaged away, and a leak between rooms is the way that shows up`
        : `native resolution, nothing resampled`),
  );

  // ## Placement
  //
  // Step 7's arithmetic, run early so it can be read rather than trusted. The last figure is what
  // the per-axis scaling is *absorbing*, not an error it leaves behind — expect a non-zero value on
  // any map nudged out of proportion to line its drawn grid up with Owlbear's.
  const placement = createPlacement(bounds, plan.width, plan.height);
  const mismatch = aspectMismatch(bounds, plan.width, plan.height);
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldHeight = bounds.max.y - bounds.min.y;
  const drift = absorbedDrift(placement);

  devLog(
    "info",
    `trace: placement origin (${bounds.min.x.toFixed(1)}, ${bounds.min.y.toFixed(1)}) ` +
      `world ${worldWidth.toFixed(1)}x${worldHeight.toFixed(1)}; units/px ` +
      `x ${placement.unitsPerPixelX.toFixed(4)} y ${placement.unitsPerPixelY.toFixed(4)}; ` +
      `aspect mismatch ${(mismatch * 100).toFixed(3)}%, per-axis scaling absorbing ` +
      `${drift >= 0 ? "+" : ""}${drift.toFixed(1)} world units at the map's bottom edge`,
  );

  if (mismatch > MAX_ASPECT_MISMATCH) {
    devLog(
      "warn",
      `trace: world bounds are ${(mismatch * 100).toFixed(0)}% off the image's aspect ratio, ` +
        `which usually means the map is rotated. Rotation is not handled — output would be ` +
        `misplaced.`,
    );
  }

  // A corner check, because a transform that is flipped or transposed produces perfectly plausible
  // numbers above and lands the bottom-right of the map somewhere absurd. Deliberately the opposite
  // corner from the origin: it is the only one that disagrees under every wrong transform.
  const farCorner = toWorldPoint(placement, plan.width, plan.height);
  const squaresAcross = dpi > 0 ? worldWidth / dpi : 0;
  const pxPerSquare = squaresAcross > 0 ? plan.width / squaresAcross : 0;
  devLog(
    "info",
    `trace: raster (0,0) -> world (${bounds.min.x.toFixed(1)}, ${bounds.min.y.toFixed(1)}), ` +
      `raster (${plan.width},${plan.height}) -> world ` +
      `(${farCorner.x.toFixed(1)}, ${farCorner.y.toFixed(1)}); ` +
      `map spans ${squaresAcross.toFixed(1)} grid squares at dpi ${dpi}, ` +
      `so ${pxPerSquare.toFixed(1)} raster px per square`,
  );

  // ## Luminance
  //
  // The one measurement here that is not bookkeeping. Step 3 has to handle polarity, and this says
  // what the ink and the ground on *this* map actually are rather than assuming dark-on-light.
  const histogram = luminanceHistogram(pixels);
  const split = otsuSplit(histogram);

  devLog(
    "info",
    `trace: luminance mean ${meanLuminance(histogram).toFixed(3)}, ` +
      `profile dark->light ${describeHistogram(histogram)} (% per 1/16 band)`,
  );

  if (split) {
    // The minority class is the ink on line art. Stated as a reading rather than a fact, because a
    // share near a half means this is not line art at all and the whole interpretation is off.
    const darkPercent = split.darkShare * 100;
    const reading =
      darkPercent < 35
        ? "dark ink on light ground"
        : darkPercent > 65
          ? "LIGHT ink on dark ground — step 3 must invert polarity for this map"
          : "neither class is a clear minority, so this may not be line art";
    devLog(
      "info",
      `trace: global split at ${(split.threshold / 255).toFixed(3)} — ` +
        `${darkPercent.toFixed(1)}% dark (mean ${split.darkMean.toFixed(3)}) vs ` +
        `${(100 - darkPercent).toFixed(1)}% light (mean ${split.lightMean.toFixed(3)}); ` +
        `reads as ${reading}`,
    );
  } else {
    devLog(
      "warn",
      "trace: luminance has fewer than two distinct values — a blank or broken asset",
    );
  }

  // ## Binarisation
  //
  // Both polarities are computed and compared. The decision is made on how *thin* each reading's ink
  // is, not on which class is smaller — see `polarity.ts` for the map style that breaks the obvious
  // rule.
  const binarizeStarted = performance.now();
  const radius = Math.min(64, Math.max(4, Math.round(SAUVOLA_RADIUS_SQUARES * pxPerSquare)));
  const field = blur(luminanceField(pixels), BLUR_SIGMA);
  const reading = detectPolarity(field, { radius, k: SAUVOLA_K });
  const binarizeMs = Math.round(performance.now() - binarizeStarted);

  const chosenCoverage =
    reading.polarity === "dark-ink" ? reading.darkCoverage : reading.lightCoverage;

  devLog(
    "info",
    `trace: binarized in ${binarizeMs}ms — Sauvola radius ${radius}px ` +
      `(${SAUVOLA_RADIUS_SQUARES} square at ${pxPerSquare.toFixed(1)} px/square), k ${SAUVOLA_K}, ` +
      `blur sigma ${BLUR_SIGMA}`,
  );
  devLog(
    "info",
    `trace: polarity ${reading.polarity}${reading.confident ? "" : " (NOT CONFIDENT)"} — ` +
      `dark reading ${(reading.darkCoverage * 100).toFixed(1)}% ink at thinness ` +
      `${reading.darkThinness.toFixed(3)}; light reading ` +
      `${(reading.lightCoverage * 100).toFixed(1)}% ink at thinness ` +
      `${reading.lightThinness.toFixed(3)}; chose the thinner`,
  );

  // ## Ink width
  //
  // The unit DESIGN.md §5 asks every parameter here to be denominated in, and it costs nothing —
  // it is the chosen thinness reinterpreted, not a second pass. Reported in both pixels and grid
  // squares, because the pixel figure is what the Sauvola window has to clear and the grid figure
  // is the one that means the same thing on the next map.
  const window = radius * 2 + 1;
  if (reading.inkWidth === null) {
    devLog("warn", "trace: no ink at all in the chosen reading — nothing to measure or trace");
  } else {
    const squares = pxPerSquare > 0 ? reading.inkWidth / pxPerSquare : 0;
    devLog(
      "info",
      `trace: ink width ~${reading.inkWidth.toFixed(1)}px (${squares.toFixed(3)} of a grid ` +
        `square); Sauvola window ${window}px is ${(window / reading.inkWidth).toFixed(1)}x that. ` +
        `Biased thin and saturates at 2px — see inkMetrics.ts`,
    );

    // The condition the radius is supposed to satisfy, checked rather than assumed. A stroke that
    // fills a large share of its own window becomes the local *ground*, and Sauvola then declines
    // to call it ink — which loses exactly the heaviest linework on the map, silently.
    if (window < reading.inkWidth * MIN_WINDOW_RATIO) {
      devLog(
        "warn",
        `trace: the Sauvola window (${window}px) is not comfortably wider than the ink ` +
          `(~${reading.inkWidth.toFixed(1)}px). Heavy linework can fill its own window and be ` +
          `read as ground. Raise SAUVOLA_RADIUS_SQUARES.`,
      );
    }
    // Saturation is a real limit rather than a small one: at or below two pixels the measure cannot
    // tell one width from another, and every length derived from it inherits that.
    if (reading.inkWidth <= 2.05) {
      devLog(
        "warn",
        "trace: ink measures at the floor of what erosion can see (2px). The linework is " +
          "hairline-thin at this resolution, so anything denominated in ink width is unreliable " +
          "here — and a stroke this thin is one threshold wobble away from developing gaps.",
      );
    }
  }

  if (!reading.confident) {
    devLog(
      "warn",
      "trace: the two polarity readings are too close to separate. Neither looks clearly more " +
        "like linework, which usually means this is not line art — a photograph, a heavily " +
        "textured render, or a blank asset. Treat everything downstream as suspect.",
    );
  }

  // Cross-checked against the histogram deliberately. The two use different evidence — area versus
  // shape — so agreement is worth something and disagreement is worth much more: it means this is
  // one of the maps where the obvious rule would have inverted the whole trace.
  if (split) {
    const byMinority: typeof reading.polarity =
      split.darkShare > 0.5 ? "light-ink" : "dark-ink";
    if (byMinority !== reading.polarity) {
      devLog(
        "warn",
        `trace: the histogram's minority class says ${byMinority} and the linework shape says ` +
          `${reading.polarity}. Trusting shape. This is the case that rule was replaced for — ` +
          `worth looking at the map to see which is right.`,
      );
    }
  }

  // ## Ink that is not linework
  //
  // Runs before labelling because it explains a class of result labelling cannot: a filled area
  // whose tone fell on the ink side of the threshold is *ink*, so it never becomes a region, is
  // never covered, and shows through as bare map inside a revealed room. The census cannot see it —
  // from the region statistics' point of view nothing is missing, because the area never existed.
  //
  // Denominated in measured ink width, since a stroke is one ink width across its narrow side by
  // definition and a filled shape is several.
  const blobStarted = performance.now();
  const blobs = findInkBlobs(reading.mask, {
    pxPerSquare,
    minSquares: MIN_BLOB_SQUARES,
    minThickness: (reading.inkWidth ?? pxPerSquare * 0.1) * BLOB_INK_WIDTHS,
  });
  devLog(
    "info",
    `trace: ink shape check in ${Math.round(performance.now() - blobStarted)}ms — ` +
      `${describeInkBlobs(blobs, plan.width, plan.height)}`,
  );

  // ## Fill and label
  //
  // The space, not the ink, and 4-connected so the ink is 8-connected — the pairing that stops two
  // rooms leaking into each other through a one-pixel diagonal. Nothing here classifies a region as
  // interior or exterior; the outside is labelled and will be emitted like anything else.
  const labelStarted = performance.now();
  const minArea = Math.max(1, Math.round(MIN_REGION_SQUARES * pxPerSquare ** 2));
  const labelled = labelSpace(reading.mask, { minArea });
  const labelMs = Math.round(performance.now() - labelStarted);

  const stats = censusStats(labelled, { pxPerSquare });

  devLog(
    "info",
    `trace: labelled in ${labelMs}ms — minimum region ${minArea}px ` +
      `(${MIN_REGION_SQUARES} of a grid square at ${pxPerSquare.toFixed(1)} px/square)`,
  );
  devLog("info", `trace: census — ${describeCensus(stats)}`);

  // The merge signal, spelled out rather than left for a reader to reconstruct. With the exterior
  // kept, the largest region is normally the outside and its share being big is correct — so the
  // number that matters is the *second*, which is the largest thing that ought to be a single room.
  if (stats.topShares.length >= 2) {
    const second = stats.topShares[1]!;
    devLog(
      "info",
      `trace: largest region ${(stats.topShares[0]! * 100).toFixed(1)}% (expected to be the ` +
        `outside, which is kept deliberately); second ${(second * 100).toFixed(1)}% — that is the ` +
        `one to watch, since rooms merging into each other show up there`,
    );
  }

  // ## Boundary tracing
  //
  // Corners rather than pixel centres, so two rooms either side of a wall meet it from opposite
  // faces and neither claims half a pixel of it. The area check is the one exact tie between this
  // stage and the last: every region's ring areas must sum to the pixel count that produced it.
  const traceStarted = performance.now();
  const traced = traceRegions(labelled);
  const traceMs = Math.round(performance.now() - traceStarted);
  const contours = contourStats(labelled, traced);

  devLog("info", `trace: traced in ${traceMs}ms — ${describeContours(contours)}`);

  if (contours.areaMismatches > 0) {
    devLog(
      "error",
      `trace: ${contours.areaMismatches} regions traced to a boundary enclosing a different area ` +
        `than the region holds. The geometry does not describe the regions it claims to, and ` +
        `nothing downstream of this is worth reading.`,
    );
  }

  // ## What is left uncovered, which is the only way to answer "why is there a gap"
  //
  // The emitted shapes are disjoint — regions do not overlap, and a filled hole belongs to exactly
  // the one region that encloses it — so their total area is the sum of the traced areas, exactly.
  // Everything else in the raster is uncovered.
  //
  // Uncovered space should be **almost all ink**. When a GM reports a gap that is not ink, this line
  // is what says whether the gap is ours at all: if uncovered barely exceeds the ink, then every
  // piece of floor is under a shape and whatever they are looking at is either on a layer above
  // ours or is not on the map image we traced.
  const coveredArea = traced.reduce((total, region) => total + region.tracedArea, 0);
  const rasterArea = plan.width * plan.height;
  const uncoveredShare = rasterArea > 0 ? 1 - coveredArea / rasterArea : 0;
  const nonInk = uncoveredShare - chosenCoverage;
  devLog(
    "info",
    `trace: emitted shapes cover ${((coveredArea / rasterArea) * 100).toFixed(1)}% of the raster; ` +
      `${(uncoveredShare * 100).toFixed(1)}% is uncovered against ${(chosenCoverage * 100).toFixed(1)}% ink, ` +
      `so ${(Math.max(0, nonInk) * 100).toFixed(2)}% of the raster is floor left bare. ` +
      (nonInk <= 0.002
        ? `That is nothing — a gap a GM can see is not an uncovered region, so look above the ` +
          `DRAWING layer or at whether the traced map is the one on screen.`
        : `That is enough to be visible; the minimum-area filter dropped ` +
          `${(labelled.discardedArea / rasterArea * 100).toFixed(2)}% and is the likeliest source.`),
  );

  // Holes are now kept only where they enclose a surviving region, so every one of these is a
  // region nested inside another — a vault inside a room, or a room cluster inside the outside. The
  // largest region is excluded because its holes are the ordinary case; anywhere else, a nested
  // region is unusual enough to be worth seeing, and it is also the only remaining way a hole can
  // show through as bare map.
  const pocketSquares: number[] = [];
  for (const region of traced.slice(1)) {
    for (const ring of region.rings) {
      const area = doubleSignedArea(ring) / 2;
      if (area < 0 && pxPerSquare > 0) pocketSquares.push(-area / pxPerSquare ** 2);
    }
  }
  pocketSquares.sort((a, b) => a - b);
  if (pocketSquares.length === 0) {
    devLog(
      "info",
      "trace: no regions nested inside any region but the largest — no bare map inside a room",
    );
  } else {
    const at = (share: number) => pocketSquares[Math.floor(pocketSquares.length * share)] ?? 0;
    devLog(
      "info",
      `trace: ${pocketSquares.length} holes kept inside regions other than the largest — each one ` +
        `encloses a region that will be revealed separately, so the ink around it stays bare. ` +
        `Sizes in grid squares: min ${pocketSquares[0]!.toFixed(2)}, median ${at(0.5).toFixed(2)}, ` +
        `max ${pocketSquares[pocketSquares.length - 1]!.toFixed(2)}.`,
    );
  }

  // ## Simplification
  //
  // Denominated in ink width, which is what makes the bound statable: the boundary moves by at most
  // the tolerance, so under half an ink width it cannot cross the centre of a wall.
  const inkWidth = reading.inkWidth ?? pxPerSquare * 0.1;
  if (reading.inkWidth === null) {
    devLog(
      "warn",
      `trace: no ink width to denominate simplification in, so the tolerance falls back to ` +
        `${inkWidth.toFixed(1)}px from the grid. The half-wall safety bound is not being checked ` +
        `against anything measured.`,
    );
  }

  const simplifyStarted = performance.now();
  const tolerance = SIMPLIFY_INK_WIDTHS * inkWidth;
  const safeTolerance = inkWidth / 2;
  const simplified = simplifyRegions(traced, {
    tolerance,
    maxTolerance: MAX_SIMPLIFY_INK_WIDTHS * inkWidth,
  });
  const simplifyMs = Math.round(performance.now() - simplifyStarted);
  const simplification = simplifyStats(simplified);

  devLog(
    "info",
    `trace: simplified in ${simplifyMs}ms — tolerance ${tolerance.toFixed(2)}px ` +
      `(${SIMPLIFY_INK_WIDTHS} of a ${inkWidth.toFixed(1)}px ink width; the bound that stops a ` +
      `boundary crossing a wall is ${safeTolerance.toFixed(2)}px)`,
  );
  devLog("info", `trace: ${describeSimplification(simplification)}`);

  // The regions most likely to be a problem at emit time, listed rather than summarised. Which
  // region escalated matters more than how many did: one enormous outside is expected, and a room
  // in the list is a map far noisier than this pipeline is tuned for.
  const heaviest = [...simplified].sort((a, b) => b.commands - a.commands).slice(0, 5);
  if (heaviest.length > 0) {
    devLog(
      "info",
      `trace: heaviest items — ` +
        heaviest
          .map(
            (region) =>
              `#${region.id} ${region.commands} cmds / ${region.rings.length} rings` +
              (region.escalations > 0 ? ` @${region.tolerance.toFixed(1)}px` : ""),
          )
          .join(", "),
    );
  }

  const pastBound = simplified.filter((region) => region.tolerance > safeTolerance);
  if (pastBound.length > 0) {
    devLog(
      "warn",
      `trace: ${pastBound.length} regions had to be simplified past half the ink width to fit ` +
        `the command cap (${pastBound.map((region) => `#${region.id}`).join(", ")}). Their ` +
        `boundaries may cross the middle of a wall. This is expected for the outside, which wraps ` +
        `every room on the map; a room in that list is not expected.`,
    );
  }

  if (simplification.overCap > 0) {
    devLog(
      "warn",
      `trace: ${simplification.overCap} regions still exceed the ${COMMAND_CAP}-command cap at ` +
        `the ceiling tolerance and could not be emitted as they stand. Splitting them is not the ` +
        `remedy — the join becomes a wall across a room — so this is either far noisier ink than ` +
        `expected or a region that has merged into something enormous.`,
    );
  }

  // ## World placement
  //
  // The last stage before anything could be seen, and the one nothing pure can fully check. The
  // arithmetic is testable and is; that raster (0,0) is the world box's minimum corner is a claim
  // about Owlbear's conventions, and a flip or a transpose would satisfy every number below.
  const placed = placeRegions(simplified, placement);
  const filled = placedBounds(placed);

  if (!filled) {
    devLog("warn", "trace: nothing to place — no region survived with any geometry");
  } else {
    // A scale error is the failure this *can* catch. The outside normally runs to all four edges of
    // the raster, so the placed geometry should fill the map's own box; a box a fraction of the
    // map's, or larger than it, means the transform is wrong by a factor.
    const slackX = Math.max(
      Math.abs(filled.min.x - bounds.min.x),
      Math.abs(filled.max.x - bounds.max.x),
    );
    const slackY = Math.max(
      Math.abs(filled.min.y - bounds.min.y),
      Math.abs(filled.max.y - bounds.max.y),
    );
    devLog(
      "info",
      `trace: placed ${placed.length} regions filling world ` +
        `(${filled.min.x.toFixed(1)}, ${filled.min.y.toFixed(1)}) to ` +
        `(${filled.max.x.toFixed(1)}, ${filled.max.y.toFixed(1)}); the map's own box is short by ` +
        `${slackX.toFixed(1)} x ${slackY.toFixed(1)} world units, which is ` +
        `${(slackX / placement.unitsPerPixelX).toFixed(1)} x ` +
        `${(slackY / placement.unitsPerPixelY).toFixed(1)} raster pixels`,
    );

    // The one diagnostic that can catch a flip without emitting anything, because it is checkable
    // against the map the GM is looking at. Deliberately stated as a share of the map rather than in
    // world units — this project has already had world units read as image pixels once.
    const namedRegions = placed.slice(0, 5).map((region) => {
      const centre = fractionWithin(bounds, boundsCentre(region.bounds));
      const acrossSquares = (region.bounds.max.x - region.bounds.min.x) / (dpi || 1);
      const downSquares = (region.bounds.max.y - region.bounds.min.y) / (dpi || 1);
      return (
        `#${region.id} ${(centre.x * 100).toFixed(0)}% across ` +
        `${(centre.y * 100).toFixed(0)}% down, ${acrossSquares.toFixed(1)}x` +
        `${downSquares.toFixed(1)} squares`
      );
    });
    devLog(
      "info",
      `trace: where the largest regions landed — ${namedRegions.join("; ")}. ` +
        `Check these against the map by eye: a mirrored or transposed placement fills the same box ` +
        `and disagrees only about which region is where.`,
    );
  }

  const elapsed = Math.round(performance.now() - started);
  // The explicit statement that nothing was written. A run that worked and a run that silently
  // failed to reach this point look identical without it. Now that geometry reaches world
  // coordinates the wording has to be exact: it was placed, and placing is not emitting.
  devLog(
    "info",
    `trace: complete in ${elapsed}ms — geometry placed in world coordinates, nothing written to ` +
      `the scene`,
  );

  // Zipped back together by id here rather than carried through every stage. Each stage answers one
  // question about a region and should not be threading the others' answers along beside it.
  const squaresById = new Map(
    labelled.regions.map((region) => [
      region.id,
      pxPerSquare > 0 ? region.area / pxPerSquare ** 2 : 0,
    ]),
  );
  const regions: TracedRegion[] = simplified.map((region, index) => ({
    id: region.id,
    placed: placed[index]!,
    squares: squaresById.get(region.id) ?? 0,
    commands: region.commands,
    tolerance: region.tolerance,
    overCap: region.overCap,
  }));

  const summary =
    `"${raster.name}" ${plan.width}x${plan.height}` +
    (plan.capped ? ` (reduced ${plan.factor}x)` : " (native)") +
    `, ${reading.polarity}${reading.confident ? "" : "?"}` +
    `, ${(chosenCoverage * 100).toFixed(1)}% ink` +
    (reading.inkWidth === null ? "" : ` ~${reading.inkWidth.toFixed(1)}px wide`) +
    `, ${stats.count} regions (${stats.roomSized} room-sized)` +
    `, ${simplification.vertices} vertices in ${simplification.commands} commands` +
    (simplification.overCap > 0 ? ` (${simplification.overCap} OVER CAP)` : "") +
    `, ${elapsed}ms`;

  return {
    ok: true,
    run: { mapId: raster.mapId, mapName: raster.name, dpi, regions, summary },
  };
}

/**
 * Roadmap step 2 — trace and report, writing nothing.
 *
 * A thin wrapper, and deliberately thin: the value is that it runs *exactly* the code the emit path
 * runs, so a disagreement between what the dry run reports and what lands in a scene cannot arise
 * by construction.
 */
export async function dryRun(): Promise<string> {
  const outcome = await runTrace();
  if (!outcome.ok) return outcome.message;
  return `${outcome.run.summary}. Placed but not emitted — detail in dev.log.`;
}
