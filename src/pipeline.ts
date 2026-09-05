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
 * ## What it reports, and what it deliberately no longer does
 *
 * Which map, at what resolution, under what transform, with what luminance, and what the graph and
 * the faces came out as. **Not** a region census: that existed so a fault could be diagnosed without
 * either party looking at pixels, which was true when the panel was a popover with no picture, and
 * stopped being true when the workspace started drawing the partition in six colours. Deleted
 * 2026-09-02 — see `DESIGN.md` §11 G, which also carries why the merge alarm went with it.
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
import { describeSettings, maskFingerprint, readingFingerprint, type Settings } from "./settings";
import { readSettings } from "./settingsStore";
import { readPaintLayer } from "./inkPaintStore";
import {
  addInk,
  paintForRaster,
  paintRevision,
  paintedCount,
  suppressInk,
  type PaintLayer,
} from "./trace/inkPaint";
import { loadMapRaster, readGridDpi, resolveTraceMap } from "./map/mapImage";
import type { Image as ImageItem } from "@owlbear-rodeo/sdk";
import { megapixels, type RasterPlan } from "./map/rasterPlan";
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
import { blur, luminanceField, type ScalarField } from "./trace/field";
import type { BinaryMask } from "./trace/binarize";
import type { LabelledSpace } from "./trace/label";
import type { Point, RasterPlacement, WorldBounds } from "./map/placement";
import { describePoint, readPoint } from "./trace/probePoint";
import { detectPolarity, type PolarityReading } from "./trace/polarity";
import { countInk } from "./trace/binarize";
import { openMask, radiusForWidth, removedInk } from "./trace/morphology";
import { removeSmallInkIslands } from "./trace/inkIslands";
import { applyGapFill, findGaps, type GapFinding, type GapLabels } from "./trace/gaps";
import { describeInkBlobs, findInkBlobs } from "./trace/inkBlobs";
import { describeAreaCheck, type FittedEdge } from "./trace/faces";
import type { WallGraph } from "./trace/wallGraph";
import {
  coveredArea,
  deriveGraphRegions,
  describeGraphRegions,
} from "./trace/graphRegions";
import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { Ring } from "./geometry/ring";
import { COMMAND_CAP } from "./trace/simplify";

/**
 * Beyond this the world bounds are not a scaled copy of the image and a uniform placement is wrong.
 * One percent absorbs rounding in the raster height without admitting a real rotation.
 */
const MAX_ASPECT_MISMATCH = 0.01;

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

/**
 * Everything the reading stage produces, which is everything the deriving stage needs.
 *
 * This is the cache boundary between stage one and stage two. Binarisation is the expensive half of
 * the chain — about 690ms of a 1.4s run on this project's test map — and none of it depends on the
 * deriving parameters, so a GM sweeping the smallest-room control should not pay for it on every
 * release of the slider.
 *
 * **What this is not: a second implementation.** The chain is still one linear function and the log
 * still reports every stage in the same order. The only thing that changes is whether the mask was
 * computed just now or a moment ago, and that is stated in the log on every run.
 */
/**
 * The GM's two hand-made layers, as everything that traces takes them.
 *
 * `null` for a layer nothing has been painted on, which is every scene until someone paints — and it
 * is the state the whole chain is free in, since applying a layer that marks nothing costs neither a
 * copy nor a walk.
 */
export interface PaintLayers {
  readonly suppress: PaintLayer | null;
  readonly ink: PaintLayer | null;
}

/** Nothing painted on either layer. */
export const NO_PAINT: PaintLayers = { suppress: null, ink: null };

/**
 * Everything durable a trace is a function of.
 *
 * Bundled rather than passed as two optional arguments, because they are one thing: the inputs the
 * GM owns, which live in scene metadata and out of which every derived thing here is computed. A
 * caller that supplied one and forgot the other would trace a mixture of what the workspace is
 * holding and what the scene last stored, which is a picture neither of them describes.
 */
export interface TraceInputs {
  readonly settings: Settings;
  readonly paint: PaintLayers;
}

interface ReadingStage {
  /** Identity of the map and the *reading* settings that produced this. See `readingIdentity`. */
  readonly fingerprint: string;
  readonly mapId: string;
  readonly name: string;
  readonly plan: RasterPlan;
  readonly bounds: WorldBounds;
  readonly dpi: number;
  readonly placement: RasterPlacement;
  readonly pxPerSquare: number;
  /** Unblurred, for the point probe. */
  readonly rawField: ScalarField;
  /** Carries the RAW mask, the polarity evidence and the measured ink width. */
  readonly reading: PolarityReading;
  readonly chosenCoverage: number;
}

interface MaskStage extends ReadingStage {
  /**
   * Identity of the map and *all* the reading-stage settings. See `maskIdentity`.
   *
   * **Named "fingerprint" and holding an identity**, which is the same mismatch `ReadingStage`'s own
   * `fingerprint` field carries. Left as it is deliberately rather than renamed across both: the two
   * are consistent with each other, the cache compares them for equality and nothing else, and a
   * rename touching both stages buys a better word for a field no caller outside this file reads.
   * `composeInk`'s parameter *was* renamed, because it shadowed the imported `maskFingerprint`
   * function.
   */
  readonly maskFingerprint: string;
  /**
   * The ink as **read**: the reading's mask after the two 1b filters, and nothing else.
   *
   * This is what the workspace draws as ink, and it is deliberately not the same thing as `mask`.
   * Drawing the composite would put invented pixels on screen indistinguishable from read ones,
   * which `DESIGN.md` §8 forbids — the repair and the GM's own two layers get their own colours on
   * their own layers instead.
   *
   * **Untouched by paint, which is what lets a stroke avoid blanking the surface.** Suppression and
   * added ink both act *after* this, so painting cannot change the picture the ink layer is drawing;
   * only the composite moves, and the composite is not drawn anywhere.
   */
  readonly base: BinaryMask;
  /**
   * The ink everything downstream derives regions from: the whole stack, composed.
   *
   * ## Three hand-made layers and one derived term
   *
   * Stage one is a stack rather than a single filtered mask (user, 2026-09-05):
   *
   * ```
   * base ink  −  suppression  +  break repair  +  added ink
   * ```
   *
   * The base is what processing the map image produces and is decided by parameters; suppression and
   * added ink are rasters the GM paints. Those three are **independent inputs** — any can be
   * revisited without disturbing the others, and the order they are edited in does not matter.
   *
   * The order they *compose* in is not free, and each position is load-bearing. Suppression comes
   * before the break search so a repair works on ink the GM has already corrected. Added ink comes
   * last, which is what makes it immune to the stroke-width opening and the island filter — the GM
   * drew it deliberately and no automatic filter may second-guess it.
   *
   * The break repair is the one term here that is derived rather than made, which is why editing
   * suppression changes what it finds. It is expected to become a tool inside the added-ink layer,
   * stamping what the GM accepts; at that point the stack is exactly three things and nothing in it
   * depends on anything else.
   */
  readonly mask: BinaryMask;
  readonly gaps: GapFinding;
  /**
   * The GM's layers **as this composition used them**, which is at the run's own raster.
   *
   * Kept because the point probe reports from the data that produced the picture rather than from a
   * parallel path, and a layer painted at another raster is resampled on the way in. Reporting the
   * stored one would answer about a pixel that is not the pixel being asked about.
   */
  readonly paint: PaintLayers;
}

