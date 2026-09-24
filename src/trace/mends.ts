/**
 * Mends: walls proposed across the gaps in the wall graph, for the GM to accept or leave.
 *
 * ## What a gap is here
 *
 * A **gap in the graph** is two pieces of wall close together in space and far apart *along the
 * walls* — the same definition the ink tool uses, measured on the graph instead of on pixels. The
 * flaw it is for (user, 2026-09-16) is a wall line that thinned out in the ink and left a break in
 * the derived walls. **Not doorways**: some drawing styles will produce them, and this is not a door
 * tool.
 *
 * A **mend** is a proposed wall closing one. Once accepted it is an ordinary drawn wall. It is not a
 * *bridge* in this project's vocabulary — a mend usually closes a loop and splits a region in two,
 * which is the opposite of what a bridge is.
 *
 * ## One side is always a free end
 *
 * A **free end** is a node with one wall on it, and a wall that stops is what a break looks like in a
 * graph. Two nodes with walls on both sides are two whole walls running close together — a doubled
 * wall, a corridor, a pillar beside a wall — and joining them would be wrong every time.
 *
 * The other side may be any of three things, **in order of preference** (user, 2026-09-16):
 *
 * 1. **another free end** within reach, even when a wall is nearer;
 * 2. failing that, an **existing vertex** within reach;
 * 3. only then a **point on a segment**, which splits it.
 *
 * ## The direction onto a segment splits the difference
 *
 * Between the free end's own heading and the perpendicular to the segment, pointing at it — and the
 * mend lands where that line meets the segment. To be tried rather than argued (user): the heading
 * alone skids along a wall met at a shallow angle, and the perpendicular alone ignores which way the
 * broken wall was going.
 *
 * ## Alignment ranks and never rejects
 *
 * A wall that stops most likely carries on the way it was going, so a target straight ahead ranks
 * above a nearer one off to the side. But a target behind the end is still a candidate (user,
 * 2026-09-16) — it only ranks lower.
 *
 * ## One mend per free end, and none crossing
 *
 * Every end ranks its own candidates, and they are then taken best first across the whole graph,
 * each end used once. Two ends that choose each other become one mend rather than two; an end whose
 * choice was taken falls back to its next; and a mend that would cross a wall or a mend already
 * taken is skipped. That is what keeps one gap from drawing a fan of proposals.
 *
 * ## Units
 *
 * Graph units throughout — the map's longer side is 1 — so a reach means the same length in every
 * direction.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { insertEdge, splitEdgesAt, type EditResult } from "./planarOps";
import { segmentMeeting } from "./planarGraph";
import { documentPoint, nodeDegrees, type WallGraph } from "./wallGraph";

export interface MendOptions {
  /** The largest gap to look for, in graph units. Zero proposes nothing. */
  readonly reach: number;
  /**
   * How far apart along the walls the two sides must be, in graph units.
   *
   * Two sides the walls already join within this are one piece of wall with a kink in it, not a
   * break. Zero switches the test off, and every gap within reach is proposed.
   */
  readonly travel: number;
}

/** What the far side of a mend is. */
export type MendTarget =
  | { readonly kind: "end"; readonly node: number }
  | { readonly kind: "vertex"; readonly node: number }
  /** A point partway along a segment, which accepting the mend splits. */
  | { readonly kind: "segment"; readonly edge: number; readonly at: Vector2 };

export interface Mend {
  /** The free end the mend leaves from. */
  readonly from: number;
  readonly to: MendTarget;
  /** The free end's position. */
  readonly start: Vector2;
  /** Where the mend lands. */
  readonly end: Vector2;
  /** Straight-line length, in graph units. */
  readonly length: number;
}

/** A candidate before pairing, with what it is ranked by. */
interface Candidate {
  readonly mend: Mend;
  /** 0 a free end, 1 a vertex, 2 a segment — the order of preference. */
  readonly tier: number;
  /** Length stretched by how far off the end's heading the target lies. Lower is better. */
  readonly score: number;
}

