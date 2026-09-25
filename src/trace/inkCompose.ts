/**
 * The ink half of the trace, pure: a reading of the map's luminance, and the ink composed from it.
 *
 * **Out of `pipeline.ts` since 2026-09-24, so it can run in the trace worker.** The reading and the
 * recompose were the freeze left once the derive moved: about 0.8 to 1.4 seconds on the busiest map for
 * a filter slider and 1.6 to 1.7 for a reading slider, all of it on the page. Nothing here needs the
 * page: the map's pixels are decoded there once per image into a luminance field, and everything after
 * that is arithmetic on arrays.
 *
 * **It logs nothing**, and returns its lines instead. A worker cannot reach `dev.log` — the page logs
 * every job when its reply lands — and the lines are the same sentences, in the same order, that the
 * pipeline wrote while this ran on the page.
 *
 * Pure: no DOM, no SDK, which `workerProtocol.ts` needs of everything it imports.
 */

import { countInk, type BinaryMask } from "./binarize";
import { blur, type ScalarField } from "./field";
import { describeInkBlobs, findInkBlobs } from "./inkBlobs";
import { removeSmallInkIslands } from "./inkIslands";
import { composePaint, paintedCount, suppressInk, type PaintLayer } from "./inkPaint";
import { healSeverances, openMask, radiusForWidth, removedInk } from "./morphology";
import { detectPolarity, type PolarityReading } from "./polarity";

/** A line for the log, written by whoever receives the result. */
export interface InkLine {
  readonly level: "info" | "warn";
  readonly text: string;
}

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

/** How to read: the blur ahead of the threshold, and Sauvola's window radius and `k`. */
export interface ReadOptions {
  readonly blurSigma: number;
  /** In raster pixels, already rounded and at least 1. */
  readonly radius: number;
  readonly k: number;
}

export interface InkReading {
  readonly reading: PolarityReading;
  /** The blur and both thresholds, timed where they ran. */
  readonly binarizeMs: number;
}

/**
 * Turn the map's luminance into a binary mask, and measure what it is made of.
 *
 * Both polarities are computed and compared. The decision is made on how *thin* each reading's ink
 * is, not on which class is smaller — see `polarity.ts` for the map style that breaks the obvious
 * rule. `field` is left as it is: `blur` returns a new one, which is what lets the page keep the
 * unblurred field for the point probe.
 */
export function readInk(field: ScalarField, options: ReadOptions): InkReading {
  const started = performance.now();
  const blurred = blur(field, options.blurSigma);
  const reading = detectPolarity(blurred, { radius: options.radius, k: options.k });
  return { reading, binarizeMs: performance.now() - started };
}

/** The GM's two layers, already at the reading's raster. */
export interface InkPaintLayers {
  readonly suppress: PaintLayer | null;
  readonly ink: PaintLayer | null;
}

export interface ComposeOptions {
  /** *Thinnest stroke to keep*, in measured ink widths. */
  readonly minStrokeInkWidths: number;
  /** *Smallest mark to keep*, in raster pixels. */
  readonly minIslandPx: number;
  /** Raster pixels per grid square, for the "of a square" clauses and the blob check's fallback. */
  readonly pxPerSquare: number;
}

export interface ComposedInk {
  /**
   * The ink as **read**: the reading's mask after the two filters, and nothing else — what the
   * workspace draws as ink. `MaskStage.base` in the pipeline says why it is not the composite.
   */
  readonly base: BinaryMask;
  /** The ink everything downstream derives from: the whole stack, composed. */
  readonly mask: BinaryMask;
  /**
   * What the island filter was handed — the stroke filter's output after the severance repair — kept
   * for the profile drawn on that filter's slider. The stroke filter's own input is the reading's mask,
   * which the caller already has.
   */
  readonly beforeIsland: BinaryMask;
  readonly lines: readonly InkLine[];
}

/**
 * Compose the ink the regions come from, out of the reading and everything the GM has said about it.
 *
 * The cheap half, and the one every filter slider and every paint change re-runs. It never re-reads
 * the map, which is what lets it be re-run on its own.
 */
