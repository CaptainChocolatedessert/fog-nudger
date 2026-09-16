/**
 * Dissolve region: which region a click is in, and which walls go when it dissolves.
 *
 * The small-region tool §10 carried as undesigned, answered by a click rather than a threshold
 * (user, 2026-09-16). A threshold was the deleted smallest-room control; a click is the exact, local,
 * visible version, and it also retires the question of what unit an area would be in.
 *
 * ## The rule
 *
 * - **Every wall between the region and something outside it goes**, so the region merges with every
 *   neighbour at once — and with the outside, which is never emitted, if any of its walls face it.
 * - **Every wall with the region on both sides goes**: a stub hanging in, a freestanding wall, the
 *   stem of a lollipop.
 * - **The walls of a closed region inside it stay**: a pillar, a table, a lollipop's head, and a room
 *   touching the outer wall at a single point.
 *
 * A stub sticking *out* into a neighbour has the neighbour on both sides, so it is not this region's
 * and it stays — left freestanding once the wall behind it has gone.
 *
 * ## One test decides all three: the sign of a loop
 *
 * The region's boundary is the half-edges of its cycles, which the traversal has already walked, so
 * *the walls around it* is an exact set with nothing to tune. What is not in the set is which of them
 * enclose the region. **A room joined to the outer wall** — by a stem, or at a single shared vertex —
 * is walked as part of the *outer* cycle, because it is the same piece of linework, so "on the outer
 * cycle" does not mean "around the region".
 *
 * So the walk is split into simple loops wherever it comes back to a vertex it is already on, and
 * each loop's signed area decides. **The traversal keeps a face on the same side of every half-edge it
 * walks**, which gives the three cases three signs:
 *
 * - **Positive** — the loop goes around the region, as an enclosing cycle does. Its walls go.
 * - **Negative** — the loop goes around something the region surrounds: a pillar's outline, a
 *   lollipop's head, a room touching the outer wall. Its walls stay. Every hole cycle is only these,
 *   and slits.
 * - **Zero** — the loop encloses nothing. That is a wall walked out and straight back, which is a wall
 *   with the region on both sides, and it goes. The two terms of such a loop are exact negations, so
 *   the sum is exactly zero rather than nearly.
 *
 * The area is a total over the loop, so the answer does not depend on where in the walk it starts.
 *
 * **Zero is also a stub drawn twice**, walked out along one copy and back along the other — a legal
 * state to pass through. The traversal files the sliver between the copies under the outside, so the
 * copies are not seen as having the region on both sides, and a rule that asked that directly left
 * both standing (measured 2026-09-16). The loop's sign does not care. Without walls overlapping there
 * is no other way to walk a loop that encloses nothing.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { containsPoint, type WallFaces } from "./wallFaces";
import type { WallGraph } from "./wallGraph";

export interface Dissolution {
  /** Which of `faces.faces` was clicked. */
  readonly face: number;
  /** The walls that go, as indices into `graph.edges`, ascending. */
  readonly edges: readonly number[];
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Outer-cycle bounds per face, kept per traversal.
 *
 * The hover asks on every pointer move, and the faces only change on an edit, so the boxes are worked
 * out once for each traversal rather than once per move.
 */
const boxesFor = new WeakMap<WallFaces, readonly Box[]>();

function outerBoxes(faces: WallFaces): readonly Box[] {
  const cached = boxesFor.get(faces);
  if (cached) return cached;
  const boxes = faces.faces.map((face) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of face.cycles[0]?.points ?? []) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
  });
  boxesFor.set(faces, boxes);
  return boxes;
}

