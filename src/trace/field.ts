/**
 * Pixels to scalar fields, and the blur that sits between them.
 *
 * Ported from the sibling, where both earned their keep on real maps. Pure: no DOM, no SDK.
 * `PixelImage` is structural so `ImageData` satisfies it without an import and tests can hand it a
 * plain object.
 */

/** The layout `CanvasRenderingContext2D.getImageData()` returns: RGBA, row-major. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array | readonly number[];
}

export interface ScalarField {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height` entries. Nominally 0..1; blur does not push outside it. */
  readonly data: Float32Array;
}

export function fieldAt(field: ScalarField, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= field.width || y >= field.height) return 0;
  return field.data[y * field.width + x]!;
}

/**
 * Perceptual luminance, 0 (black) to 1 (white).
 *
 * **Transparent pixels composite over white**, so they read as ground rather than as ink — the same
 * rule the histogram uses, and for the same reason: a map asset with transparent margins would
 * otherwise be ringed in a false wall, and a false wall that forms a closed loop traces perfectly
 * cleanly while being entirely wrong.
 */
export function luminanceField(image: PixelImage): ScalarField {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = (data[p] ?? 0) / 255;
    const g = (data[p + 1] ?? 0) / 255;
    const b = (data[p + 2] ?? 0) / 255;
    const a = (data[p + 3] ?? 255) / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = a * luma + (1 - a);
  }

  return { width, height, data: out };
}

/**
 * Invert a field, so light linework becomes dark.
 *
 * This is the whole of polarity handling as far as the rest of the pipeline is concerned. Every
 * stage downstream may assume ink is dark, because a light-ink map is inverted here and never
 * mentioned again — which is much safer than threading a polarity flag through code that would
 * then have to get the comparison right in each place.
 */
export function invertField(field: ScalarField): ScalarField {
  const out = new Float32Array(field.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - field.data[i]!;
  return { width: field.width, height: field.height, data: out };
}

/**
 * Separable Gaussian blur, edges clamped.
 *
 * **This is the noise-suppression control, and it is deliberately a separate stage.** Scanned and
 * JPEG-compressed maps carry speckle that binarises into hundreds of tiny bogus regions. Reducing
 * the raster would also suppress it, which is exactly why the raster must not be used for the job:
 * one parameter doing two jobs can be tuned for neither, and resolution changes cost ink
 * continuity (DESIGN.md §5).
 *
 * `sigma <= 0` returns a copy, so callers can treat "no blur" as an ordinary setting.
 */
export function blur(field: ScalarField, sigma: number): ScalarField {
  if (!(sigma > 0)) {
    return { ...field, data: Float32Array.from(field.data) };
  }

  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = gaussianKernel(sigma, radius);
  const { width, height } = field;
  if (width === 0 || height === 0) {
    return { width, height, data: new Float32Array(0) };
  }

  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = clamp(x + k, 0, width - 1);
        sum += field.data[row + sx]! * kernel[k + radius]!;
      }
      horizontal[row + x] = sum;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = clamp(y + k, 0, height - 1);
        sum += horizontal[sy * width + x]! * kernel[k + radius]!;
      }
      out[y * width + x] = sum;
    }
  }

  return { width, height, data: out };
}

function gaussianKernel(sigma: number, radius: number): Float32Array {
  const kernel = new Float32Array(radius * 2 + 1);
  const denominator = 2 * sigma * sigma;
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp(-(k * k) / denominator);
    kernel[k + radius] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= total;
  return kernel;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
