/**
 * Collapsing small regions: which regions qualify, and what taking one does to the walls.
 *
 * ## What it is for
 *
 * Detail drawn alongside a wall — a line of texture just inside it, a pebble against it — encloses
 * cells too small to be rooms, and a map with a lot of it has a lot of them (user, 2026-09-21).
 * **Dissolve region is the wrong tool for these**: it takes every wall around the clicked region, and
 * a cell against a building's outer wall includes that wall, so the room beside it joins the outside
 * and can never be revealed.
 *
 * ## The star — user's proposal, 2026-09-21
 *
 * **The region's walls go, and a new vertex at its middle is joined to every vertex where a wall ran
 * off elsewhere.** Nothing else moves: the vertices those outside walls end at stay where they are,
 * so every region around the collapsed one keeps its shape everywhere except inside the collapsed
 * region's own outline, where its boundary now dips to the centre. *"A circle with many connections
 * collapses into a star."*
 *
 * - **The centre is the average of the connections** (user): there is no better answer to where it
 *   should be, and in the commonest case — a cell against a straight wall, touching it at two points
 *   — the average of those two lies on the wall, so the wall stays exactly where it was drawn.
 * - **Two connections make a straight wall through its own midpoint**, which Straighten removes at
 *   its smallest amount — the user's reason for not special-casing it.
 * - **Fewer than two, no centre.** One connection is a loop hanging off a vertex, and nothing is a
 *   loop touching nothing — a pebble drawn as a circle. Both just go; a single spoke would be a new
 *   dead end.
 *
 * ## What qualifies, and the one check
 *
 * **Area inside the region's outer boundary, holes included** (user: *"we are really looking for
 * things with small area, that are visually small, whatever their shape"*). Holes included because a
 * wall drawn as two parallel lines makes a thin ring of region round a whole room; its own area is
 * small, and collapsing it would delete the room inside with everything else in it.
 *
 * **Every spoke must stay inside the region**, which is the whole of the geometric check. A convex
 * region passes by construction. A spoke that left the region — from a C-shaped sliver whose centre
 * lies in the room it curls round — would slice that room into wedges **without crossing a single
 * wall**, since the region's own walls are the ones being deleted, so no crossing test could catch it.
 * And a spoke that stays inside cannot cross anything, because everything inside goes with the region.
 * A region that fails is simply not offered.
 *
 * **Everything inside goes with it.** It is inside something under the limit, so it is under the limit
 * too, and leaving it would strand walls in space the spokes are about to divide.
 *
 * ## Why no two regions can merge
 *
 * Only the collapsed region's own walls are deleted; every wall between two other regions stays. What
 * changes is where each neighbour's boundary runs *inside the collapsed outline*, and that is two
 * spokes meeting at the centre. **Euler's identity pins the count**: one vertex arrives, the walls
 * deleted equal the spokes added when every outline vertex is a connection, and one region goes — so
 * a neighbour touching the region in two places ends up touching *itself* at the centre rather than
 * splitting in two. The oracle checks both, on every collapse of every random graph.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { regionAt, simpleLoops } from "./dissolve";
import { segmentMeeting } from "./planarGraph";
import { insertEdge, removeEdges, type EditResult } from "./planarOps";
import { buildWallFaces, containsPoint, type WallFaces } from "./wallFaces";
import { documentPoint, type WallGraph } from "./wallGraph";

/**
 * How close a point may be to a line to count as on it, in graph units.
 *
 * A pixel on a 10,000-pixel map is 1e-4 of the longer side, so this is a thousandth of one. It is
 * a few float32 steps at the scale of the map, which is what a centre quantised on its way into the
 * document can be off the line through its two connections.
 */
const ON_TOLERANCE = 1e-7;

export interface Collapse {
  /** Which of `faces.faces`. Meaningful only against the traversal it was found in. */
  readonly face: number;
  /** Area inside the region's outer boundary, holes included, in graph units squared. */
  readonly area: number;
  /** The loop that goes round the region, in walk order. Graph units. */
  readonly outline: readonly Vector2[];
  /** The walls that go: the region's own and everything inside it. Ascending indices into `graph.edges`. */
  readonly edges: readonly number[];
  /** The vertices a wall runs off elsewhere from, in order round the outline. */
  readonly connections: readonly number[];
  /** Where the spokes meet, quantised as a stored point is, or `null` with fewer than two connections. */
  readonly centre: Vector2 | null;
  /** Every vertex the collapse touches, so one round's collapses can be kept apart. */
  readonly vertices: readonly number[];
}

