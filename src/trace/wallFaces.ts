/**
 * Faces of the wall graph — the partition stage two draws and emits, derived from the document
 * alone.
 *
 * Stage one derives its faces from the skeleton *and* a raster labelling of the space between the
 * strokes: sampling the pixel one step to the right of each boundary step names the face, separates
 * an outer ring from a hole, and resolves nesting, all from one lookup. Stage two has no raster —
 * building the wall graph is the point where the pixels stop being needed — so every one of those three jobs has
 * to be done from the geometry.
 *
 * The walk itself is unchanged, and deliberately so: sort the walls meeting at each vertex by
 * heading, and leave a vertex by the entry *before* the one just arrived along. That keeps the face
 * on the right of every half-edge, so an enclosing cycle comes out with positive doubled area and a
 * hole with negative — the same convention as stage one, which is what lets the two produce the same
 * partition from the same graph.
 *
 * ## What replaces the pixel sample: containment, tested only across pieces of linework
 *
 * Each connected piece of linework contributes exactly one cycle that faces *outward* — its own
 * boundary as seen from whatever surrounds it — and one enclosing cycle per bounded face of its own.
 * So grouping is: every enclosing cycle is a face's outer ring, and every outward cycle is a hole of
 * the **smallest** enclosing ring that contains it. Nothing contains the outermost, and that is the
 * unbounded face, which has no polygon and is not emitted.
 *
 * **A cycle is only ever tested against cycles of other pieces of linework, and that is a
 * correctness requirement rather than an optimisation.** A piece's outward cycle runs along the same
 * vertices as its own faces' rings, so testing one of its points against one of them asks whether a
 * point exactly on a polygon is inside it — which is a coin flip, and it is the case that arises on
 * every single room. Two different pieces of linework share no vertex, so the test is never
 * degenerate. A vertex of one lying exactly on an *edge* of another would be, and cannot survive:
 * the planarity sweep splits that into a shared node, which makes them one piece.
 *
 * ## Areas are summed over half-edges, so a slit cancels exactly
 *
 * A cycle walks a stub out and back, and those two half-edges contribute a term and its exact
 * negation. Summing the shoelace point by point leaves them separated by everything in between, and
 * floating-point addition is not associative — so a piece of linework floating free inside a room
 * could come out with an area of 1e-18 instead of zero, and a *positive* 1e-18 would be read as a
 * room. Summing per half-edge and dropping any whose twin is in the same cycle removes those terms
 * before they are added rather than hoping they cancel afterwards. Exact by construction, and the
 * remaining sum is shorter and more accurate as well.
 *
 * ## The arithmetic check, and what it does not catch
 *
 * The area check does not survive the derivation — it is a lattice identity over pixel counts and step
 * counts, and fitted geometry has neither. What stage two can check is Euler's identity:
 *
 * > **V − E + (enclosing cycles) = (pieces of linework)**
 *
 * The left three come from counting the graph and from the sign of each cycle's area; the right from
 * a union-find over the same edges. Independent enough to catch a missed half-edge, a cycle
 * partition that does not partition, and a successor rule tracing faces the wrong way round — that
 * last one fails as soon as the graph has more than one room, because tracing with the interior on
 * the left leaves exactly one positively-signed cycle however many rooms there are.
 *
 * **It does not catch a crossing.** Two walls crossing at a point that is a node of neither still
 * walk into cycles that satisfy the identity. Planarity is a separate check and is already built;
 * this one says the traversal is coherent, not that the embedding is.
 *
 * ## No size rule, and no fitting
 *
 * Stage one drops a face with no interior pixels — the sub-pixel slivers a junction cluster leaves.
 * There is no pixel count here, and the alternative would be an area threshold, which is the control
 * that was deleted for deleting a *region* where what is usually wrong is a *wall*. So nothing is
 * dropped: a sliver in stage two is the GM's, possibly on purpose, and it is counted rather than
 * prevented. The stated cost is that a sliver stage one refused to emit becomes one stage two emits.
 *
 * There is no simplification either. The wall graph *is* the fitted geometry — that is why the
 * derive sits after fitting — so a ring is its nodes and nothing is approximated a second time.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { MIN_RING_POINTS, type Ring } from "../geometry/ring";
import type { WallGraph } from "./wallGraph";

/** One closed walk of half-edges. A face's outer ring is one; each of its holes is another. */
export interface WallCycle {
  /** Half-edge ids in walk order. Edge `e` has half-edges `2e` (a→b) and `2e+1` (b→a). */
  readonly halfEdges: readonly number[];
  /** The origin of each half-edge, closing implicitly. Graph units. */
  readonly points: readonly Vector2[];
  /** Shoelace, doubled, signed. Positive encloses; negative faces outward; zero is all slit. */
  readonly doubleArea: number;
}

