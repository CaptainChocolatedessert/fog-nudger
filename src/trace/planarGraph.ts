/**
 * Keeping the edited graph planar: finding where walls cross, and splitting them when they do.
 *
 * **This is the invariant stage two has instead of the area check.** Stage one's check is a lattice
 * identity comparing two independent computations of the same number, and it does not survive the
 * freeze — fitted geometry has no steps and no interior pixel counts. Planarity is the right
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

import { documentPoint, type FrozenEdge, type FrozenGraph } from "./frozenGraph";

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
export function findCrossings(graph: FrozenGraph): Crossing[] {
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

export interface InsertResult {
  readonly graph: FrozenGraph;
  /** How many existing segments were cut. */
  readonly splits: number;
  /** Collinear overlaps found. Reported, never fixed — splitting cannot separate them. */
  readonly overlaps: number;
}

/**
 * Add a wall as a run of points, splitting whatever it crosses so the graph stays planar.
 *
 * The points are in map fractions. **Whether they attach to existing nodes is the caller's
 * decision** — the editing tool snaps to a vertex within a radius the GM can see, and passes the
 * snapped position. Nothing here second-guesses that by proximity; an exact coordinate match reuses
 * a node, and anything else is a new one.
 *
 * Rebuilt rather than mutated: the caller holds the old graph until this returns, which is what lets
 * a failed edit leave the GM exactly where they were. **Node ids survive for everything untouched**,
 * which is the property the whole document exists to hold and the one an edit is most likely to
 * break by accident.
 */
export function insertEdge(graph: FrozenGraph, points: readonly Vector2[]): InsertResult {
  const fresh: Vector2[] = [];
  for (const point of points) {
    const at = documentPoint(point.x, point.y);
    const last = fresh[fresh.length - 1];
    // Consecutive duplicates make zero-length segments, which have no direction to cross with.
    if (!last || last.x !== at.x || last.y !== at.y) fresh.push(at);
  }
  if (fresh.length < 2) return { graph, splits: 0, overlaps: 0 };

  const nodes: Vector2[] = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
  const idFor = (point: Vector2): number => {
    const found = nodes.findIndex((n) => n.x === point.x && n.y === point.y);
    if (found >= 0) return found;
    nodes.push(point);
    return nodes.length - 1;
  };

  const newIds = fresh.map(idFor);
  const pending: { a: number; b: number; isNew: boolean }[] = graph.edges.map((edge) => ({
    a: edge.a,
    b: edge.b,
    isNew: false,
  }));
  for (let i = 0; i + 1 < newIds.length; i++) {
    pending.push({ a: newIds[i]!, b: newIds[i + 1]!, isNew: true });
  }

  /** Where each pending segment has to be cut: how far along, and the node to cut at. */
  const cuts = new Map<number, { at: number; id: number }[]>();
  let overlaps = 0;

  const addCut = (index: number, point: Vector2): void => {
    const segment = pending[index]!;
    const id = idFor(point);
    /*
      A cut at one of the segment's own ends is not a cut; the node is already there.

      `END_TOLERANCE` already rejects a crossing near an end, so reaching this needs the crossing to
      be comfortably interior and *still* round onto an end — which takes a segment only a float32
      unit or two long, well under a thousandth of a pixel. **Defence in depth, and not isolated by a
      test**: several attempts to construct the case landed either side of it. Said plainly rather
      than left looking like something the suite covers.
    */
    if (id === segment.a || id === segment.b) return;
    const from = nodes[segment.a]!;
    const to = nodes[segment.b]!;
    const span = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
    const at =
      span <= 0
        ? 0
        : ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / span;
    const list = cuts.get(index) ?? [];
    if (!list.some((cut) => cut.id === id)) list.push({ at, id });
    cuts.set(index, list);
  };

  const total = pending.length;
  for (let i = 0; i < total; i++) {
    if (!pending[i]!.isNew) continue;
    for (let j = 0; j < total; j++) {
      if (pending[j]!.isNew) continue;
      const meeting = segmentMeeting(
        nodes[pending[j]!.a]!,
        nodes[pending[j]!.b]!,
        nodes[pending[i]!.a]!,
        nodes[pending[i]!.b]!,
      );
      if (!meeting) continue;
      if (meeting.kind === "overlap") {
        overlaps += 1;
        continue;
      }
      if (meeting.splitsFirst) addCut(j, meeting.point);
      if (meeting.splitsSecond) addCut(i, meeting.point);
    }
  }

  const edges: FrozenEdge[] = [];
  let splits = 0;
  for (let i = 0; i < total; i++) {
    const segment = pending[i]!;
    const list = cuts.get(i);
    if (!list || list.length === 0) {
      // Untouched: an existing segment keeps its identity exactly.
      edges.push(segment.isNew ? { a: segment.a, b: segment.b } : graph.edges[i]!);
      continue;
    }
    // Ordered along the segment, or the rebuilt wall threads through its own cuts backwards.
    list.sort((x, y) => x.at - y.at);
    if (!segment.isNew) splits += list.length;
    let previous = segment.a;
    for (const cut of list) {
      edges.push({ a: previous, b: cut.id });
      previous = cut.id;
    }
    edges.push({ a: previous, b: segment.b });
  }

  return { graph: { nodes, edges }, splits, overlaps };
}