/** What is known about a region before the limit is consulted, worked out once per traversal. */
interface Outline {
  /** The one loop around the region, as node ids in walk order; `null` when there is not exactly one. */
  readonly loop: readonly number[] | null;
  readonly area: number;
}

const outlinesOf = new WeakMap<WallFaces, readonly Outline[]>();
const detailsOf = new WeakMap<WallFaces, Map<number, Collapse | null>>();

/**
 * The loop around each region and the area inside it.
 *
 * The outer cycle is split into simple loops as Dissolve splits it: the traversal keeps the region on
 * the same side of every half-edge, so a loop around the region is positive, a loop around something
 * it surrounds — a room joined to its boundary — is negative, and a slit walked out and back is zero.
 * **Exactly one positive loop** is what an ordinary region has. Anything else is not offered, which
 * is the safe answer to a shape nobody has met.
 *
 * **Measured as never deciding anything on a valid graph** (2026-09-21): 9,521 regions over 2,100
 * random graphs of both generators, every one with exactly one. That is also what the topology says —
 * a region is connected, so its outer boundary can go round it only once — and a mutation accepting
 * several survived for that reason. Kept as defence in depth against a graph that is not valid.
 */
function outlines(graph: WallGraph, faces: WallFaces): readonly Outline[] {
  const cached = outlinesOf.get(faces);
  if (cached) return cached;

  const edgeOf = (half: number) => graph.edges[faces.sourceEdges[half >> 1]!]!;
  const origin = (half: number): number => ((half & 1) === 0 ? edgeOf(half).a : edgeOf(half).b);
  const target = (half: number): number => origin(half ^ 1);

  const found = faces.faces.map((face): Outline => {
    const outer = face.cycles[0];
    if (!outer) return { loop: null, area: 0 };
    let around: number[] | null = null;
    let area = 0;
    let positives = 0;
    for (const loop of simpleLoops(outer.halfEdges, origin, target)) {
      let doubleArea = 0;
      for (const half of loop) {
        const from = graph.nodes[origin(half)]!;
        const to = graph.nodes[target(half)]!;
        doubleArea += from.x * to.y - to.x * from.y;
      }
      if (!(doubleArea > 0)) continue;
      positives += 1;
      around = loop.map(origin);
      area = doubleArea / 2;
    }
    return positives === 1 ? { loop: around, area } : { loop: null, area: 0 };
  });
  outlinesOf.set(faces, found);
  return found;
}

/** Every edge meeting each vertex, worked out once per graph. */
const incidenceOf = new WeakMap<WallGraph, readonly (readonly number[])[]>();

function incidence(graph: WallGraph): readonly (readonly number[])[] {
  const cached = incidenceOf.get(graph);
  if (cached) return cached;
  const around: number[][] = graph.nodes.map(() => []);
  graph.edges.forEach((edge, index) => {
    around[edge.a]?.push(index);
    if (edge.b !== edge.a) around[edge.b]?.push(index);
  });
  incidenceOf.set(graph, around);
  return around;
}

/**
 * The walls bucketed by where they lie, worked out once per graph.
 *
 * **Measured before it was built** (2026-09-21): every region asked about every wall twice — once for
 * what lies inside it, once for what its spokes might meet — and on a mesh of 2,500 regions and 7,000
 * walls *Collapse all* at the top of the track took **14 to 15 seconds**, which is a frozen page. The
 * drag was never the problem; the far right of the track is reachable on purpose, and a press there
 * was. Span met the same thing and answered it the same way.
 *
 * Square cells, about as many as there are walls, over the walls' bounds. A wall goes in every cell its
 * bounds touch, so a query for a box returns every wall whose bounds meet it — a superset, which each
 * caller then tests exactly as it did when it looked at all of them.
 */
interface EdgeGrid {
  readonly minX: number;
  readonly minY: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly buckets: readonly (readonly number[])[];
}

const gridOf = new WeakMap<WallGraph, EdgeGrid>();

