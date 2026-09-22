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
 * The caller passes distances in graph units, having turned screen pixels into them. That keeps
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

import { documentPoint, type WallGraph } from "../trace/wallGraph";
import {
  insertEdge,
  mergeNodes,
  moveNode,
  nearestEdgePoint,
  nearestNode,
  splitEdgesAt,
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
  /**
   * The wall a release would land **on**, and where along it — or `null`.
   *
   * A vertex beats a wall when both are in reach, because folding into a point that already exists
   * is the more specific answer. A wall is a long target and gets a tighter radius for it (user,
   * 2026-09-22: *"Tighter, 8px"*), or on a map of any density every release would catch one.
   */
  readonly landOn: { readonly edge: number; readonly at: Vector2 } | null;
}

/**
 * The vertex a press takes hold of, or `null` to let the press mean something else.
 *
 * Returning `null` is how a drag on empty map stays a pan: the tool asks, and the absence of an
 * answer is what leaves the gesture alone.
 */
export function grabAt(graph: WallGraph, u: number, v: number, radius: number): Grab | null {
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
  graph: WallGraph,
  grab: Grab,
  u: number,
  v: number,
  snapRadius: number,
  suppressSnap: boolean,
  wallRadius = 0,
): DragState {
  const at = documentPoint(u + grab.offsetU, v + grab.offsetV);
  const snapTo = suppressSnap ? null : nearestNode(graph, at, snapRadius, grab.id);
  if (snapTo !== null) return { at: graph.nodes[snapTo]!, snapTo, landOn: null };
  /*
    **The wall the vertex is being dropped on** (user, 2026-09-22: *"also move, because it could also
    place a vertex on a wall"*). Without it the vertex sits where it was dropped — near the wall, not
    joined to it, and the two come apart the moment either moves.

    **The walls this vertex already carries are skipped.** They pass under it by definition, so
    offering one would land the vertex on a wall it is an end of and split that wall where its own end
    already is.
  */
  const landing = suppressSnap || wallRadius <= 0 ? null : nearestEdgePoint(graph, at, wallRadius, grab.id);
  return { at, snapTo: null, landOn: landing };
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
export function applyDrag(graph: WallGraph, grab: Grab, state: DragState): EditResult | null {
  if (state.snapTo !== null) return mergeNodes(graph, grab.id, state.snapTo);
  /*
    **Landing on a wall is a split and then a merge**, in that order, and the order is the whole of it.

    Splitting puts a vertex on the wall *at the landing*, and merging folds the dragged vertex into
    that one — so the two genuinely share a point, which is a T-junction. Moving the vertex onto the
    wall and leaving the crossing sweep to notice would share it only when the two quantise alike, and
    7,926 of 19,061 landings did not.
  */
  if (state.landOn !== null) {
    const split = splitEdgesAt(graph, [{ edge: state.landOn.edge, at: state.landOn.at }]);
    const landed = split.graph.nodes.findIndex(
      (node) => node.x === state.landOn!.at.x && node.y === state.landOn!.at.y,
    );
    if (landed < 0 || landed === grab.id) return moveNode(graph, grab.id, state.at);
    const merged = mergeNodes(split.graph, grab.id, landed);
    return { ...merged, splits: merged.splits + split.splits };
  }
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
 * node **is** joined, permanently, which is what closing a gap in the linework has to mean. So the
 * tool snaps by default and the layer marks it, exactly as the vertex drag does.
 */
export interface DrawPoint {
  readonly at: Vector2;
  /** The existing vertex it would attach to, or `null` for a new one. */
  readonly onNode: number | null;
  /**
   * The wall it would land **on**, or `null`.
   *
   * Set only when no vertex is in reach: a vertex that exists is the more specific answer, and a
   * wall's own ends are `onNode`'s business. The wall is split at `at` before the new wall goes in,
   * which is what makes the join a shared vertex rather than two points agreeing.
   */
  readonly onEdge: number | null;
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
  graph: WallGraph,
  u: number,
  v: number,
  snapRadius: number,
  suppressSnap: boolean,
  wallRadius = 0,
): DrawPoint {
  const onNode = suppressSnap ? null : nearestNode(graph, { x: u, y: v }, snapRadius);
  if (onNode !== null) return { at: graph.nodes[onNode]!, onNode, onEdge: null };
  const landing =
    suppressSnap || wallRadius <= 0 ? null : nearestEdgePoint(graph, { x: u, y: v }, wallRadius);
  if (landing) return { at: landing.at, onNode: null, onEdge: landing.edge };
  return { at: documentPoint(u, v), onNode: null, onEdge: null };
}

/**
 * Split whatever these points land on, so a wall added by their coordinates shares those vertices.
 *
 * **Every split before any wall**, which is the rule `splitEdgesAt` already states: a landing names
 * its wall by index, and adding a wall renumbers the edges. Points that land on nothing pass through
 * untouched.
 */
export function splitForLandings(graph: WallGraph, points: readonly DrawPoint[]): EditResult {
  const landings = points
    .filter((point) => point.onEdge !== null)
    .map((point) => ({ edge: point.onEdge!, at: point.at }));
  if (landings.length === 0) return { graph, splits: 0, overlaps: 0 };
  return splitEdgesAt(graph, landings);
}

/**
 * Add the wall, or `null` if there is no wall to add.
 *
 * **`minLength` is a floor on what can be drawn, and it comes from a room** (2026-09-05): a GM
 * clicking twice in nearly the same place made a wall a few thousandths of a pixel long, which is
 * invisible, all but impossible to aim the erase tool at, and does nothing but sit in the document.
 * It is passed in rather than fixed here for the same reason the radii are — how small is *too*
 * small is a question about a surface and a zoom, and zooming in to draw finer detail should work.
 *
 * `null` also covers the two degenerate cases, **with one test rather than three**: two ends on one
 * spot and two ends snapped to the same existing vertex are the same thing, because snapping reports
 * the target's own coordinate. A zero-length segment has no direction, so nothing could sort it into
 * a rotation and the face traversal could not use it; the derivation drops them for the same reason.
 */
export function applyDraw(
  graph: WallGraph,
  from: DrawPoint,
  to: DrawPoint,
  minLength = 0,
): EditResult | null {
  const dx = to.at.x - from.at.x;
  const dy = to.at.y - from.at.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || length < minLength) return null;
  // Split first, then add by the same coordinates: that is what makes an end that landed on a wall
  // share the wall's new vertex instead of stopping beside it.
  const split = splitForLandings(graph, [from, to]);
  const added = insertEdge(split.graph, [from.at, to.at]);
  return { ...added, splits: added.splits + split.splits };
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

/**
 * What releasing the button means while drawing: put the wall down, or leave it armed.
 *
 * **Four cases, and getting one of them wrong is what a room found** (2026-09-05): the first version
 * finished only when the press had *travelled*, which is never true of the second click of a
 * click-click draw — so two clicks placed an anchor and then silently re-placed it, for ever, and
 * only dragging could finish a wall.
 *
 * A tiny function rather than an expression in the handler, because gesture *sequencing* is where
 * both of that day's defects lived and it is the one part of a pointer tool that can be pinned
 * without a DOM.
 *
 * - No anchor before the press, and it moved: a drag drew the whole wall. **Finish.**
 * - No anchor before the press, and it did not: a click set the first end. **Arm.**
 * - An anchor already, and it moved: dragged from the armed end. **Finish.**
 * - An anchor already, and it did not: the second click. **Finish** — this is the one that was wrong.
 */
export function drawRelease(armedBeforePress: boolean, travelled: boolean): "finish" | "arm" {
  return armedBeforePress || travelled ? "finish" : "arm";
}