/**
 * Two caches, one per half, and the split is what makes a slider sweep bearable.
 *
 * The reading — binarise, decide polarity, measure the ink width — is about 690ms of a 1.4s run and
 * depends on none of the filters or repairs composed on top of it. Cached on its own, a sweep of the
 * 1b filters or either gap slider re-runs only the cheap half. `settings.ts` declares which
 * parameters are composed on top, by exclusion, so that a forgotten declaration makes this cache
 * useless rather than wrong.
 */
let cachedReading: ReadingStage | null = null;
let cachedMask: MaskStage | null = null;

/**
 * What a cached mask is only valid for.
 *
 * Conservative on purpose, and deliberately more so than it needs to be. A wrong reuse would derive
 * regions from a stale reading and report them as current — which is exactly the failure this
 * project has already paid for once, when a clean-looking coverage figure was believed twice and
 * used to reject the correct answer. Recomputing needlessly costs 690ms; reusing wrongly costs a
 * diagnostic that lies.
 *
 * So this covers every input to the mask, plus the scene's grid, which is **not** one — and the
 * distinction is worth keeping straight because a comment here used to get it wrong. The Sauvola
 * window has been in raster pixels since 2026-08-23, so the grid cannot change the mask: `dpi` reaches
 * only log lines, the island warning's gate, and a reporting fallback. It stays in the fingerprint
 * for the reason stated three lines up — over-broad is the safe direction, since a wrong reuse
 * reports a stale mask as current — and it costs a string concatenation. Owlbear's own `lastModified`
 * would very likely cover the geometry on its own, but it is undocumented bookkeeping.
 */
function mapIdentity(map: ImageItem, dpi: number): string {
  return [
    map.id,
    map.lastModified,
    map.image.url,
    `${map.image.width}x${map.image.height}`,
    `pos:${map.position.x},${map.position.y}`,
    `scale:${map.scale.x},${map.scale.y}`,
    `rot:${map.rotation}`,
    `grid:${map.grid.dpi},${map.grid.offset.x},${map.grid.offset.y}`,
    `dpi:${dpi}`,
  ].join("|");
}

/**
 * What a cached *mask* is valid for: the same map, the same reading settings, and the same paint.
 *
 * The paint is here and not in `readingIdentity` because both layers compose on top of a reading and
 * neither can change what binarisation produced — the same split the `POST_READING` parameters get,
 * arrived at structurally rather than by being listed. So a session of painting re-composes the ink
 * and never re-reads the map.
 *
 * By content rather than by a counter, since the pipeline is reached from two iframes with
 * independent module state and a counter that agrees with itself in one says nothing about the
 * other. `paintRevision` walks the layer, which is paid once when a layer changes rather than here.
 */
function maskIdentity(
  map: ImageItem,
  dpi: number,
  settings: Settings,
  paint: PaintLayers,
): string {
  return [
    mapIdentity(map, dpi),
    maskFingerprint(settings),
    `suppress:${paintRevision(paint.suppress)}`,
    `ink:${paintRevision(paint.ink)}`,
  ].join("|");
}

/**
 * What a cached *reading* is valid for: the same map, read the same way.
 *
 * A strict prefix of the above. Everything the two share is the map's own identity and geometry;
 * the difference is that the filters and repairs composed on top of the reading do not appear here,
 * because none of them can change what binarisation produced.
 */
function readingIdentity(map: ImageItem, dpi: number, settings: Settings): string {
  return `${mapIdentity(map, dpi)}|${readingFingerprint(settings)}`;
}

/**
 * The last run's intermediates, so a point can be asked about without tracing again.
 *
 * A deliberate cache of things the pipeline otherwise discards. It goes stale the moment the map or
 * the parameters change, which is survivable because the probe says which run it is answering from
 * and the remedy is to trace again.
 */
let lastRun: {
  rawField: ScalarField;
  mask: BinaryMask;
  /** Which pixels the repair invented, so the probe can tell them from the map's own ink. */
  gapLabels: GapLabels;
  /** And which the GM painted, so it can tell those from both. */
  paint: PaintLayers;
  labelled: LabelledSpace;
  placement: RasterPlacement;
  pxPerSquare: number;
  name: string;
} | null = null;

/**
 * The last mask the overlay path produced, for the probe.
 *
 * The full run holds a labelling and this does not, which is the whole difference between what the
 * probe can say in the Regions step and what it can say in the Ink step. Kept separately rather than
 * folded into `lastRun`, because a half-filled `lastRun` would let anything reading it believe a
 * partition existed.
 */
let lastReading: {
  rawField: ScalarField;
  mask: BinaryMask;
  gapLabels: GapLabels;
  paint: PaintLayers;
  pxPerSquare: number;
  name: string;
} | null = null;

/**
 * What the pipeline computed at one point of the map, given as a fraction of it.
 *
 * **A fraction rather than a pixel**, because the caller is a surface drawing the map at whatever
 * size it likes and the raster here may have been reduced by §5's memory cap. Converting on this
 * side means the surface never has to know the trace's resolution, and cannot be half a raster out
 * when the cap bites on a large map.
 *
 * Answers from the partition when one has been derived and from the reading when one has not, which
 * is why it says something useful in the steps where the question "what is here?" is usually asked.
 */
export function probeMapFraction(u: number, v: number): string {
  if (lastRun) {
    const { rawField, mask, labelled, gapLabels, paint, name } = lastRun;
    const line = describePoint(
      readPoint(rawField, mask, labelled, u * mask.width, v * mask.height, gapLabels, paint),
    );
    devLog("info", `probe: map (${u.toFixed(3)}, ${v.toFixed(3)}) on "${name}" — ${line}`);
    return line;
  }

  if (lastReading) {
    const { rawField, mask, gapLabels, paint, name } = lastReading;
    const line = describePoint(
      readPoint(rawField, mask, null, u * mask.width, v * mask.height, gapLabels, paint),
    );
    devLog("info", `probe: map (${u.toFixed(3)}, ${v.toFixed(3)}) on "${name}" — ${line}`);
    return line;
  }

  return "Nothing read yet in this session — wait for the ink, then click again.";
}

/**
 * What the pipeline computed at one world point.
 *
 * The diagnostic every other one in this project could not be: all of them report a total, and a
 * total cannot say what is happening *there*. Four wrong explanations for a GM's report of bare
 * patches were argued from aggregates before this existed.
 */
export function probeWorldPoint(x: number, y: number): string {
  if (!lastRun) return "Nothing traced yet in this session — run a trace first, then probe.";

  const { rawField, mask, labelled, gapLabels, placement, name } = lastRun;
  const rasterX =
    placement.unitsPerPixelX === 0 ? 0 : (x - placement.origin.x) / placement.unitsPerPixelX;
  const rasterY =
    placement.unitsPerPixelY === 0 ? 0 : (y - placement.origin.y) / placement.unitsPerPixelY;

  const line = describePoint(readPoint(rawField, mask, labelled, rasterX, rasterY, gapLabels));
  devLog("info", `probe: world (${x.toFixed(0)}, ${y.toFixed(0)}) on "${name}" — ${line}`);
  return line;
}

/**
 * Raster pixels per grid square from the last reading, or null before one.
 *
 * So a control can show a setting in a unit the GM can feel — "0.25 squares" means nothing until it
 * also says "27 px across". Null before the first reading, because until then there is no map and the
 * conversion would be invented.
 *
 * **Read from the mask cache rather than from `lastRun`, for the same reason `lastInkWidth` is.**
 * `pxPerSquare` is a field of the reading stage, so it is known as soon as a reading lands — and
 * reading it from `lastRun` meant it was null until a *full trace* had run, which in a fresh
 * workspace session means until the GM opens Regions. Two of the three derived readouts in stage one
 * were therefore less informative than the third for no reason anyone had stated: the stroke-width
 * readout said "under ~6px goes (ink is 5.7px)" while the break and prune readouts said only "12px",
 * both of them dropping their "of a square" clause on a null.
 *
 * **Zero is treated as null, and that is not defensiveness.** `pxPerSquare` is computed as
 * `squaresAcross > 0 ? plan.width / squaresAcross : 0`, so a scene with no usable grid legitimately
 * produces 0 — and a readout that guards on `=== null` and then divides turns that into the literal
 * string "Infinity" beside a slider. `Measured`'s own doc says both fields are nullable so that a
 * control cannot report a guess in the voice of a measurement; a zero is a worse version of the same
 * thing, because it survives the guard.
 */