function edgeGrid(graph: WallGraph): EdgeGrid {
  const cached = gridOf.get(graph);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const edge of graph.edges) {
    for (const id of [edge.a, edge.b]) {
      const point = graph.nodes[id]!;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!(maxX >= minX)) {
    const empty = { minX: 0, minY: 0, cell: 1, cols: 0, rows: 0, buckets: [] };
    gridOf.set(graph, empty);
    return empty;
  }
  const side = Math.max(1, Math.ceil(Math.sqrt(graph.edges.length)));
  const cell = Math.max(maxX - minX, maxY - minY, 1e-12) / side;
  const cols = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxY - minY) / cell) + 1;
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  const grid = { minX, minY, cell, cols, rows, buckets };
  graph.edges.forEach((edge, index) => {
    const a = graph.nodes[edge.a]!;
    const b = graph.nodes[edge.b]!;
    const [c0, c1] = spanOf(grid, Math.min(a.x, b.x), Math.max(a.x, b.x), "x");
    const [r0, r1] = spanOf(grid, Math.min(a.y, b.y), Math.max(a.y, b.y), "y");
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) buckets[row * cols + col]!.push(index);
    }
  });
  gridOf.set(graph, grid);
  return grid;
}

/** The first and last cell a stretch of one axis falls in, clamped to the grid. */
function spanOf(grid: Omit<EdgeGrid, "buckets">, low: number, high: number, axis: "x" | "y"): [number, number] {
  const origin = axis === "x" ? grid.minX : grid.minY;
  const count = axis === "x" ? grid.cols : grid.rows;
  const clamp = (value: number) => Math.min(count - 1, Math.max(0, Math.floor((value - origin) / grid.cell)));
  return [clamp(low), clamp(high)];
}

/** Every wall whose bounds could meet a box, each once. A superset: callers test what they get. */
function edgesNear(graph: WallGraph, minX: number, minY: number, maxX: number, maxY: number): number[] {
  const grid = edgeGrid(graph);
  if (grid.cols === 0) return [];
  const [c0, c1] = spanOf(grid, minX, maxX, "x");
  const [r0, r1] = spanOf(grid, minY, maxY, "y");
  const found = new Set<number>();
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) for (const index of grid.buckets[row * grid.cols + col]!) found.add(index);
  }
  return [...found];
}

/** Distance from a point to a segment, in graph units. */
function distanceToSegment(point: Vector2, from: Vector2, to: Vector2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
      : 0;
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function onOutline(point: Vector2, outline: readonly Vector2[]): boolean {
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    if (distanceToSegment(point, outline[j]!, outline[i]!) <= ON_TOLERANCE) return true;
  }
  return false;
}

function insideOrOn(point: Vector2, outline: readonly Vector2[]): boolean {
  return onOutline(point, outline) || containsPoint(outline, point);
}

/**
 * Whether the segment from `from` to `to` lies inside the closed outline — on its boundary counts.
 *
 * Cut at every place it meets the outline — each outline vertex lying on it, and each outline edge it
 * crosses — and then the middle of every piece has to be inside or on. A piece that left the outline
 * has its middle outside; a piece running along the boundary has its middle on it, which is allowed,
 * because the boundary is the region's own walls and they are the ones being replaced.
 */
function segmentWithin(from: Vector2, to: Vector2, outline: readonly Vector2[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0)) return false;
  const along = (point: Vector2): number =>
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;

  const cuts = [0, 1];
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const p = outline[j]!;
    const q = outline[i]!;
    if (distanceToSegment(q, from, to) <= ON_TOLERANCE) cuts.push(along(q));
    // Where the segment crosses this outline edge, if it does so properly.
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const denominator = dx * sy - dy * sx;
    if (Math.abs(denominator) <= 1e-18) continue;
    const t = ((p.x - from.x) * sy - (p.y - from.y) * sx) / denominator;
    const u = ((p.x - from.x) * dy - (p.y - from.y) * dx) / denominator;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((left, right) => left - right);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const low = Math.max(0, cuts[i]!);
    const high = Math.min(1, cuts[i + 1]!);
    if (high - low <= 1e-12) continue;
    const middle = (low + high) / 2;
    if (!insideOrOn({ x: from.x + middle * dx, y: from.y + middle * dy }, outline)) return false;
  }
  return true;
}

/**
 * Whether the spokes meet no wall that stays, by the crossing predicate every edit's sweep uses.
 *
 * **Staying inside the region is not quite enough, and a sweep found why** (2026-09-21). Two vertices
 * a float32 step apart — 1e-8 of the map — can sit either side of a region's boundary, one a
 * connection and one not, and a spoke to the first passes within that distance of the second. The
 * containment test calls that inside; the edit's sweep calls it a touch, splits the spoke there, and
 * leaves a segment doubling one already stored. Asking the sweep's own question here means what is
 * offered is exactly what the sweep will leave alone.
 *
 * A wall that stays and ends at a spoke's own connection is not a meeting — sharing a vertex is how
 * the spoke attaches — unless it lies along the spoke, which the predicate calls an overlap.
 *
 * **Spokes lying along one another need no check of their own**, and one was here until a mutation
 * disabling it survived. Two spokes overlap only when one connection sits on the other's spoke — and
 * a connection is by definition a vertex with a wall that stays, so that wall touches the spoke and
 * the loop below refuses it first.
 */
