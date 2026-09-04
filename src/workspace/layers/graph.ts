/**
 * The graph layer: the frozen walls, and a handle at every point in them.
 *
 * **Stage two's picture of the thing it edits.** Every other layer draws a *derivation* — the ink is
 * what the reading made of the map, the skeleton is what thinning made of the ink, the partition is
 * what the traversal made of the graph. This one draws the document itself, which after the freeze
 * is the only thing there is: nothing upstream of it applies any more.
 *
 * ## Map fractions, so there is no raster to agree with
 *
 * The frozen graph is stored in fractions of the map's own extent, which is exactly the space the
 * shell hands a painter — the map's draw rectangle. So a point multiplies by the draw width and
 * lands where it belongs, with no scale factor to derive and no raster to be consistent with. The
 * other layers all carry one; this one cannot get it wrong because it has none.
 *
 * ## Cased lines, learned the expensive way
 *
 * A wall here is a *centreline*, so by construction it lies exactly on top of the map's own
 * linework. The first wall lines this project drew were near-black, and a room reported "no stubs or
 * bridges showing" when all twenty-two were on screen. A saturated core over a light casing is what
 * reads against dark ink and pale paper alike, which is the only pair of backgrounds a wall is drawn
 * against.
 *
 * Blue rather than the wall lines' red, because red already means something on this canvas: the
 * Regions layer draws the walls that emit as `LINE` items in it, and that distinction is worth
 * keeping visible while the graph is drawn over the same picture.
 */

import { nodeDegrees, type FrozenGraph } from "../../trace/frozenGraph";
import { addPainter, type Painter } from "../shell";
import { frozenGraph } from "../stage";

/** Kept distinct from the wall lines' red and from the six proposal colours. */
const WALL_COLOUR = "#2b6bff";
const WALL_CASING = "#ffffff";
/** Screen pixels. A hairline over busy map art is not a wall anybody can judge or aim at. */
const WALL_WIDTH_PX = 2;

const HANDLE_FILL = "#ffffff";
const HANDLE_RIM = "#2b6bff";
const HANDLE_RADIUS = 3;

/**
 * Past this many handles *on screen*, none are drawn.
 *
 * A real map's graph is thousands of points, and every one of them at zoom-out is a wash of dots
 * that hides the walls the handles are meant to sit on. The cap is on what is visible rather than on
 * the graph's size, which is the difference that matters: zooming in to work on a room brings the
 * handles back, and zooming out to judge the whole map leaves the linework readable. The state line
 * carries the total, so nothing is silently missing.
 */
const MAX_HANDLES = 2000;

/** Degrees are derived per graph rather than per frame; the graph only changes on an edit. */
let degreesOf: number[] = [];
let degreesFor: FrozenGraph | null = null;

function degrees(graph: FrozenGraph): number[] {
  if (degreesFor !== graph) {
    degreesOf = nodeDegrees(graph);
    degreesFor = graph;
  }
  return degreesOf;
}

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const graph = frozenGraph();
  if (!graph || graph.edges.length === 0) return;

  const x = (fraction: number): number => view.x + fraction * drawWidth;
  const y = (fraction: number): number => view.y + fraction * drawHeight;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  // One path for every wall, stroked twice: the casing first, then the core over it.
  context.beginPath();
  for (const edge of graph.edges) {
    const from = graph.nodes[edge.a];
    const to = graph.nodes[edge.b];
    if (!from || !to) continue;
    context.moveTo(x(from.x), y(from.y));
    context.lineTo(x(to.x), y(to.y));
  }
  context.strokeStyle = WALL_CASING;
  context.lineWidth = WALL_WIDTH_PX + 2;
  context.stroke();
  context.strokeStyle = WALL_COLOUR;
  context.lineWidth = WALL_WIDTH_PX;
  context.stroke();

  paintHandles(context, graph, x, y);
  context.restore();
};

/**
 * A handle at every point of the graph — in **screen** space, so it stays grabbable at any zoom.
 *
 * The same argument as the break rings and the skeleton's node marks: a point is a single position
 * with a whole map on the canvas, and a mark that scales with the zoom disappears at exactly the
 * moment it is wanted. A handle has a second reason on top of that one — piece by piece this is what
 * the drag gesture will aim at, and a target that changes size under the cursor as the GM zooms is a
 * target they have to re-learn.
 *
 * **A point with no walls gets no handle.** Merging two vertices leaves the folded one in the table
 * unreferenced rather than renumbering, because renumbering would invalidate every id the caller
 * holds. Those are bookkeeping, not geometry, and a handle you can grab that moves nothing would be
 * a lie about what is there.
 */
function paintHandles(
  context: CanvasRenderingContext2D,
  graph: FrozenGraph,
  x: (fraction: number) => number,
  y: (fraction: number) => number,
): void {
  const degree = degrees(graph);
  const width = context.canvas.width;
  const height = context.canvas.height;
  const onScreen = (px: number, py: number): boolean =>
    px >= -HANDLE_RADIUS &&
    py >= -HANDLE_RADIUS &&
    px <= width + HANDLE_RADIUS &&
    py <= height + HANDLE_RADIUS;

  let visible = 0;
  for (let id = 0; id < graph.nodes.length; id++) {
    if ((degree[id] ?? 0) === 0) continue;
    const node = graph.nodes[id]!;
    if (onScreen(x(node.x), y(node.y))) visible += 1;
    if (visible > MAX_HANDLES) return;
  }

  context.fillStyle = HANDLE_FILL;
  context.strokeStyle = HANDLE_RIM;
  context.lineWidth = 1.5;
  for (let id = 0; id < graph.nodes.length; id++) {
    if ((degree[id] ?? 0) === 0) continue;
    const node = graph.nodes[id]!;
    const px = x(node.x);
    const py = y(node.y);
    if (!onScreen(px, py)) continue;
    context.beginPath();
    context.arc(px, py, HANDLE_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

/** Wire the layer up. Registered after the regions, so the graph sits over the rooms it makes. */
export function registerGraphLayer(): void {
  addPainter("graph", paint);
}
