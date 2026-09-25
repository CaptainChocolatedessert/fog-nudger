/**
 * The skeleton graph's cycles, its sub-pixel slivers and their removal — before any wall is fitted.
 *
 * Each edge has two half-edges. At every node the departing half-edges are sorted by heading, and
 * the walk leaves a node by taking the entry **before** the one it arrived along — `walkCycles` says
 * why before and not after. Every cycle that produces is a face boundary. The arrangement is safe to
 * walk because **no intersection is ever computed**: the skeleton is already a planar embedding,
 * nodes exist only where pixels are adjacent, and the only geometric decision is the angular sort —
 * which is close only when two edges leave a node at nearly the same heading. That is the sliver
 * case: two chains between the same pair of nodes bounding a sub-pixel triangle, and one of the two is
 * deleted before anything downstream reads the graph.
 *
 * With the convention below the face lies to the **right** of each half-edge and an enclosing cycle
 * has positive signed area. Holes come out negative, and a bridge walked out and back comes out at
 * exactly zero.
 *
 * **What this module no longer does, since 2026-09-08**: name faces by sampling a raster labelling one
 * step to the right of each half-edge, check the *area check*'s lattice identity against the
 * labelling's pixel counts, and fit and assemble the faces' rings (`fitFaces`). Faces come from
 * walking the **wall graph** now (`wallFaces.ts`), and the fitting is done once per edge inside the
 * derive. The header described all three until 2026-09-24, and `fitFaces` with its four types
 * outlived its last caller by the same sixteen days; `walkCycles`' own doc has why they went.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import { removeEdges, type SkeletonGraph } from "./skeletonGraph";

export interface FaceCycle {
  /** Lattice points, closing implicitly: the last steps back to the first. */
  readonly points: readonly Vector2[];
  /** Half-edge ids in walk order, so the fitted geometry can be reassembled from the same edges. */
  readonly halfEdges: readonly number[];
  /** Shoelace, doubled, signed. Positive encloses; negative is a hole; zero is a bridge walked twice. */
  readonly doubleArea: number;
  /** Steps in the closed walk, which equals the number of points. */
  readonly steps: number;
}

const twin = (half: number): number => half ^ 1;

/** Points of a half-edge, oriented so the walk runs from its origin node to its target node. */
function orientedPoints(graph: SkeletonGraph, half: number): readonly Vector2[] {
  const edge = graph.edges[half >> 1]!;
  return (half & 1) === 0 ? edge.points : [...edge.points].reverse();
}

function originNode(graph: SkeletonGraph, half: number): number {
  const edge = graph.edges[half >> 1]!;
  return (half & 1) === 0 ? edge.a : edge.b;
}

function targetNode(graph: SkeletonGraph, half: number): number {
  return originNode(graph, twin(half));
}