function spokesMeetNothing(
  graph: WallGraph,
  going: ReadonlySet<number>,
  centre: Vector2,
  ends: readonly Vector2[],
): boolean {
  for (const end of ends) {
    const minX = Math.min(centre.x, end.x) - ON_TOLERANCE;
    const maxX = Math.max(centre.x, end.x) + ON_TOLERANCE;
    const minY = Math.min(centre.y, end.y) - ON_TOLERANCE;
    const maxY = Math.max(centre.y, end.y) + ON_TOLERANCE;
    for (const index of edgesNear(graph, minX, minY, maxX, maxY)) {
      if (going.has(index)) continue;
      const edge = graph.edges[index]!;
      const a = graph.nodes[edge.a]!;
      const b = graph.nodes[edge.b]!;
      if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX) continue;
      if (Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
      if (segmentMeeting(centre, end, a, b)) return false;
    }
  }
  return true;
}

/**
 * Everything about collapsing one region, or `null` when it cannot be offered.
 *
 * Worked out once per region per traversal and kept, so a handle moving across the track costs a
 * filter over the areas plus this for regions it has not reached before.
 */
function detail(graph: WallGraph, faces: WallFaces, face: number, outline: Outline): Collapse | null {
  const loop = outline.loop;
  if (!loop) return null;
  const points = loop.map((id) => graph.nodes[id]!);

  // The region's own walls: every edge any of its cycles walks, holes included.
  const going = new Set<number>();
  for (const cycle of faces.faces[face]!.cycles) {
    for (const half of cycle.halfEdges) going.add(faces.sourceEdges[half >> 1]!);
  }

  // And everything inside it. An edge whose middle is strictly inside the outline lies wholly inside,
  // since the graph is planar and the outline is made of its walls.
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
  for (const index of edgesNear(graph, minX, minY, maxX, maxY)) {
    if (going.has(index)) continue;
    const edge = graph.edges[index]!;
    const a = graph.nodes[edge.a]!;
    const b = graph.nodes[edge.b]!;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (middle.x < minX || middle.x > maxX || middle.y < minY || middle.y > maxY) continue;
    if (containsPoint(points, middle) && !onOutline(middle, points)) going.add(index);
  }

  const around = incidence(graph);
  const connections = loop.filter((id) => around[id]!.some((edge) => !going.has(edge)));

  let centre: Vector2 | null = null;
  if (connections.length >= 2) {
    let x = 0;
    let y = 0;
    for (const id of connections) {
      x += graph.nodes[id]!.x;
      y += graph.nodes[id]!.y;
    }
    centre = documentPoint(x / connections.length, y / connections.length);
    const ends = connections.map((id) => graph.nodes[id]!);
    for (const end of ends) {
      /*
        A centre on a connection would make a spoke of no length. Exactly on one, the containment test
        below refuses it anyway; within a float32 step or two it would leave a vertex a hair from
        another, which is what the meeting check exists to keep out. **Defence in depth, and not
        isolated by a test** — a mutation removing it survived, since the connections have to average
        onto one of themselves to reach it. Said plainly rather than left looking covered.
      */
      if (Math.hypot(end.x - centre.x, end.y - centre.y) <= ON_TOLERANCE) return null;
      if (!segmentWithin(centre, end, points)) return null;
    }
    if (!spokesMeetNothing(graph, going, centre, ends)) return null;
  }

  const vertices = new Set<number>(loop);
  for (const index of going) {
    vertices.add(graph.edges[index]!.a);
    vertices.add(graph.edges[index]!.b);
  }

  return {
    face,
    area: outline.area,
    outline: points,
    edges: [...going].sort((left, right) => left - right),
    connections,
    centre,
    vertices: [...vertices],
  };
}

/** `detail`, cached per face per traversal — the one path both a size-gated search and a direct click use. */
function detailFor(graph: WallGraph, faces: WallFaces, face: number, outline: Outline): Collapse | null {
  let cache = detailsOf.get(faces);
  if (!cache) {
    cache = new Map();
    detailsOf.set(faces, cache);
  }
  let collapse = cache.get(face);
  if (collapse === undefined) {
    collapse = detail(graph, faces, face, outline);
    cache.set(face, collapse);
  }
  return collapse;
}