/**
 * How far from a segment's end a landing has to be to count as partway along it.
 *
 * A fraction of the segment, matching the crossing predicate's own tolerance: a point closer to an
 * end than this is that end, and the vertex tier is where it belongs.
 */
const END_TOLERANCE = 1e-6;

/**
 * The walls within reach of every free end, and the mends that close the gaps between them.
 *
 * Returned in the order they were taken — best first — which is also the order accepting all of
 * them applies.
 */
export function findMends(graph: WallGraph, options: MendOptions): Mend[] {
  const { reach, travel } = options;
  if (!(reach > 0)) return [];

  const degrees = nodeDegrees(graph);
  const neighbours = adjacency(graph);

  const candidates: Candidate[][] = [];
  for (let id = 0; id < graph.nodes.length; id++) {
    if (degrees[id] !== 1) continue;
    const listed = candidatesFor(graph, id, degrees, neighbours, reach, travel);
    if (listed.length > 0) candidates.push(listed);
  }

  return pairOff(graph, candidates);
}

/** Every edge meeting each node, by index. */
function adjacency(graph: WallGraph): number[][] {
  const lists: number[][] = graph.nodes.map(() => []);
  graph.edges.forEach((edge, index) => {
    lists[edge.a]?.push(index);
    lists[edge.b]?.push(index);
  });
  return lists;
}

const distance = (a: Vector2, b: Vector2): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * One free end's candidates, best first: by tier, then by score.
 *
 * Tier is compared before score on purpose. Preferring a free end is a rule about *what kind* of
 * thing a break is joined to, not a bonus that a close enough segment can outbid.
 */
function candidatesFor(
  graph: WallGraph,
  id: number,
  degrees: readonly number[],
  neighbours: readonly (readonly number[])[],
  reach: number,
  travel: number,
): Candidate[] {
  const at = graph.nodes[id]!;
  const ownEdge = neighbours[id]![0]!;
  const edge = graph.edges[ownEdge]!;
  const other = graph.nodes[edge.a === id ? edge.b : edge.a]!;
  const along = distance(other, at);
  // A free end whose only wall has no length has no heading, and nothing to say which way it went.
  if (!(along > 0)) return [];
  const heading = { x: (at.x - other.x) / along, y: (at.y - other.y) / along };

  const walked = walkWalls(graph, neighbours, id, travel);
  const sameWall = (node: number, extra = 0): boolean => {
    const known = walked.get(node);
    return known !== undefined && known + extra <= travel;
  };

  const score = (target: Vector2, length: number): number => {
    const cos = length > 0 ? ((target.x - at.x) * heading.x + (target.y - at.y) * heading.y) / length : 1;
    // Straight ahead costs nothing extra; square to the heading doubles; straight behind trebles.
    return length * (2 - cos);
  };

  const found: Candidate[] = [];
  const neighbour = edge.a === id ? edge.b : edge.a;

  for (let node = 0; node < graph.nodes.length; node++) {
    if (node === id || node === neighbour) continue;
    const degree = degrees[node] ?? 0;
    if (degree === 0) continue;
    const target = graph.nodes[node]!;
    const length = distance(at, target);
    if (!(length > 0) || length > reach) continue;
    if (travel > 0 && sameWall(node)) continue;
    const kind = degree === 1 ? "end" : "vertex";
    found.push({
      mend: { from: id, to: { kind, node }, start: at, end: target, length },
      tier: degree === 1 ? 0 : 1,
      score: score(target, length),
    });
  }

  graph.edges.forEach((wall, index) => {
    if (index === ownEdge) return;
    const p = graph.nodes[wall.a]!;
    const q = graph.nodes[wall.b]!;
    const landing = landOnSegment(at, heading, p, q);
    if (!landing) return;
    const length = distance(at, landing.point);
    if (!(length > 0) || length > reach) return;
    if (
      travel > 0 &&
      (sameWall(wall.a, distance(p, landing.point)) || sameWall(wall.b, distance(q, landing.point)))
    ) {
      return;
    }
    found.push({
      mend: {
        from: id,
        to: { kind: "segment", edge: index, at: landing.point },
        start: at,
        end: landing.point,
        length,
      },
      tier: 2,
      score: score(landing.point, length),
    });
  });

  return found.sort((a, b) => a.tier - b.tier || a.score - b.score);
}

