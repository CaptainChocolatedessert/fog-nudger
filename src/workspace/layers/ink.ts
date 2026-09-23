/**
 * The ink layer: the binary mask, painted over the map in a colour the GM chose.
 *
 * **Binary — ink or not ink, and nothing else.** Not a tri-state including discarded floor: that is
 * a *smallest-room* verdict, which the three-stage split put in stage two, and drawing it here would
 * put a stage-two outcome on a stage-one surface.
 *
 * ## The composite, except while a brush is in hand — user, 2026-09-14
 *
 * It drew the **base** — the ink as read, before the GM's paint — on the rule that handing it the
 * composite would make invented pixels indistinguishable from read ones. That rule was right about
 * the risk and wrong about where to pay for it: the rest of the time what a GM wants is *the current
 * state of the ink*, which is the thing everything downstream is derived from, and showing them the
 * base while the walls come from the composite is showing them a picture of something else.
 *
 * So: **the composite normally, the base while a paint tool is armed.** The distinction survives
 * exactly where it matters — with a brush in hand the base is drawn and the GM's two layers sit over
 * it in their own colours, so what they added and what they took away are separable at the moment
 * they are being edited. And the per-pixel fallback is unchanged: the point probe still answers
 * whether what you are pointing at was painted or read.
 */

import { DEFAULT_SETTINGS } from "../../settings";
import type { BinaryMask } from "../../trace/binarize";
import { paintMask, parseColour } from "../../overlay/maskImage";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { maskShowing, onReading } from "../reading";
import { currentSettings } from "../settingsState";
import { addPainter, invalidate, say, type Painter } from "../shell";
import { currentTool, onToolChange } from "../toolPalette";

let painted: Bitmap | null = null;

/** The last reading, kept so a tool change can redraw from the other half of it. */
let reading: { readonly mask: BinaryMask; readonly composed: BinaryMask } | null = null;

/**
 * Whether the base is wanted rather than the composite.
 *
 * **True for a brush, and for *Suppress speckles* since 2026-09-22.** The rule is not "is this a
 * brush" but *is the GM's paint the thing being edited*: with the base drawn and the paint layer over
 * it, what they have taken shows as their own mark on ink that is still there — which is what lets the
 * recompose, and the derive behind it, wait until the tool is put down (user, 2026-09-22: *"The derive
 * can act like it does for the painting tools — wait until the tool is not in hand."*).
 *
 * *Suppress blob* is deliberately not in this list yet: it recomposes per press to show the ink go, and
 * it is being compared against the speckle tool in a room before either changes.
 */
function painting(): boolean {
  const tool = currentTool();
  return tool === "suppress" || tool === "ink" || tool === "speckles";
}

/** Which half of the reading to draw. */
function inkToDraw(): BinaryMask | null {
  if (!reading) return null;
  return painting() ? reading.mask : reading.composed;
}

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
  // Solid, always. The opacity control went on 2026-09-09; see `settings.ts` for the cost.
  context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
};

/** Wire the layer up. Called in draw order, which is what puts the ink under the gaps. */
export function registerInkLayer(): void {
  addPainter("ink", paint);
  onReading((result) => {
    // Kept before rasterising, so a later colour change repaints *this* mask rather than whichever
    // one happened to be current when the workspace opened.
    reading = { mask: result.mask, composed: result.composed };
    lastMask = inkToDraw();
    const bitmap = rasterise(lastMask!, currentSettings().overlay.inkColour, painted);
    if (!bitmap) {
      say("could not allocate the mask image", "bad");
      return false;
    }
    painted = bitmap;
    return true;
  });

  /*
    Picking a brush up or putting it down swaps which half is drawn, and nothing else announces it.

    Re-rasterised rather than redrawn, because the two halves are different pixels — a repaint with
    the same bitmap would show the composite while the GM paints into the layers that made it.
  */
  onToolChange(() => {
    const next = inkToDraw();
    if (!next || next === lastMask) return;
    lastMask = next;
    const bitmap = rasterise(next, currentSettings().overlay.inkColour, painted);
    if (bitmap) painted = bitmap;
    invalidate();
  });
}
