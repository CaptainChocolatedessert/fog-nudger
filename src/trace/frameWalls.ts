/**
 * Adding walls around the map's edge, so the exterior becomes a room again.
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
 * Four segments at the map's own extent: (0,0) to (1,0) to (1,1) to (0,1) and back. Those are exact
 * in the document's float32 coordinates, so the frame lands on the map's boundary rather than near
 * it, and nothing downstream needs a tolerance for it having been placed approximately.
 *
 * **Crossings are split, like every other edit.** A wall running off the edge of the map meets the
 * frame, and `insertEdge` cuts both at the meeting point — which is what makes the exterior a single
 * face rather than a shape overlapping the linework. That also means the four segments become more
 * than four once there is anything to meet.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, type WallGraph } from "./wallGraph";
import { insertEdge } from "./planarOps";

/** The map's four corners, in the document's own units. */
const CORNERS: readonly Vector2[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export interface FramingResult {
  readonly graph: WallGraph;
  /** Segments of existing linework cut where the frame met them. */
  readonly splits: number;
  /** Collinear overlaps found. Reported, never fixed — splitting cannot separate them. */
  readonly overlaps: number;
  /** Whether a frame was already there, in which case nothing was added. */
  readonly alreadyFramed: boolean;
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
export function alreadyFramed(graph: WallGraph): boolean {
  const onEdge = { left: false, right: false, top: false, bottom: false };
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    if (a.x === 0 && b.x === 0) onEdge.left = true;
    if (a.x === 1 && b.x === 1) onEdge.right = true;
    if (a.y === 0 && b.y === 0) onEdge.top = true;
    if (a.y === 1 && b.y === 1) onEdge.bottom = true;
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
export function addFrameWalls(graph: WallGraph): FramingResult {
  if (alreadyFramed(graph)) {
    return { graph, splits: 0, overlaps: 0, alreadyFramed: true };
  }

  const closed = [...CORNERS, CORNERS[0]!].map((corner) => documentPoint(corner.x, corner.y));
  const result = insertEdge(graph, closed);
  return {
    graph: result.graph,
    splits: result.splits,
    overlaps: result.overlaps,
    alreadyFramed: false,
  };
}
