/**
 * The skeleton layer: centrelines over the ink they came from.
 *
 * Drawn as a bitmap rather than paths, because that is what it is — a one-pixel-wide mask, not a set
 * of polylines. Turning it into vectors is step D's job and it needs decisions this view exists to
 * inform; rasterising it here is honest about the fact that it is still pixels.
 *
 * ## A colour that is not the ink's
 *
 * The ink is a GM-chosen colour and the skeleton must not be mistaken for it, so this one is fixed —
 * the same reasoning as the break marks. Green, which is the one hue neither the ink swatches nor
 * the break purple sits on by default.
 *
 * Zoomed out, a one-pixel skeleton over a whole map is close to invisible however it is coloured.
 * That is a real limitation of drawing it at map resolution and the reason to zoom in when judging
 * it; the alternative — a screen-space dilation — would make a hairy skeleton look tidy by drawing
 * everything the same width.
 */

import { paintMask, parseColour } from "../../overlay/maskImage";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { currentSkeleton, skeletonShowing } from "../skeleton";
import { addPainter, type Painter } from "../shell";

/** Kept in step with `.skeleton-key` in the page's stylesheet by hand. */
const SKELETON_COLOUR = "#00ff88";

let painted: Bitmap | null = null;
/** The mask the bitmap was made from, so a repaint only happens when the skeleton changes. */
let paintedFrom: unknown = null;

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const skeleton = currentSkeleton();
  if (!skeleton || !skeletonShowing()) return;

  if (paintedFrom !== skeleton) {
    const colour = parseColour(SKELETON_COLOUR);
    if (!colour) return;
    const buffer = paintMask(skeleton, colour, painted?.buffer);
    const bitmap = bitmapFrom(buffer, skeleton.width, skeleton.height, painted);
    if (!bitmap) return;
    painted = bitmap;
    paintedFrom = skeleton;
  }

  if (!painted) return;
  context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
};

/** Wire the layer up. Registered after the ink, so centrelines sit over the strokes they came from. */
export function registerSkeletonLayer(): void {
  addPainter("skeleton", paint);
}
