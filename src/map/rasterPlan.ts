/**
 * What resolution to trace at.
 *
 * ## Native, and why the sibling's answer does not transfer
 *
 * Cartographer's Fog traces at a raster capped to 1024 pixels wide. That looks like a performance
 * budget and is not one: its tuning constants are *raw pixel values measured at that raster*, so
 * changing the width silently invalidates every one of them. The width is a calibration lock-in.
 *
 * None of that applies here. We have no tuned pixel constants yet, so adopting the same cap would
 * not be caution — it would manufacture the same trap, since we would then tune against it and be
 * stuck there permanently for a reason nobody could reconstruct.
 *
 * The positive case for native resolution is stronger than the absence of a reason to downscale.
 * Downscaling resamples the ink, and the ink's topology *is* the answer this project computes.
 * Averaging a thin dark line into its lighter surroundings lowers its contrast, and any stretch
 * that then falls below threshold opens a gap that does not exist on the map — a manufactured leak
 * between two rooms, which is the failure mode DESIGN.md §5 biases hardest against. The same
 * averaging can also close a genuine doorway gap. Both artifacts are real, they push in opposite
 * directions, and which one dominates on a given map is not predictable. At native resolution
 * neither is introduced.
 *
 * The cost side also inverts. The sibling's downscale paid for *thinning* — iterative and expensive
 * per pixel — and thinning is precisely the stage this project dropped (DESIGN.md §5). Fill and
 * label is a couple of passes. And this runs GM-only, once per map, at prep time, where a slow
 * answer is entirely affordable.
 *
 * ## So the cap here is about memory, not time
 *
 * The arithmetic is on `MEGAPIXEL_BUDGET` below, and it is dominated by something not obvious until
 * binarisation was written: Sauvola's two summed-area tables, at eight bytes per pixel each. Browsers
 * also cap canvas dimensions outright. Neither limit is about how long anyone waits.
 *
 * **The lesson worth carrying forward:** the sibling's real trap was denominating its parameters in
 * raster pixels, which made the raster load-bearing forever. Ours should be denominated in measured
 * *ink width* instead — already the native unit of this project, since the half-wall coverage
 * target in DESIGN.md §4 is stated as a fraction of the wall's own thickness. Keep it that way and
 * the raster never becomes something we cannot change.
 */

/**
 * Megapixels we are willing to hold.
 *
 * **Lowered from 48 on 2026-08-16, once binarisation existed and the real cost could be counted
 * rather than guessed.** The first figure was sized against the obvious arrays — four bytes of
 * image, one of mask, four of labels. Sauvola's summed-area tables dwarf all of it: two of them,
 * eight bytes per pixel each, both live at once because the variance needs the sum and the sum of
 * squares together. They cannot be narrowed to `Float32Array` either, for the precision reason set
 * out in `binarize.ts`.
 *
 * Counting properly, per pixel: 4 image + 4 luminance + 4 blurred (+4 transient) + **16 integral**
 * + 2 masks ≈ 34 bytes at peak. So the budget below is roughly half a gigabyte, in a third-party
 * iframe, which is already the outer edge of reasonable. The old 48 would have been about 1.6GB and
 * would simply have failed.
 *
 * 16 megapixels still covers a 4000×4000 map untouched, and this project's test map — 3300×2550, or
 * 8.4 — sits comfortably inside it.
 *
 * **The reserve, if a larger map turns up:** tile the binarisation with an overlap of the Sauvola
 * radius, which bounds the tables to a tile rather than the image. That is real work and there is no
 * reason to do it before a map demands it.
 */
export const MEGAPIXEL_BUDGET = 16;

/**
 * Canvas dimension ceiling. Well under what browsers allow, and it only ever binds on an image so
 * long and thin that the megapixel budget would not have caught it.
 */
export const MAX_DIMENSION = 16384;

export interface RasterPlan {
  readonly width: number;
  readonly height: number;
  /**
   * 1 means native — the source is used as it is. Above 1, each output pixel covers an `n`×`n`
   * block of source pixels.
   *
   * Integer rather than an arbitrary fraction so the reduction is uniform across the image. A
   * fractional ratio resamples different parts of the image against different sub-pixel phases,
   * which puts a beat pattern into linework of a consistent width — thinning it in some places and
   * not others, which is the leak this whole module is trying not to invent.
   */
  readonly factor: number;
  /** Whether a limit bit. False means the raster is the image, pixel for pixel. */
  readonly capped: boolean;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** Megapixels in a raster of this size. */
export function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

/**
 * Choose the raster dimensions for a source image.
 *
 * **Never upscales.** Enlarging invents detail that was never drawn, and every downstream stage
 * would then be measuring the interpolator rather than the map.
 *
 * A degenerate source — zero or negative in either axis — yields a zero plan rather than throwing.
 * The caller reports it; an image that decoded to nothing is a broken asset, not a crash.
 */
export function planRaster(
  sourceWidth: number,
  sourceHeight: number,
  budgetMegapixels: number = MEGAPIXEL_BUDGET,
  maxDimension: number = MAX_DIMENSION,
): RasterPlan {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return {
      width: 0,
      height: 0,
      factor: 1,
      capped: false,
      sourceWidth: Math.max(0, sourceWidth || 0),
      sourceHeight: Math.max(0, sourceHeight || 0),
    };
  }

  const budgetPixels = Math.max(1, budgetMegapixels * 1_000_000);
  const limit = Math.max(1, maxDimension);

  let factor = 1;
  // Floor, not round: the reduced size must never come out above what the factor promised, or the
  // loop could sit one pixel over the budget forever. Nothing is cropped by this — the whole image
  // is drawn into the whole raster, so a lost row is a fractionally different scale rather than a
  // missing edge, and placement reads the raster's actual dimensions rather than assuming.
  for (;;) {
    const width = Math.max(1, Math.floor(sourceWidth / factor));
    const height = Math.max(1, Math.floor(sourceHeight / factor));
    const withinBudget = width * height <= budgetPixels;
    const withinDimensions = width <= limit && height <= limit;

    if ((withinBudget && withinDimensions) || (width === 1 && height === 1)) {
      return {
        width,
        height,
        factor,
        capped: factor > 1,
        sourceWidth,
        sourceHeight,
      };
    }
    factor += 1;
  }
}
