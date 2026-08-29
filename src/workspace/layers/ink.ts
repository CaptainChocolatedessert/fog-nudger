/**
 * The ink layer: the binary mask, painted over the map in a colour the GM chose.
 *
 * **Binary — ink or not ink, and nothing else.** Not a tri-state including discarded floor: that is
 * a *smallest-room* verdict, which the three-stage split put in stage two, and drawing it here would
 * put a stage-two outcome on a stage-one surface.
 *
 * Which steps show it is the steps' business, not this file's — it is declared in `steps.ts`, and
 * today the ink and walls steps both ask for it because both are judged by looking at it.
 */

import { DEFAULT_SETTINGS } from "../../settings";
import { paintMask, parseColour } from "../../overlay/maskImage";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { maskShowing, onReading } from "../reading";
import { currentSettings } from "../settingsState";
import { addPainter, invalidate, say, type Painter } from "../shell";

let painted: Bitmap | null = null;

/** The last mask painted, kept so a colour change can rewrite it without asking the pipeline. */
let lastMask: Parameters<typeof paintMask>[0] | null = null;

/**
 * Rasterise the mask into an offscreen canvas at the map's own resolution.
 *
 * Once per mask, not once per frame: every subsequent view change is a `drawImage` with a different
 * transform, which the probe measured at a tenth of a millisecond.
 */
function rasterise(
  mask: Parameters<typeof paintMask>[0],
  colour: string,
  reusing: Bitmap | null,
): Bitmap | null {
  const rgb = parseColour(colour) ?? parseColour(DEFAULT_SETTINGS.overlay.inkColour);
  if (!rgb) return null;

  const buffer = paintMask(mask, rgb, reusing?.buffer);
  return bitmapFrom(buffer, mask.width, mask.height, reusing);
}

/**
 * Repaint the mask in a new colour without recomputing it.
 *
 * The expensive half is already done — the mask has not changed, only how it is drawn — so this is
 * a rewrite of an RGBA buffer rather than a re-read of the map.
 */
export function recolourInk(): void {
  if (!lastMask) return;
  const bitmap = rasterise(lastMask, currentSettings().overlay.inkColour, painted);
  if (!bitmap) return;
  painted = bitmap;
  invalidate();
}

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  if (!painted || !maskShowing()) return;
  context.globalAlpha = currentSettings().overlay.inkOpacity;
  context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
  context.globalAlpha = 1;
};

/** Wire the layer up. Called in draw order, which is what puts the ink under the breaks. */
export function registerInkLayer(): void {
  addPainter("ink", paint);
  onReading((result) => {
    // Kept before rasterising, so a later colour change repaints *this* mask rather than whichever
    // one happened to be current when the workspace opened.
    lastMask = result.mask;
    const bitmap = rasterise(result.mask, currentSettings().overlay.inkColour, painted);
    if (!bitmap) {
      say("could not allocate the mask image", "bad");
      return false;
    }
    painted = bitmap;
    return true;
  });
}
