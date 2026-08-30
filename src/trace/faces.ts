/**
 * Faces of the wall graph — the regions, derived by walking the graph rather than a raster of it.
 *
 * Each edge has two half-edges. At every node the departing half-edges are sorted by heading, and
 * the walk leaves a node by taking the entry *after* the one it arrived along. Every cycle that
 * produces is a face boundary. The arrangement is safe to walk here because **no intersection is
 * ever computed**: the skeleton is already a planar embedding, nodes exist only where pixels are
 * adjacent, and the only geometric decision is the angular sort — which is close only when two edges
 * leave a node at nearly the same heading, the case the weld radius has already removed.
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
import type { LabelledSpace } from "./label";
import { simplifyPolyline } from "./simplify";
import { removeEdges, type WallGraph } from "./wallGraph";

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
   * Exactly one is expected — the unbounded face outside the border frame. More than one means a
   * face with no interior pixels, which is a degenerate sliver rather than a room.
   */
  readonly unlabelled: number;
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
function orientedPoints(graph: WallGraph, half: number): readonly Vector2[] {
  const edge = graph.edges[half >> 1]!;
  return (half & 1) === 0 ? edge.points : [...edge.points].reverse();
}

function originNode(graph: WallGraph, half: number): number {
  const edge = graph.edges[half >> 1]!;
  return (half & 1) === 0 ? edge.a : edge.b;
}

function targetNode(graph: WallGraph, half: number): number {
  return originNode(graph, twin(half));
}

/** Heading of a half-edge as it leaves its origin. */
function departure(graph: WallGraph, half: number): number {
  const points = orientedPoints(graph, half);
  const from = points[0]!;
  const to = points[1]!;
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * The pixel on the right of a step, which is the face this half-edge bounds.
 *
 * For an orthogonal step there is one candidate; for a diagonal there are two flanks and the cross
 * product picks the right-hand one. Offsets are always to an 8-neighbour of `from`, so the sample is
 * either inside the face or on the skeleton — never inside a different face.
 */
function rightFlank(from: Vector2, to: Vector2): Vector2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const candidates: Vector2[] =
    dx === 0 || dy === 0
      ? [{ x: -dy, y: dx }, { x: dy, y: -dx }]
      : [{ x: dx, y: 0 }, { x: 0, y: dy }];
  const pick = candidates.find((option) => dx * option.y - dy * option.x > 0) ?? candidates[0]!;
  return { x: from.x + pick.x, y: from.y + pick.y };
}

/**
 * Walk the graph into faces.
 *
 * `labelled` must be the labelling of `graph.framed` with no minimum area — the smallest-room filter
 * belongs downstream, and filtering here would leave the identity comparing against a pixel count
 * that had holes punched in it.
 */
