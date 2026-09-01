/**
 * The region census — the channel through which this pipeline's output can be reasoned about
 * without looking at pixels.
 *
 * ## What is being claimed for it, narrowly
 *
 * Not that these numbers say whether the output is right. Absolute thresholds across different maps
 * are the "property of the fixture" trap this project has recorded more than once, and a healthy
 * region count differs wildly between a six-room dungeon and a sprawling cave. What it is good at is
 * **comparison** — same map, one parameter moved, did the numbers shift — and at catching the
 * catastrophic case where rooms have merged into one another (DESIGN.md §8).
 *
 * ## Keeping the outside changes where the merge signal lives
 *
 * The census was designed when the exterior was going to be discarded, and its headline was to be
 * "the fraction of map area in the largest region", on the reasoning that one region holding most of
 * the map means rooms merged through a doorway gap.
 *
 * That reading no longer holds. The exterior is now emitted like any other region (DESIGN.md §4), so
 * **the largest region is normally the exterior and its large share is correct**. Reading it as a
 * merge would raise an alarm on every healthy map, which is the fastest way to make a diagnostic
 * ignored.
 *
 * The signal moved rather than vanished, and it is worth being explicit about where:
 *
 * - **Rooms merging with each other** shows up in the *second* largest region growing.
 * - **A room merging with the exterior**, through a gap in an outer wall, shows up in the largest
 *   growing while the region count falls.
 *
 * Neither has an absolute threshold. Both are obvious in a side-by-side of two runs, which is what
 * the top-N listing is for.
 *
 * Pure: no DOM, no SDK.
 */

import type { LabelledSpace, Region } from "./label";

export interface CensusOptions {
  /** Raster pixels per grid square, so areas can be reported in a portable unit. */
  readonly pxPerSquare: number;
  /** How many of the largest regions to name individually. */
  readonly top?: number;
}

export interface CensusStats {
  readonly count: number;
  /**
   * Share of the raster held by the faces, 0–1 — a **skeleton-density** readout, not an ink one.
   *
   * **Its meaning changed at the wall-graph pivot and the wording did not**, which made it worse than
   * merely uninformative. Region-first, the complement of this figure was the ink: "269 regions
   * covering 92.7%" sat beside "ink 7.2%" and the two were one fact. The labelling now runs on
   * `graph.framed`, so the complement is the one-pixel skeleton plus the border frame — around 0.5%
   * of any raster, on any map. The number jumped about seven points for reasons that have nothing to
   * do with the map, and `CLAUDE.md`'s recorded 92.7% is not comparable to anything a run prints now.
   *
   * Still worth having, read as what it is: a thinned skeleton is a roughly constant share of a
   * raster, so a figure well away from ~99.5% means the thinning or the framing did something odd.
   *
   * **The merge alarm is unaffected.** That is the *second-largest* share in `topShares` — 1.5%
   * healthy, 5–15% meaning rooms have leaked together — and it still measures exactly what it did.
   * So do `roomSized` and `medianSquares`. Only this one moved.
   */
  readonly coverage: number;
  /** Largest-first shares of the raster, one per region, truncated to `top`. */
  readonly topShares: readonly number[];
  /** Regions at least one grid square in area — roughly, the ones big enough to be a room. */
  readonly roomSized: number;
  /** Median region area in grid squares. */
  readonly medianSquares: number;
  /*
    `touchingBorder`, `discarded` and `discardedShare` were here until 2026-08-31, and all three had
    become **structurally constant** — which by this project's own rule makes them evidence about the
    diagnostic rather than about the map.

    The census is only ever handed the labelling of `graph.framed`, and two things follow from that.
    `frameSkeleton` paints the whole outer row and column as skeleton before labelling runs, and
    `labelSpace` skips ink, so no labelled pixel can sit on the raster border and the count was always
    zero. And that call passes `minArea: 0`, so nothing is ever filtered and `dropped N below the
    minimum` always printed `dropped 0`.

    The second was the worse of the two, because it printed a *number*: a reader who did not know the
    smallest-room control had been deleted read "dropped 0" as evidence that nothing was dropped rather
    than as evidence that nothing could be.

    The underlying fields stay on `LabelledSpace` — see the note there.
  */
}

export function censusStats(
  labelled: LabelledSpace,
  options: CensusOptions,
): CensusStats {
  const { regions, width, height } = labelled;
  const pixels = Math.max(1, width * height);
  const perSquare = options.pxPerSquare > 0 ? options.pxPerSquare ** 2 : 0;
  const top = options.top ?? 5;

  let covered = 0;
  for (const region of regions) covered += region.area;

  // Regions arrive largest first, so the median is a lookup rather than a sort — and for an even
  // count it is the mean of the two middle entries, which it was not until 2026-09-01. Being sorted
  // justifies not sorting; it does not justify taking the upper-middle element and calling it a
  // median, and this figure is quoted in the record as a measurement of a real map.
  const middle = medianArea(regions);

  return {
    count: regions.length,
    coverage: covered / pixels,
    topShares: regions.slice(0, top).map((region) => region.area / pixels),
    roomSized: perSquare > 0 ? regions.filter((r) => r.area >= perSquare).length : 0,
    medianSquares: perSquare > 0 ? middle / perSquare : 0,
  };
}

/** The middle area, averaging the two middle entries when there is an even number of them. */
function medianArea(regions: readonly Region[]): number {
  if (regions.length === 0) return 0;
  const half = Math.floor(regions.length / 2);
  if (regions.length % 2 === 1) return regions[half]!.area;
  return (regions[half - 1]!.area + regions[half]!.area) / 2;
}

/**
 * One line, in the order a human reads it.
 *
 * **Says something in every case, including the empty one.** A census that goes quiet when it finds
 * nothing is indistinguishable from a census that never ran, which is the failure this project has
 * inherited a standing warning about and has already been bitten by once in the map picker.
 */
export function describeCensus(stats: CensusStats): string {
  if (stats.count === 0) {
    // Not "or everything was below the minimum area": there is no minimum any more, so every pixel
    // being ink is the only way to get here.
    return "no regions at all — every pixel is ink";
  }

  const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
  const shares = stats.topShares.map(percent).join(", ");

  return (
    `${stats.count} faces covering ${percent(stats.coverage)} of the raster ` +
    `(the rest is the centreline skeleton); ` +
    `largest first ${shares}; ` +
    `${stats.roomSized} at least a grid square, median ${stats.medianSquares.toFixed(2)} sq`
  );
}
