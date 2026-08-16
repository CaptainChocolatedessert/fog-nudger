/**
 * Luminance statistics over a map's pixels.
 *
 * This is the one part of the dry run that is not bookkeeping. Roadmap step 3 has to handle
 * **polarity** — classic dungeon maps are frequently light ink on dark ground, and a binarizer
 * assuming dark-on-light produces the exact complement of the right answer, confidently and
 * completely (DESIGN.md §10). The histogram is how that stops being an assumption: it says what the
 * ink and the ground on *this* map actually are, measured, before any thresholding exists.
 *
 * **This is not binarisation and does not pre-empt it.** Step 3 wants Sauvola, which is adaptive and
 * local. What is here is a global summary — a statistic to read in a log, not a mask to trace. The
 * two share no code and the global split below would be the wrong tool for the real job.
 *
 * Pure: no DOM, no SDK.
 */

import type { PixelImage } from "./field";

export const HISTOGRAM_BUCKETS = 256;

export interface LuminanceHistogram {
  /** `HISTOGRAM_BUCKETS` counts, indexed by luminance 0–255. */
  readonly counts: Uint32Array;
  readonly total: number;
}

/**
 * Bucket every pixel by perceptual luminance.
 *
 * Accumulated in a single streaming pass with no intermediate array. That matters at the sizes this
 * project now works at: materialising a luminance field for a 48-megapixel map would cost as much
 * again as the image itself, and the histogram does not need one.
 *
 * **Transparent pixels composite over white**, so they read as ground rather than as ink. Map assets
 * with transparent margins are ordinary, and treating alpha as darkness would ring the whole map in
 * a false wall — which, being a closed loop of ink, is exactly the sort of thing that traces
 * cleanly and is completely wrong.
 */
export function luminanceHistogram(image: PixelImage): LuminanceHistogram {
  const counts = new Uint32Array(HISTOGRAM_BUCKETS);
  const pixels = image.width * image.height;
  const { data } = image;

  let total = 0;
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const r = (data[p] ?? 0) / 255;
    const g = (data[p + 1] ?? 0) / 255;
    const b = (data[p + 2] ?? 0) / 255;
    const a = (data[p + 3] ?? 255) / 255;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const composited = a * luma + (1 - a);

    const bucket = Math.min(
      HISTOGRAM_BUCKETS - 1,
      Math.max(0, Math.round(composited * (HISTOGRAM_BUCKETS - 1))),
    );
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    total += 1;
  }

  return { counts, total };
}

export interface LuminanceSplit {
  /** Bucket index the two classes divide at; the darker class is `<= threshold`. */
  readonly threshold: number;
  /** Share of all pixels falling in the darker class, 0–1. */
  readonly darkShare: number;
  /** Mean luminance of each class, 0–1. */
  readonly darkMean: number;
  readonly lightMean: number;
}

/**
 * Split the histogram in two by Otsu's method — the threshold maximising between-class variance.
 *
 * Reported so the histogram is actionable rather than 256 numbers. What it answers is the polarity
 * question in the form step 3 needs it: on a dungeon map the *ink is the minority class*, so a dark
 * share of a few per cent means dark-on-light and a dark share of most of the image means the map
 * is light ink on dark ground. A share near a half means neither, and is a signal that the image is
 * a photograph or a heavily textured render rather than line art — which is worth knowing before
 * blaming the binarizer.
 *
 * Returns `null` for an empty histogram or one where every pixel is the same shade. Both are real
 * states of a broken or blank asset, and inventing a threshold for them would produce a number
 * indistinguishable from a real one.
 */
export function otsuSplit(histogram: LuminanceHistogram): LuminanceSplit | null {
  const { counts, total } = histogram;
  if (total <= 0) return null;

  let sum = 0;
  let occupied = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const count = counts[i] ?? 0;
    sum += i * count;
    if (count > 0) occupied += 1;
  }
  if (occupied < 2) return null;

  let bestThreshold = 0;
  let bestVariance = -1;
  let darkCount = 0;
  let darkSum = 0;

  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    darkCount += counts[i] ?? 0;
    if (darkCount === 0) continue;

    const lightCount = total - darkCount;
    if (lightCount === 0) break;

    darkSum += i * (counts[i] ?? 0);
    const darkMean = darkSum / darkCount;
    const lightMean = (sum - darkSum) / lightCount;

    const between = darkCount * lightCount * (darkMean - lightMean) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      bestThreshold = i;
    }
  }

  // Recomputed at the winner rather than carried through the loop, so the reported means belong to
  // the threshold actually chosen instead of to whichever bucket the loop happened to end on.
  let finalDarkCount = 0;
  let finalDarkSum = 0;
  for (let i = 0; i <= bestThreshold; i++) {
    finalDarkCount += counts[i] ?? 0;
    finalDarkSum += i * (counts[i] ?? 0);
  }
  const finalLightCount = total - finalDarkCount;
  const scale = HISTOGRAM_BUCKETS - 1;

  return {
    threshold: bestThreshold,
    darkShare: finalDarkCount / total,
    darkMean: finalDarkCount > 0 ? finalDarkSum / finalDarkCount / scale : 0,
    lightMean:
      finalLightCount > 0 ? (sum - finalDarkSum) / finalLightCount / scale : 0,
  };
}

/**
 * A compact profile of the histogram for one log line: sixteen coarse bands as whole percentages.
 *
 * Sixteen rather than 256 because this is read by eye in a log, and because the shape being looked
 * for — two humps and where they sit — survives the coarsening. Percentages are floored, so a band
 * holding a little of the image shows `0` rather than disappearing; a band holding *none* shows
 * `.`, because "nothing here" and "a rounding error here" are different facts about a map.
 */
export function describeHistogram(histogram: LuminanceHistogram): string {
  const { counts, total } = histogram;
  if (total <= 0) return "no pixels";

  const bands = 16;
  const perBand = HISTOGRAM_BUCKETS / bands;
  const parts: string[] = [];

  for (let band = 0; band < bands; band++) {
    let sum = 0;
    for (let i = band * perBand; i < (band + 1) * perBand; i++) {
      sum += counts[i] ?? 0;
    }
    parts.push(sum === 0 ? "." : String(Math.floor((sum / total) * 100)));
  }

  return parts.join("|");
}

/** Mean luminance across the image, 0–1. Reported alongside the split as a sanity anchor. */
export function meanLuminance(histogram: LuminanceHistogram): number {
  const { counts, total } = histogram;
  if (total <= 0) return 0;

  let sum = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) sum += i * (counts[i] ?? 0);
  return sum / total / (HISTOGRAM_BUCKETS - 1);
}
