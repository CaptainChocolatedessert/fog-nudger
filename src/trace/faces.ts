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
import type { WallGraph } from "./wallGraph";

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
  let unlabelled = 0;
  let disagreements = 0;

  for (let start = 0; start < halfEdgeCount; start++) {
    if (seen[start] === 1) continue;

    const points: Vector2[] = [];
    const halfEdges: number[] = [];
    let label = 0;
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
        if (found === 0) continue;
        if (label === 0) label = found;
        else if (label !== found) disagreements += 1;
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

    if (label === 0) {
      unlabelled += 1;
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
    unlabelled,
    disagreements,
    exact,
    checked: faces.length,
    ambiguous,
  };
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

/**
 * Fit every edge once, then reassemble the faces from the fitted edges.
 *
 * **Per edge, not per ring, and that is the whole point.** Two faces sharing a wall reference the
 * same fitted point list, so they cannot drift apart and open a sliver between rooms — which
 * independent per-ring simplification would do, since under the graph their boundaries are
 * coincident rather than a wall width apart. The same list is what a bridge emits as a line, so a
 * room and the stub meeting it share their corner exactly, with no epsilon.
 *
 * Douglas–Peucker pins both endpoints, so nodes are never moved or removed.
 */
export function fitFaces(
  graph: WallGraph,
  faces: readonly GraphFace[],
  tolerance: number,
): { rings: readonly (readonly Vector2[])[][]; fitted: readonly (readonly Vector2[])[] } {
  const fitted = graph.edges.map((edge) => simplifyPolyline(edge.points, tolerance));

  const oriented = (half: number): readonly Vector2[] => {
    const points = fitted[half >> 1]!;
    return (half & 1) === 0 ? points : [...points].reverse();
  };

  const rings = faces.map((face) =>
    face.cycles.map((cycle) => {
      const points: Vector2[] = [];
      for (const half of cycle.halfEdges) {
        const chain = oriented(half);
        for (let i = points.length === 0 ? 0 : 1; i < chain.length; i++) points.push(chain[i]!);
      }
      if (points.length > 1) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (first.x === last.x && first.y === last.y) points.pop();
      }
      return points;
    }),
  );

  return { rings, fitted };
}
