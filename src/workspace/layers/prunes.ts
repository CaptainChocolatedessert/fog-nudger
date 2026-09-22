/**
 * The rings round each piece *Prune the dead ends* would take.
 *
 * **Only the rings.** The walls that go are already drawn red by the walls layer, at a wall's own width
 * and with their handles red too — that preview predates the rings, it is the part rooms asked for, and
 * drawing the walls a second time here would put two answers to one question on the canvas. This layer
 * adds the one thing that preview could not do, which is make a two-pixel hair something a GM can see
 * and click at map zoom.
 *
 * **One ring per piece** — a hair, or a whole star of short strokes — so the red inside a ring is exactly
 * what a click on it takes, and every ring together is what the button takes (`trace/prunePieces.ts`).
 *
 * Solid over a dark rim, in the additive colour, as Mend's and Collapse's rings are. The additive colour
 * for a ring that removes looks odd written down and is right on the canvas: the ring is the target, the
 * red is the consequence, and every ringed tool on this surface draws its target the same way.
 *
 * Drawn only while the tool is in hand: it is a tool layer, and the tool is its switch.
 */

import { colourFor } from "../palette";
import { currentPrunePieces } from "../pruneSearch";
import { ringCentre, ringRadius } from "../ringGesture";
import { addPainter, type Painter } from "../shell";

const additive = () => colourFor("additive");

const paint: Painter = ({ context, view, width, height, drawWidth, drawHeight }) => {
  const pieces = currentPrunePieces();
  if (pieces.length === 0) return;
  const long = Math.max(drawWidth, drawHeight);
  if (!(long > 0)) return;
  const perPixel = 1 / long;

  context.save();
  for (const piece of pieces) {
    const centre = ringCentre(piece.points);
    const cx = view.x + centre.x * long;
    const cy = view.y + centre.y * long;
    const radius = ringRadius(piece.points, perPixel);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) continue;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.lineWidth = 4;
    context.strokeStyle = "rgba(6, 4, 12, 0.7)";
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = additive();
    context.stroke();
  }
  context.restore();
};

/** Wire the layer up. Registered after the walls, so a ring sits over the hair it rings. */
export function registerPrunesLayer(): void {
  addPainter("prunes", paint);
}