/**
 * The regions a limit would collapse, smallest first.
 *
 * `faces` must be the traversal of `graph`. `limit` is an area in graph units squared, and a region
 * exactly at it qualifies. A region whose spokes would leave it is not offered at any limit.
 */
export function findCollapses(graph: WallGraph, faces: WallFaces, limit: number): Collapse[] {
  if (!(limit > 0)) return [];
  const known = outlines(graph, faces);
  const found: Collapse[] = [];
  known.forEach((outline, face) => {
    if (!outline.loop || outline.area > limit) return;
    const collapse = detailFor(graph, faces, face, outline);
    if (collapse) found.push(collapse);
  });
  return found.sort((left, right) => left.area - right.area || left.face - right.face);
}

/**
 * Everything about collapsing the region at a point, **with no size limit at all** — for a direct
 * click on a region the ring never offered because it is bigger than the drawer's own setting.
 *
 * The limit only ever decided which regions a size-gated search rings; whether a region *can*
 * collapse — its spokes staying inside it, meeting no wall that stays — has never depended on its
 * area. This is that same check, asked of one region rather than filtered from all of them.
 */
export function collapseAt(graph: WallGraph, faces: WallFaces, point: Vector2): Collapse | null {
  const face = regionAt(faces, point);
  if (face === null) return null;
  // `outlines` maps `faces.faces` one for one, and `face` is `regionAt`'s own index into it — never
  // out of range. `detail` (through `detailFor`) is what refuses a face with no simple outline.
  return detailFor(graph, faces, face, outlines(graph, faces)[face]!);
}

/**
 * Collapse several regions of one graph at once. They must share no vertex, which `collapseAll`
 * guarantees and a single click trivially satisfies.
 *
 * Every wall that goes is removed first, then each star is added through `insertEdge`, so the spokes
 * go through the same crossing sweep every added wall does. The sweep should find nothing — a spoke
 * inside its region has nothing left to cross — and it is there because every edit here goes through
 * it, not because anything is expected of it.
 */
export function applyCollapses(graph: WallGraph, collapses: readonly Collapse[]): EditResult {
  const going = new Set<number>();
  for (const collapse of collapses) for (const edge of collapse.edges) going.add(edge);
  let result: EditResult = removeEdges(graph, going);
  let splits = 0;
  let overlaps = 0;
  for (const collapse of collapses) {
    if (!collapse.centre) continue;
    for (const id of collapse.connections) {
      const next = insertEdge(result.graph, [collapse.centre, graph.nodes[id]!]);
      splits += next.splits;
      overlaps += next.overlaps;
      result = next;
    }
  }
  return { graph: result.graph, splits, overlaps };
}

export interface CollapseAll extends EditResult {
  /** Regions collapsed, over every round. */
  readonly collapsed: number;
  readonly rounds: number;
  /**
   * A round failed to reduce the number of regions, which a correct collapse cannot do. That round is
   * undone — the graph and the counts are as they were before it — and the caller says so.
   */
  readonly stopped: boolean;
}

/**
 * A point strictly inside a simple outline, or `null` if none could be found.
 *
 * The standard construction: the lowest-leftmost vertex is convex, so the triangle it makes with its
 * two neighbours pokes into the region. If no other vertex lies in that triangle its centroid is
 * inside; otherwise the midpoint between the vertex and the deepest one in the triangle is. Checked
 * against the outline all the same, with a lattice over the bounds as the fallback, because a region
 * with no point to identify it by is simply not carried into later rounds.
 */
