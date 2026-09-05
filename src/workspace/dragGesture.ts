/**
 * What dragging a vertex *means* — separated from the pointer events that deliver it.
 *
 * The gesture has four decisions in it and every one of them can be wrong in a way a picture would
 * not show: which vertex a press grabs, where the vertex sits while the cursor moves, whether a
 * release joins two vertices or merely moves one, and whether anything happened at all. Left in the
 * event handlers those are unreachable by a test, because reaching them means a DOM and a scene.
 * Here they are ordinary functions over a graph.
 *
 * ## Radii arrive already converted
 *
 * The caller passes distances in map fractions, having turned screen pixels into them. That keeps
 * the two concerns apart: how big a target should *feel* is a question about a surface and a zoom
 * level, and what falls inside it is a question about a graph.
 *
 * ## Snapping is decided here and nowhere else
 *
 * `moveNode` and `insertEdge` match vertices by exact coordinate and never by proximity, so that
 * "close enough to join" is decided once, where the GM can be shown it happening. This is that one
 * place. A suppressed snap is simply not asking.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, type FrozenGraph } from "../trace/frozenGraph";
import {
  insertEdge,
  mergeNodes,
  moveNode,
  nearestNode,
  type EditResult,
} from "../trace/planarOps";

/** A vertex under the cursor, and where it sits relative to it. */
export interface Grab {
  readonly id: number;
  /**
   * The vertex's position less the cursor's, kept from the moment of the press.
   *
   * Without it the vertex jumps to the cursor when grabbed. That is only ever a few pixels, and it
   * is a few pixels of the GM's own work moving because they touched it — which is not something
   * this surface may ever do, at any size.
   */
  readonly offsetU: number;
  readonly offsetV: number;
}

/** Where the dragged vertex would land, and what a release would do. */
export interface DragState {
  readonly at: Vector2;
  /** The vertex a release would fold this one into, or `null` for a plain move. */
  readonly snapTo: number | null;
}

/**
 * The vertex a press takes hold of, or `null` to let the press mean something else.
 *
 * Returning `null` is how a drag on empty map stays a pan: the tool asks, and the absence of an
 * answer is what leaves the gesture alone.
 */
export function grabAt(graph: FrozenGraph, u: number, v: number, radius: number): Grab | null {
  const id = nearestNode(graph, { x: u, y: v }, radius);
  if (id === null) return null;
  const node = graph.nodes[id]!;
  return { id, offsetU: node.x - u, offsetV: node.y - v };
}

/**
 * Where the vertex is while the cursor is at `(u, v)`, and whether it would merge.
 *
 * **The snap is measured from where the vertex would be, not from the cursor.** They differ by the
 * grab offset, so measuring from the cursor would make a vertex grabbed slightly off-centre snap to
 * a target it is not near — the GM would see the mark appear beside a vertex their wall does not
 * reach. Excluding the dragged vertex is what stops it snapping to itself.
 *
 * When it snaps, the reported position **is the target's**, because that is exactly what releasing
 * would produce. Showing the wall in its post-merge place is a stronger statement than a colour
 * change beside it, and it costs nothing: nothing is written until the release either way.
 */
export function dragTo(
  graph: FrozenGraph,
  grab: Grab,
  u: number,
  v: number,
  snapRadius: number,
  suppressSnap: boolean,
): DragState {
  const at = documentPoint(u + grab.offsetU, v + grab.offsetV);
  const snapTo = suppressSnap ? null : nearestNode(graph, at, snapRadius, grab.id);
  return { at: snapTo === null ? at : graph.nodes[snapTo]!, snapTo };
}

/**
 * Apply the gesture, or `null` if it changed nothing.
 *
 * **A snap is a merge and not a move**, and the difference is the point of the whole document: a
 * merge renames every reference to the folded vertex, so the two walls genuinely share a point and
 * follow each other for ever after. A move that happened to land on identical coordinates would
 * leave two vertices that agree only until one of them moves again — which is exactly the state the
 * emitted fog is stuck in, and the reason editing cannot be pulled back out of the scene.
 *
 * `null` for a press and release that went nowhere. Writing an unchanged graph to the scene would be
 * a scene write, a rebuild and a log line for a gesture in which nothing happened.
 */