/**
 * Where a mend from `at` lands on the segment `p`–`q`, or `null` if it does not land partway along.
 *
 * The direction is halfway between the end's heading and the segment's perpendicular, taking the
 * perpendicular that points from the end towards the segment's line. When those two point exactly
 * opposite ways the halfway direction has no length, and the perpendicular alone is used: the end is
 * facing directly away, and square on is the only direction left that says anything.
 */
function landOnSegment(
  at: Vector2,
  heading: Vector2,
  p: Vector2,
  q: Vector2,
): { readonly point: Vector2; readonly t: number } | null {
  const sx = q.x - p.x;
  const sy = q.y - p.y;
  const span = Math.hypot(sx, sy);
  if (!(span > 0)) return null;

  let nx = -sy / span;
  let ny = sx / span;
  const toLine = (p.x - at.x) * nx + (p.y - at.y) * ny;
  // On the line already: there is no side to be on and no gap to close.
  if (toLine === 0) return null;
  if (toLine < 0) {
    nx = -nx;
    ny = -ny;
  }

  let dx = heading.x + nx;
  let dy = heading.y + ny;
  const half = Math.hypot(dx, dy);
  if (half > 1e-9) {
    dx /= half;
    dy /= half;
  } else {
    dx = nx;
    dy = ny;
  }

  // Solve at + s·d = p + t·(q − p).
  const denominator = dx * sy - dy * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const px = p.x - at.x;
  const py = p.y - at.y;
  const s = (px * sy - py * sx) / denominator;
  const t = (px * dy - py * dx) / denominator;
  if (!(s > 0)) return null;
  if (t <= END_TOLERANCE || t >= 1 - END_TOLERANCE) return null;

  return { point: documentPoint(p.x + t * sx, p.y + t * sy), t };
}

/**
 * How far along the walls every node within `limit` is from `start`.
 *
 * A shortest-path search that stops at the limit, so it costs what the neighbourhood costs and not
 * what the map does. With no limit there is nothing to measure and nothing is walked.
 */
function walkWalls(
  graph: WallGraph,
  neighbours: readonly (readonly number[])[],
  start: number,
  limit: number,
): Map<number, number> {
  const best = new Map<number, number>();
  if (!(limit > 0)) return best;
  best.set(start, 0);
  // A plain list is enough: the neighbourhood inside a travel distance is a handful of nodes.
  const open: number[] = [start];
  while (open.length > 0) {
    let pick = 0;
    for (let i = 1; i < open.length; i++) {
      if (best.get(open[i]!)! < best.get(open[pick]!)!) pick = i;
    }
    const node = open.splice(pick, 1)[0]!;
    const here = best.get(node)!;
    for (const index of neighbours[node] ?? []) {
      const edge = graph.edges[index]!;
      const next = edge.a === node ? edge.b : edge.a;
      const through = here + distance(graph.nodes[node]!, graph.nodes[next]!);
      if (through > limit) continue;
      const known = best.get(next);
      if (known === undefined || through < known) {
        if (known === undefined) open.push(next);
        best.set(next, through);
      }
    }
  }
  return best;
}

/**
 * Take the candidates best first, each free end once, skipping any that would cross.
 *
 * Ordered across the whole graph by each end's current best, tier before score. A candidate is
 * checked for crossings only when it is its end's turn, so an end that never gets that far costs
 * nothing.
 */
function pairOff(graph: WallGraph, lists: readonly (readonly Candidate[])[]): Mend[] {
  const cursor = lists.map(() => 0);
  const used = new Set<number>();
  const taken: Mend[] = [];

  const head = (list: number): Candidate | null => lists[list]![cursor[list]!] ?? null;

  for (;;) {
    let bestList = -1;
    let best: Candidate | null = null;
    for (let list = 0; list < lists.length; list++) {
      const candidate = head(list);
      if (!candidate || used.has(candidate.mend.from)) continue;
      if (
        !best ||
        candidate.tier < best.tier ||
        (candidate.tier === best.tier && candidate.score < best.score)
      ) {
        best = candidate;
        bestList = list;
      }
    }
    if (!best) break;

    cursor[bestList] = cursor[bestList]! + 1;
    const mend = best.mend;
    if (mend.to.kind === "end" && used.has(mend.to.node)) continue;
    if (crossesAnything(graph, mend, taken)) continue;

    taken.push(mend);
    used.add(mend.from);
    if (mend.to.kind === "end") used.add(mend.to.node);
  }

  return taken;
}