export function buildFaces(graph: WallGraph, labelled: LabelledSpace): GraphFaces {
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
   * because taking the far side of the fan crosses to the other face. Caught by the fixture with a
   * bridge in it, and by the handedness samples disagreeing along the cycle it produced.
   */
  const next = (half: number): number => {
    const back = twin(half);
    const list = departing[targetNode(graph, half)]!;
    return list[(slotOf[back]! + list.length - 1) % list.length]!;
  };

  const areaOf = (label: number): number =>
    labelled.regions.find((region) => region.id === label)?.area ?? 0;

  const seen = new Uint8Array(halfEdgeCount);
  const byLabel = new Map<number, FaceCycle[]>();
  const slivers: FaceCycle[] = [];
  let unlabelled = 0;
  let disagreements = 0;

  for (let start = 0; start < halfEdgeCount; start++) {
    if (seen[start] === 1) continue;

    const points: Vector2[] = [];
    const halfEdges: number[] = [];
    /** One representative sampled pixel per label seen to the right of this cycle. */
    const samples = new Map<number, Vector2>();
    let half = start;

    do {
      seen[half] = 1;
      halfEdges.push(half);

      const chain = orientedPoints(graph, half);
      // The shared node belongs to one step only, however many half-edges meet at it.
      for (let i = points.length === 0 ? 0 : 1; i < chain.length; i++) points.push(chain[i]!);

      for (let i = 1; i < chain.length; i++) {
        const flank = rightFlank(chain[i - 1]!, chain[i]!);
        if (flank.x < 0 || flank.y < 0 || flank.x >= labelled.width || flank.y >= labelled.height) {
          continue;
        }
        const found = labelled.labels[flank.y * labelled.width + flank.x]!;
        if (found !== 0 && !samples.has(found)) samples.set(found, flank);
      }

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

    /*
      A sample one step to the right is *usually* inside the face this cycle bounds — but not
      always, and the exception is what made the area check fail on a real map. Where thinning turns
      a T into a small Y, two chains run between the same pair of nodes and enclose a **sub-pixel
      face**: a triangle of half a pixel with no lattice point in it at all. Every sample around it
      lands in the neighbouring face, so the sliver was silently absorbed into its neighbour and
      corrupted that neighbour's accounting.

      So the sample is verified rather than trusted: it must lie inside the cycle when the cycle
      encloses, and outside it when the cycle is a hole. Exact, because a sampled pixel is never on
      the boundary — the polygon's vertices are skeleton pixels and its steps are to 8-neighbours,
      so no other lattice point can lie on one.
    */
    const shouldContain = doubleArea > 0;
    let label = 0;
    for (const [candidate, point] of samples) {
      if (containsPoint(points, point) !== shouldContain) continue;
      if (label === 0) label = candidate;
      else if (label !== candidate) disagreements += 1;
    }

    if (label === 0) {
      unlabelled += 1;
      // An enclosing cycle that belongs to no labelled face is a sliver: a face of the arrangement
      // holding no space on the map. Reported so the caller can remove it from the graph; the one
      // legitimately unlabelled cycle, the unbounded face outside the border frame, runs the other
      // way and is negative.
      if (doubleArea > 0) slivers.push(cycle);
      continue;
    }
    const list = byLabel.get(label);
    if (list) list.push(cycle);
    else byLabel.set(label, [cycle]);
  }

  const faces: GraphFace[] = [];
  let exact = 0;
  let ambiguous = 0;

  for (const [label, cycles] of byLabel) {
    const enclosing = cycles.filter((cycle) => cycle.doubleArea > 0);
    if (enclosing.length !== 1) ambiguous += 1;

    const ordered = [...cycles].sort((left, right) => right.doubleArea - left.doubleArea);
    const doubleArea = ordered.reduce((total, cycle) => total + cycle.doubleArea, 0);
    const steps = ordered.reduce((total, cycle) => total + cycle.steps, 0);
    const interior = areaOf(label);
    const expectedDoubleArea = 2 * interior + steps + 2 * (ordered.length - 1) - 2;
    const holds = doubleArea === expectedDoubleArea;
    if (holds) exact += 1;

    faces.push({
      label,
      cycles: ordered,
      doubleArea,
      interior,
      expectedDoubleArea,
      exact: holds,
    });
  }

  faces.sort((left, right) => right.doubleArea - left.doubleArea);

  return {
    faces,
    slivers,
    unlabelled,
    disagreements,
    exact,
    checked: faces.length,
    ambiguous,
  };
}

/**
 * Whether a lattice point lies strictly inside a closed lattice polygon.
 *
 * Plain crossing number. Safe without any on-boundary handling for the one thing it is asked here:
 * the polygon's vertices are skeleton pixels and consecutive ones are 8-neighbours, so no other
 * lattice point lies on an edge, and the points tested are never skeleton.
 */
function containsPoint(polygon: readonly Vector2[], point: Vector2): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y === b.y > point.y) continue;
    const crossing = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}

