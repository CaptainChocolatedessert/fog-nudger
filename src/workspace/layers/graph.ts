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

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { nodeDegrees, type FrozenGraph } from "../../trace/frozenGraph";
import { addPainter, type Painter } from "../shell";
import { frozenGraph } from "../stage";
import type { DrawPoint } from "../dragGesture";
import {
  draggedNode,
  hoveredNode,
  hoveredWall,
  pendingPoint,
  pendingWall,
  snapTarget,
} from "../wallEdit";

/** Kept distinct from the wall lines' red and from the six proposal colours. */
const WALL_COLOUR = "#2b6bff";
const WALL_CASING = "#ffffff";
/** Screen pixels. A hairline over busy map art is not a wall anybody can judge or aim at. */
const WALL_WIDTH_PX = 2;

const HANDLE_FILL = "#ffffff";
const HANDLE_RIM = "#2b6bff";
const HANDLE_RADIUS = 3;

/**
 * The three states a handle can be in beyond ordinary, and they say different things.
 *
 * **Grabbable** is the answer to a question nobody can otherwise ask: a press either moves a vertex
 * or pans, and without this the GM finds out which by doing it. **Moving** marks the one point the
 * gesture is carrying. **Joining** is the one §8 actually demands — a merge is not undoable and the
 * boundary has to be visible *before* it is crossed, so the target changes colour and grows while
 * there is still a chance to move away or hold Shift.
 */
const HOVER_RADIUS = 5;
const ACTIVE_FILL = "#ffcc00";
const MERGE_FILL = "#00e06a";
const ACTIVE_RIM = "#20242c";
const MERGE_RADIUS = 6;

/**
 * The wall about to be erased, and the wall about to be drawn.
 *
 * Both are the §8 rule doing the same job in two places: an erase cannot be undone and a drawn wall
 * changes which rooms exist, so what is about to happen is on screen before the click that does it.
 * Red for the one that removes and green for the one that adds, which is the only pair of meanings
 * on this canvas that a colour can carry without being learned.
 */