export function lastPixelsPerSquare(): number | null {
  const measured = cachedMask?.pxPerSquare ?? null;
  return measured !== null && measured > 0 ? measured : null;
}

/**
 * The ink width the last reading measured, in raster pixels.
 *
 * For the panel's derived readouts. Two controls are denominated in ink widths — the minimum stroke
 * width and the simplification tolerance — and without this the panel can only show the GM a bare
 * fraction, which means nothing on its own.
 *
 * Read from the **mask cache** rather than from `lastRun`, so it is available after a reading change
 * even when no full trace has been run since. `null` before anything has been read, which the panel
 * shows as no derived figure rather than as a wrong one.
 */
export function lastInkWidth(): number | null {
  return cachedMask?.reading.inkWidth ?? null;
}

/** One region, carrying everything the emit path needs and nothing it does not. */
export interface TracedRegion {
  readonly id: number;
  readonly placed: PlacedRegion;
  /**
   * The same rings before placement, in **raster pixels**.
   *
   * Carried so the workspace can draw the partition over the map it was read from without a second
   * chain to produce it, and without undoing the world transform to get back to where it started.
   * The placed rings are what an emitted item needs; these are what a picture of the map needs, and
   * they are the same geometry either way — which is the point of returning both from one run
   * rather than tracing twice.
   */
  readonly rings: readonly Ring[];
  /** The region's true area in grid squares — its pixel count, not its bounding box. */
  readonly squares: number;
  readonly commands: number;
  readonly tolerance: number;
  /** Over the command cap even at the ceiling tolerance, so it cannot be emitted as it stands. */
  readonly overCap: boolean;
}

/**
 * A wall no emitted fog shape's boundary covers, ready to emit as lines.
 *
 * Both coordinate systems, for the same reason `TracedRegion` carries both: the world points are
 * what an item needs, the raster points are what a picture of the map needs, and deriving one from
 * the other twice is how the two end up disagreeing.
 */
export interface TracedWall {
  /** The graph edge this came from. */
  readonly edge: number;
  readonly placed: readonly Point[];
  readonly points: readonly Vector2[];
  /** A vertex id per point. Shared with any region ring that meets this wall at a node. */
}