/**
 * Whether a mend would meet a wall or a mend already taken anywhere but its own two ends.
 *
 * The walls it leaves from and lands on are not exempt by rule — the predicate already treats a
 * shared endpoint as no meeting — with one exception: the segment a mend lands partway along is met
 * at exactly the point it will be split, which is the mend doing its job.
 */
function crossesAnything(graph: WallGraph, mend: Mend, taken: readonly Mend[]): boolean {
  for (let index = 0; index < graph.edges.length; index++) {
    if (mend.to.kind === "segment" && mend.to.edge === index) continue;
    const edge = graph.edges[index]!;
    if (segmentMeeting(mend.start, mend.end, graph.nodes[edge.a]!, graph.nodes[edge.b]!)) return true;
  }
  for (const other of taken) {
    if (segmentMeeting(mend.start, mend.end, other.start, other.end)) return true;
  }
  return false;
}

/**
 * One free end's own best match, the reach ceiling ignored — for a direct click on an end whose true
 * best candidate is farther than *Largest gap to look for* currently reaches.
 *
 * **The same-wall distance stays as set.** `travel` excludes a candidate already joined by a short
 * walk through the existing walls, which is not a "how far away" ceiling in the same sense as reach —
 * a free click has no business turning off a check the GM tuned on purpose.
 *
 * **Respects every mend already accepted.** A candidate whose target is another mend's own free end
 * is not offered again: that mend's ring is what a click there should take, and this is deliberately
 * not a second global reassignment that could disturb it. `crossesAnything` is checked against the
 * same accepted set, for the same reason.
 */
export function mendForFreeEnd(
  graph: WallGraph,
  id: number,
  travel: number,
  taken: readonly Mend[],
): Mend | null {
  const degrees = nodeDegrees(graph);
  if (degrees[id] !== 1) return null;

  const used = new Set<number>();
  for (const mend of taken) {
    used.add(mend.from);
    if (mend.to.kind === "end") used.add(mend.to.node);
  }
  if (used.has(id)) return null;

  const neighbours = adjacency(graph);
  const candidates = candidatesFor(graph, id, degrees, neighbours, Infinity, travel);
  for (const candidate of candidates) {
    if (candidate.mend.to.kind === "end" && used.has(candidate.mend.to.node)) continue;
    if (crossesAnything(graph, candidate.mend, taken)) continue;
    return candidate.mend;
  }
  return null;
}

/**
 * Accept mends: add each as a wall, splitting the segments they land partway along.
 *
 * **Every split first, then every wall**, and the order is what makes accepting several at once
 * safe. A mend onto a segment names that segment by its index, and adding a wall renumbers the
 * edges — so the splits are made while the indices still mean what the search meant, and each new
 * vertex is then reached by its **coordinate**, which adding walls does not change. Two mends onto
 * the same segment split it once, at both points, in order along it.
 *
 * One call for one mend or for all of them, so accepting everything shown is exactly accepting each
 * in turn and is one edit — which is what makes it one step of undo.
 */
export function applyMends(graph: WallGraph, mends: readonly Mend[]): EditResult {
  const landings = mends.flatMap((mend) =>
    mend.to.kind === "segment" ? [{ edge: mend.to.edge, at: mend.to.at }] : [],
  );
  let result: EditResult = splitEdgesAt(graph, landings);
  for (const mend of mends) {
    const next = insertEdge(result.graph, [mend.start, mend.end]);
    result = {
      graph: next.graph,
      splits: result.splits + next.splits,
      overlaps: result.overlaps + next.overlaps,
    };
  }
  return result;
}
