/**
 * Separating ink from ground.
 *
 * On the maps this project targets — line art over fake parchment, cross-hatching, coffee stains —
 * **a global threshold does not work**. Parchment texture and ink share a luminance range, so any
 * single cutoff either loses pale linework in the light areas or swallows texture in the dark ones.
 *
 * Sauvola's local threshold is the standard answer, from document binarisation, where the problem is
 * literally "ink on aged paper":
 *
 *     T(x,y) = mean * (1 + k * (deviation / R - 1))
 *
 * A pixel is ink when it is darker than `T`. In a *flat* neighbourhood the deviation term drives `T`
 * well below the mean, so an evenly textured patch of parchment produces no ink at all; near real
 * linework the deviation is high and `T` rises toward the mean, so the stroke is kept. That
 * asymmetry is the whole point, and it is why this beats a plain local mean.
 *
 * Computed over summed-area tables, so window statistics cost the same whatever the radius — the
 * radius can be tuned freely without watching the clock.
 *
 * Pure: no DOM, no SDK.
 */

import type { ScalarField } from "./field";

export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, row-major: 1 is ink, 0 is ground. */
  readonly data: Uint8Array;
}

export function countInk(mask: BinaryMask): number {
  let total = 0;
  for (const value of mask.data) total += value;
  return total;
}

export function emptyMask(width: number, height: number): BinaryMask {
  return { width, height, data: new Uint8Array(width * height) };
}

/**
 * Half the field's dynamic range, the `R` term above. Fields here are 0..1, so 0.5 — the equivalent
 * of Sauvola's 128 for 8-bit input.
 */
const DYNAMIC_RANGE = 0.5;

export interface SauvolaOptions {
  /**
   * Window radius in pixels. Wants to be comfortably larger than the linework is thick, so a stroke
   * never fills its own window and become "the ground" locally.
   *
   * **Denominate this in ink width or grid squares, never in raster pixels.** Tying it to the raster
   * is what made the sibling's resolution impossible to change afterwards (DESIGN.md §5). The dry
   * run derives it from the scene's pixels-per-grid-square figure for exactly that reason.
   */
  readonly radius: number;
  /**
   * Sensitivity. Higher pulls the threshold further below the local mean, keeping less; the usual
   * working range is 0.2–0.5, and 0.34 is the value Sauvola's paper settles on.
   */
  readonly k: number;
}

export const DEFAULT_SAUVOLA: SauvolaOptions = { radius: 12, k: 0.34 };

/**
 * Both polarities from one pass, because deciding between them means measuring both.
 *
 * The saving is not incidental. Inverting the field and running Sauvola again would double the
 * expensive part — two more summed-area tables at eight bytes per pixel each, which are the memory
 * peak of the whole pipeline. They are not needed, because **variance is invariant under negation**:
 * for `g = 1 - f` the local deviation is identical and only the mean flips to `1 - mean`. So one
 * pair of tables yields both thresholds, and the second mask is very nearly free.
 *
 * Note the two masks are *not* complements of each other. Sauvola's threshold is asymmetric about
 * the mean, so a pixel can be ink under both readings or neither — which is precisely why the
 * polarity decision has to look at the masks rather than reason about the histogram.
 *
 * **This is where polarity stops mattering.** `detectPolarity` picks one of these two masks and
 * every stage downstream may then assume ink is 1, whichever way the map was drawn. The alternative
 * — threading a polarity flag onward and getting the comparison right in each place — is what
 * choosing here avoids. It is done by *selection*, not by inverting the field: nothing in this
 * pipeline ever inverts one.
 */
export function sauvolaBothPolarities(
  field: ScalarField,
  options: SauvolaOptions = DEFAULT_SAUVOLA,
): { readonly dark: BinaryMask; readonly light: BinaryMask } {
  const { width, height } = field;
  const dark = new Uint8Array(width * height);
  const light = new Uint8Array(width * height);
  if (width === 0 || height === 0) {
    return {
      dark: { width, height, data: dark },
      light: { width, height, data: light },
    };
  }

  const sum = integral(field, false);
  const squares = integral(field, true);
  const radius = Math.max(1, Math.round(options.radius));
  const stride = width + 1;

  const windowTotal = (
    table: Float64Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) =>
    table[y1 * stride + x1]! -
    table[y0 * stride + x1]! -
    table[y1 * stride + x0]! +
    table[y0 * stride + x0]!;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const count = (x1 - x0) * (y1 - y0);

      const total = windowTotal(sum, x0, y0, x1, y1);
      const totalSquares = windowTotal(squares, x0, y0, x1, y1);
      const mean = total / count;
      // Clamped because floating-point cancellation can leave this fractionally negative on a
      // perfectly uniform window, and Math.sqrt of that is NaN — which would silently mark every
      // pixel as ground.
      const variance = Math.max(0, totalSquares / count - mean * mean);
      const deviation = Math.sqrt(variance);

      const shape = 1 + options.k * (deviation / DYNAMIC_RANGE - 1);
      const index = y * width + x;
      const value = field.data[index]!;

      dark[index] = value < mean * shape ? 1 : 0;
      light[index] = 1 - value < (1 - mean) * shape ? 1 : 0;
    }
  }

  return {
    dark: { width, height, data: dark },
    light: { width, height, data: light },
  };
}

/**
 * Summed-area table with a zero row and column, so window sums need no bounds tests.
 *
 * **`Float64Array` is not a default, it is load-bearing.** The running total reaches the pixel count
 * — millions — while every window statistic is a *difference* of two such totals, so the answer
 * lives in the low bits. `Float32Array` carries about 24 bits of mantissa, which a 16-megapixel
 * image exhausts exactly, and the failure would be silent: thresholds slightly wrong everywhere,
 * worst in the bottom-right where the sums are largest.
 */
function integral(field: ScalarField, square: boolean): Float64Array {
  const { width, height } = field;
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowTotal = 0;
    for (let x = 0; x < width; x++) {
      const value = field.data[y * width + x]!;
      rowTotal += square ? value * value : value;
      table[(y + 1) * stride + (x + 1)] = table[y * stride + (x + 1)]! + rowTotal;
    }
  }

  return table;
}
