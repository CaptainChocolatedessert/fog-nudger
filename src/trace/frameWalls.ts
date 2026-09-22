/**
 * Walling the map's edge, and taking that wall off again, so the exterior can be a room.
 *
 * **It is a toggle** (user, 2026-09-22): one press walls the edge, the next takes it off. The state is
 * read out of the document by `alreadyFramed` rather than stored, so nothing can disagree with the
 * walls — and there is no record of *which* walls the framing placed, which is what `removeFrameWalls`
 * says the cost of.
 *
 * ## Why this is a button rather than something the trace does
 *
 * The derivation used to paint a one-pixel border into the skeleton before building the graph, which
 * made the map's exterior an ordinary bounded face. It stopped on 2026-09-08 (user):
 *
 * > *"On most maps the exterior isn't a 'room'. It's not an explorable space. Not emitting a shape
 * > for it would simplify what we emit, and be more true to the typical intent of the map... If we
 * > maintain a button for the user to apply frame walls in the edit stage, the user can get the
 * > exterior shape if they want it."*
 *
 * The graph's outer face is unbounded and has no polygon, so with nothing at the edge there is simply
 * no exterior to emit — and everything is fogged by default, so the outside stays fogged and
 * unrevealable. This puts it back for the maps where the outside *is* somewhere the party can go.
 *
 * ## What it adds, and where
 *
 * Four segments at the map's own extent: (0,0) to (w,0) to (w,h) to (0,h) and back, where `w × h` is
 * the map's size in graph units — the longer side 1 and the other its share of it. The extent is
 * quantised to float32 the way every coordinate is, so the frame lands on the map's boundary rather
 * than near it, and nothing downstream needs a tolerance for it having been placed approximately.
 *
 * **The extent is passed in**, because the document does not know the map's aspect: that is a
 * property of the image, and the caller is the one holding the image.
 *
 * **Crossings are split, like every other edit.** A wall running off the edge of the map meets the
 * frame, and `insertEdge` cuts both at the meeting point — which is what makes the exterior a single
 * face rather than a shape overlapping the linework. That also means the four segments become more
 * than four once there is anything to meet.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { GraphExtent } from "./graphUnits";
import { documentPoint, type WallGraph } from "./wallGraph";
import { insertEdge } from "./planarOps";

/** The map's four corners, in graph units, for a map whose extent is `extent`. */
function corners(extent: GraphExtent): readonly Vector2[] {
  const far = documentPoint(extent.x, extent.y);
  return [
    { x: 0, y: 0 },
    { x: far.x, y: 0 },
    { x: far.x, y: far.y },
    { x: 0, y: far.y },
  ];
}

export interface FramingResult {
  readonly graph: WallGraph;
  /** Segments of existing linework cut where the frame met them. */
  readonly splits: number;
  /** Collinear overlaps found. Reported, never fixed — splitting cannot separate them. */
  readonly overlaps: number;
  /** Whether a frame was already there, in which case nothing was added. */
  readonly alreadyFramed: boolean;
  /** Walls lying along an edge that were taken out before laying the new frame. */
  readonly cleared: number;
}

/**
 * Every wall lying **wholly along** one of the four edge lines.
 *
 * The same question `alreadyFramed` asks, kept as a set rather than counted per side — one is "is
 * each side covered", the other is "which walls are the covering". Both must read *along*, not
 * *touching*: a wall from corner to corner has an endpoint on all four edges and is not one of these.
 */
export function edgeWallIndices(graph: WallGraph, extent: GraphExtent): number[] {
  const far = documentPoint(extent.x, extent.y);
  const found: number[] = [];
  for (let index = 0; index < graph.edges.length; index++) {
    const edge = graph.edges[index]!;
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const along =
      (a.x === 0 && b.x === 0) ||
      (a.x === far.x && b.x === far.x) ||
      (a.y === 0 && b.y === 0) ||
      (a.y === far.y && b.y === far.y);
    if (along) found.push(index);
  }
  return found;
}