function interiorPoint(outline: readonly Vector2[]): Vector2 | null {
  const n = outline.length;
  if (n < 3) return null;
  let v = 0;
  for (let i = 1; i < n; i++) {
    const p = outline[i]!;
    const best = outline[v]!;
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) v = i;
  }
  const a = outline[(v + n - 1) % n]!;
  const b = outline[v]!;
  const c = outline[(v + 1) % n]!;
  const side = (p: Vector2, q: Vector2, r: Vector2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const turn = side(a, b, c);
  let deepest: Vector2 | null = null;
  let depth = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i === v || i === (v + n - 1) % n || i === (v + 1) % n) continue;
    const p = outline[i]!;
    const inTriangle =
      Math.sign(side(a, b, p)) !== -Math.sign(turn) &&
      Math.sign(side(b, c, p)) !== -Math.sign(turn) &&
      Math.sign(side(c, a, p)) !== -Math.sign(turn);
    if (!inTriangle) continue;
    const distance = Math.abs(side(a, c, p));
    if (distance > depth) {
      depth = distance;
      deepest = p;
    }
  }
  const guess = deepest
    ? { x: (b.x + deepest.x) / 2, y: (b.y + deepest.y) / 2 }
    : { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
  if (containsPoint(outline, guess) && !onOutline(guess, outline)) return guess;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  for (let i = 1; i < 32; i++) {
    for (let j = 1; j < 32; j++) {
      const p = { x: minX + ((maxX - minX) * i) / 32, y: minY + ((maxY - minY) * j) / 32 };
      if (containsPoint(outline, p) && !onOutline(p, outline)) return p;
    }
  }
  return null;
}

/**
 * Collapse every region ringed at the press that is still under the limit — the drawer's button, as
 * one edit.
 *
 * **In rounds.** Two small regions side by side share walls, so collapsing one changes the other, and
 * a round takes the smallest first and skips any that shares a vertex with one already taken. The
 * search then runs again on what is left.
 *
 * **Only regions that were ringed when it was pressed**, and that has to be enforced rather than
 * assumed. It looked automatic: a collapse only grows its neighbours, so nothing over the limit can
 * come under it. **A sweep at four times its usual size found the hole** (2026-09-21): a region *under*
 * the limit but refused — its spokes would have left it — changes shape when a neighbour goes, starts
 * qualifying, and was taken in a later round without ever having been ringed. Nine graphs in seven
 * hundred. So each ringed region is remembered by a point inside it, which stays inside it because a
 * surviving region only ever gains area, and later rounds take a region only if it holds one.
 *
 * What it can still do is leave out a ringed region: one that grew past the limit when its neighbour
 * went, or whose spokes now leave it.
 *
 * **It ends**, because every collapse removes a region and adds none, which the oracle asserts rather
 * than this trusting it — and **the loop checks it all the same**: a round that leaves as many regions
 * as it found is undone and the loop stops. Not decoration. Two mutations looped here — walls not
 * removed, and rounds letting neighbours go together — and the second was worse than a loop: stars
 * from neighbours crossed, the sweep split them into new regions, and the count **doubled** every
 * round, 4,588 to 8,854, so a cap on rounds alone would have let it run for minutes. A loop in the
 * workspace freezes the page with the GM's work in it; checking the one invariant bounds both the
 * rounds and the work.
 */
export function collapseAll(graph: WallGraph, limit: number): CollapseAll {
  let current = graph;
  let collapsed = 0;
  let rounds = 0;
  let splits = 0;
  let overlaps = 0;
  let before: { readonly regions: number; readonly result: CollapseAll } | null = null;
  // One point inside each region ringed at the press, and whether that region has gone yet.
  let ringed: { readonly point: Vector2; gone: boolean }[] | null = null;
  for (;;) {
    const faces = buildWallFaces(current);
    if (before && faces.faces.length >= before.regions) return before.result;
    let found = findCollapses(current, faces, limit);
    ringed ??= found.flatMap((collapse) => {
      const point = interiorPoint(collapse.outline);
      return point ? [{ point, gone: false }] : [];
    });
    // Which ringed region each region holding a ringed point is. A region holds at most one: no two
    // regions merge, and the point of one that has gone is retired before it can land in a neighbour.
    const holding = new Map<number, number>();
    ringed.forEach((mark, index) => {
      if (mark.gone) return;
      const face = regionAt(faces, mark.point);
      if (face !== null) holding.set(face, index);
    });
    found = found.filter((collapse) => holding.has(collapse.face));

    const taken: Collapse[] = [];
    const used = new Set<number>();
    for (const collapse of found) {
      if (collapse.vertices.some((id) => used.has(id))) continue;
      taken.push(collapse);
      for (const id of collapse.vertices) used.add(id);
    }
    if (taken.length === 0) break;
    before = {
      regions: faces.faces.length,
      result: { graph: current, splits, overlaps, collapsed, rounds, stopped: true },
    };
    for (const collapse of taken) ringed[holding.get(collapse.face)!]!.gone = true;
    const result = applyCollapses(current, taken);
    current = result.graph;
    splits += result.splits;
    overlaps += result.overlaps;
    collapsed += taken.length;
    rounds += 1;
  }
  return { graph: current, splits, overlaps, collapsed, rounds, stopped: false };
}
