/**
 * The small regions on offer: each one ringed, the walls a collapse would take in red, and the star
 * it would leave dashed.
 *
 * ## Three marks, each in the palette's own terms
 *
 * - **The walls that go are destructive**, so red at Erase's width — the same act on more walls, which
 *   is Dissolve region's highlight exactly.
 * - **The star is additive and proposed**, so dashed in the additive colour and cased like a wall, as
 *   Mend's proposals are. What is drawn is what a click puts in.
 * - **The ring is the target**, solid over a dark rim and sized by `ringGesture.ts`, which is what a
 *   click is tested against — so what is drawn and what is hit are one circle.
 *
 * **Before the click, and that is the licence** (§8: a control that can be wrong needs a visual channel
 * before it ships). The long thin sliver on a curved wall is the case to look at: its wall is replaced
 * by straight spokes, and the dashed star is where that shows.
 *
 * **The cost, stated:** at map-wide zoom the regions are a few pixels across and neither the red nor
 * the dashes survive at that size. The ring carries it there.
 *
 * Drawn only while the tool is in hand: it is a tool layer, and the tool is its switch.
 */

import { colourFor } from "../palette";
import { currentCollapses, hoveredFreeCollapse } from "../collapseSearch";
import { ringCentre, ringRadius } from "../ringGesture";
import { editableGraph } from "../regions";
import { addPainter, type Painter } from "../shell";

/** The width of a wall on this canvas, so the star reads as walls that are not there yet. */
const LINE_WIDTH_PX = 2;
/** Erase's width, which the walls a collapse takes share with Dissolve region's highlight. */
const GOING_WIDTH_PX = 5;
const additive = () => colourFor("additive");
const destructive = () => colourFor("destructive");
const CASING = colourFor("casing");

const paint: Painter = ({ context, view, width, height, drawWidth, drawHeight }) => {
  /*
    **A free-click target joins the same list** (2026-09-24): a region bigger than the drawer's own
    size draws exactly the same going-red, star and ring a ringed one does, since that is exactly
    what a click there would take. It never duplicates an entry here — the hover only computes one
    while the ring test itself found nothing.
  */
  const free = hoveredFreeCollapse();
  const collapses = free ? [...currentCollapses(), free] : currentCollapses();
  const graph = editableGraph();
  if (collapses.length === 0 || !graph) return;

  // Graph units to screen: the longer drawn side is one unit on both axes.
  const long = Math.max(drawWidth, drawHeight);
  if (!(long > 0)) return;
  const perPixel = 1 / long;
  const x = (units: number): number => view.x + units * long;
  const y = (units: number): number => view.y + units * long;

  context.save();
  context.lineCap = "round";
  for (const collapse of collapses) {
    const centre = ringCentre(collapse.outline);
    const cx = x(centre.x);
    const cy = y(centre.y);
    const radius = ringRadius(collapse.outline, perPixel);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) continue;

    // What goes. The indices name walls in the graph the search ran on, which `currentCollapses` has
    // just made sure is the one on screen.
    context.setLineDash([]);
    context.beginPath();
    for (const index of collapse.edges) {
      const edge = graph.edges[index];
      const from = edge ? graph.nodes[edge.a] : undefined;
      const to = edge ? graph.nodes[edge.b] : undefined;
      if (!from || !to) continue;
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
    }
    context.strokeStyle = destructive();
    context.lineWidth = GOING_WIDTH_PX;
    context.stroke();

    // What arrives: the star, cased like a wall and dashed because it is proposed.
    if (collapse.centre) {
      context.setLineDash([6, 4]);
      context.beginPath();
      for (const id of collapse.connections) {
        const end = graph.nodes[id];
        if (!end) continue;
        context.moveTo(x(collapse.centre.x), y(collapse.centre.y));
        context.lineTo(x(end.x), y(end.y));
      }
      context.strokeStyle = CASING;
      context.lineWidth = LINE_WIDTH_PX + 2;
      context.stroke();
      context.strokeStyle = additive();
      context.lineWidth = LINE_WIDTH_PX;
      context.stroke();
    }

    // The ring: solid, over a dark rim, as Mend and the ink tool draw one they will accept.
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

/** Wire the layer up. Registered after the walls, so what would go is drawn over what is there. */
export function registerCollapsesLayer(): void {
  addPainter("collapses", paint);
}