export interface WallFace {
  /**
   * Outer ring first, then holes, with the bridges taken out.
   *
   * A ring is not the same thing as a cycle: a stub hanging into a room is walked as a zero-width
   * slit in the room's cycle and must not be emitted as one, so it is dropped here and emitted as a
   * wall line instead. Removing a stalk can also *split* a cycle into more than one ring.
   */
  readonly rings: readonly Ring[];
  /** The cycles the rings came from, outer first. Kept for the area and for hit-testing. */
  readonly cycles: readonly WallCycle[];
  /** Doubled signed area, summed over the cycles. Holes are negative, so this is the net. */
  readonly doubleArea: number;
  /**
   * The walls this face's rings cover, as ascending indices into `graph.edges`.
   *
   * What the bridge criterion is counted from: a wall emits as a line exactly when no *emitted* face
   * covers it. Every face is emitted unless one is suppressed, and then the walls it alone covered
   * have to be found again without it — which needs coverage per face rather than the total.
   */
  readonly ringEdges: readonly number[];
}

export interface WallFaces {
  /** Bounded faces, largest first. The unbounded face has no polygon and is not among them. */
  readonly faces: readonly WallFace[];
  /**
   * Edges no emitted ring covers — the walls that need a line of their own.
   *
   * Indices into `graph.edges`. Every bridge is one, plus a piece of linework that encloses nothing,
   * plus any ring that collapsed below three points. **Every edge is either covered by a ring or in
   * here, exactly once**, which is the invariant that stops linework vanishing from both outputs.
   */
  readonly walls: readonly number[];
  /** Edges with the same face on both sides. */
  readonly bridges: number;
  /** Faces whose rings enclose nothing at all. Counted, never dropped — a sliver is the GM's. */
  readonly degenerateFaces: number;
  /**
   * Rings of fewer than three points, which cannot be a shape. Their edges fall through to walls.
   *
   * **Defence in depth, and not isolated by a test.** Reaching it needs a loop of two half-edges,
   * which needs two distinct walls on the same pair of vertices — and those are coincident, so they
   * enclose nothing and never become a face in the first place. Said plainly rather than left
   * looking like something the suite covers.
   */
  readonly droppedRings: number;
  /** Closed walks found, bounded and unbounded together. */
  readonly cycles: number;
  /** Cycles with positive area — one per bounded face. */
  readonly enclosing: number;
  /** Outward-facing cycles. Exactly one per piece of linework, so it must equal `components`. */
  readonly outward: number;
  /**
   * Boundary cycles of the unbounded face — pieces of linework nested inside nothing.
   *
   * **One per connected piece of linework nested inside nothing**, which since 2026-09-08 is the
   * ordinary case rather than a warning sign. It used to be exactly one on every graph, because the
   * border frame enclosed everything; with the frame gone a map showing two separate buildings has
   * two, and that is correct. Counted rather than asserted, for that reason.
   */
  readonly unbounded: number;
  /** Connected pieces of linework, counting only vertices that have an edge. */
  readonly components: number;
  /** Vertices with at least one edge. Merging leaves unreferenced ids behind, and they are not it. */
  readonly vertices: number;
  /** Segments the traversal ran on — the graph's, less any of no length. */
  readonly edges: number;
  /**
   * The graph's index for each segment the traversal ran on.
   *
   * **A half-edge id is not a graph edge index**, and this is the translation. The traversal numbers
   * only the segments it walked, so once a segment of no length has been left out every later id is
   * shifted — and a caller that took `half >> 1` as an index into `graph.edges` would act on the wall
   * next door. Half-edge `h` belongs to `graph.edges[sourceEdges[h >> 1]]`, running from its `a` to
   * its `b` when `h` is even and back when odd.
   */
  readonly sourceEdges: readonly number[];
  /** Segments whose ends are at the same point, so they have no heading to sort by. */
  readonly zeroLength: number;
  /** Whether V − E + enclosing = components. */
  readonly eulerHolds: boolean;
}

const twin = (half: number): number => half ^ 1;

/**
 * Walk the wall graph into faces.
 *
 * Everything here is O(E) or O(E log d) except the containment pass, which is the number of pieces
 * of linework times the number of rooms and is pre-filtered by bounding box. On a real map that is a
 * few hundred against a few dozen, which is nothing beside the traversal.
 */