/** Heading of a half-edge as it leaves its origin. */
function departure(graph: SkeletonGraph, half: number): number {
  const points = orientedPoints(graph, half);
  const from = points[0]!;
  const to = points[1]!;
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * Whether a cycle encloses no lattice point at all — the definition of a sub-pixel sliver.
 *
 * ## The rule, and why it needs no labelling
 *
 * A junction cluster leaves faces that are real faces of the arrangement and hold no map: where
 * thinning turns a T into a small Y, two chains run between the same pair of nodes and bound a
 * triangle of half a pixel. Until 2026-09-08 those were found by *asking the labelling* — a positive
 * cycle that no sample could name — which made sliver removal depend on a flood fill of the raster.
 *
 * They can be found from the geometry alone. Pick's theorem, rearranged: for a lattice polygon,
 * **I = A − B/2 + 1**. Every step of one of these cycles is to an 8-neighbour, so no lattice point
 * lies strictly inside a step and every boundary lattice point is a vertex of the walk. In the
 * doubled integers this walk already carries, a cycle holds no interior lattice point exactly when
 *
 * > **doubled area = B − 2**
 *
 * Exact integer arithmetic, no tolerance, no raster.
 *
 * ## B is DISTINCT points, and using the step count instead is wrong — measured, 2026-09-08
 *
 * The first version of this used `steps`, on the reasoning that each step contributes one boundary
 * point. That is false wherever a cycle walks a **slit**: a bridge is walked out and back, so its
 * pixels are visited twice and the step count exceeds the number of distinct boundary points. The
 * sweep caught it immediately — cycles with `doubleArea 2, steps 8, four points revisited`, which the
 * formula scored as I = −2 and therefore refused to call slivers, where the truth is I = 0.
 *
 * **This is the same correction the area check documented**, running the other way — that identity,
 * gone with the labelling, used the *step* count deliberately, because it was the bridged form
 * (A = I + S/2 + h − 1) and counting a slit pixel twice was exactly what it needed. Pick's plain form needs distinct points
 * and a simple polygon. Two identities, two boundary counts, and swapping them is silent.
 *
 * A negative cycle is a hole rather than a face and is never a sliver, so the sign is tested first.
 */
function enclosesNoLatticePoint(cycle: FaceCycle): boolean {
  if (cycle.doubleArea <= 0) return false;
  const distinct = new Set(cycle.points.map((point) => `${point.x},${point.y}`)).size;
  return cycle.doubleArea === distinct - 2;
}

/** Every closed walk of the arrangement, and the ones that hold no map. */
export interface CycleWalk {
  readonly cycles: readonly FaceCycle[];
  /**
   * Cycles enclosing no lattice point — the sub-pixel faces a junction cluster leaves.
   *
   * Where thinning turns a T into a small Y, two chains run between the same pair of nodes and bound
   * a triangle of half a pixel. They are real faces of the arrangement and hold no map, so they are
   * removed from the graph rather than emitted.
   */
  readonly slivers: readonly FaceCycle[];
}

/**
 * Walk the arrangement into closed cycles.
 *
 * ## What this used to be, and what went with it — 2026-09-08
 *
 * It was `buildFaces`, and it took a **raster labelling** as well as the graph. For each cycle it
 * sampled the pixel one step to the right of every boundary step, used that to name the face, and
 * then checked a lattice identity — the *area check* — that the polygon it had produced enclosed
 * exactly the pixels the flood fill had attributed to that face.
 *
 * All of that is gone, and the reason is that faces stopped being made of pixels. The document is a
 * planar graph; a planar graph partitions the plane by construction, so there is nothing to check
 * about whether every part of the map is under a face. What the check uniquely covered was the
 * **raster-to-graph conversion** — did the chain walk claim every skeleton pixel — and that is the
 * orphan count, which is direct, cheap, and asserted on every run.
 *
 * > *"It feels to me like it is a left-over diagnostic that doesn't do anything now that we treat
 * > the graph as the base truth, not a set of faces. Why are we counting pixels?"* — user, 2026-09-08
 *
 * **What the check was really doing was serving as a test oracle at runtime**, and that belongs in
 * tests with known answers rather than in production: a stub, a lollipop, a freestanding line, shapes
 * whose faces can be written down. `faces.test.ts` carries those now.
 *
 * The walk itself is untouched, deliberately. Sort the half-edges at each node by heading and leave
 * by the entry *before* the one arrived along, so the face is on the right of every half-edge and an
 * enclosing cycle comes out positive. Same convention as the wall graph traversal, which is what lets the
 * two produce the same partition from the same graph.
 */
export function walkCycles(graph: SkeletonGraph): CycleWalk {
  const halfEdgeCount = graph.edges.length * 2;

  // Departing half-edges at each node, sorted by heading. The walk's only geometric decision.
  const departing: number[][] = graph.nodes.map(() => []);
  for (let half = 0; half < halfEdgeCount; half++) {
    departing[originNode(graph, half)]!.push(half);
  }
  const slotOf = new Int32Array(halfEdgeCount).fill(-1);
  for (const list of departing) {
    list.sort((left, right) => departure(graph, left) - departure(graph, right));
    list.forEach((half, index) => {
      slotOf[half] = index;
    });
  }

  /**
   * Leave a node by the entry *before* the one just arrived along, in ascending-heading order.
   *
   * Before, not after — and the difference is invisible on any fixture whose nodes have only two
   * departing half-edges, which is every plain room. It shows up first at a junction: with the
   * successor rule a stub hanging into a room is walked as part of the *band outside* the room,
   * because taking the far side of the fan crosses to the other face.
   */
  const next = (half: number): number => {
    const back = twin(half);
    const list = departing[targetNode(graph, half)]!;
    return list[(slotOf[back]! + list.length - 1) % list.length]!;
  };

  const seen = new Uint8Array(halfEdgeCount);
  const cycles: FaceCycle[] = [];
  const slivers: FaceCycle[] = [];

  for (let start = 0; start < halfEdgeCount; start++) {
    if (seen[start] === 1) continue;

    const points: Vector2[] = [];
    const halfEdges: number[] = [];
    let half = start;

    do {
      seen[half] = 1;
      halfEdges.push(half);

      const chain = orientedPoints(graph, half);
      // The shared node belongs to one step only, however many half-edges meet at it.
      for (let i = points.length === 0 ? 0 : 1; i < chain.length; i++) points.push(chain[i]!);

      half = next(half);
    } while (half !== start);

    // The walk returns to its first point; drop the repeat so the step count equals the point count.
    if (points.length > 1) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      if (first.x === last.x && first.y === last.y) points.pop();
    }

    let doubleArea = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      doubleArea += a.x * b.y - b.x * a.y;
    }

    const cycle: FaceCycle = { points, halfEdges, doubleArea, steps: points.length };
    cycles.push(cycle);
    if (enclosesNoLatticePoint(cycle)) slivers.push(cycle);
  }

  return { cycles, slivers };
}

