/**
 * Keeping the edited graph planar: finding where walls cross, and splitting them when they do.
 *
 * **This is the invariant stage two has instead of the area check.** Stage one's check is a lattice
 * identity comparing two independent computations of the same number, and it does not survive the
 * derive — fitted geometry has no steps and no interior pixel counts. Planarity is the right
 * replacement, because the whole of face derivation is a half-edge traversal, and a traversal over a
 * non-planar embedding is not wrong so much as **meaningless**: two walls crossing at a point that is
 * a node of neither means the faces either side of the crossing are not faces.
 *
 * ## Segments, so a junction cannot hide
 *
 * Every edge is two nodes and every vertex is a node, so a crossing either lands on an existing node
 * or splits a segment. There is no third case. The polyline form had one — a wall meeting another at
 * one of its *interior* vertices produced a junction the traversal walked straight through — and that
 * whole class is gone rather than guarded against.
 *
 * ## Identity is by id; geometry has one tolerance, and it is not an identity epsilon
 *
 * Nothing here decides whether two points are "the same" by comparing coordinates. Two walls meet
 * because they **share a node id**, and whether a click near a vertex should attach to it is the
 * editing tool's decision, made with a screen-space radius the GM can see.
 *
 * So the standing rule that vertex matching is exact and never uses an epsilon is untouched: it is
 * about identity, and identity is by id. What floating-point coordinates do reintroduce is a
 * *degeneracy* threshold in the crossing predicate — deciding when a crossing is close enough to a
 * segment's end to count as being at its end. Every floating-point geometry predicate has one, and
 * the cases it decides are the ones where the answer is genuinely ambiguous: the two walls are within
 * a rounding error of touching, and either answer is defensible.
 *
 * ## Three kinds of meeting, and only two of them are faults
 *
 * - **At a shared node** — fine, that is what a junction is.
 * - **A proper crossing**, interior to both. Both segments are split at the point.
 * - **A T**, where one segment's end lands inside the other. Only the crossed one is split.
 *
 * **Collinear overlap is reported and not fixed.** Two walls lying along each other do not meet at a
 * point, so no amount of splitting separates them. It is also a state a GM can legitimately be
 * passing through — doubling a line in order to drag the copy away is the case the record names — so
 * it warns rather than refuses, which is the rule degenerate faces get too.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, type WallGraph } from "./wallGraph";

/**
 * How close to a segment's end a crossing has to be before it counts as being *at* the end.
 *
 * Measured as a fraction along the segment, and coordinates are themselves fractions of the map, so
 * this is loose in the only direction that matters. On a 10,000-pixel map a pixel is 1e-4 of the
 * width; this is a millionth of a *segment*, so it can only ever absorb a crossing already
 * indistinguishable from the endpoint.
 *
 * Its job is to stop a crossing a rounding error away from a vertex splitting a segment into a piece
 * of length 1e-16, which would put two nodes at visually the same place and leave the graph
 * technically planar and practically nonsense.
 */
const END_TOLERANCE = 1e-6;

/** Below this, two directions are parallel as far as a crossing is concerned. */
const PARALLEL_TOLERANCE = 1e-12;

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

export interface Meeting {
  readonly kind: "crossing" | "touch" | "overlap";
  readonly point: Vector2;
  /** Interior to the first segment — so the first segment needs splitting here. */
  readonly splitsFirst: boolean;
  /** Interior to the second segment. */
  readonly splitsSecond: boolean;
}

/**
 * How two segments meet, or `null` if they do not.
 *
 * Ends that merely coincide are **not** a meeting: two walls sharing a junction is the ordinary case,
 * and splitting there would be splitting at a node that already exists.
 */
export function segmentMeeting(
  p1: Vector2,
  p2: Vector2,
  q1: Vector2,
  q2: Vector2,
): Meeting | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const denominator = cross(rx, ry, sx, sy);
  const qpx = q1.x - p1.x;
  const qpy = q1.y - p1.y;

  if (Math.abs(denominator) <= PARALLEL_TOLERANCE) {
    // Parallel. Collinear *and* sharing more than a point is an overlap; anything else misses.
    const lengthSquared = rx * rx + ry * ry;
    if (lengthSquared <= 0) return null;
    // How far q1 sits off the first segment's line, scaled by that line's length so the comparison
    // is against a fraction of the segment rather than an absolute distance.
    if (Math.abs(cross(qpx, qpy, rx, ry)) > END_TOLERANCE * lengthSquared) return null;
    const along = (point: Vector2): number =>
      ((point.x - p1.x) * rx + (point.y - p1.y) * ry) / lengthSquared;
    const a = along(q1);
    const b = along(q2);
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    // Touching end to end is not an overlap: they share one point, which is a legitimate join.
    if (high <= END_TOLERANCE || low >= 1 - END_TOLERANCE) return null;
    return { kind: "overlap", point: q1, splitsFirst: false, splitsSecond: false };
  }

  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, rx, ry) / denominator;
  if (t < -END_TOLERANCE || t > 1 + END_TOLERANCE) return null;
  if (u < -END_TOLERANCE || u > 1 + END_TOLERANCE) return null;

  const splitsFirst = t > END_TOLERANCE && t < 1 - END_TOLERANCE;
  const splitsSecond = u > END_TOLERANCE && u < 1 - END_TOLERANCE;
  // Both at an end means the two segments simply share a vertex.
  if (!splitsFirst && !splitsSecond) return null;

  return {
    kind: splitsFirst && splitsSecond ? "crossing" : "touch",
    point: documentPoint(p1.x + t * rx, p1.y + t * ry),
    splitsFirst,
    splitsSecond,
  };
}

/** A place two walls meet that is not a node of both of them. */
export interface Crossing {
  readonly edgeA: number;
  readonly edgeB: number;
  readonly point: Vector2;
  readonly kind: "crossing" | "touch" | "overlap";
}

/**
 * Every crossing in a graph — the planarity check.
 *
 * **Quadratic in the number of segments**, which is fine for what it is for: a graph the GM has just
 * edited, checked once, not per frame. On a whole map's tens of thousands of segments it would be far
 * too slow to run casually; if that is ever wanted, sweep by bounding box first. Nothing here depends
 * on the order it reports in.
 */
export function findCrossings(graph: WallGraph): Crossing[] {
  const found: Crossing[] = [];
  for (let a = 0; a < graph.edges.length; a++) {
    const ea = graph.edges[a]!;
    const a1 = graph.nodes[ea.a]!;
    const a2 = graph.nodes[ea.b]!;
    for (let b = a + 1; b < graph.edges.length; b++) {
      const eb = graph.edges[b]!;
      const meeting = segmentMeeting(a1, a2, graph.nodes[eb.a]!, graph.nodes[eb.b]!);
      if (meeting) found.push({ edgeA: a, edgeB: b, point: meeting.point, kind: meeting.kind });
    }
  }
  return found;
}

