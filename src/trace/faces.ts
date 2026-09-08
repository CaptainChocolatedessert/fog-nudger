/**
 * Faces of the wall graph — the regions, derived by walking the graph rather than a raster of it.
 *
 * Each edge has two half-edges. At every node the departing half-edges are sorted by heading, and
 * the walk leaves a node by taking the entry *after* the one it arrived along. Every cycle that
 * produces is a face boundary. The arrangement is safe to walk here because **no intersection is
 * ever computed**: the skeleton is already a planar embedding, nodes exist only where pixels are
 * adjacent, and the only geometric decision is the angular sort — which is close only when two edges
 * leave a node at nearly the same heading. **That used to say "the case the weld radius has already
 * removed", and nothing welds** (2026-08-30). What removes it now is sliver removal: two chains
 * between the same pair of nodes bounding a sub-pixel triangle are exactly the near-parallel case,
 * and one of the two is deleted before the faces are walked.
 *
 * With the convention below the face lies to the **right** of each half-edge and an enclosing cycle
 * has positive signed area. Holes come out negative, and a bridge walked out and back comes out at
 * exactly zero.
 *
 * ## Three jobs from one trick
 *
 * Sampling the pixel one step to the right of each half-edge gives the label of the face that cycle
 * bounds. That single sample identifies the face, separates an outer ring from a hole, and resolves
 * nesting: a room drawn wholly inside a hall is a *separate connected component* whose cycle reports
 * the hall's label, so it attaches as a hole of the hall with no containment test anywhere.
 *
 * ## The area check
 *
 * The old identity — polygon area equals pixel count — does not survive the pivot, because the
 * boundary now runs *through* the wall pixels rather than around them. What replaces it is an exact
 * lattice identity:
 *
 * > **A = I + S/2 + h − 1**
 *
 * for A the summed signed area of a face's cycles, I the labelling's pixel count for it, S the total
 * steps walked, and h the number of holes. Three quantities from three unrelated routes — the
 * polygon, the labelling, and the traversal — against the two the old check coupled. Held in doubled
 * integers here, so the comparison is exact and no tolerance appears anywhere.
 *
 * **It is not plain Pick's theorem**, which was the first proposal and is wrong. Pick counts
 * *distinct* boundary points and needs a simple polygon; a face containing a bridge is a slit region
 * whose stub pixels are walked twice, and Pick under-counts it. Counting steps counts a slit pixel
 * twice, which is exactly the correction required.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import { simplifyPolyline } from "./simplify";
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

export interface GraphFace {
  /** The `Region.id` this face's interior carries in the labelling. */
  readonly label: number;
  /** Outer ring first, then holes. */
  readonly cycles: readonly FaceCycle[];
  /** Doubled signed area, summed over the cycles. */
  readonly doubleArea: number;
  /** Labelled pixels inside it. */
  readonly interior: number;
  /** What the identity says `doubleArea` must be. */
  readonly expectedDoubleArea: number;
  readonly exact: boolean;
}