export function composeInk(
  readingMask: BinaryMask,
  inkWidth: number | null,
  paint: InkPaintLayers,
  options: ComposeOptions,
): ComposedInk {
  const lines: InkLine[] = [];
  const say = (level: InkLine["level"], text: string): void => {
    lines.push({ level, text });
  };
  const { pxPerSquare } = options;

  // ## Minimum stroke width
  //
  // An opening — erode then dilate — so marks narrower than the threshold vanish and everything
  // else keeps its width. Deliberately placed **after** the ink-width measurement and not before:
  // the threshold is denominated in ink widths, and measuring a mask this has already thinned out
  // would raise the mean width, which would move the threshold, which would change what it removes.
  // Measure the raw reading, then filter it.
  //
  // Polarity is decided on the raw reading for the same reason: this only ever removes thin marks,
  // so it can only make a reading look less like linework than it is.
  const rawInk = countInk(readingMask);
  const openStarted = performance.now();
  const strokeFloor = options.minStrokeInkWidths * (inkWidth ?? 0);
  const openRadius = radiusForWidth(strokeFloor);
  const opened = openMask(readingMask, openRadius);
  /*
    **Put back what the opening severed, before anything downstream amplifies it.**

    An opening retracts a stroke's end, so a radius one notch high nicks a corner — and thinning then
    pulls each free end back by `(w + 1) / 2`, so `g` pixels of ink arrive as `g + w + 1` pixels of
    graph. Two pixels became about nine on 5.7px linework, measured in a room. The penalty is
    additive, so there is no such thing as a small break once it reaches the graph, and this is the
    last place it is cheap to undo.

    **It restores and never invents**: `healSeverances` intersects the closing with the reading, so
    every pixel it puts back was ink the trace found. That is what lets it run with nothing to set
    and nothing to confirm, where the automatic gap repair could not — that one re-invented ink on
    every recompose, and this cannot invent any.

    **Before the island filter**, so a restored bridge rejoins its fragment to the network rather
    than leaving it to be deleted as debris.
  */
  const healed = healSeverances(opened, readingMask, openRadius);
  const effectiveMask = healed.mask;

  if (openRadius > 0) {
    const removed = removedInk(readingMask, effectiveMask);
    if (healed.restored > 0) {
      say(
        "info",
        `trace: put back ${healed.restored} px the stroke filter severed — ink the reading found, ` +
          `in channels narrower than ${openRadius * 2}px. Nothing invented: every pixel restored ` +
          `was ink before the filter ran.`,
      );
    }
    say(
      "info",
      `trace: minimum stroke width in ${Math.round(performance.now() - openStarted)}ms — ` +
        `${options.minStrokeInkWidths} of a ${(inkWidth ?? 0).toFixed(1)}px ink ` +
        `width is ${strokeFloor.toFixed(1)}px, radius ${openRadius}px, so marks under about ` +
        `${openRadius * 2}px are gone. Removed ${removed} of ${rawInk} ink px ` +
        `(${rawInk > 0 ? ((removed / rawInk) * 100).toFixed(1) : "0.0"}%).`,
    );
    // Named as a risk rather than reported as a number, because the number cannot distinguish a
    // floor grid from a wall. Only looking at the mask can, which is the entire reason this control
    // exists at all rather than remaining rejected.
    say(
      "warn",
      "trace: the minimum stroke width can sever a thin wall, which merges two rooms. Check the " +
        "Ink step in the workspace for gaps in the linework, and watch the second-largest region " +
        "below.",
    );
  } else if (options.minStrokeInkWidths > 0) {
    // The setting is on but rounds to nothing. Silence here would look identical to it working.
    say(
      "info",
      `trace: minimum stroke width ${options.minStrokeInkWidths} of a ` +
        `${(inkWidth ?? 0).toFixed(1)}px ink width rounds to a radius of 0, so nothing ` +
        `was removed. Raise it past ${(1 / Math.max(0.01, inkWidth ?? 1)).toFixed(2)} to bite.`,
    );
  }

  // ## Smallest ink island
  //
  // The second filter, and it catches what the first leaves: decoration that is high-contrast, thick
  // enough to survive an opening, and stubby. It separates those from walls by *connectivity* first —
  // walls join into one enormous network, a decoration is an island — so the size threshold only has
  // to be large enough to catch islands.
  //
  // Eight-connected, per the pairing rule, and that is the conservative direction here: a decoration
  // touching a wall even diagonally counts as part of the network and is never removed.
  const islandStarted = performance.now();
  const { minIslandPx } = options;
  const islands = removeSmallInkIslands(effectiveMask, minIslandPx);
  const filteredMask = islands.mask;

  if (minIslandPx > 0) {
    const beforeIslands = countInk(effectiveMask);
    say(
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
    if (islands.largestKeptSpan < readingMask.width * 0.25) {
      say(
        "warn",
        `trace: the largest surviving ink island spans only ${islands.largestKeptSpan}px of a ` +
          `${readingMask.width}px raster. The linework of a map is normally one connected network ` +
          `running most of its width, so this suggests the walls have been broken into pieces — by ` +
          `this filter, or by the minimum stroke width before it.`,
      );
    }
  }

  /*
    ## The GM's two layers, composed

    Where the global filters are blunt, these are local: the GM can tell meaningless crosshatching
    from linework by looking, and no measurement can. Both go in **after** the filters, so what they
    act on is exactly the ink the parameters above produced — which is also what the ink layer draws,
    so the two questions stay separable.

    **The order lives in `composePaint` rather than here**, which is what lets a headless test pin
    it. That became possible on 2026-09-05 when the gap repair stopped being a term between the
    two: while it was derived it had to run in the middle, so the composition could not be one
    expression. As a tool writing into the added-ink layer it is not part of this at all, and what
    is left is three independent layers and one function that says how they stack.
  */
  const inkedMask = composePaint(filteredMask, paint);

  if (paint.suppress) {
    const removed = countInk(filteredMask) - countInk(suppressInk(filteredMask, paint.suppress));
    say(
      "info",
      `trace: suppression — ${paintedCount(paint.suppress)} px painted, of which ${removed} were ` +
        `ink and are now ground.`,
    );
  }
  if (paint.ink) {
    say(
      "info",
      `trace: added ink — ${paintedCount(paint.ink)} px painted, including anything accepted from ` +
        `the gap search, which writes into this layer like a brush stroke.`,
    );
  }

  // ## Ink that is not linework
  //
  // A filled area whose tone fell on the ink side of the threshold is *ink*, so it never becomes a
  // region, is never covered, and shows through as bare map inside a revealed room. No aggregate can
  // see it: from a count of regions' point of view nothing is missing, because the area never
  // existed. Reporting only; nothing behaves differently because of it.
  //
  // Denominated in measured ink width, since a stroke is one ink width across its narrow side by
  // definition and a filled shape is several.
  const blobStarted = performance.now();
  const blobs = findInkBlobs(inkedMask, {
    pxPerSquare,
    minSquares: MIN_BLOB_SQUARES,
    minThickness: (inkWidth ?? pxPerSquare * 0.1) * BLOB_INK_WIDTHS,
  });
  say(
    "info",
    `trace: ink shape check in ${Math.round(performance.now() - blobStarted)}ms — ` +
      `${describeInkBlobs(blobs, readingMask.width, readingMask.height)}`,
  );

  return { base: filteredMask, mask: inkedMask, beforeIsland: effectiveMask, lines };
}
