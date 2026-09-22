/**
 * What one click means while a chain of walls is being drawn.
 *
 * Gesture sequencing is the part of a pointer tool that can be pinned without a DOM, and this project
 * has already paid twice for leaving it in the event handlers. The rule is small and has four
 * outcomes, so it is here as a function rather than as branches inside a press.
 *
 * ## The four answers
 *
 * - **append** — an ordinary click: another point, and the chain runs on.
 * - **close** — a click on the chain's own first point: the shape closes and the chain ends.
 * - **join** — a click on a point the chain already has, other than the first: a loop with a tail, and
 *   the chain ends. It shares that vertex rather than laying a second point on top of it, which is the
 *   document's standing rule about two points agreeing.
 * - **finish** — a click on the last point placed, or on a vertex the graph already has: the chain
 *   ends where it is.
 *
 * ## Why there is no "too short to draw" answer
 *
 * The draw tool refuses a wall under a few screen pixels, because a wall too short to see is painfully
 * hard to aim any other tool at. A chain needs no such rule: **the snap radius is wider than that
 * minimum**, so a click too short to be a wall is already a click on the last point placed — which
 * finishes (user, 2026-09-22). One rule covers both, and the GM gets a deliberate way to stop where
 * they are rather than a click that silently does nothing.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

export type ChainClick =
  | { readonly kind: "append" }
  | { readonly kind: "close" }
  | { readonly kind: "join"; readonly at: number }
  | { readonly kind: "finish" };

/** How close two points in graph units have to be for a click to count as landing on one. */
function within(a: Vector2, b: Vector2, radius: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= radius;
}

/**
 * What this click does to the chain in progress.
 *
 * `placed` are the points already laid down, in order. `onNode` is the existing graph vertex the
 * landing snapped to, or `null` — the caller has already asked `drawPoint` that question, and this
 * does not repeat it.
 *
 * **The chain's own points are tested here and not by the snap**, because they are not in the graph
 * yet: nothing would find them. Tested nearest-first from the end, so a chain that doubles back on
 * itself finishes at the point the GM is actually pointing at rather than at the first one it happens
 * to walk past.
 */
export function chainClick(
  placed: readonly Vector2[],
  landing: Vector2,
  onNode: number | null,
  radius: number,
): ChainClick {
  if (placed.length === 0) return { kind: "append" };

  const last = placed[placed.length - 1]!;
  if (within(last, landing, radius)) return { kind: "finish" };

  /*
    The first point closes the shape, and it is asked before the middle ones: a chain of two points
    clicked back on its start is a close, not a join.

    **No length guard**, because a chain of one point cannot reach here — its only point is also its
    last, and the check above has already answered. A mutation pass found the guard could not fire.
  */
  if (within(placed[0]!, landing, radius)) return { kind: "close" };

  /*
    The middle points only. **Both bounds are unreachable guards** and survive mutation deliberately:
    a landing on the last point or the first has already been answered above, so widening this loop to
    the whole array would not change an answer. They are kept because "the middle points" is what this
    step means, and a loop over everything would say something the code does not do.
  */
  for (let index = placed.length - 2; index >= 1; index--) {
    if (within(placed[index]!, landing, radius)) return { kind: "join", at: index };
  }

  if (onNode !== null) return { kind: "finish" };
  return { kind: "append" };
}

/**
 * The run of points to insert, for a chain that has ended.
 *
 * `null` when there is nothing to draw — a chain of one point, which is what a press followed
 * immediately by a finish leaves. **A closed chain repeats its first point at the end**, which is how
 * `insertEdge` is told to shut the loop: it takes a run, and a run whose last point is its first is a
 * ring whose corners are shared vertices by construction. That is the same thing the map frame does.
 */
export function chainRun(placed: readonly Vector2[], closed: boolean): Vector2[] | null {
  if (placed.length < 2) return null;
  return closed ? [...placed, placed[0]!] : [...placed];
}