export interface GraphFaces {
  readonly faces: readonly GraphFace[];
  /**
   * Enclosing cycles that belong to no labelled face — sub-pixel slivers left by junction clusters.
   *
   * Each is a real face of the arrangement that holds no space on the map. They must be removed
   * from the graph rather than tolerated: absorbed into a neighbour they corrupt its area identity,
   * and left alone they emit as shapes enclosing nothing.
   */
  readonly slivers: readonly FaceCycle[];
  /**
   * Cycles whose right-hand sample found no label at all.
   *
   * Zero is expected: there is no border frame, so the only unbounded face has no cycle. Any means a
   * face with no interior pixels, which is a degenerate sliver rather than a room.
   */
  readonly unlabelled: number;
  /**
   * Enclosing cycles the labelling could not name that the lattice rule does not call slivers.
   *
   * **Expected to be zero, and it is a cross-check rather than a state with a meaning.** Sliver
   * detection is a lattice property now — a cycle holds no lattice point, computed from integer
   * coordinates — where it used to be "the sampling found no label". The two should agree exactly:
   * a positive cycle is unlabelled precisely when there is no pixel inside it to find. Anything here
   * means the sample and the arithmetic disagree, which is worth hearing before the labelling is
   * removed altogether.
   */
  readonly unexplained: number;
  /**
   * Right-hand samples along one cycle that disagreed about which face they were in.
   *
   * Must be zero. One step to the right of a half-edge is either the face or a skeleton pixel, never
   * a different face, so a disagreement means the handedness is wrong somewhere.
   */
  readonly disagreements: number;
  /** Faces whose area identity held, and the total checked. */
  readonly exact: number;
  readonly checked: number;
  /** Faces with more than one enclosing cycle, which cannot happen and is reported rather than thrown. */
  readonly ambiguous: number;
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
 * Walk the graph into faces.
 *
 * `labelled` must be the labelling of `graph.framed` with no minimum area — the smallest-room filter
 * belongs downstream, and filtering here would leave the identity comparing against a pixel count
 * that had holes punched in it.
 */
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
 * **This is the same correction the area check already documents**, running the other way. That
 * identity uses the *step* count deliberately, because it is the bridged form (A = I + S/2 + h − 1)
 * and counting a slit pixel twice is exactly what it needs. Pick's plain form needs distinct points
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

export interface FittedEdge {
  readonly points: readonly Vector2[];
}

/** A ring's geometry, assembled from the fitted edges around one cycle. */
export interface FittedRing {
  readonly points: readonly Vector2[];
  /**
   * The same ring before fitting, one point per skeleton pixel.
   *
   * Kept for the one caller that needs it: a ring small against the tolerance can fit down to two
   * points and stop being a shape at all, and losing a room is worse than carrying its full detail.
   */
  readonly raw: readonly Vector2[];
}

export interface FittedFaces {
  /**
   * Per face, per cycle, the rings that cycle produced.
   *
   * A cycle yields **more than one ring** when a bridge splits it, and none at all when it was
   * nothing but a bridge excursion.
   */
  readonly rings: readonly (readonly FittedRing[])[][];
  /** Per graph edge. */
  readonly edges: readonly FittedEdge[];
}

/**
 * Fit every edge once, then assemble the faces from the fitted edges.
 *
 * **Per edge, not per ring, and that is the whole point.** Two faces sharing a wall reference the
 * same fitted point list, so they cannot drift apart and open a sliver between rooms — which
 * independent per-ring simplification would do, since under the graph their boundaries are
 * coincident rather than a wall width apart. The same list is what a bridge emits as lines, so a
 * room and the stub meeting it share their corner exactly, with no epsilon.
 *
 * Douglas–Peucker pins both endpoints, so nodes are never moved or removed.
 *
 * ## Vertex ids were here, and were removed — 2026-08-31
 *
 * Every fitted point used to carry an integer id, so that grouping emitted items by id would
 * reconstruct the graph and tell a join that had come apart from two ends never joined — a doorway
 * being two ends deliberately close and deliberately separate, which geometry alone cannot
 * distinguish.
 *
 * They went because **the scene never has to be read back** (user, 2026-08-31). Everything that
 * determines the graph is durable: the settings and the nominated map live in scene metadata, which
 * survives closing the workspace, reloading the room, and disabling the extension. Everything else
 * is derived, and the derivation is a pure function of those inputs — so the graph is always one
 * re-run away, and reconstructing it from emitted geometry answers a question nobody needs to ask.
 *
 * **What would bring them back**, so a future session can tell: storing hand edits *as scene items*
 * rather than as durable inputs. That is the one arrangement where the scene becomes the source of
 * truth for something the pipeline did not derive, and it is explicitly rejected — a hand edit to
 * our fog is meant not to survive the next push. Steps F and G add edits; while those live in
 * metadata beside the settings, ids stay unnecessary.
 *
 * ## Bridges are left out of the rings
 *
 * A cycle walks a bridge out and back, so a stub hanging into a room appears in the room's boundary
 * as a zero-width slit. That is right for the traversal and for the area check, which counts those
 * steps — and wrong to emit. It would put our internal representation into the scene and leave two
 * other renderers to interpret a degenerate excursion, where a human would simply have drawn the
 * room and then drawn the wall. So the excursion is dropped here and the bridge is emitted as its
 * own line, which is what Dynamic Fog's own wall mode builds.
 *
 * Dropping it costs the ring nothing: a slit encloses no area.
 */
export function fitFaces(
  graph: SkeletonGraph,
  faces: readonly GraphFace[],
  tolerance: number,
  /** Edges to leave out of the rings — the bridges. Their geometry is emitted separately. */
  omit: ReadonlySet<number> = new Set(),
): FittedFaces {
  const edges: FittedEdge[] = graph.edges.map((edge) => ({
    points: simplifyPolyline(edge.points, tolerance),
  }));

  const oriented = (half: number): FittedEdge => {
    const edge = edges[half >> 1]!;
    if ((half & 1) === 0) return edge;
    return { points: [...edge.points].reverse() };
  };

  const unfitted = (half: number): readonly Vector2[] => {
    const points = graph.edges[half >> 1]!.points;
    return (half & 1) === 0 ? points : [...points].reverse();
  };

  /*
    Taking the bridges out of a cycle is a **graph** operation, not a linear one.

    Two cases look identical in the walk and need opposite handling. Skip a plain stub — out and
    straight back — and the boundary either side of it is *contiguous*, so the ring carries on. Skip
    the stalk of a lollipop, a room on the end of a stub, and the boundary either side of it is
    *not*: what was one hole around a building-plus-lollipop becomes two, one round each. A linear
    scan cutting at every omitted half-edge gets the first case wrong; one that never cuts gets the
    second wrong. Both were tried, and the second is what a real map exposed — the exterior's outline
    running across the map to unrelated vertices and skipping long stretches of wall.

    What settles it: after the bridges are removed, every node has as many kept half-edges arriving
    as leaving, because an excursion always comes back. So the kept half-edges decompose into closed
    loops, and following unused departures from each arrival finds them — Hierholzer's walk. A stub
    rejoins its two sides at the shared node; a lollipop's stalk does not, because the loop closes
    before it reaches the stalk again.

    Areas are unaffected either way, which is what the sweep asserts: a slit encloses nothing, so
    splitting only redistributes the same total across more rings.
  */
  const rings = faces.map((face) =>
    face.cycles.map((cycle) => {
      const kept = cycle.halfEdges.filter((half) => !omit.has(half >> 1));
      if (kept.length === 0) return [];

      // Departures from each node, in the order the walk met them, with a pointer into each list.
      const departures = new Map<number, number[]>();
      for (const half of kept) {
        const from = originNode(graph, half);
        const list = departures.get(from);
        if (list) list.push(half);
        else departures.set(from, [half]);
      }
      const taken = new Set<number>();
      const nextFrom = (node: number): number | null => {
        const list = departures.get(node);
        if (!list) return null;
        for (const half of list) if (!taken.has(half)) return half;
        return null;
      };

      const out: FittedRing[] = [];
      for (const first of kept) {
        if (taken.has(first)) continue;

        const points: Vector2[] = [];
        const raw: Vector2[] = [];
        let half: number | null = first;

        while (half !== null) {
          taken.add(half);
          const chain = oriented(half);
          // The shared node belongs to one step only, however many half-edges meet at it.
          for (let i = points.length === 0 ? 0 : 1; i < chain.points.length; i++) {
            points.push(chain.points[i]!);
          }
          const source = unfitted(half);
          for (let i = raw.length === 0 ? 0 : 1; i < source.length; i++) raw.push(source[i]!);

          half = nextFrom(targetNode(graph, half));
        }

        if (points.length > 1) {
          const head = points[0]!;
          const tail = points[points.length - 1]!;
          if (head.x === tail.x && head.y === tail.y) points.pop();
        }
        if (raw.length > 1) {
          const head = raw[0]!;
          const tail = raw[raw.length - 1]!;
          if (head.x === tail.x && head.y === tail.y) raw.pop();
        }
        if (points.length > 0) out.push({ points, raw });
      }

      return out;
    }),
  );

  return { rings, edges };
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
 * nothing; absorbed into a neighbour, it corrupts that neighbour's area identity. The second is what
 * it did, and it is what made the area check fail on a real map.
 *
 * The repair deletes one of the sliver's bounding edges, merging it into whatever lies on the other
 * side. Deleting an edge cannot break planarity and moves no point, which is exactly what the
 * endpoint welding this replaces could not promise. Two constraints on which edge:
 *
 * - **It must have no interior pixels.** Deleting an edge that has them takes those pixels out of
 *   the graph entirely, leaving them neither inside a face nor on any boundary — and the identity
 *   then comes up short by exactly them.
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