/**
 * Take the frame off: every wall along an edge goes, and nothing else moves.
 *
 * **The vertices stay**, which is `removeEdge`'s own rule — ids are the only stable identity the
 * document has, and one with no walls draws no handle. A wall that *ended* on the frame keeps its
 * endpoint and becomes a free end again, which is exactly where it ended before the frame went on.
 *
 * **What it cannot undo is a split.** A wall the frame cut is left as two pieces meeting at a vertex:
 * the same line, one vertex more, because the document never recorded which cuts the framing made.
 * Straighten takes such a vertex out; nothing else needs to.
 *
 * **A wall the GM drew along the edge themselves is indistinguishable from a frame wall** and goes
 * with it. That is the accepted cost of the frame being a state of the document rather than a thing
 * the document remembers placing (user, 2026-09-22).
 */
export function removeFrameWalls(graph: WallGraph, extent: GraphExtent): { graph: WallGraph; removed: number } {
  const indices = new Set(edgeWallIndices(graph, extent));
  if (indices.size === 0) return { graph, removed: 0 };
  return {
    graph: { nodes: graph.nodes, edges: graph.edges.filter((_, index) => !indices.has(index)) },
    removed: indices.size,
  };
}

/**
 * Whether this graph already runs along the map's edge.
 *
 * Asked before adding rather than after, because adding a second frame would lay four segments
 * exactly on four that exist — collinear overlaps, which splitting cannot separate and which make
 * Euler's identity fail. A button that quietly corrupted the document on a second press would be
 * the worst kind of idempotence bug: invisible until the next traversal.
 *
 * **Tested by counting, not by matching.** A frame contributes at least one segment lying wholly
 * along each of the four edges; anything less is ordinary linework that happens to touch the border.
 */
export function alreadyFramed(graph: WallGraph, extent: GraphExtent): boolean {
  const far = documentPoint(extent.x, extent.y);
  const onEdge = { left: false, right: false, top: false, bottom: false };
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    if (a.x === 0 && b.x === 0) onEdge.left = true;
    if (a.x === far.x && b.x === far.x) onEdge.right = true;
    if (a.y === 0 && b.y === 0) onEdge.top = true;
    if (a.y === far.y && b.y === far.y) onEdge.bottom = true;
  }
  return onEdge.left && onEdge.right && onEdge.top && onEdge.bottom;
}

/**
 * Add the four walls, splitting anything they cross.
 *
 * Inserted as **one closed run** rather than four separate calls, so the corners are shared vertices
 * by construction rather than by four coordinates happening to be equal. That is the same reason the
 * drawing tool snaps: a wall that merely *ends* where another begins is two points agreeing until one
 * moves.
 */
export function addFrameWalls(graph: WallGraph, extent: GraphExtent): FramingResult {
  if (alreadyFramed(graph, extent)) {
    return { graph, splits: 0, overlaps: 0, alreadyFramed: true, cleared: 0 };
  }

  /*
    **Whatever already lies along an edge comes out first** (2026-09-22), and this is a correctness
    guard rather than tidiness.

    The refusal above is all-or-nothing: it asks whether *each* of the four sides is covered. A frame
    with one side erased therefore reads as unframed, and laying a fresh one put three new segments
    exactly on three existing ones — collinear overlaps, which splitting cannot separate and which
    make Euler's identity fail. The document was corrupt with nothing to see until the next traversal,
    which is the failure the refusal was written to prevent and did not reach.

    Clearing first makes the press mean *the edge is walled by this frame*, in every starting state.
  */
  const cleared = removeFrameWalls(graph, extent);

  const around = corners(extent);
  const closed = [...around, around[0]!].map((corner) => documentPoint(corner.x, corner.y));
  const result = insertEdge(cleared.graph, closed);
  return {
    graph: result.graph,
    splits: result.splits,
    overlaps: result.overlaps,
    alreadyFramed: false,
    cleared: cleared.removed,
  };
}