/** One skeleton edge after fitting. The derive fits each edge once, so faces sharing it agree. */
export interface FittedEdge {
  readonly points: readonly Vector2[];
}

/** Enough rounds for a cluster of any plausible size; a guard rather than a working limit. */
const MAX_SLIVER_ROUNDS = 8;

export interface ResolvedFaces {
  /** The graph after its sub-pixel slivers were removed. Use this one downstream, not the input. */
  readonly graph: SkeletonGraph;
  /** The walk of the cleaned graph, so a caller need not repeat it. */
  readonly walk: CycleWalk;
  readonly sliversRemoved: number;
  readonly rounds: number;
  /** Slivers still present when the round cap was reached. Expected to be zero. */
  readonly sliversLeft: number;
}

/**
 * Walk the faces, then clean up after the junction clusters, then walk again.
 *
 * The two halves are one operation, which is why they live together: a raw traversal is not a usable
 * partition. Where thinning turns a T into a small Y, two chains run between the same pair of nodes
 * and enclose a triangle of half a pixel with no lattice point inside it. That is a real face of the
 * arrangement holding no space on the map, and it has to go: left in, it emits as a shape enclosing
 * nothing; absorbed into a neighbour, it corrupts that neighbour's area. The second is what it did,
 * and it is what made the area check fail on a real map while there was one.
 *
 * The repair deletes one of the sliver's bounding edges, merging it into whatever lies on the other
 * side. Deleting an edge cannot break planarity and moves no point, which is exactly what the
 * endpoint welding this replaces could not promise. Two constraints on which edge:
 *
 * - **It must have no interior pixels.** Deleting an edge that has them takes those pixels out of
 *   the graph entirely, leaving them neither inside a face nor on any boundary — linework lost with
 *   nothing to say which.
 * - **A diagonal link is preferred.** Three mutually-touching pixels make a triangle whose
 *   hypotenuse is the redundant 8-connection; giving up a leg instead cuts the corner off the
 *   linework rather than tidying it.
 *
 * Iterated, because removing one sliver's edge can expose another.
 */
export function resolveFaces(graph: SkeletonGraph): ResolvedFaces {
  let current = graph;
  let walk = walkCycles(current);
  let sliversRemoved = 0;
  let rounds = 0;

  for (; rounds < MAX_SLIVER_ROUNDS && walk.slivers.length > 0; rounds += 1) {
    const drop = new Set<number>();
    for (const sliver of walk.slivers) {
      let chosen = -1;
      let already = false;
      for (const half of sliver.halfEdges) {
        const edge = half >> 1;
        // Two slivers can share an edge; one deletion serves both, and dropping a second edge of
        // the same pair could disconnect linework that is really there.
        if (drop.has(edge)) {
          already = true;
          break;
        }
        const points = current.edges[edge]!.points;
        if (points.length !== 2) continue;
        const diagonal = points[0]!.x !== points[1]!.x && points[0]!.y !== points[1]!.y;
        if (chosen < 0 || diagonal) chosen = edge;
        if (diagonal) break;
      }
      if (!already && chosen >= 0) drop.add(chosen);
    }
    if (drop.size === 0) break;
    sliversRemoved += drop.size;
    current = removeEdges(current, drop);
    walk = walkCycles(current);
  }

  return { graph: current, walk, sliversRemoved, rounds, sliversLeft: walk.slivers.length };
}
