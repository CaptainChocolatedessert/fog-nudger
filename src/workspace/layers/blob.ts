/**
 * What *Fill a mark* would take, drawn under the pointer before the click.
 *
 * The tool's visual channel, and §8 requires it: a control that can be wrong needs one before it
 * ships. This one can be wrong in a way nothing else on the surface warns about — a mark that touches
 * a wall is one contiguous region with it, so the fill takes the whole network — and that is a
 * decision the GM is entitled to make rather than something to guard against, *provided they can see
 * it first*. A whole map lighting up is a clear answer to "do not click here".
 *
 * **Drawn in the subtractive colour**, because what the fill becomes is suppression. Same hue as the
 * brush that does the same job by hand.
 *
 * ## Only the rectangle the fill lies in
 *
 * Every other raster layer here rasterises the whole raster once and lets `drawImage` stretch it,
 * which is right for a picture that changes when a reading does. This one changes on **every pointer
 * move**, and rewriting nine million RGBA pixels per frame is not available. So the buffer is the
 * size of the fill's own bounding box and is drawn into the matching slice of the map's rectangle —
 * a pool is seventy pixels across, and the worst case pays for itself only when it happens.
 */

import { parseColour, type Rgb } from "../../overlay/maskImage";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { addPainter, invalidate, type Frame, type Painter } from "../shell";
import { suppressColour } from "./paint";

/** How solid the preview is. Enough to read as a fill, short of hiding the linework under it. */
const PREVIEW_ALPHA = 150;

interface Preview {
  readonly bitmap: Bitmap;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The raster the box is in, so the painter can place it without asking anyone. */
  readonly rasterWidth: number;
  readonly rasterHeight: number;
}

let preview: Preview | null = null;
/** Reused between frames: a hover redraws this many times a second and each one would allocate. */
let buffer: Uint8ClampedArray<ArrayBuffer> | null = null;
let reusable: Bitmap | null = null;

/**
 * Show what a click would take, or nothing.
 *
 * `pixels` are raster indices into a raster of `rasterWidth` × `rasterHeight`, and `bounds` is the
 * box they lie in — both exactly as the flood hands them over, so this never walks the raster to
 * find out where the fill is.
 */
export function setBlobPreview(
  found:
    | {
        readonly pixels: ArrayLike<number>;
        readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
      }
    | null,
  rasterWidth: number,
  rasterHeight: number,
): void {
  if (!found) {
    if (preview) {
      preview = null;
      invalidate();
    }
    return;
  }

  const { left, top, right, bottom } = found.bounds;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const needed = width * height * 4;
  if (!buffer || buffer.length !== needed) buffer = new Uint8ClampedArray(needed);
  else buffer.fill(0);

  const rgb: Rgb | null = parseColour(suppressColour());
  // No colour to draw in is not a reason to draw the fill in a wrong one: the preview simply does not
  // appear, and the tool still says what it did after the click.
  if (!rgb) {
    preview = null;
    return;
  }

  for (let i = 0; i < found.pixels.length; i++) {
    const at = found.pixels[i]!;
    const x = (at % rasterWidth) - left;
    const y = ((at - (at % rasterWidth)) / rasterWidth) - top;
    const p = (y * width + x) * 4;
    buffer[p] = rgb.r;
    buffer[p + 1] = rgb.g;
    buffer[p + 2] = rgb.b;
    buffer[p + 3] = PREVIEW_ALPHA;
  }

  const bitmap = bitmapFrom(buffer, width, height, reusable);
  if (!bitmap) {
    preview = null;
    return;
  }
  reusable = bitmap;
  preview = { bitmap, left, top, width, height, rasterWidth, rasterHeight };
  invalidate();
}

/** Take the preview down. What putting the tool down does, and what leaving the map does. */
export function clearBlobPreview(): void {
  setBlobPreview(null, 0, 0);
}

const paint: Painter = ({ context, view, drawWidth, drawHeight }: Frame) => {
  if (!preview) return;
  const { bitmap, left, top, width, height, rasterWidth, rasterHeight } = preview;
  // The box's slice of the map's own rectangle. The map's rectangle is the raster stretched over it,
  // so a raster box is that same stretch applied to a sub-rectangle — which is why this needs nothing
  // from the reading beyond the raster's size.
  context.drawImage(
    bitmap.canvas,
    view.x + (left / rasterWidth) * drawWidth,
    view.y + (top / rasterHeight) * drawHeight,
    (width / rasterWidth) * drawWidth,
    (height / rasterHeight) * drawHeight,
  );
};

export function registerBlobLayer(): void {
  addPainter("blob", paint);
}