export function applyDrag(graph: FrozenGraph, grab: Grab, state: DragState): EditResult | null {
  if (state.snapTo !== null) return mergeNodes(graph, grab.id, state.snapTo);
  const from = graph.nodes[grab.id];
  // Exact, because both sides came through `documentPoint`: identity here is not approximate, and
  // an epsilon would silently discard a deliberate nudge of a fraction of a pixel.
  if (from && from.x === state.at.x && from.y === state.at.y) return null;
  return moveNode(graph, grab.id, state.at);
}

/**
 * What the edit did, in the GM's terms.
 *
 * Splits and overlaps are reported rather than hidden. A split is the graph *staying* planar — a
 * wall dragged across another now meets it at a real vertex — and saying so is the difference
 * between a tool that quietly restructured the linework and one that says what it did. An overlap is
 * two walls lying along each other, which splitting cannot separate and which is a legal state to
 * pass through, so it is named and left alone.
 *
 * **A single crossing reports two walls, and the wording has to allow for it.** Both segments are
 * cut where they meet — the one being dragged and the one it ran into — so a move across one wall
 * splits two. An earlier version said "walls it crossed", which is wrong about the half that is its
 * own wall, and would have had a GM looking for a second wall that was never there.
 */
export function describeEdit(merged: boolean, splits: number, overlaps: number): string {
  const head = merged ? "joined two points" : "moved a point";
  const notes: string[] = [];
  if (splits > 0) notes.push(`split ${splits} wall${splits === 1 ? "" : "s"} at the crossing`);
  if (overlaps > 0) {
    notes.push(`${overlaps} wall${overlaps === 1 ? " lies" : "s lie"} along another`);
  }
  return notes.length === 0 ? head : `${head} · ${notes.join(" · ")}`;
}

/**
 * One end of a wall being drawn: where it would land, and what it would attach to.
 *
 * `onNode` is the whole reason drawing needs snapping at all. A wall that merely *ends* where
 * another begins is two coincident points that agree until one of them moves; a wall that shares a
 * node **is** joined, permanently, which is what closing a break in the linework has to mean. So the
 * tool snaps by default and the layer marks it, exactly as the vertex drag does.
 */
export interface DrawPoint {
  readonly at: Vector2;
  /** The existing vertex it would attach to, or `null` for a new one. */
  readonly onNode: number | null;
}

/**
 * Where one end of a new wall lands, snapped to a nearby vertex unless suppressed.
 *
 * The snapped position is the target's own coordinate rather than something near it, which is what
 * lets `insertEdge` recognise the attachment: it matches vertices by **exact** coordinate and never
 * by proximity, precisely so that "close enough to join" is decided here, once, where the GM is
 * shown it happening.
 */
export function drawPoint(
  graph: FrozenGraph,
  u: number,
  v: number,
  snapRadius: number,
  suppressSnap: boolean,
): DrawPoint {
  const onNode = suppressSnap ? null : nearestNode(graph, { x: u, y: v }, snapRadius);
  if (onNode === null) return { at: documentPoint(u, v), onNode: null };
  return { at: graph.nodes[onNode]!, onNode };
}

/**
 * Add the wall, or `null` if there is no wall to add.
 *
 * `null` covers both ways of drawing nothing, **with one test rather than two**: two ends on one
 * spot, and two ends snapped to the same existing vertex. The second looks like it needs a check of
 * its own and does not — snapping reports the target's own coordinate, so two ends on one vertex are
 * two ends on one spot, and a separate id comparison was a branch nothing could reach past this.
 *
 * A zero-length segment has no direction, so nothing could sort it into a rotation and the face
 * traversal could not use it. The freeze drops them for the same reason.
 */
export function applyDraw(graph: FrozenGraph, from: DrawPoint, to: DrawPoint): EditResult | null {
  if (from.at.x === to.at.x && from.at.y === to.at.y) return null;
  return insertEdge(graph, [from.at, to.at]);
}

/**
 * What the wall tools did, in the GM's terms.
 *
 * Separate from `describeEdit` rather than folded into it: that one is about moving a point and this
 * one is about walls appearing and disappearing, and a single function taking a verb enum would read
 * as one thing happening in four ways when it is four things.
 */
export function describeDraw(splits: number, overlaps: number): string {
  const notes: string[] = [];
  if (splits > 0) notes.push(`split ${splits} wall${splits === 1 ? "" : "s"} at the crossing`);
  if (overlaps > 0) {
    notes.push(`${overlaps} wall${overlaps === 1 ? " lies" : "s lie"} along another`);
  }
  return notes.length === 0 ? "drew a wall" : `drew a wall · ${notes.join(" · ")}`;
}