export function buildWallFaces(graph: WallGraph): WallFaces {
  const nodes = graph.nodes;

  /*
    A segment of no length has no heading, so it cannot take a place in the rotation at either end —
    and one that did would put an arbitrary direction into the only geometric decision the walk
    makes. The editing operations cannot produce one (a merge drops the wall it closes up, and an
    insert drops repeated points), so this is a guard against a decoded document rather than an
    expected case. Left out of the traversal, counted, and emitted as a wall like anything else the
    rings do not cover, so nothing disappears silently.
  */
  const edges: { a: number; b: number }[] = [];
  const sourceOf: number[] = [];
  let zeroLength = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    const { a, b } = graph.edges[i]!;
    const from = nodes[a]!;
    const to = nodes[b]!;
    if (a === b || (from.x === to.x && from.y === to.y)) {
      zeroLength += 1;
      continue;
    }
    edges.push({ a, b });
    sourceOf.push(i);
  }

  const halfEdgeCount = edges.length * 2;
  const originNode = (half: number): number => {
    const edge = edges[half >> 1]!;
    return (half & 1) === 0 ? edge.a : edge.b;
  };
  const targetNode = (half: number): number => originNode(twin(half));

  // Departing half-edges at each vertex, sorted by heading. The walk's only geometric decision.
  const heading = new Float64Array(halfEdgeCount);
  const departing: number[][] = nodes.map(() => []);
  for (let half = 0; half < halfEdgeCount; half++) {
    const from = nodes[originNode(half)]!;
    const to = nodes[targetNode(half)]!;
    heading[half] = Math.atan2(to.y - from.y, to.x - from.x);
    departing[originNode(half)]!.push(half);
  }
  const slotOf = new Int32Array(halfEdgeCount).fill(-1);
  for (const list of departing) {
    list.sort((left, right) => heading[left]! - heading[right]!);
    list.forEach((half, index) => {
      slotOf[half] = index;
    });
  }

  /**
   * Leave a vertex by the entry *before* the one just arrived along, in ascending-heading order.
   *
   * Before, not after — the same rule as stage one and for the same reason. It is invisible wherever
   * a vertex has two walls meeting at it, which is every plain room, and shows up first at a
   * junction: the successor rule walks a stub hanging into a room as part of the band *outside* it.
   */
  const next = (half: number): number => {
    const back = twin(half);
    const list = departing[targetNode(half)]!;
    return list[(slotOf[back]! + list.length - 1) % list.length]!;
  };

  const cycleOf = new Int32Array(halfEdgeCount).fill(-1);
  const walks: { halfEdges: number[]; points: Vector2[] }[] = [];

  for (let start = 0; start < halfEdgeCount; start++) {
    if (cycleOf[start] !== -1) continue;
    const index = walks.length;
    const halfEdges: number[] = [];
    const points: Vector2[] = [];
    let half = start;
    do {
      cycleOf[half] = index;
      halfEdges.push(half);
      points.push(nodes[originNode(half)]!);
      half = next(half);
    } while (half !== start);
    walks.push({ halfEdges, points });
  }

  const cycles: WallCycle[] = walks.map((walk, index) => {
    let doubleArea = 0;
    for (const half of walk.halfEdges) {
      // A half-edge whose twin is in this same cycle is one side of a slit. Its term and its twin's
      // are exact negations, so leaving both out is exact where adding both is not.
      if (cycleOf[twin(half)] === index) continue;
      const from = nodes[originNode(half)]!;
      const to = nodes[targetNode(half)]!;
      doubleArea += from.x * to.y - to.x * from.y;
    }
    return { halfEdges: walk.halfEdges, points: walk.points, doubleArea };
  });

  // Pieces of linework, over the vertices that actually have an edge.
  const parent = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) parent[i] = i;
  const find = (start: number): number => {
    let at = start;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  const referenced = new Uint8Array(nodes.length);
  for (const edge of edges) {
    referenced[edge.a] = 1;
    referenced[edge.b] = 1;
    const rootA = find(edge.a);
    const rootB = find(edge.b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }
  const roots = new Set<number>();
  let vertices = 0;
  for (let id = 0; id < nodes.length; id++) {
    if (referenced[id] !== 1) continue;
    vertices += 1;
    roots.add(find(id));
  }
  const componentOfCycle = cycles.map((cycle) => find(originNode(cycle.halfEdges[0]!)));

  const enclosing: number[] = [];
  const outwardCycles: number[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (cycles[i]!.doubleArea > 0) enclosing.push(i);
    else outwardCycles.push(i);
  }

  const bounds = enclosing.map((index) => boundingBox(cycles[index]!.points));

  /*
    Which face each outward cycle is a hole of: the smallest enclosing cycle that contains it, from
    some other piece of linework. Nested containment is a total order, so "smallest" is "innermost"
    and there is nothing to disambiguate.
  */
  const holesOf = new Map<number, number[]>();
  let unbounded = 0;
  for (const index of outwardCycles) {
    const cycle = cycles[index]!;
    const point = cycle.points[0]!;
    const component = componentOfCycle[index]!;
    let best = -1;
    let bestArea = Infinity;
    for (let slot = 0; slot < enclosing.length; slot++) {
      const candidate = enclosing[slot]!;
      if (componentOfCycle[candidate] === component) continue;
      const area = cycles[candidate]!.doubleArea;
      if (area >= bestArea) continue;
      const box = bounds[slot]!;
      if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) {
        continue;
      }
      if (!containsPoint(cycles[candidate]!.points, point)) continue;
      best = candidate;
      bestArea = area;
    }
    if (best < 0) {
      unbounded += 1;
      continue;
    }
    const list = holesOf.get(best);
    if (list) list.push(index);
    else holesOf.set(best, [index]);
  }

  // Which face lies on each side of each wall, so the bridges can be found.
  const faceOfHalfEdge = new Int32Array(halfEdgeCount).fill(-1);
  const faceCycles: number[][] = enclosing.map((index) => [index, ...(holesOf.get(index) ?? [])]);
  faceCycles.forEach((list, face) => {
    for (const index of list) {
      for (const half of cycles[index]!.halfEdges) faceOfHalfEdge[half] = face;
    }
  });

  const bridgeEdges = new Uint8Array(edges.length);
  let bridges = 0;
  for (let edge = 0; edge < edges.length; edge++) {
    if (faceOfHalfEdge[edge * 2] !== faceOfHalfEdge[edge * 2 + 1]) continue;
    bridgeEdges[edge] = 1;
    bridges += 1;
  }

  const covered = new Uint8Array(edges.length);
  let droppedRings = 0;

  const faces: WallFace[] = faceCycles.map((list) => {
    const rings: Ring[] = [];
    const ringEdges = new Set<number>();
    for (const index of list) {
      for (const loop of decomposeRings(cycles[index]!, bridgeEdges, originNode, targetNode)) {
        if (loop.length < MIN_RING_POINTS) {
          droppedRings += 1;
          continue;
        }
        rings.push(loop.map((half) => nodes[originNode(half)]!));
        for (const half of loop) {
          covered[half >> 1] = 1;
          ringEdges.add(sourceOf[half >> 1]!);
        }
      }
    }
    const faceCycleList = list.map((index) => cycles[index]!);
    const doubleArea = faceCycleList.reduce((total, cycle) => total + cycle.doubleArea, 0);
    return {
      rings,
      cycles: faceCycleList,
      doubleArea,
      ringEdges: [...ringEdges].sort((left, right) => left - right),
    };
  });

  const walls: number[] = [];
  for (let edge = 0; edge < edges.length; edge++) {
    if (covered[edge] !== 1) walls.push(sourceOf[edge]!);
  }
  for (let i = 0; i < graph.edges.length; i++) {
    const { a, b } = graph.edges[i]!;
    const from = nodes[a]!;
    const to = nodes[b]!;
    if (a === b || (from.x === to.x && from.y === to.y)) walls.push(i);
  }
  walls.sort((left, right) => left - right);

  faces.sort((left, right) => right.doubleArea - left.doubleArea);

  return {
    faces,
    walls,
    bridges,
    degenerateFaces: faces.filter((face) => face.doubleArea === 0).length,
    droppedRings,
    cycles: cycles.length,
    enclosing: enclosing.length,
    outward: outwardCycles.length,
    unbounded,
    components: roots.size,
    vertices,
    edges: edges.length,
    sourceEdges: sourceOf,
    zeroLength,
    eulerHolds: vertices - edges.length + enclosing.length === roots.size,
  };
}