/** One line for the log, in the same shape as the old area check's. */
export function describeAreaCheck(result: GraphFaces): string {
  const head =
    result.exact === result.checked
      ? `area check exact across ${result.checked} faces`
      : `area check FAILED on ${result.checked - result.exact} of ${result.checked} faces`;
  const notes: string[] = [];
  if (result.unlabelled !== 1) notes.push(`${result.unlabelled} unlabelled cycles`);
  if (result.disagreements > 0) notes.push(`${result.disagreements} handedness disagreements`);
  if (result.ambiguous > 0) notes.push(`${result.ambiguous} faces with no single outer ring`);
  return notes.length === 0 ? head : `${head} — ${notes.join(", ")}`;
}

/** A fitted polyline and the id of each of its points, which travel together everywhere. */
export interface FittedEdge {
  readonly points: readonly Vector2[];
  readonly ids: readonly number[];
}

/** A ring's geometry with the vertex id of each point, in the same order. */
export interface FittedRing {
  readonly points: readonly Vector2[];
  readonly ids: readonly number[];
}

export interface FittedFaces {
  /** Per face, per cycle. Bridge excursions are omitted — see below. */
  readonly rings: readonly FittedRing[][];
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
 * ## Vertex ids
 *
 * Every fitted point carries an integer id. A node's id is its index in the graph, so two edges
 * meeting there agree by construction; an edge's surviving interior points get ids of their own from
 * a separate range. Grouping emitted items by id reconstructs the graph — and, more to the point,
 * tells a join that has come apart from two ends that were never joined, which geometry alone
 * cannot: a doorway is two ends deliberately close and deliberately separate.
 *
 * **Stable within one emitted set, not across runs.** The ids are graph indices, and any change to
 * the reading rebuilds the graph and renumbers everything.
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
  graph: WallGraph,
  faces: readonly GraphFace[],
  tolerance: number,
  /** Edges to leave out of the rings — the bridges. Their geometry is emitted separately. */
  omit: ReadonlySet<number> = new Set(),
): FittedFaces {
  let nextId = graph.nodes.length;
  const edges: FittedEdge[] = graph.edges.map((edge) => {
    const points = simplifyPolyline(edge.points, tolerance);
    const ids = points.map((_, index) => {
      if (index === 0) return edge.a;
      if (index === points.length - 1) return edge.b;
      return nextId++;
    });
    return { points, ids };
  });

  const oriented = (half: number): FittedEdge => {
    const edge = edges[half >> 1]!;
    if ((half & 1) === 0) return edge;
    return { points: [...edge.points].reverse(), ids: [...edge.ids].reverse() };
  };

  const rings = faces.map((face) =>
    face.cycles.map((cycle) => {
      const points: Vector2[] = [];
      const ids: number[] = [];
      for (const half of cycle.halfEdges) {
        if (omit.has(half >> 1)) continue;
        const chain = oriented(half);
        // The shared node belongs to one step only, however many half-edges meet at it.
        for (let i = points.length === 0 ? 0 : 1; i < chain.points.length; i++) {
          points.push(chain.points[i]!);
          ids.push(chain.ids[i]!);
        }
      }
      if (points.length > 1) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (first.x === last.x && first.y === last.y) {
          points.pop();
          ids.pop();
        }
      }
      return { points, ids };
    }),
  );

  return { rings, edges };
}

/** Enough rounds for a cluster of any plausible size; a guard rather than a working limit. */
const MAX_SLIVER_ROUNDS = 8;

export interface ResolvedFaces {
  /** The graph after its sub-pixel slivers were removed. Use this one downstream, not the input. */
  readonly graph: WallGraph;
  readonly faces: GraphFaces;
  readonly sliversRemoved: number;
  readonly rounds: number;
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
export function resolveFaces(graph: WallGraph, labelled: LabelledSpace): ResolvedFaces {
  let current = graph;
  let faces = buildFaces(current, labelled);
  let sliversRemoved = 0;
  let rounds = 0;

  for (; rounds < MAX_SLIVER_ROUNDS && faces.slivers.length > 0; rounds += 1) {
    const drop = new Set<number>();
    for (const sliver of faces.slivers) {
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
    faces = buildFaces(current, labelled);
  }

  return { graph: current, faces, sliversRemoved, rounds };
}