const ERASE_COLOUR = "#ff3b30";
const ERASE_WIDTH_PX = 5;
const DRAW_COLOUR = "#00e06a";

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

  /*
    Where a vertex is *drawn*, which during a drag is not where it is stored.

    The gesture holds the position it would land on and nothing is written to the graph until the
    release. So the walls follow the cursor by substituting one coordinate here, at no cost beyond
    the redraw — no graph rebuilt per frame, and no crossing sweep per frame either.
  */
  const dragged = draggedNode();
  const at = (id: number): Vector2 | undefined =>
    dragged !== null && id === dragged.id ? dragged.at : graph.nodes[id];

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  // One path for every wall, stroked twice: the casing first, then the core over it.
  context.beginPath();
  for (const edge of graph.edges) {
    const from = at(edge.a);
    const to = at(edge.b);
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

  // The wall a click would erase, marked before it goes rather than reported after.
  const erasing = hoveredWall();
  if (erasing !== null) {
    const edge = graph.edges[erasing];
    const from = edge ? at(edge.a) : undefined;
    const to = edge ? at(edge.b) : undefined;
    if (from && to) {
      context.beginPath();
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
      context.strokeStyle = ERASE_COLOUR;
      context.lineWidth = ERASE_WIDTH_PX;
      context.stroke();
    }
  }

  /*
    The wall being drawn, following the cursor.

    Dashed, because it is the one line on this canvas that is not there yet — every other stroke
    describes something the document already holds, and a solid rubber band would claim the same
    standing as a wall that exists.
  */
  const pending = pendingWall();
  if (pending) {
    context.save();
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(x(pending.from.at.x), y(pending.from.at.y));
    context.lineTo(x(pending.to.at.x), y(pending.to.at.y));
    context.strokeStyle = WALL_CASING;
    context.lineWidth = WALL_WIDTH_PX + 2;
    context.stroke();
    context.strokeStyle = DRAW_COLOUR;
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
    context.restore();
  }

  // The walls the gesture is carrying, over the rest, so what is moving is never in doubt.
  if (dragged !== null) {
    context.beginPath();
    for (const edge of graph.edges) {
      if (edge.a !== dragged.id && edge.b !== dragged.id) continue;
      const from = at(edge.a);
      const to = at(edge.b);
      if (!from || !to) continue;
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
    }
    context.strokeStyle = ACTIVE_FILL;
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
  }

  paintHandles(context, graph, x, y, at);
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
  at: (id: number) => Vector2 | undefined,
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

  const dragged = draggedNode();
  const snap = snapTarget();
  const hover = hoveredNode();

  const dot = (px: number, py: number, radius: number, fill: string, rim: string): void => {
    context.fillStyle = fill;
    context.strokeStyle = rim;
    context.beginPath();
    context.arc(px, py, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  };

  context.lineWidth = 1.5;
  for (let id = 0; id < graph.nodes.length; id++) {
    if ((degree[id] ?? 0) === 0) continue;
    // The three marked states are drawn afterwards, over everything, so a handle they overlap
    // cannot cover them.
    if (id === dragged?.id || id === snap) continue;
    const node = graph.nodes[id]!;
    const px = x(node.x);
    const py = y(node.y);
    if (!onScreen(px, py)) continue;
    const grabbable = id === hover;
    dot(px, py, grabbable ? HOVER_RADIUS : HANDLE_RADIUS, HANDLE_FILL, HANDLE_RIM);
  }

  if (dragged !== null) {
    const point = at(dragged.id);
    if (point) dot(x(point.x), y(point.y), HOVER_RADIUS, ACTIVE_FILL, ACTIVE_RIM);
  }
  // Last and largest: this is the one mark that has to be seen before the gesture ends, because a
  // merge is what release would do and it cannot be taken back.
  if (snap !== null) {
    const point = graph.nodes[snap];
    if (point) dot(x(point.x), y(point.y), MERGE_RADIUS, MERGE_FILL, ACTIVE_RIM);
  }

  /*
    Either end of a wall being drawn, marked green where it would **attach**.

    Attaching is the whole difference between a wall that closes a break and one that merely ends
    near it — a shared vertex is joined for ever, two coincident points agree until one moves. So the
    two states are drawn differently rather than left for the GM to infer from the position.
  */
  /*
    A mark where a drawn end would **attach**, and nowhere else.

    Attaching is the whole difference between closing a break and drawing a line that merely ends
    near one, and it is decided before the press — so it has to be visible then, which the cursor
    cannot say. A crosshair means "the tool acts here", not "and it will join that".

    **Nothing is drawn under the cursor when it would not attach** (user, 2026-09-05). A dot that
    simply follows the pointer says only where the pointer is, which the pointer already says, and
    it sits in the middle of the thing being aimed at — the same fault the grab cursor had. The
    fixed end of a wall in progress is different and is always marked: it is not under the cursor,
    and where a wall began and whether it caught is worth seeing while the far end moves.
  */
  const pending = pendingWall();
  const marks: DrawPoint[] = [];
  if (pending) {
    marks.push(pending.from);
    if (pending.to.onNode !== null) marks.push(pending.to);
  } else {
    const next = pendingPoint();
    if (next && next.onNode !== null) marks.push(next);
  }

  for (const point of marks) {
    const attaching = point.onNode !== null;
    dot(
      x(point.at.x),
      y(point.at.y),
      attaching ? MERGE_RADIUS : HOVER_RADIUS,
      attaching ? MERGE_FILL : ACTIVE_FILL,
      ACTIVE_RIM,
    );
  }
}

/** Wire the layer up. Registered after the regions, so the graph sits over the rooms it makes. */
export function registerGraphLayer(): void {
  addPainter("graph", paint);
}