/**
 * The uncovered walls as geometry — one pair of points each.
 *
 * A convenience, and it lives here rather than at the two call sites because that is the whole of
 * it: `walls` holds *indices*, both the preview and the emit path want points, and index arithmetic
 * repeated in two places is index arithmetic that can disagree in one. A wall drawn from the wrong
 * pair of vertices is a line across the map that looks like a decision somebody made.
 */
export function wallSegments(
  graph: WallGraph,
  faces: WallFaces,
): readonly (readonly [Vector2, Vector2])[] {
  const out: (readonly [Vector2, Vector2])[] = [];
  for (const index of faces.walls) {
    const edge = graph.edges[index];
    if (!edge) continue;
    const from = graph.nodes[edge.a];
    const to = graph.nodes[edge.b];
    if (from && to) out.push([from, to]);
  }
  return out;
}

/**
 * Take the bridges out of a cycle and close up what is left.
 *
 * **A graph operation, not a linear one**, and the two cases that look identical in the walk need
 * opposite handling. Skip a plain stub — out and straight back — and the boundary either side of it
 * is contiguous, so the ring carries on. Skip the stalk of a lollipop, a room on the end of a stub,
 * and it is not: what was one boundary around building-plus-lollipop becomes two, one around each.
 * A scan that cuts at every omitted half-edge gets the first wrong; one that never cuts gets the
 * second wrong, and that is the one a real map exposed in stage one — a ring running across the map
 * to unrelated vertices, skipping long stretches of wall.
 *
 * What settles it: an excursion always comes back, so once the bridges are gone every vertex has as
 * many kept half-edges arriving as leaving. Following unused departures from each arrival therefore
 * finds closed loops and nothing else.
 */
