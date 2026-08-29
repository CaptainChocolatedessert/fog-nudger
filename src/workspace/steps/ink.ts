/**
 * Step: what counts as ink.
 *
 * The controls that decide the reading, and the layer that shows what they decided. **The mask here
 * is binary — ink or not ink, and nothing else.** Not a tri-state including discarded floor: that is
 * a *smallest-room* verdict, which the three-stage split put in stage two, and drawing it here would
 * put a stage-two outcome on a stage-one surface.
 *
 * The ink layer belongs to this step because this step is what the GM is judging when they look at
 * it — but it is drawn on every frame regardless of which step is in front, and it will go on being
 * drawn under the walls and the regions. Which steps paint which layers is a question for the step
 * declaration, not for this file.
 */

import { DEFAULT_SETTINGS } from "../../settings";
import { paintMask, parseColour } from "../../overlay/maskImage";
import { layerFrom, type Layer } from "../layer";
import { maskShowing } from "../reading";
import { currentSettings } from "../settingsState";
import { invalidate, say, type Painter } from "../shell";
import type { Step } from "../step";

let painted: Layer | null = null;

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
  reusing: Layer | null,
): Layer | null {
  const rgb = parseColour(colour) ?? parseColour(DEFAULT_SETTINGS.overlay.inkColour);
  if (!rgb) return null;

  const buffer = paintMask(mask, rgb, reusing?.buffer);
  return layerFrom(buffer, mask.width, mask.height, reusing);
}

/**
 * Repaint the mask in a new colour without recomputing it.
 *
 * The expensive half is already done — the mask has not changed, only how it is drawn — so this is
 * a rewrite of an RGBA buffer rather than a re-read of the map.
 */
export function recolourInk(): void {
  if (!lastMask) return;
  const layer = rasterise(lastMask, currentSettings().overlay.inkColour, painted);
  if (!layer) return;
  painted = layer;
  invalidate();
}

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  if (!painted || !maskShowing()) return;
  context.globalAlpha = currentSettings().overlay.inkOpacity;
  context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
  context.globalAlpha = 1;
};

export const inkStep: Step = {
  id: "ink",
  paint,
  onReading: (result) => {
    // Kept before rasterising, so a later colour change repaints *this* mask rather than whichever
    // one happened to be current when the workspace opened.
    lastMask = result.mask;
    const layer = rasterise(result.mask, currentSettings().overlay.inkColour, painted);
    if (!layer) {
      say("could not allocate the mask image", "bad");
      return false;
    }
    painted = layer;
    return true;
  },
};