/**
 * The region a point is in, as an index into `faces.faces`, or `null` outside every region.
 *
 * Inside the outer cycle and outside every hole. The outer cycle is tested as walked — slits and
 * joined inner rooms included — which is what makes a click inside a lollipop's head or a room
 * touching the outer wall choose that room: see `containsPoint`.
 *
 * The regions partition the plane, so one answers, and the first is taken. A click exactly on a wall
 * is still one region's: the crossing test counts a wall to one side only, and both regions see the
 * same wall. The exception is a slanted wall the two walk in opposite directions, where rounding can
 * put the point in both or neither — so a click there takes either region or does nothing, which is
 * the whole of the cost. **Not "the smaller wins"** as a tie-break: a region's area is net of its
 * holes, so a room around a large pillar can measure smaller than the pillar.
 */
export function regionAt(faces: WallFaces, point: Vector2): number | null {
  const boxes = outerBoxes(faces);
  for (let index = 0; index < faces.faces.length; index++) {
    const box = boxes[index]!;
    if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) continue;
    const [outer, ...holes] = faces.faces[index]!.cycles;
    if (!outer || !containsPoint(outer.points, point)) continue;
    if (holes.some((hole) => containsPoint(hole.points, point))) continue;
    return index;
  }
  return null;
}

/**
 * The walls that go when a region dissolves, as ascending indices into `graph.edges`.
 *
 * `faces` must be the traversal of `graph` — half-edge ids mean nothing against any other.
 */
export function dissolvedEdges(graph: WallGraph, faces: WallFaces, face: number): number[] {
  const region = faces.faces[face];
  if (!region) return [];

  const edgeOf = (half: number) => graph.edges[faces.sourceEdges[half >> 1]!]!;
  const origin = (half: number): number => ((half & 1) === 0 ? edgeOf(half).a : edgeOf(half).b);
  const target = (half: number): number => origin(half ^ 1);

  const going = new Set<number>();
  for (const cycle of region.cycles) {
    for (const loop of simpleLoops(cycle.halfEdges, origin, target)) {
      let doubleArea = 0;
      for (const half of loop) {
        const from = graph.nodes[origin(half)]!;
        const to = graph.nodes[target(half)]!;
        doubleArea += from.x * to.y - to.x * from.y;
      }
      if (doubleArea < 0) continue;
      for (const half of loop) going.add(faces.sourceEdges[half >> 1]!);
    }
  }
  return [...going].sort((left, right) => left - right);
}

/** The region at a point and the walls dissolving it would remove, or `null` outside every region. */
export function dissolutionAt(graph: WallGraph, faces: WallFaces, point: Vector2): Dissolution | null {
  const face = regionAt(faces, point);
  if (face === null) return null;
  return { face, edges: dissolvedEdges(graph, faces, face) };
}

/**
 * Split a closed walk into loops that visit no vertex twice.
 *
 * A stack of half-edges and the vertex each one arrives at. Arriving at a vertex already on the stack
 * closes a loop: everything pushed since that vertex comes off as one. Innermost loops close first,
 * so what comes off never contains a repeat, and what is left at the end closes on the walk's own
 * start. Every half-edge lands in exactly one loop.
 *
 * **A slit comes off as a loop of two** — out along a wall and straight back — and so does each wall
 * of a branching stub, from the tips inward. A bridge disconnects what is beyond it, so whatever is
 * walked between its two sides stays beyond it and closes before the walk returns across.
 */
export function simpleLoops(
  walk: readonly number[],
  origin: (half: number) => number,
  target: (half: number) => number,
): number[][] {
  if (walk.length === 0) return [];
  const loops: number[][] = [];
  const stack: number[] = [];
  // The vertex reached after `index` half-edges; index 0 is where the walk starts.
  const vertexAt: number[] = [origin(walk[0]!)];
  const depthOf = new Map<number, number>([[vertexAt[0]!, 0]]);

  for (const half of walk) {
    stack.push(half);
    const vertex = target(half);
    const depth = depthOf.get(vertex);
    if (depth === undefined) {
      depthOf.set(vertex, stack.length);
      vertexAt.push(vertex);
      continue;
    }
    for (let at = depth + 1; at < vertexAt.length; at++) depthOf.delete(vertexAt[at]!);
    vertexAt.length = depth + 1;
    loops.push(stack.splice(depth));
  }
  return loops;
}
