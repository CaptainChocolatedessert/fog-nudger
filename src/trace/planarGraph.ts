/**
 * Keeping the edited graph planar: finding where edges cross, and splitting them when they do.
 *
 * **This is the invariant stage two was missing.** Stage one has the area check — a lattice identity
 * comparing two independent computations of the same number — and it does not survive the freeze,
 * because fitted geometry has no steps and no interior pixel counts. Planarity is the property that
 * replaces it, and it is the right one: the whole of face derivation is a half-edge traversal, and a
 * traversal over a non-planar embedding is not wrong so much as **meaningless**. Two walls crossing
 * at a point that is a node of neither means the faces either side of the crossing are not faces.
 *
 * ## Every coordinate is an integer, and that is what makes this exact
 *
 * The derived graph is a walk over lattice points, and `simplifyPolyline` selects a *subset* of its
 * input rather than computing new positions — so a fitted vertex is a pixel. Edits keep it that way
 * (see `snap` below). So the crossing **test** is integer cross products with no tolerance anywhere,
 * which matters more than it sounds: this project's standing rule is that vertex matching is exact
 * and never uses an epsilon, and an epsilon here would be one that decides whether two walls meet.
 *
 * The crossing **point** is a different matter: two integer segments generally cross at a rational
 * point. That is rounded to the nearest pixel, which moves the split by up to about seven tenths of
 * a pixel. Accepted deliberately — it is far below the ink width, it keeps every later comparison
 * exact, and the alternative is floating-point coordinates and epsilons for the rest of the
 * project's life.
 *
 * ## Three kinds of meeting, and only two of them are faults
 *
 * - **At a shared node** — fine, that is what a junction is.
 * - **A proper crossing**, interior to both. Both edges are split at the point.
 * - **A T**, where one edge's endpoint lands inside the other's interior. Only the crossed edge is
 *   split; the toucher already has a node there.
 *
 * **Collinear overlap is reported and not fixed.** Two edges lying along each other do not meet at a
 * point, so no amount of splitting separates them. It is also a state a GM can legitimately be
 * passing through — doubling a line in order to drag the copy away is the case the record names —
 * so it warns rather than refuses, which is the same rule degenerate faces get.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { FrozenEdge, FrozenGraph } from "./frozenGraph";

/** The nearest lattice point. See the module doc for why the rounding is accepted. */
function snap(x: number, y: number): Vector2 {
  return { x: Math.round(x), y: Math.round(y) };
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

const same = (a: Vector2, b: Vector2): boolean => a.x === b.x && a.y === b.y;

/**
 * Where two segments meet, and how.
 *
 * `t` and `u` are the positions along the first and second segment as exact fractions, kept as a
 * numerator and a shared denominator so nothing is compared after a division.
 */
interface Meeting {
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
 * Endpoints that merely coincide are **not** a meeting: two walls sharing a junction is the ordinary
 * case and splitting there would be splitting at a node that already exists.
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

  if (denominator === 0) {
    // Parallel. Collinear *and* sharing more than a point is an overlap; anything else misses.
    if (cross(qpx, qpy, rx, ry) !== 0) return null;
    const along = (point: Vector2): number =>
      rx !== 0 ? (point.x - p1.x) / rx : ry !== 0 ? (point.y - p1.y) / ry : 0;
    if (rx === 0 && ry === 0) return null;
    const a = along(q1);
    const b = along(q2);
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    // Touching end to end is not an overlap: they share one point, which is a legitimate join.
    if (high <= 0 || low >= 1) return null;
    return { kind: "overlap", point: q1, splitsFirst: false, splitsSecond: false };
  }

  const tNumerator = cross(qpx, qpy, sx, sy);
  const uNumerator = cross(qpx, qpy, rx, ry);
  // Normalised so both fractions are over a positive denominator and can be compared as integers.
  const sign = denominator < 0 ? -1 : 1;
  const d = denominator * sign;
  const tn = tNumerator * sign;
  const un = uNumerator * sign;

  if (tn < 0 || tn > d || un < 0 || un > d) return null;

  const point = snap(p1.x + (tn / d) * rx, p1.y + (tn / d) * ry);
  const splitsFirst = tn > 0 && tn < d;
  const splitsSecond = un > 0 && un < d;
  // Both at an endpoint means the two segments simply share a vertex.
  if (!splitsFirst && !splitsSecond) return null;
  return {
    kind: splitsFirst && splitsSecond ? "crossing" : "touch",
    point,
    splitsFirst,
    splitsSecond,
  };
}

/** A place two edges meet that is not a node of both of them. */
export interface Crossing {
  readonly edgeA: number;
  readonly edgeB: number;
  readonly point: Vector2;
  readonly kind: "crossing" | "touch" | "overlap";
}

/**
 * Every crossing in a graph — the planarity check.
 *
 * **Quadratic in the number of segments**, which is fine for what it is used for: a graph the GM has
 * just edited, checked once, not per frame. On a whole map's ~8,700 vertices this is tens of
 * millions of segment pairs and would be too slow to run casually. If it is ever wanted on a full
 * graph, sweep by bounding box first; nothing here depends on the order it reports in.
 */
export function findCrossings(graph: FrozenGraph): Crossing[] {
  const found: Crossing[] = [];
  const points = (edge: FrozenEdge): Vector2[] => edge.nodes.map((id) => graph.nodes[id]!);

  for (let a = 0; a < graph.edges.length; a++) {
    const pa = points(graph.edges[a]!);
    for (let b = a + 1; b < graph.edges.length; b++) {
      const pb = points(graph.edges[b]!);
      for (let i = 0; i + 1 < pa.length; i++) {
        for (let j = 0; j + 1 < pb.length; j++) {
          const meeting = segmentMeeting(pa[i]!, pa[i + 1]!, pb[j]!, pb[j + 1]!);
          if (meeting) {
            found.push({ edgeA: a, edgeB: b, point: meeting.point, kind: meeting.kind });
          }
        }
      }
    }
  }
  return found;
}

export interface InsertResult {
  readonly graph: FrozenGraph;
  /** How many existing edges were cut, counting an edge cut twice as two. */
  readonly splits: number;
  /** Collinear overlaps found. Reported, never fixed — splitting cannot separate them. */
  readonly overlaps: number;
}

/** A cut on one edge: which of its segments, how far along, and the point. */
interface Cut {
  readonly segment: number;
  /** Squared distance from the segment's start, for ordering. Integer, so the sort is exact. */
  readonly distance: number;
  readonly point: Vector2;
}

/** Insert the cuts into a point list and break it where they land. */
function applyCuts(points: readonly Vector2[], cuts: readonly Cut[]): Vector2[][] {
  const ordered = [...cuts].sort((a, b) => a.segment - b.segment || a.distance - b.distance);
  const expanded: Vector2[] = [points[0]!];
  const breaks = new Set<number>();

  for (let i = 0; i + 1 < points.length; i++) {
    for (const cut of ordered) {
      if (cut.segment !== i) continue;
      const last = expanded[expanded.length - 1]!;
      // A cut landing on a vertex that is already there breaks at it rather than duplicating it.
      if (!same(last, cut.point)) expanded.push(cut.point);
      breaks.add(expanded.length - 1);
    }
    const next = points[i + 1]!;
    if (!same(expanded[expanded.length - 1]!, next)) expanded.push(next);
  }

  const pieces: Vector2[][] = [];
  let start = 0;
  for (let i = 1; i < expanded.length; i++) {
    if (!breaks.has(i)) continue;
    if (i > start) pieces.push(expanded.slice(start, i + 1));
    start = i;
  }
  if (start < expanded.length - 1) pieces.push(expanded.slice(start));
  return pieces.length > 0 ? pieces : [expanded];
}

/**
 * Break every edge at an interior point that anything else also holds.
 *
 * **The intersection test cannot see this case**, which is why it is a separate pass rather than
 * part of the sweep. A new wall meeting an existing one head-on at one of its *interior vertices*
 * crosses no segment's interior at all — both segments meet it exactly at an endpoint — so nothing
 * is reported, and yet that point is now a junction of four while remaining an interior point of the
 * wall, which the traversal cannot turn at. It comes back as degree 2, and the face walk quietly
 * goes straight through a junction. Found by mutation testing, not by a fixture.
 *
 * The rule is one line and covers every variation of it: **an interior point belongs to exactly one
 * edge and nothing else**, so any interior id occurring more than once in the whole graph is a place
 * two things meet, and the edge holding it has to be cut there. A closed loop is unaffected — its
 * repeated id is an endpoint twice, not an interior point.
 */
export function splitAtSharedNodes(graph: FrozenGraph): FrozenGraph {
  const occurrences = new Map<number, number>();
  for (const edge of graph.edges) {
    for (const id of edge.nodes) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  }

  const edges: FrozenEdge[] = [];
  let changed = false;
  for (const edge of graph.edges) {
    const cuts: number[] = [];
    for (let i = 1; i < edge.nodes.length - 1; i++) {
      if ((occurrences.get(edge.nodes[i]!) ?? 0) > 1) cuts.push(i);
    }
    if (cuts.length === 0) {
      edges.push(edge);
      continue;
    }
    changed = true;
    let start = 0;
    for (const cut of cuts) {
      edges.push({ nodes: edge.nodes.slice(start, cut + 1) });
      start = cut;
    }
    edges.push({ nodes: edge.nodes.slice(start) });
  }

  return changed ? { ...graph, edges } : graph;
}

/**
 * Add a wall, splitting whatever it crosses so the graph stays planar.
 *
 * Rebuilt rather than mutated: the caller holds the old graph until this returns, which is what lets
 * a failed edit leave the GM exactly where they were.
 *
 * **Node identity survives for everything untouched.** An edge nothing crossed keeps its ids, and a
 * point shared by two rooms is still one id afterwards — which is the property the whole document
 * exists to hold, and the one an edit is most likely to break by accident.
 */
export function insertEdge(graph: FrozenGraph, points: readonly Vector2[]): InsertResult {
  const lattice = points.map((p) => snap(p.x, p.y));
  // Consecutive duplicates would make zero-length segments, which have no direction to cross with.
  const fresh: Vector2[] = [];
  for (const point of lattice) {
    if (fresh.length === 0 || !same(fresh[fresh.length - 1]!, point)) fresh.push(point);
  }
  if (fresh.length < 2) return { graph, splits: 0, overlaps: 0 };

  const existing = graph.edges.map((edge) => edge.nodes.map((id) => graph.nodes[id]!));
  const cutsByEdge = new Map<number, Cut[]>();
  const cutsOnNew: Cut[] = [];
  let overlaps = 0;

  const distance = (from: Vector2, to: Vector2): number =>
    (to.x - from.x) ** 2 + (to.y - from.y) ** 2;

  for (let e = 0; e < existing.length; e++) {
    const chain = existing[e]!;
    for (let i = 0; i + 1 < chain.length; i++) {
      for (let j = 0; j + 1 < fresh.length; j++) {
        const meeting = segmentMeeting(chain[i]!, chain[i + 1]!, fresh[j]!, fresh[j + 1]!);
        if (!meeting) continue;
        if (meeting.kind === "overlap") {
          overlaps += 1;
          continue;
        }
        if (meeting.splitsFirst) {
          const list = cutsByEdge.get(e) ?? [];
          list.push({ segment: i, distance: distance(chain[i]!, meeting.point), point: meeting.point });
          cutsByEdge.set(e, list);
        }
        if (meeting.splitsSecond) {
          cutsOnNew.push({
            segment: j,
            distance: distance(fresh[j]!, meeting.point),
            point: meeting.point,
          });
        }
      }
    }
  }

  // One flat node table for the result, seeded with the old one so untouched ids are unchanged.
  const nodes: Vector2[] = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
  const idByPoint = new Map<string, number>();
  nodes.forEach((n, id) => {
    const k = `${n.x},${n.y}`;
    // First wins: a coordinate held twice keeps the lower id, so nothing already shared is re-split.
    if (!idByPoint.has(k)) idByPoint.set(k, id);
  });
  const idFor = (point: Vector2): number => {
    const k = `${point.x},${point.y}`;
    const found = idByPoint.get(k);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push({ x: point.x, y: point.y });
    idByPoint.set(k, id);
    return id;
  };

  const edges: FrozenEdge[] = [];
  let splits = 0;

  for (let e = 0; e < existing.length; e++) {
    const cuts = cutsByEdge.get(e);
    if (!cuts || cuts.length === 0) {
      // Untouched: kept exactly, ids and all.
      edges.push(graph.edges[e]!);
      continue;
    }
    const pieces = applyCuts(existing[e]!, cuts);
    splits += Math.max(0, pieces.length - 1);
    for (const piece of pieces) edges.push({ nodes: piece.map(idFor) });
  }

  for (const piece of applyCuts(fresh, cutsOnNew)) {
    edges.push({ nodes: piece.map(idFor) });
  }

  // The second pass, for meetings at an existing interior vertex that no segment interior saw.
  const joined = splitAtSharedNodes({ width: graph.width, height: graph.height, nodes, edges });
  return {
    graph: joined,
    splits: splits + Math.max(0, joined.edges.length - edges.length),
    overlaps,
  };
}