export interface TraceRun {
  readonly mapId: string;
  readonly mapName: string;
  readonly dpi: number;
  /**
   * The raster the region rings are expressed in, in pixels.
   *
   * The map's own pixels unless §5's memory cap reduced them, in which case every ring is in the
   * reduced raster together. Stated rather than left to be inferred: anything drawing these rings
   * over the map needs the scale, and measuring it from the rings themselves would be a guess that
   * happens to work because the outside region covers the map.
   */
  readonly raster: { readonly width: number; readonly height: number };
  readonly regions: readonly TracedRegion[];
  /**
   * Walls emitted as lines rather than as part of a shape's boundary — the bridge criterion (§4).
   *
   * A stub hanging into a room is the common case: the traversal walks it out and back as a slit,
   * which is right for the area check and wrong to emit, so the ring drops it and it comes out here.
   */
  readonly walls: readonly TracedWall[];
  /**
   * The cleaned graph and its fitted edges — what step G freezes.
   *
   * The **cleaned** one, after sliver removal, because that is what the faces are made of and what
   * the Walls step draws: a GM must edit what they can see. The raw graph has an order of magnitude
   * more nodes, almost all of them artefacts of junction clusters.
   *
   * Carried on the run rather than re-derived by the freeze, so what gets stored is provably the
   * same geometry this run would have emitted. Fitting keeps both ends of every edge, so the fitted
   * endpoints *are* these nodes, which is what lets the stored document share them by reference.
   */
  readonly graph: WallGraph;
  readonly fittedEdges: readonly FittedEdge[];
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
 * The expensive half: turn the map into a binary mask, and measure what it is made of.
 *
 * Ends deliberately at the last thing that reads the *image*. Everything after this point works on
 * the mask alone — filters, repairs, and eventually the GM's own suppression and ink — which is what
 * makes this the right place to cache. It is not a separate mode: `resolveMask` is its only caller,
 * so the chain stays one implementation.
 *
 * Returns `null` on exactly one condition — `loadMapRaster` finding nothing to read.
 */
async function computeReading(
  map: ImageItem,
  dpi: number,
  settings: Settings,
  fingerprint: string,
): Promise<ReadingStage | null> {
  const raster = await loadMapRaster(map);
  if (!raster) return null;

  const { pixels, plan, bounds } = raster;

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
  // A shape summary of the image, not a polarity verdict. The verdict is the thinness comparison
  // below; reading the ink off the minority class is the rule this project rejected, and printing
  // both as though they were the same kind of statement is how a reader would come to trust the
  // wrong one on the map where they disagree.
  const histogram = luminanceHistogram(pixels);
  const split = otsuSplit(histogram);

  devLog(
    "info",
    `trace: luminance mean ${meanLuminance(histogram).toFixed(3)}, ` +
      `profile dark->light ${describeHistogram(histogram)} (% per 1/16 band)`,
  );

  if (split) {
    // Tone distribution only. This deliberately no longer names ink or ground: it used to print
    // "LIGHT ink on dark ground — step 3 must invert polarity", which is a verdict from the
    // minority-class rule, in the same log as the real verdict from the thinness comparison, and
    // naming a step that no longer exists. On a map with a dark exterior the two disagree and this
    // one is the wrong one.
    const darkPercent = split.darkShare * 100;
    const reading =
      darkPercent < 35
        ? "mostly light"
        : darkPercent > 65
          ? "mostly dark"
          : "near an even split — this may not be line art";
    devLog(
      "info",
      `trace: global split at ${(split.threshold / 255).toFixed(3)} — ` +
        `${darkPercent.toFixed(1)}% dark (mean ${split.darkMean.toFixed(3)}) vs ` +
        `${(100 - darkPercent).toFixed(1)}% light (mean ${split.lightMean.toFixed(3)}); ` +
        `tone is ${reading} (the polarity verdict is the thinness line below, not this)`,
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
  const radius = Math.max(1, Math.round(settings.trace.sauvolaRadiusPx));
  // Kept unblurred as well, purely so the point probe can report the tone the *map* has rather than
  // the tone the binariser read. When the question is "is this actually white", a value softened by
  // a one-pixel Gaussian is the wrong number to answer it with.
  const rawField = luminanceField(pixels);
  const field = blur(rawField, settings.trace.blurSigma);
  const reading = detectPolarity(field, { radius, k: settings.trace.sauvolaK });
  const binarizeMs = Math.round(performance.now() - binarizeStarted);

  const chosenCoverage =
    reading.polarity === "dark-ink" ? reading.darkCoverage : reading.lightCoverage;

  devLog(
    "info",
    `trace: binarized in ${binarizeMs}ms — Sauvola radius ${radius}px ` +
      `(window ${radius * 2 + 1}px), k ${settings.trace.sauvolaK}, ` +
      `blur sigma ${settings.trace.blurSigma}px`,
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
  // `windowPx`, not `window`: this runs in a browser iframe, and a local named `window` shadows the
  // global one for the rest of the scope. Nothing here wants the real `window`, so it worked — the
  // next line that wants it would have got a number and no error.
  const windowPx = radius * 2 + 1;
  if (reading.inkWidth === null) {
    devLog("warn", "trace: no ink at all in the chosen reading — nothing to measure or trace");
  } else {
    const squares = pxPerSquare > 0 ? reading.inkWidth / pxPerSquare : 0;
    devLog(
      "info",
      `trace: ink width ~${reading.inkWidth.toFixed(1)}px (${squares.toFixed(3)} of a grid ` +
        `square); Sauvola window ${windowPx}px is ${(windowPx / reading.inkWidth).toFixed(1)}x that. ` +
        `Biased thin and saturates at 2px — see inkMetrics.ts`,
    );

    // The condition the radius is supposed to satisfy, checked rather than assumed. A stroke that
    // fills a large share of its own window becomes the local *ground*, and Sauvola then declines
    // to call it ink — which loses exactly the heaviest linework on the map, silently.
    if (windowPx < reading.inkWidth * MIN_WINDOW_RATIO) {
      devLog(
        "warn",
        `trace: the Sauvola window (${windowPx}px) is not comfortably wider than the ink ` +
          `(~${reading.inkWidth.toFixed(1)}px). Heavy linework can fill its own window and be ` +
          `read as ground. Raise the detail window.`,
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

  return {
    fingerprint,
    mapId: raster.mapId,
    name: raster.name,
    plan,
    bounds,
    dpi,
    placement,
    pxPerSquare,
    rawField,
    reading,
    chosenCoverage,
  };
}

/**
 * The cheap half: compose the ink the regions come from, out of the reading and everything the GM
 * has said about it.
 *
 * Synchronous, because everything here works on arrays already in hand. That is the same property
 * that lets it be re-run without re-reading the map.
 */
/**
 * A paint layer at this run's raster, saying so when it was not already.
 *
 * A layer is painted at the raster it acts on, and that raster is a function of the source image's
 * own pixels and `MEGAPIXEL_BUDGET` — so moving, scaling or rotating the map in Owlbear cannot move
 * it. Only replacing the image or changing our own constant can, and both are rare enough that
 * passing silently is the wrong behaviour: the GM's marks would land somewhere slightly different
 * from where they put them, with nothing to say why. Recording the dimensions in the document is
 * what makes this reachable at all; this is the report it exists for.
 */
function fitPaint(
  layer: PaintLayer | null,
  plan: RasterPlan,
  name: string,
): PaintLayer | null {
  if (!layer) return null;
  if (layer.width === plan.width && layer.height === plan.height) return layer;
  devLog(
    "warn",
    `trace: the stored ${name} was painted at ${layer.width}x${layer.height} and this map now ` +
      `reads at ${plan.width}x${plan.height}, so it has been resampled to fit. That happens when ` +
      `the map image is replaced, or when this extension's memory budget changes. Marks may have ` +
      `moved by a pixel; check them before trusting the result.`,
  );
  return paintForRaster(layer, plan.width, plan.height);
}

function composeInk(
  source: ReadingStage,
  settings: Settings,
  paint: PaintLayers,
  identity: string,
): MaskStage {
  const { plan, pxPerSquare, reading } = source;

  // ## Ink that is not linework
  //
  // Runs before labelling because it explains a class of result labelling cannot: a filled area
  // whose tone fell on the ink side of the threshold is *ink*, so it never becomes a region, is
  // never covered, and shows through as bare map inside a revealed room. No aggregate can see it:
  // from a count of regions' point of view nothing is missing, because the area never existed. Only
  // the point probe answers it, which is why that one survived the diagnostics being cut back.
  //
  // Denominated in measured ink width, since a stroke is one ink width across its narrow side by
  // definition and a filled shape is several.
  // ## Minimum stroke width
  //
  // An opening — erode then dilate — so marks narrower than the threshold vanish and everything
  // else keeps its width. Deliberately placed **after** the ink-width measurement above and not
  // before: the threshold is denominated in ink widths, and measuring a mask this has already
  // thinned out would raise the mean width, which would move the threshold, which would change what
  // it removes. Measure the raw reading, then filter it.
  //
  // Polarity is decided on the raw reading for the same reason: this only ever removes thin marks,
  // so it can only make a reading look less like linework than it is.
  const rawInk = countInk(reading.mask);
  const openStarted = performance.now();
  const strokeFloor = settings.trace.minStrokeInkWidths * (reading.inkWidth ?? 0);
  const openRadius = radiusForWidth(strokeFloor);
  const effectiveMask = openMask(reading.mask, openRadius);

  if (openRadius > 0) {
    const removed = removedInk(reading.mask, effectiveMask);
    devLog(
      "info",
      `trace: minimum stroke width in ${Math.round(performance.now() - openStarted)}ms — ` +
        `${settings.trace.minStrokeInkWidths} of a ${(reading.inkWidth ?? 0).toFixed(1)}px ink ` +
        `width is ${strokeFloor.toFixed(1)}px, radius ${openRadius}px, so marks under about ` +
        `${openRadius * 2}px are gone. Removed ${removed} of ${rawInk} ink px ` +
        `(${rawInk > 0 ? ((removed / rawInk) * 100).toFixed(1) : "0.0"}%).`,
    );
    // Named as a risk rather than reported as a number, because the number cannot distinguish a
    // floor grid from a wall. Only looking at the mask can, which is the entire reason this control
    // exists at all rather than remaining rejected.
    devLog(
      "warn",
      "trace: the minimum stroke width can sever a thin wall, which merges two rooms. Check the " +
        "Ink step in the workspace for gaps in the linework, and watch the second-largest region " +
        "below.",
    );
  } else if (settings.trace.minStrokeInkWidths > 0) {
    // The setting is on but rounds to nothing. Silence here would look identical to it working.
    devLog(
      "info",
      `trace: minimum stroke width ${settings.trace.minStrokeInkWidths} of a ` +
        `${(reading.inkWidth ?? 0).toFixed(1)}px ink width rounds to a radius of 0, so nothing ` +
        `was removed. Raise it past ${(1 / Math.max(0.01, reading.inkWidth ?? 1)).toFixed(2)} to bite.`,
    );
  }

  // ## Smallest ink island
  //
  // The second stage-1b filter, and it catches what the first leaves: decoration that is
  // high-contrast, thick enough to survive an opening, and stubby. It separates those from walls by
  // *connectivity* first — walls join into one enormous network, a decoration is an island — so the
  // size threshold only has to be large enough to catch islands.
  //
  // Eight-connected, per the pairing rule, and that is the conservative direction here: a decoration
  // touching a wall even diagonally counts as part of the network and is never removed.
  const islandStarted = performance.now();
  const minIslandPx = settings.trace.minIslandPx;
  const islands = removeSmallInkIslands(effectiveMask, minIslandPx);
  const filteredMask = islands.mask;

  if (minIslandPx > 0) {
    const beforeIslands = countInk(effectiveMask);
    devLog(
      "info",
      `trace: smallest ink island in ${Math.round(performance.now() - islandStarted)}ms — ` +
        `any isolated mark shorter than ${minIslandPx}px on both sides is gone. ` +
        `Removed ${islands.removed} ` +
        `islands holding ${islands.removedArea} px ` +
        `(${beforeIslands > 0 ? ((islands.removedArea / beforeIslands) * 100).toFixed(1) : "0.0"}% ` +
        `of the ink); largest surviving island spans ${islands.largestKeptSpan}px ` +
        `(${pxPerSquare > 0 ? (islands.largestKeptSpan / pxPerSquare).toFixed(1) : "?"} squares).`,
    );
    // The number that says whether this went too far. The wall network should be one island running
    // most of the map; if the largest survivor is room-sized instead, the linework has been cut up.
    //
    // **Not gated on `pxPerSquare`**, which it was until 2026-08-31. The comparison is a span in
    // raster pixels against a raster width in raster pixels and never mentions the grid — the gate had
    // drifted from the *info* line above, which does use it for an "of a square" clause. A scene whose
    // grid reports zero was therefore suppressing a warning that the linework had been cut into
    // pieces: a clean diagnostic that was evidence about the diagnostic.
    if (islands.largestKeptSpan < plan.width * 0.25) {
      devLog(
        "warn",
        `trace: the largest surviving ink island spans only ${islands.largestKeptSpan}px of a ` +
          `${plan.width}px raster. The linework of a map is normally one connected network running ` +
          `most of its width, so this suggests the walls have been broken into pieces — by this ` +
          `filter, or by the minimum stroke width before it.`,
      );
    }
  }

  // ## The GM's suppression layer
  //
  // Where the global filters are blunt, this is local: the GM can tell meaningless crosshatching
  // from linework by looking, and no measurement can. It goes in **after** both 1b filters, so what
  // it acts on is exactly the ink the parameters above produced — which is also what the Ink step
  // draws, so the two questions stay separable.
  //
  // And **before** the break search below, so a repair works on ink the GM has already corrected.
  // That is the one coupling in an otherwise order-free stack, and it is deliberate: a break the GM
  // has already dealt with by hand should not also be repaired automatically.
  const suppressLayer = fitPaint(paint.suppress, plan, "suppression");
  const suppressed = suppressInk(filteredMask, suppressLayer);
  if (suppressLayer) {
    const removed = countInk(filteredMask) - countInk(suppressed);
    devLog(
      "info",
      `trace: suppression — ${paintedCount(suppressLayer)} px painted, of which ${removed} were ` +
        `ink and are now ground.`,
    );
  }

  // ## Breaks in the linework, and the repair of the ones the GM asked for
  //
  // Runs after the minimum stroke width specifically: part of its job is repairing what that control
  // severed, so it has to see the damage.
  //
  // The fill adds the pixels of **marked** breaks and nothing else — never a blanket closing. A
  // blanket closing would also seal channels that failed the travel test, the clearest example being
  // a narrow doorway beside a corner, and it would do so with nothing to see. See `gaps.ts`.
  //
  // One width, not two. Finding and repairing were briefly separate controls; a room showed that
  // channels merge as the radius grows, so the marks are not a stable set to select from. See
  // `gaps.ts`.
  const gapStarted = performance.now();
  const gaps = findGaps(suppressed, {
    fillPx: settings.trace.gapFillPx,
    travelPx: settings.trace.gapTravelPx,
  });
  const repaired = applyGapFill(suppressed, gaps.labels);

  if (gaps.searchRadius > 0) {
    devLog(
      "info",
      `trace: breaks in ${Math.round(performance.now() - gapStarted)}ms — search radius ` +
        `${gaps.searchRadius}px found ${gaps.channels} narrow channels, ${gaps.through} passing ` +
        `through; ${gaps.marks.length} had banks more than ${settings.trace.gapTravelPx}px apart ` +
        `along the ink and are breaks. Repaired ${gaps.filled} of them, inventing ` +
        `${gaps.filledArea} px of ink.`,
    );
    // The number that says whether the marks are worth reading. A map reporting hundreds is either
    // drawn with hollow walls or has a reading that is falling apart, and either way the count is
    // the signal rather than any individual ring.
    if (gaps.marks.length > 200) {
      devLog(
        "warn",
        `trace: ${gaps.marks.length} breaks is a great many for one map. Two usual causes: walls ` +
          `drawn as two parallel strokes, whose hollow interiors are all narrow channels, or a ` +
          `reading that is breaking the linework up. Narrow the largest break to repair, or look ` +
          `at the ink before trusting the result. The count also moves around as channels merge, ` +
          `so it is not a tally of distinct faults.`,
      );
    }
    if (gaps.budgetHits > 0) {
      devLog(
        "warn",
        `trace: ${gaps.budgetHits} breaks were marked because the search ran out of budget rather ` +
          `than because the ink was broken. They are never filled. Lower the same-wall distance.`,
      );
    }
  }

  /*
    ## The GM's added ink, last of everything

    Last is the whole of its meaning. A line drawn deliberately must survive the stroke-width
    opening, the island filter and anything else automatic, because the GM drew it *knowing* what
    those had done — so nothing after this point may take it away.

    It also means added ink is what closes a break the repair did not, which is the alternative the
    automatic search now has to justify itself against.
  */
  const inkLayer = fitPaint(paint.ink, plan, "added ink");
  const inkedMask = addInk(repaired, inkLayer);
  if (inkLayer) {
    const added = countInk(inkedMask) - countInk(repaired);
    devLog(
      "info",
      `trace: added ink — ${paintedCount(inkLayer)} px painted, of which ${added} were not already ` +
        `ink and are now.`,
    );
  }

  const blobStarted = performance.now();
  const blobs = findInkBlobs(inkedMask, {
    pxPerSquare,
    minSquares: MIN_BLOB_SQUARES,
    minThickness: (reading.inkWidth ?? pxPerSquare * 0.1) * BLOB_INK_WIDTHS,
  });
  devLog(
    "info",
    `trace: ink shape check in ${Math.round(performance.now() - blobStarted)}ms — ` +
      `${describeInkBlobs(blobs, plan.width, plan.height)}`,
  );

  return {
    ...source,
    maskFingerprint: identity,
    base: filteredMask,
    mask: inkedMask,
    gaps,
    paint: { suppress: suppressLayer, ink: inkLayer },
  };
}

/**
 * Get a mask for these settings, reusing whichever halves are still valid.
 *
 * The only place either cache is read or written, so there is one answer to "may this be reused"
 * rather than one per caller. Which halves ran is reported by the caller, every time: a run that
 * reused a reading and a run that took one are not the same run, and only the second can be wrong
 * about the map.
 */
async function resolveMask(
  map: ImageItem,
  dpi: number,
  settings: Settings,
  paint: PaintLayers,
): Promise<{ stage: MaskStage; readingReused: boolean; maskReused: boolean } | null> {
  const maskPrint = maskIdentity(map, dpi, settings, paint);
  if (cachedMask && cachedMask.maskFingerprint === maskPrint) {
    return { stage: cachedMask, readingReused: true, maskReused: true };
  }

  const readingPrint = readingIdentity(map, dpi, settings);
  const readingReused = cachedReading !== null && cachedReading.fingerprint === readingPrint;
  const source = readingReused
    ? cachedReading!
    : await computeReading(map, dpi, settings, readingPrint);

  if (!source) {
    cachedReading = null;
    cachedMask = null;
    // The previous map's reading must not go on answering probes for a map that failed to load.
    lastReading = null;
    lastRun = null;
    return null;
  }

  cachedReading = source;
  /*
    A new mask means the partition that went with the old one is no longer what is on screen.

    `lastRun` holds a whole trace — raw field, composed mask, labelling, placement — and the point
    probe prefers it unconditionally, falling back to `lastReading` only when it is null. It was
    assigned at the end of `runTrace` and never cleared, so after the first trace of a session it
    never was null: a GM who opened Regions, went back to Ink, moved the threshold and then clicked
    the map got an answer computed from the superseded mask and the superseded partition, while the
    screen showed the new ink. Nothing said so, because `describePoint` returns whole sentences that
    name no run and no settings.

    Clearing it here is enough because `runTrace` calls this function and assigns `lastRun`
    afterwards, so a full trace re-establishes it in the same call. One case does not reach here at
    all: changing `spurPrunePx` alters the graph and therefore the labelling without recomposing the
    ink, so this short-circuits on the mask cache above. That case always goes through `runTrace` —
    it is a Regions-step recompute — which overwrites `lastRun` anyway.
  */
  lastRun = null;
  cachedMask = composeInk(source, settings, paint, maskPrint);
  return { stage: cachedMask, readingReused, maskReused: false };
}

/**
 * Both of the GM's layers for one map, out of scene metadata.
 *
 * Read together, because a trace composed from a fresh suppression layer and a stale added-ink one
 * is a picture neither of them describes. A layer that will not decode comes back as nothing painted
 * — the store has already put the loss on the console, and refusing to trace at all would leave the
 * GM with no map rather than with one layer missing.
 */
async function readPaintFor(mapId: string): Promise<PaintLayers> {
  const [suppress, ink] = await Promise.all([
    readPaintLayer("suppress", mapId),
    readPaintLayer("ink", mapId),
  ]);
  return { suppress: suppress.layer, ink: ink.layer };
}

/** What the overlay needs: the mask, and where the raster sits in the world. */
export interface MaskForOverlay {
  /**
   * The ink as **read**, before anything was invented — what the surface draws as ink.
   *
   * Deliberately not the filled mask. The filled pixels are handed over separately in `gaps`, so
   * they can be drawn in their own colour: `DESIGN.md` §8 requires that invented ink never look
   * like read ink, and a surface handed only the composite could not tell them apart.
   */
  readonly mask: BinaryMask;
  /**
   * The ink everything downstream derives from: `mask` plus whatever the repair invented.
   *
   * Handed over as well as the base because the **skeleton** must be thinned from it. A repair
   * asserts that two wall segments are connected, and a centreline built from the unrepaired ink
   * would show them as two — which is the assertion being thrown away at the point it matters most.
   */
  readonly composed: BinaryMask;
  /** The breaks found, each carrying whether the fill closed it. */
  readonly gaps: GapFinding;
  readonly bounds: WorldBounds;
  readonly mapName: string;
  /** The resolved map's id, so the frozen graph can record which map it describes. */
  readonly mapId: string;
  /**
   * The map image's URL, from the same resolution the mask was read through.
   *
   * Carried here rather than left for the surface to fetch, and that is the point of it. The
   * workspace used to call `resolveTraceMap()` a second time purely to get this — a second scene
   * query per map load, and a second *answer*, which need not be the first one: a nomination
   * changing between the two calls (a GM clicking another row while the first is still loading, or
   * another client writing the metadata) drew map B under a mask read from map A. The whole claim of
   * this surface is that the map and the mask agree by construction, and that was the one place they
   * were fetched independently.
   */
  readonly mapUrl: string;
  /** Whether this run recomputed the mask or reused the cached one, for the log. */
  readonly reused: boolean;
  /** Whether the expensive half was reused even though the mask was not. */
  readonly readingReused: boolean;
}

/**
 * Either a reading, or which of the two ways it failed.
 *
 * The same shape as `TraceOutcome`, and for a sharper version of the same reason. This used to be
 * `MaskForOverlay | null`, and `null` meant **two entirely different things**: the scene holds no
 * `MAP`-layer image, or the map's pixels could not be read. The workspace named only the first, so a
 * GM whose map failed to load was told to pick a map — while the map they picked was drawn on the
 * canvas behind the message. Advice that is not merely unhelpful but impossible to follow: picking
 * the same map again produces the same sentence, and picking a different one is not the fix.
 *
 * That is `DESIGN.md` §8's rule — a diagnostic that reads the same for two outcomes cannot
 * distinguish them — arriving in a return type rather than in a message. `runTrace` never had it,
 * because it tests the two conditions separately.
 */
export type MaskOutcome =
  | { readonly ok: false; readonly reason: "no-map" }
  | { readonly ok: false; readonly reason: "unreadable"; readonly mapName: string }
  | { readonly ok: true; readonly reading: MaskForOverlay };

/**
 * Run stage one alone, for the overlay.
 *
 * **Not a third mode, and not a second implementation.** `resolveMask` is already a discrete
 * function with `runTrace` as its caller; this adds a second caller to the *same* function rather
 * than a second copy of the chain — and to the same pair of caches, which matters as much, since two
 * callers with two caches would disagree about what is current. The distinction is the one the sibling paid for: what must never
 * be duplicated is the chain, because a duplicate drifts and then disagrees with a real room in a
 * direction nobody can account for.
 *
 * It exists because the overlay lives in a **different iframe** from the panel. The two share no
 * memory at all, so the mask cannot be handed across — and it certainly cannot be sent, since the
 * sibling measured the message bus wedging at 1.37MB against a mask that is 8.4MB here. The overlay
 * therefore reads the same scene metadata and runs the same stage one, and gets its own cache in
 * its own iframe for free.
 *
 * Deliberately quiet compared with `runTrace`: the trace is where a GM goes to read numbers, and an
 * overlay repainting because a colour changed should not fill the log with resolution and polarity
 * reports every time.
 */
export async function maskForOverlay(
  /*
    The durable inputs to read with, or scene metadata's if omitted.

    The workspace needs to preview a value the GM is still dragging, and metadata is the wrong place
    to keep one: writing on every drag frame is exactly what the `input`/`change` split exists to
    prevent, and a pending value written there would also be a value a *reload* would inherit
    without the GM ever having accepted it. So the caller may supply the settings it wants a mask
    for. The cache and its fingerprint work unchanged either way, since the fingerprint is computed
    from whatever settings arrive rather than from where they came from.
  */
  override?: TraceInputs,
): Promise<MaskOutcome> {
  const settings = override?.settings ?? (await readSettings());
  const map = await resolveTraceMap();
  if (!map) return { ok: false, reason: "no-map" };

  // After the map, because a stored layer records which map it belongs to and one painted against
  // another image is not paint for this one.
  const paint = override?.paint ?? (await readPaintFor(map.id));
  const dpi = await readGridDpi();
  const resolved = await resolveMask(map, dpi, settings, paint);
  // Named rather than collapsed into the case above: the map is chosen and on screen, and what
  // failed is reading its pixels. `loadMapRaster` has already put the detail on the console.
  if (!resolved) return { ok: false, reason: "unreadable", mapName: map.name || "map" };

  // Kept for the point probe, which the workspace answers from wherever the GM clicks. The mask here
  // is the *composed* one, since that is what a region would be derived from — the base is what gets
  // drawn, and a probe reporting the drawn version would disagree with the partition on exactly the
  // pixels the repair invented.
  lastReading = {
    rawField: resolved.stage.rawField,
    mask: resolved.stage.mask,
    gapLabels: resolved.stage.gaps.labels,
    paint: resolved.stage.paint,
    pxPerSquare: resolved.stage.pxPerSquare,
    name: resolved.stage.name,
  };

  return {
    ok: true,
    reading: {
      mask: resolved.stage.base,
      composed: resolved.stage.mask,
      gaps: resolved.stage.gaps,
      bounds: resolved.stage.bounds,
      mapName: resolved.stage.name,
      mapId: map.id,
      // From `map`, the item this call resolved, rather than from the cached stage: a cache hit
      // means the same map by identity, but the URL is the one thing about an item that can be
      // reissued without its identity changing, and this is the copy that is certainly current.
      mapUrl: map.image.url,
      reused: resolved.maskReused,
      readingReused: resolved.readingReused,
    },
  };
}

/**
 * Trace the scene's map through every stage the pipeline has, and report each one.
 *
 * Writes nothing. Reports everything, including the boring values — a diagnostic that only speaks
 * when something is wrong cannot tell "fine" from "never ran".
 *
 * ## Which half actually ran, and why the log always says
 *
 * When the map and the reading parameters are unchanged, the mask from the previous run is reused
 * and the whole of stage one is skipped — about half the elapsed time. That is an optimisation and
 * nothing more: the decision is made from a fingerprint, never from which button the GM pressed, so
 * correctness never depends on them working the tabs in order.
 *
 * It is stated on every run regardless, because a run that reused a mask and a run that recomputed
 * one must not produce the same log. The first is the one that can be wrong about the map.
 */
export async function runTrace(
  /*
    The settings to trace with, or scene metadata's if omitted.

    Same reason as `maskForOverlay`: the workspace previews a value the GM has only just released,
    and a write to scene metadata is in flight rather than landed at that moment. Passing the
    settings in removes the race entirely rather than making the preview wait on a round trip — and
    the fingerprints work unchanged either way, since they are computed from whatever settings
    arrive rather than from where they came from.
  */
  override?: TraceInputs,
): Promise<TraceOutcome> {
  const started = performance.now();

  // Read before anything else, and log them beside the run they produced. A set of numbers with no
  // record of the settings that made them cannot be compared against the next set, which is the
  // whole claim this project makes for its diagnostics (DESIGN.md §8).
  const settings = override?.settings ?? (await readSettings());
  devLog("info", `trace: settings — ${describeSettings(settings)}`);

  const map = await resolveTraceMap();
  if (!map) {
    // The resolver has already logged which case this was and named the candidates, so repeating
    // that here would only make the panel's one line unreadable.
    return {
      ok: false,
      message: "No map to trace — see dev.log for which case this was, or pick one above.",
    };
  }

  // One SDK call, made before deciding anything, because the *deriving* half and every log line
  // need it. Not because the mask does: the Sauvola window is in raster pixels, so the grid cannot
  // change what is read. It is still in the mask fingerprint, deliberately over-broad — see
  // `mapIdentity`.
  // After the map, because a stored layer records which map it belongs to and one painted against
  // another image is not paint for this one.
  const paint = override?.paint ?? (await readPaintFor(map.id));
  const dpi = await readGridDpi();

  const resolved = await resolveMask(map, dpi, settings, paint);
  if (!resolved) {
    return {
      ok: false,
      message: `Could not read pixels from "${map.name || "map"}" — see the console.`,
    };
  }
  const mask = resolved.stage;

  if (resolved.readingReused) {
    // The reading's own diagnostics — resolution, placement, luminance, polarity, ink width —
    // belong to the run that took it and are not repeated. So restate the few figures the rest of
    // this run is built on, or a reader of the log has numbers below with nothing above them.
    devLog(
      "info",
      `trace: reused the cached reading for "${mask.name}" — the map and the reading settings are ` +
        `unchanged, so the expensive half was skipped` +
        (resolved.maskReused ? " and so was composing the ink" : ", and the ink was recomposed") +
        `. ${mask.plan.width}x${mask.plan.height}, ${mask.reading.polarity}` +
        `${mask.reading.confident ? "" : " (NOT CONFIDENT)"}, ` +
        `${(mask.chosenCoverage * 100).toFixed(1)}% ink` +
        (mask.reading.inkWidth === null ? "" : ` ~${mask.reading.inkWidth.toFixed(1)}px wide`) +
        `, ${mask.pxPerSquare.toFixed(1)} px/square. Full detail is against the run that read it.`,
    );
  }

  const {
    plan,
    bounds,
    placement,
    pxPerSquare,
    rawField,
    reading,
    mask: inkMask,
    gaps: inkGaps,
    chosenCoverage,
    name: mapName,
    mapId,
  } = mask;

  // ## From ink to faces, by way of the wall graph
  //
  // Step D. The regions are the **faces of the skeleton's arrangement**, not the space between the
  // strokes, so a face boundary is the wall's centreline: half-wall reveal is true by construction
  // and a stub wall survives instead of being deleted for separating nothing.
  //
  // The labelling inside is still 4-connected space against 8-connected linework — the pairing that
  // stops two rooms leaking into each other through a one-pixel diagonal — and it still supplies the
  // area check. What it no longer supplies is geometry.
  const inkWidth = reading.inkWidth ?? pxPerSquare * 0.1;
  if (reading.inkWidth === null) {
    devLog(
      "warn",
      `trace: no ink width to denominate simplification in, so the tolerance falls back to ` +
        `${inkWidth.toFixed(1)}px from the grid. The half-wall safety bound is not being checked ` +
        `against anything measured.`,
    );
  }

  const tolerance = settings.trace.simplifyInkWidths * inkWidth;
  const safeTolerance = inkWidth / 2;

  const derived = deriveGraphRegions(inkMask, {
    spurPrunePx: settings.trace.spurPrunePx,
    tolerance,
    maxTolerance: MAX_SIMPLIFY_INK_WIDTHS * inkWidth,
  });
  const labelled = derived.labelled;

  // Held for the point probe, which needs the partition as well as the mask and therefore cannot be
  // served by the mask cache alone. The mask is the **ink**, so "is this ink?" still answers about
  // the linework; the labelling is the graph's, so "which region?" answers about the faces that were
  // actually emitted.
  lastRun = {
    rawField,
    mask: inkMask,
    gapLabels: inkGaps.labels,
    paint: mask.paint,
    labelled,
    placement,
    pxPerSquare,
    name: mapName,
  };

  devLog(
    "info",
    `trace: graph — thinned ${derived.thinning.before} ink pixels to ${derived.thinning.after} in ` +
      `${derived.thinning.passes} passes; pruned ${derived.pruning.removed} spurs ` +
      `(${derived.pruning.pixels} px) at ${settings.trace.spurPrunePx}px; ` +
      `${derived.graph.stats.chains} chains into ${derived.graph.nodes.length} nodes and ` +
      `${derived.graph.edges.length} edges (${derived.graph.stats.merged} joins through path ` +
      `nodes, ${derived.graph.stats.orphans} orphaned pixels); ${derived.sliversRemoved} sub-pixel ` +
      `slivers deleted in ${derived.sliverRounds} rounds, ${derived.sliversLeft} left`,
  );
  if (derived.graph.stats.orphans > 0) {
    devLog(
      "warn",
      `trace: ${derived.graph.stats.orphans} skeleton pixels were claimed by no chain. The walk ` +
        `stepped over them, which loses linework without saying which. Expected to be zero.`,
    );
  }
  if (derived.droppedCycles > 0) {
    // Latent rather than observed: it needs a cycle of one or two skeleton pixels, which sliver
    // removal should have taken. Warned about because the failure it guards was silent in both
    // outputs at once — the edges were marked covered by a ring that did not exist, so they were
    // emitted neither as a shape nor as a wall line.
    devLog(
      "warn",
      `trace: ${derived.droppedCycles} cycles produced no usable ring. Their edges fall through to ` +
        `the wall lines rather than vanishing, which is the safe direction, but a cycle this small ` +
        `should have been removed as a sliver — read the sliver counts above.`,
    );
  }
  if (derived.sliversLeft > 0) {
    // Reported rather than merely counted, because it is never harmless: a surviving sub-pixel face
    // is emitted as a shape enclosing nothing, and the area check will have failed on its
    // neighbours. Two ways to reach it — the round cap, or a sliver with no bounding edge free of
    // interior pixels to delete — and the log cannot tell them apart, so it names both.
    devLog(
      "warn",
      `trace: ${derived.sliversLeft} sub-pixel faces could not be removed after ` +
        `${derived.sliverRounds} rounds — either the round cap was reached or none of their ` +
        `bounding edges was free of interior pixels. They emit as shapes enclosing nothing; read ` +
        `the area check below, which will have failed on the faces beside them.`,
    );
  }

  devLog(
    "info",
    `trace: ${describeGraphRegions(derived)}`,
  );

  // ## The area check
  //
  // Two stages compute the same quantity by unrelated routes and must agree exactly. Under the
  // graph it is a lattice identity — area = interior points + steps / 2 + holes - 1 — where the
  // interior count comes from the labelling, the step count from the traversal, and the area from
  // the polygon. **Not** plain Pick's theorem, which under-counts a face containing a bridge.
  devLog("info", `trace: ${describeAreaCheck(derived.faces)}`);
  if (derived.faces.exact !== derived.faces.checked) {
    devLog(
      "error",
      `trace: ${derived.faces.checked - derived.faces.exact} faces enclose a different area than ` +
        `the labelling says they hold. The geometry does not describe the regions it claims to, ` +
        `and nothing downstream of this is worth reading.`,
    );
  }
  if (derived.faces.disagreements > 0) {
    devLog(
      "error",
      `trace: ${derived.faces.disagreements} half-edges disagreed about which face they bound. One ` +
        `step to the right of a half-edge is either the face or the skeleton, never another face, ` +
        `so this means the traversal took a wrong turn at a junction.`,
    );
  }
  if (derived.faces.unlabelled !== 1) {
    devLog(
      "warn",
      `trace: ${derived.faces.unlabelled} cycles had no interior at all. Exactly one is expected — ` +
        `the unbounded face outside the border frame — so anything else is a degenerate sliver.`,
    );
  }

  // ## Bridges — walls no face boundary covers
  //
  // An edge with the same face on both sides. Step E emits these as lines; nothing here does, so
  // for now they are reported rather than drawn. A map with none has no free-standing linework at
  // all, which on a hand-drawn dungeon would itself be worth a second look.
  const wallPoints = derived.uncoveredEdges.reduce((total, edge) => total + edge.points.length, 0);
  devLog(
    "info",
    `trace: ${derived.bridges} of ${derived.graph.edges.length} edges are bridges — the same face ` +
      `on both sides, so no ring can cover them. With everything else no ring walks, that is ` +
      `${derived.uncoveredEdges.length} walls in ${Math.max(0, wallPoints - derived.uncoveredEdges.length)} ` +
      `segments, emitted as LINE items the way Dynamic Fog's own wall mode builds one.`,
  );

  // ## What is left uncovered, which is the only way to answer "why is there a gap"
  //
  // The faces tile the framed raster, so their total is very nearly the whole of it — short only by
  // the half-pixel each boundary runs inside the wall.
  //
  // **There is no bare floor to report any more.** With the smallest-room control gone, every face
  // holding any map is emitted, and the only faces dropped hold none. The warning that used to live
  // here — grid squares of floor covered by nothing, showing through as bare map inside a revealed
  // room — described a defect that no longer has a mechanism.
  const coveredPixels = coveredArea(derived.regions);
  const rasterArea = plan.width * plan.height;
  devLog(
    "info",
    `trace: emitted shapes cover ${((coveredPixels / rasterArea) * 100).toFixed(1)}% of the raster ` +
      `(against ${(chosenCoverage * 100).toFixed(1)}% ink); ${derived.discarded} faces held no map ` +
      `at all and were dropped, and ${derived.filledHoles} holes enclosed nothing emitted.`,
  );

  // ## Simplification
  //
  // **Per edge, not per ring** — two faces sharing a wall are assembled from the same fitted points,
  // so they cannot drift apart and open a sliver between rooms. Escalation is therefore global: when
  // anything exceeds the command cap the tolerance rises for the whole map, because a region
  // escalated on its own would stop matching its neighbours along their shared walls.
  const totalVertices = derived.regions.reduce((total, region) => total + region.vertices, 0);
  const totalCommands = derived.regions.reduce((total, region) => total + region.commands, 0);
  const preserved = derived.regions.reduce((total, region) => total + region.preservedRings, 0);
  const overCap = derived.regions.filter((region) => region.overCap);

  devLog(
    "info",
    `trace: simplified to ${totalVertices} vertices in ${totalCommands} commands at ` +
      `${derived.tolerance.toFixed(2)}px (${settings.trace.simplifyInkWidths} of a ` +
      `${inkWidth.toFixed(1)}px ink width, escalated ${derived.escalations} times for the whole ` +
      `map); ${preserved} rings kept unfitted because fitting would have collapsed them`,
  );
  if (derived.tolerance > safeTolerance) {
    devLog(
      "warn",
      `trace: the tolerance escalated to ${derived.tolerance.toFixed(2)}px, past the ` +
        `${safeTolerance.toFixed(2)}px half-ink-width bound. Under the graph that bound guards a ` +
        `corner cut across a doorway rather than an edge crossing into the next room — the old ` +
        `reason no longer applies and the new one has not been derived. Treat it as unverified.`,
    );
  }

  const heaviest = [...derived.regions].sort((a, b) => b.commands - a.commands).slice(0, 5);
  if (heaviest.length > 0) {
    devLog(
      "info",
      `trace: heaviest items — ` +
        heaviest
          .map((region) => `#${region.id} ${region.commands} cmds / ${region.rings.length} rings`)
          .join(", "),
    );
  }

  if (overCap.length > 0) {
    devLog(
      "warn",
      `trace: ${overCap.length} regions still exceed the ${COMMAND_CAP}-command cap at ` +
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
  const placed = placeRegions(derived.regions, placement);
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
  // The uncovered edges, carried into world coordinates by the same placement the regions used.
  // One transform, applied twice, rather than two that have to agree.
  const walls: TracedWall[] = derived.uncoveredEdges.map((edge, index) => ({
    edge: index,
    points: edge.points,
    placed: edge.points.map((point) => toWorldPoint(placement, point.x, point.y)),
  }));

  const regions: TracedRegion[] = derived.regions.map((region, index) => ({
    id: region.id,
    placed: placed[index]!,
    rings: region.rings,
    squares: squaresById.get(region.id) ?? 0,
    commands: region.commands,
    // One tolerance for the whole map now, since fitting is per edge and two faces sharing a wall
    // have to be fitted the same way.
    tolerance: derived.tolerance,
    overCap: region.overCap,
  }));

  const summary =
    `"${mapName}" ${plan.width}x${plan.height}` +
    (plan.capped ? ` (reduced ${plan.factor}x)` : " (native)") +
    `, ${reading.polarity}${reading.confident ? "" : "?"}` +
    `, ${(chosenCoverage * 100).toFixed(1)}% ink` +
    (reading.inkWidth === null ? "" : ` ~${reading.inkWidth.toFixed(1)}px wide`) +
    `, ${derived.regions.length} regions` +
    `, ${totalVertices} vertices in ${totalCommands} commands` +
    (overCap.length > 0 ? ` (${overCap.length} OVER CAP)` : "") +
    `, ${elapsed}ms`;

  return {
    ok: true,
    run: {
      mapId,
      mapName,
      dpi,
      raster: { width: plan.width, height: plan.height },
      regions,
      walls,
      graph: derived.graph,
      fittedEdges: derived.fittedEdges,
      summary,
    },
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
