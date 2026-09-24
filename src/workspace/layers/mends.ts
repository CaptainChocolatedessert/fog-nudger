/**
 * The mends layer: every proposed mend, dashed, and the ring a GM clicks to accept it.
 *
 * ## Dashed, in the additive colour
 *
 * The palette's two axes: the hue says what kind of thing a mark is, and the treatment says how real.
 * A mend is **content being put in**, so it takes the additive colour, and it is **proposed**, so it
 * is dashed — the same as a wall being drawn, which is the one other line on this canvas that is not
 * there yet. Accepted, it becomes an ordinary wall and draws solid in the structure colour, so what
 * is on offer and what exists can never look alike (user, 2026-09-16).
 *
 * **The cost, stated:** at map-wide zoom a mend across a thin break is a pixel or two long and no
 * dash pattern survives at that length. The ring is what carries it there.
 *
 * ## The ring is the target
 *
 * Solid, cased, and sized by `mendGesture.ts`, which is what a click is tested against — so what is
 * drawn and what is hit are one circle. The ink tool's rings use the same floor and padding.
 *
 * Drawn only while the mend tool is in hand: it is a tool layer, and the tool is its switch.
 */

import { colourFor } from "../palette";
import { currentMends, hoveredFreeMend } from "../mendSearch";
import { mendCentre, mendRingRadius } from "../mendGesture";
import { addPainter, type Painter } from "../shell";

/** The width of a wall on this canvas, so a proposal reads as a wall that is not there yet. */
const LINE_WIDTH_PX = 2;
const additive = () => colourFor("additive");
const CASING = colourFor("casing");

const paint: Painter = ({ context, view, width, height, drawWidth, drawHeight }) => {
  /*
    **The free-click preview joins the same list** (2026-09-24): a free end too far to be rung draws
    exactly the same proposal and ring a rung one does, since that is exactly what a click there would
    take. It can never duplicate an entry here — the hover only ever computes one while the ring test
    itself found nothing.
  */
  const free = hoveredFreeMend();
  const mends = free ? [...currentMends(), free] : currentMends();
  if (mends.length === 0) return;

  // Graph units to screen: the longer drawn side is one unit on both axes.
  const long = Math.max(drawWidth, drawHeight);
  if (!(long > 0)) return;
  const perPixel = 1 / long;

  context.save();
  context.lineCap = "round";
  for (const mend of mends) {
    const centre = mendCentre(mend);
    const cx = view.x + centre.x * long;
    const cy = view.y + centre.y * long;
    const radius = mendRingRadius(mend, perPixel);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) continue;

    // The mend: cased like a wall, dashed because it is proposed.
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(view.x + mend.start.x * long, view.y + mend.start.y * long);
    context.lineTo(view.x + mend.end.x * long, view.y + mend.end.y * long);
    context.strokeStyle = CASING;
    context.lineWidth = LINE_WIDTH_PX + 2;
    context.stroke();
    context.strokeStyle = additive();
    context.lineWidth = LINE_WIDTH_PX;
    context.stroke();

    // The ring: solid, over a dark rim, as the ink tool draws one it will accept.
    context.setLineDash([]);
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

/** Wire the layer up. Registered after the walls, so a proposal sits over the break it closes. */
export function registerMendsLayer(): void {
  addPainter("mends", paint);
}