function decomposeRings(
  cycle: WallCycle,
  bridgeEdges: Uint8Array,
  originNode: (half: number) => number,
  targetNode: (half: number) => number,
): number[][] {
  const kept = cycle.halfEdges.filter((half) => bridgeEdges[half >> 1] !== 1);
  if (kept.length === 0) return [];

  const departures = new Map<number, number[]>();
  for (const half of kept) {
    const from = originNode(half);
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

  const loops: number[][] = [];
  for (const first of kept) {
    if (taken.has(first)) continue;
    const loop: number[] = [];
    let half: number | null = first;
    while (half !== null) {
      taken.add(half);
      loop.push(half);
      half = nextFrom(targetNode(half));
    }
    loops.push(loop);
  }
  return loops;
}

function boundingBox(points: readonly Vector2[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Whether a point lies inside a closed polygon. Plain crossing number.
 *
 * No on-boundary handling, and neither caller needs any. **Containment grouping** asks it about a
 * point of one piece of linework against a polygon of another, and two pieces share no vertex. A
 * vertex of one lying exactly on an *edge* of another would be on the boundary — and cannot reach
 * here, because the planarity sweep splits that meeting into a shared node, which makes them one
 * piece. **Dissolve region** asks it about a click, which lands exactly on a wall only by accident,
 * and either answer there is one of the two regions the wall divides.
 *
 * **A walked cycle can be handed in as it stands**, slits and all. A slit is walked out and back, so a
 * ray crosses its two sides together or not at all and they cancel; and a room hanging off the
 * boundary is walked as a loop of its own inside the outer one, so a ray from a point inside it
 * crosses each loop an odd number of times, the total is even, and the point reads as outside. That is what lets a click inside an inner room or a lollipop's head choose that room
 * rather than the one around it.
 */
export function containsPoint(polygon: readonly Vector2[], point: Vector2): boolean {
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

/** One line for the log, in the same shape as stage one's area check. */
export function describeWallFaces(result: WallFaces): string {
  const head = result.eulerHolds
    ? `${result.faces.length} faces from ${result.edges} walls, Euler holds`
    : `${result.faces.length} faces from ${result.edges} walls — EULER FAILED ` +
      `(${result.vertices} − ${result.edges} + ${result.enclosing} ≠ ${result.components})`;
  const notes: string[] = [`${result.bridges} bridges`, `${result.walls.length} wall lines`];
  if (result.outward !== result.components) {
    notes.push(`outward cycles ${result.outward} against ${result.components} pieces of linework`);
  }
  if (result.unbounded !== 1) notes.push(`${result.unbounded} cycles outside everything`);
  if (result.degenerateFaces > 0) notes.push(`${result.degenerateFaces} faces enclosing nothing`);
  if (result.droppedRings > 0) notes.push(`${result.droppedRings} rings too small to be a shape`);
  if (result.zeroLength > 0) notes.push(`${result.zeroLength} walls of no length`);
  return `${head} — ${notes.join(", ")}`;
}
