/**
 * Span: the shortest straight wall across an opening, from a click.
 *
 * A GM who wants a wall in a doorway — Dynamic Fog's doors cannot be made from here — clicks in the
 * opening, and the tool finds the wall (user, 2026-09-16).
 *
 * ## Two candidates, and a preference for the click
 *
 * - **Through** — the shortest wall whose line passes exactly through the click, ending at the first
 *   wall met on each side. Because it ends at the first wall, it can never cross one.
 * - **Near** — the shortest wall within a few screen pixels of the click that **ends at a vertex** on
 *   at least one side: between two vertices, or from a vertex square onto a wall.
 *
 * **The near wall is taken only when it is at most two-thirds the length of the through wall** (user).
 * Through alone fails on the commonest doorway: two wall ends facing each other get their door only
 * from a click exactly on the line joining them, and a click a pixel off it reaches across the room
 * instead. Near alone would pull a click in a corridor onto some small kink in a wall nearby. The
 * factor is what lets a doorway's jambs win and a kink lose — and a doorway into an alcove barely
 * deeper than the door is wide, where the crooked through wall is only half as long again as the door,
 * still gets the door.
 *
 * **Near ends at a vertex, which is a definition rather than a shortcut.** A doorway's jambs are
 * vertices, and so is a wall's end across from a flat wall; a wall between two plain stretches of wall
 * gains nothing from being moved off the click, since walls that are parallel are as short through it,
 * and walls that converge would only pull it toward whatever narrows nearby — the jump the preference
 * exists to stop.
 *
 * Both distances are fixed (user): what they do is on screen before every click, so there is nothing
 * a slider would let a GM tune that they cannot already see.
 *
 * ## Why the through search is exact
 *
 * Sweep the direction through the click, and the wall first met on each side changes only as the
 * direction passes a vertex. So aiming exactly at every vertex covers the directions where it changes,
 * and between two of them the length is a sum of two distances to fixed lines — each convex in the
 * angle — so a bracketed search finds its one lowest point. Nothing is sampled.
 *
 * **Only vertices within the best length found so far can matter**: a wall of length L through the
 * click has both ends within L of it. A first guess from four directions bounds that.
 *
 * ## Why it is fast enough to preview on every pointer move
 *
 * It runs on every move, so the first version's shape — every ray tested against every wall — was
 * measured and refused: a median of 11ms and a worst click of 6.7s on a graph of 10,107 segments
 * (2026-09-16), the worst being a click with no wall through it, where nothing bounds the search.
 * Three things answer it, none of them changing what is found:
 *
 * - **A grid of the walls, built once per graph**, so a ray tests the walls in the cells it crosses
 *   and stops at the first cell boundary beyond a hit.
 * - **Two vertices can only be joined near the click if they are nearly opposite each other across
 *   it.** For the nearer at distance d > 2R, the angle between them seen from the click must be within
 *   asin(2R/d) of a straight line — a chord between points further round cannot come within R. So
 *   each vertex looks only through a narrow window of the others, sorted by angle.
 * - **A square drop only passes near the click from a wall lying nearly square to the line from the
 *   vertex to the click**, within asin(R/d); the walls are sorted by direction and looked up the same
 *   way.
 *
 * **Measured after** (2026-09-16), on derived graphs far denser than any real map — the densest
 * recorded, 5,881 wall segments, could not even be pushed:
 *
 * | graph | median | 95th percentile | worst | first call, building the index |
 * |---|---|---|---|---|
 * | 10,107 segments | 2.1ms | 4.3ms | 170ms | 52ms |
 * | 36,022 segments | 9.0ms | 17ms | 114ms | 106ms |
 *
 * **The worst clicks are all in open space**, and the cost stated: where no wall runs through the click
 * nothing bounds the through search, and until a near wall is found nothing bounds the square drops.
 * The sibling's vision work met the same thing and answered it with a radius — *"the radius is the
 * whole cost"* — so the remedy, if a room ever feels it, is a longest span offered. That changes what
 * the tool finds, so it is a decision rather than an optimisation, and it has not been taken.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { segmentMeeting } from "./planarGraph";
import { insertEdge, splitEdgesAt, type EditResult } from "./planarOps";
import type { WallGraph } from "./wallGraph";

/** How much shorter the near wall has to be to be taken instead of the one through the click. */
export const NEAR_SHORTER = 2 / 3;

/** Where one end of a span lands: on a vertex, or partway along a wall, which accepting splits. */
export type SpanEnd =
  | { readonly kind: "vertex"; readonly node: number; readonly at: Vector2 }
  | { readonly kind: "segment"; readonly edge: number; readonly at: Vector2 };

export interface Span {
  readonly from: SpanEnd;
  readonly to: SpanEnd;
  /** Graph units. */
  readonly length: number;
  /** Whether it passes through the click, rather than near it. */
  readonly through: boolean;
}

export interface SpanOptions {
  /** How near a wall must pass to the click to be a near candidate, in graph units. */
  readonly near: number;
  /** The shortest wall worth placing, in graph units — Draw's floor, turned from screen pixels. */
  readonly minLength: number;
}

/**
 * A fraction of a segment within which a point on it counts as its end — the crossing predicate's
 * own tolerance, so a span and the edit that places it agree about what is a vertex.
 */
const END_TOLERANCE = 1e-6;
/** Below this, a hit is where the ray started, not something it met. */
const START_TOLERANCE = 1e-12;
/** Two lengths this close, relatively, are a tie. */
const TIE = 1e-9;
/** Golden-section steps between two vertex directions: far past what a float can resolve. */
const SEARCH_STEPS = 80;

/** The span a click would place, or `null` when there is none to place. */
export function findSpan(graph: WallGraph, point: Vector2, options: SpanOptions): Span | null {
  const index = indexFor(graph);
  const shortest = throughSpan(index, point);
  /*
    The near wall is measured against the shortest wall through the click **even when that one is
    too short to place**. Refusing it does not make the click a place with no wall through it — it is
    a hairline slit — and treating it as one left the near search unbounded, where it found a long
    diagonal across a corridor that happened to pass through the click.
  */
  const bound = shortest ? shortest.length * NEAR_SHORTER : Infinity;
  const near = nearSpan(index, point, options, bound);
  if (near) return { from: near.from, to: near.to, length: near.length, through: false };
  // Refused when too short to place, and not replaced by the shortest of those long enough: that
  // would be whichever longer chord happened to be tried, which is not a wall anyone asked for.
  if (!shortest || shortest.length < options.minLength) return null;
  return { from: shortest.from, to: shortest.to, length: shortest.length, through: true };
}

/**
 * Place a span: split the walls its ends land partway along, then add it.
 *
 * Splits first and by coordinate — see `splitEdgesAt` for why that order was measured necessary.
 */
export function applySpan(graph: WallGraph, span: Span): EditResult {
  const landings = [span.from, span.to].flatMap((end) =>
    end.kind === "segment" ? [{ edge: end.edge, at: end.at }] : [],
  );
  const split = splitEdgesAt(graph, landings);
  const added = insertEdge(split.graph, [span.from.at, span.to.at]);
  return {
    graph: added.graph,
    splits: split.splits + added.splits,
    overlaps: added.overlaps,
  };
}

// ---- The index -------------------------------------------------------------------------------

interface Wall {
  /** Its position in the index's list, for marking. */
  readonly slot: number;
  readonly edge: number;
  readonly a: number;
  readonly b: number;
  readonly p: Vector2;
  readonly q: Vector2;
  /** The wall's direction in [0, π). */
  readonly direction: number;
}

interface Candidate {
  readonly from: SpanEnd;
  readonly to: SpanEnd;
  readonly length: number;
  /** The span's direction in [0, π), for ties. */
  readonly angle: number;
}

interface SpanIndex {
  readonly walls: readonly Wall[];
  /** Vertices with at least one wall, and the walls meeting each. */
  readonly vertices: readonly { readonly node: number; readonly at: Vector2 }[];
  readonly incident: ReadonlyMap<number, readonly Wall[]>;
  /** Walls sorted by direction, for the square-drop lookup. */
  readonly byDirection: readonly Wall[];
  readonly grid: WallGrid;
}

/**
 * Built once per graph and kept while that graph is the one in hand.
 *
 * Keyed on the graph object, which every edit and derive replaces rather than mutates — so an index
 * can never answer for a graph it was not built from.
 */
const indexes = new WeakMap<WallGraph, SpanIndex>();

function indexFor(graph: WallGraph): SpanIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;

  const walls: Wall[] = [];
  graph.edges.forEach((edge, index) => {
    const p = graph.nodes[edge.a]!;
    const q = graph.nodes[edge.b]!;
    if (p.x === q.x && p.y === q.y) return;
    walls.push({
      slot: walls.length,
      edge: index,
      a: edge.a,
      b: edge.b,
      p,
      q,
      direction: fold(Math.atan2(q.y - p.y, q.x - p.x)),
    });
  });
  const incident = new Map<number, Wall[]>();
  for (const wall of walls) {
    for (const node of [wall.a, wall.b]) {
      const list = incident.get(node) ?? [];
      list.push(wall);
      incident.set(node, list);
    }
  }
  const index: SpanIndex = {
    walls,
    vertices: [...incident.keys()].map((node) => ({ node, at: graph.nodes[node]! })),
    incident,
    byDirection: [...walls].sort((left, right) => left.direction - right.direction),
    grid: new WallGrid(walls),
  };
  indexes.set(graph, index);
  return index;
}

/**
 * The walls binned into square cells, so a ray or a region asks only about the walls near it.
 *
 * About one cell per wall, which on a real map's short fitted walls puts a handful in each. A wall
 * goes into every cell its bounding box covers; a long diagonal lands in more cells than it needs,
 * which costs a few extra tests and changes no answer.
 */
class WallGrid {
  private readonly minX: number;
  private readonly minY: number;
  private readonly wallsMinX: number;
  private readonly wallsMinY: number;
  private readonly wallsMaxX: number;
  private readonly wallsMaxY: number;
  private readonly size: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private readonly stamps: Uint32Array;
  private stamp = 0;

  constructor(private readonly walls: readonly Wall[]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const wall of walls) {
      for (const point of [wall.p, wall.q]) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    if (walls.length === 0) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const across = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(walls.length))));
    this.size = (span / across) * (1 + 1e-9);
    this.minX = minX;
    this.minY = minY;
    this.wallsMinX = minX;
    this.wallsMinY = minY;
    this.wallsMaxX = maxX;
    this.wallsMaxY = maxY;
    this.columns = Math.max(1, Math.ceil((maxX - minX) / this.size) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / this.size) + 1);
    this.cells = Array.from({ length: this.columns * this.rows }, () => []);
    this.stamps = new Uint32Array(walls.length);
    walls.forEach((wall, at) => {
      const [c0, r0] = this.cellOf(Math.min(wall.p.x, wall.q.x), Math.min(wall.p.y, wall.q.y));
      const [c1, r1] = this.cellOf(Math.max(wall.p.x, wall.q.x), Math.max(wall.p.y, wall.q.y));
      for (let row = r0; row <= r1; row++) {
        for (let column = c0; column <= c1; column++) this.cells[row * this.columns + column]!.push(at);
      }
    });
  }

  /** Whether a point lies within the walls' bounding box. */
  contains(point: Vector2): boolean {
    return (
      point.x >= this.wallsMinX && point.x <= this.wallsMaxX && point.y >= this.wallsMinY && point.y <= this.wallsMaxY
    );
  }

  private cellOf(x: number, y: number): [number, number] {
    const column = Math.floor((x - this.minX) / this.size);
    const row = Math.floor((y - this.minY) / this.size);
    return [
      Math.max(0, Math.min(this.columns - 1, column)),
      Math.max(0, Math.min(this.rows - 1, row)),
    ];
  }

  /** Every wall in a cell touching the box, once each. */
  inBox(minX: number, minY: number, maxX: number, maxY: number, visit: (wall: Wall) => void): void {
    this.stamp += 1;
    const [c0, r0] = this.cellOf(minX, minY);
    const [c1, r1] = this.cellOf(maxX, maxY);
    for (let row = r0; row <= r1; row++) {
      for (let column = c0; column <= c1; column++) {
        for (const at of this.cells[row * this.columns + column]!) {
          if (this.stamps[at] === this.stamp) continue;
          this.stamps[at] = this.stamp;
          visit(this.walls[at]!);
        }
      }
    }
  }

  /**
   * The walls a ray passes, cell by cell, until `visit` says a hit it holds is nearer than the cell
   * about to be entered, or the ray is past `maxDistance`.
   *
   * `visit` returns the distance of the nearest hit so far, or `Infinity`. **The ray must start inside
   * the walls' bounds** — see `contains` — which is what lets it begin in the cell holding its origin.
   */
  alongRay(
    origin: Vector2,
    dx: number,
    dy: number,
    maxDistance: number,
    visit: (wall: Wall) => number,
  ): void {
    let [column, row] = this.cellOf(origin.x, origin.y);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const deltaX = dx === 0 ? Infinity : this.size / Math.abs(dx);
    const deltaY = dy === 0 ? Infinity : this.size / Math.abs(dy);
    let nextX =
      dx === 0 ? Infinity : (this.minX + (column + (dx > 0 ? 1 : 0)) * this.size - origin.x) / dx;
    let nextY =
      dy === 0 ? Infinity : (this.minY + (row + (dy > 0 ? 1 : 0)) * this.size - origin.y) / dy;

    this.stamp += 1;
    // Held across cells: a hit found in one cell can lie beyond it, and an empty cell after it must
    // not forget that a stop is already owed.
    let nearest = Infinity;
    for (;;) {
      for (const at of this.cells[row * this.columns + column]!) {
        if (this.stamps[at] === this.stamp) continue;
        this.stamps[at] = this.stamp;
        nearest = Math.min(nearest, visit(this.walls[at]!));
      }
      const leaving = Math.min(nextX, nextY);
      if (nearest <= leaving || leaving > maxDistance) return;
      if (nextX < nextY) {
        column += stepX;
        nextX += deltaX;
        if (column < 0 || column >= this.columns) return;
      } else {
        row += stepY;
        nextY += deltaY;
        if (row < 0 || row >= this.rows) return;
      }
    }
  }
}

/** The walls a search may meet: all of them, or those within a distance of a point. */
interface Reach {
  readonly index: SpanIndex;
  /** Marks by wall slot, or `null` for every wall. */
  readonly allowed: Uint8Array | null;
  readonly walls: readonly Wall[];
  /** How far a ray need walk: the farthest end of any wall it may meet. */
  readonly distance: number;
}

function everything(index: SpanIndex): Reach {
  return { index, allowed: null, walls: index.walls, distance: Infinity };
}

function within(index: SpanIndex, origin: Vector2, distance: number): Reach {
  if (!Number.isFinite(distance)) return everything(index);
  const allowed = new Uint8Array(index.walls.length);
  const walls: Wall[] = [];
  /*
    How far a ray has to walk is the farthest END of these walls, not the distance they were chosen
    by. A wall within the distance can run well beyond it, and a ray stopped at the distance would
    miss it partway through a stretch between two directions — report nothing there, skip the
    stretch, and with it a shorter wall near the stretch's edge. Measured: a wall 1% shorter than the
    one returned, found by sampling on seed 124, before this was the walk's limit.
  */
  let farthest = 0;
  index.grid.inBox(origin.x - distance, origin.y - distance, origin.x + distance, origin.y + distance, (wall) => {
    if (distanceToSegment(origin, wall.p, wall.q) > distance) return;
    allowed[wall.slot] = 1;
    walls.push(wall);
    for (const end of [wall.p, wall.q]) {
      farthest = Math.max(farthest, Math.hypot(end.x - origin.x, end.y - origin.y));
    }
  });
  return { index, allowed, walls, distance: farthest };
}

// ---- Through the click -----------------------------------------------------------------------

/** The shortest chord through `origin`, however short — `findSpan` decides whether it can be placed. */
function throughSpan(index: SpanIndex, origin: Vector2): Candidate | null {
  /*
    Outside the walls' bounding box there is no wall through the click: a line through a point outside
    every wall meets them all on one side of it. **For speed, and no test can see it** — without this
    every ray still finds nothing on one side and the answer is the same — but it is also what lets a
    ray begin in the cell holding its origin, so the grid walk needs no entry clipping.
  */
  if (!index.grid.contains(origin)) return null;
  // A click exactly on a wall has no side to start from.
  let onWall = false;
  index.grid.inBox(origin.x, origin.y, origin.x, origin.y, (wall) => {
    if (distanceToSegment(origin, wall.p, wall.q) <= START_TOLERANCE) onWall = true;
  });
  if (onWall) return null;

  /*
    A first bound from a few directions, and more only if those find nothing. The bound only prunes —
    any chord at all bounds the answer — so trying more changes nothing found and spares the one
    expensive case: a click where no early guess meets walls on both sides, which otherwise aims at
    every vertex in the graph.
  */
  let bound = Infinity;
  for (const directions of [4, 32]) {
    for (let step = 0; step < directions; step++) {
      const found = chordAt(everything(index), origin, (Math.PI * step) / directions);
      if (found && found.length < bound) bound = found.length;
    }
    if (Number.isFinite(bound)) break;
  }

  /*
    **The walls within the bound, and the directions of their ends** — not the vertices within the
    bound, which was tried and is wrong. Casting against these walls alone, the first one met changes
    only at one of their ends, so between two of those directions the length really is two fixed lines
    and its lowest point is exact; a wall beyond the bound could only be met further off than a wall
    this search already beats. Aiming only at vertices within the bound, and casting against every
    wall, let a far wall change what a ray met partway between two directions — and in a corridor with
    no vertex near the click, searched nothing at all.
  */
  const reach = within(index, origin, bound);
  const angles: number[] = [];
  const seen = new Set<number>();
  for (const wall of reach.walls) {
    for (const [node, at] of [
      [wall.a, wall.p],
      [wall.b, wall.q],
    ] as const) {
      if (seen.has(node)) continue;
      seen.add(node);
      angles.push(fold(Math.atan2(at.y - origin.y, at.x - origin.x)));
    }
  }
  angles.sort((left, right) => left - right);
  if (angles.length === 0) return null;

  let best: Candidate | null = null;
  const consider = (found: Candidate | null) => {
    if (found && better(found, best)) best = found;
  };

  for (let at = 0; at < angles.length; at++) {
    const start = angles[at]!;
    consider(chordAt(reach, origin, start));
    // The next direction round, wrapping past π to the first again.
    const end = at + 1 < angles.length ? angles[at + 1]! : angles[0]! + Math.PI;
    if (end - start <= 1e-12) continue;
    consider(lowestBetween(reach, origin, start, end));
  }
  return best;
}

/**
 * The shortest chord between two vertex directions.
 *
 * Between them the walls met on each side do not change, so the length is the distance to one fixed
 * line plus the distance to another, and a golden-section search on that closes in on its minimum.
 * The answer is then cast for real, so what is returned is what the walls give rather than the model.
 */
function lowestBetween(index: Reach, origin: Vector2, start: number, end: number): Candidate | null {
  const middle = (start + end) / 2;
  const ahead = castRay(index, origin, middle);
  if (!ahead) return null;
  const behind = castRay(index, origin, middle + Math.PI);
  if (!behind) return null;

  const length = (angle: number): number =>
    distanceToLine(origin, angle, ahead.wall) + distanceToLine(origin, angle + Math.PI, behind.wall);

  const ratio = (Math.sqrt(5) - 1) / 2;
  let low = start;
  let high = end;
  let left = high - ratio * (high - low);
  let right = low + ratio * (high - low);
  let leftLength = length(left);
  let rightLength = length(right);
  for (let step = 0; step < SEARCH_STEPS; step++) {
    if (leftLength <= rightLength) {
      high = right;
      right = left;
      rightLength = leftLength;
      left = high - ratio * (high - low);
      leftLength = length(left);
    } else {
      low = left;
      left = right;
      leftLength = rightLength;
      right = low + ratio * (high - low);
      rightLength = length(right);
    }
  }
  return chordAt(index, origin, (low + high) / 2);
}

/** The chord through `origin` at an angle, ending at the first wall each way, or `null`. */
function chordAt(index: Reach, origin: Vector2, angle: number): Candidate | null {
  const ahead = castRay(index, origin, angle);
  if (!ahead) return null;
  const behind = castRay(index, origin, angle + Math.PI);
  if (!behind) return null;
  return {
    from: behind.end,
    to: ahead.end,
    /*
      Between the ends as placed, not the sum of the two ray distances. A hit within tolerance of a
      wall's end is that vertex, which can sit a millionth of the wall's length off the ray — so the
      wall placed is not quite the chord cast, and the length reported is the wall's.
    */
    length: Math.hypot(ahead.end.at.x - behind.end.at.x, ahead.end.at.y - behind.end.at.y),
    angle: fold(angle),
  };
}

interface Hit {
  readonly distance: number;
  readonly end: SpanEnd;
  readonly wall: Wall;
}

/**
 * The first wall a ray meets, and where.
 *
 * A wall lying along the ray is met at its nearer end, which is how a click exactly on the line of a
 * doorway reaches the jamb rather than sliding along the wall it belongs to. A hit within the tolerance
 * of a wall's end is that end's vertex.
 */
function castRay(reach: Reach, origin: Vector2, angle: number): Hit | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best: Hit | null = null;
  const offer = (hit: Hit) => {
    if (!best || hit.distance < best.distance) best = hit;
  };

  reach.index.grid.alongRay(origin, dx, dy, reach.distance, (wall) => {
    if (reach.allowed && reach.allowed[wall.slot] !== 1) return (best as Hit | null)?.distance ?? Infinity;
    const ex = wall.q.x - wall.p.x;
    const ey = wall.q.y - wall.p.y;
    const apx = wall.p.x - origin.x;
    const apy = wall.p.y - origin.y;
    const length = Math.hypot(ex, ey);
    const denominator = dx * ey - dy * ex;

    if (Math.abs(denominator) <= 1e-12 * length) {
      if (Math.abs(apx * dy - apy * dx) <= END_TOLERANCE * length) {
        const toP = apx * dx + apy * dy;
        const toQ = (wall.q.x - origin.x) * dx + (wall.q.y - origin.y) * dy;
        if (toP > START_TOLERANCE) offer({ distance: toP, end: { kind: "vertex", node: wall.a, at: wall.p }, wall });
        if (toQ > START_TOLERANCE) offer({ distance: toQ, end: { kind: "vertex", node: wall.b, at: wall.q }, wall });
      }
      return (best as Hit | null)?.distance ?? Infinity;
    }

    const distance = (apx * ey - apy * ex) / denominator;
    const along = (apx * dy - apy * dx) / denominator;
    if (distance > START_TOLERANCE && along >= -END_TOLERANCE && along <= 1 + END_TOLERANCE) {
      const end: SpanEnd =
        along <= END_TOLERANCE
          ? { kind: "vertex", node: wall.a, at: wall.p }
          : along >= 1 - END_TOLERANCE
            ? { kind: "vertex", node: wall.b, at: wall.q }
            : {
                kind: "segment",
                edge: wall.edge,
                at: { x: origin.x + distance * dx, y: origin.y + distance * dy },
              };
      offer({ distance, end, wall });
    }
    return (best as Hit | null)?.distance ?? Infinity;
  });
  return best;
}

/** How far along a ray its wall's line lies, or `Infinity` when the ray never meets that line. */
function distanceToLine(origin: Vector2, angle: number, wall: Wall): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ex = wall.q.x - wall.p.x;
  const ey = wall.q.y - wall.p.y;
  const denominator = dx * ey - dy * ex;
  if (denominator === 0) return Infinity;
  const distance = ((wall.p.x - origin.x) * ey - (wall.p.y - origin.y) * ex) / denominator;
  return distance > 0 ? distance : Infinity;
}

// ---- Near the click --------------------------------------------------------------------------

/**
 * The shortest wall ending at a vertex that passes within reach of the click, shorter than `bound`.
 *
 * **A candidate under the floor is ignored**, where through the click the shortest under the floor
 * refuses the lot. The two differ because these candidates are a fixed set — every vertex pair and
 * every square drop — so skipping one leaves a well-defined next best; and a tiny one here is a corner
 * cut beside the click rather than the click being in a slit.
 */
function nearSpan(index: SpanIndex, origin: Vector2, options: SpanOptions, bound: number): Candidate | null {
  const reach = options.near;
  if (!(reach > 0)) return null;

  let best: Candidate | null = null;
  const limit = () => Math.min(bound, best?.length ?? Infinity);
  const offer = (from: SpanEnd, to: SpanEnd, landing: number | null) => {
    const length = Math.hypot(to.at.x - from.at.x, to.at.y - from.at.y);
    if (length < options.minLength || length > limit()) return;
    if (distanceToSegment(origin, from.at, to.at) > reach) return;
    if (!clear(index, from.at, to.at, landing)) return;
    const found: Candidate = {
      from,
      to,
      length,
      angle: fold(Math.atan2(to.at.y - from.at.y, to.at.x - from.at.x)),
    };
    if (better(found, best)) best = found;
  };

  // Only vertices that could end a wall shorter than the bound and within reach of the click — found
  // through the grid when the bound is finite, since a vertex is the end of a wall in some cell.
  const cap = bound + 2 * reach;
  const candidates: { readonly node: number; readonly at: Vector2 }[] = [];
  if (Number.isFinite(cap)) {
    const taken = new Set<number>();
    index.grid.inBox(origin.x - cap, origin.y - cap, origin.x + cap, origin.y + cap, (wall) => {
      for (const [node, at] of [
        [wall.a, wall.p],
        [wall.b, wall.q],
      ] as const) {
        if (taken.has(node)) continue;
        taken.add(node);
        candidates.push({ node, at });
      }
    });
  } else {
    candidates.push(...index.vertices);
  }
  const seen = candidates
    .map((vertex) => {
      const dx = vertex.at.x - origin.x;
      const dy = vertex.at.y - origin.y;
      return { ...vertex, distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
    })
    .filter((vertex) => vertex.distance <= cap);
  const byDistance = [...seen].sort((left, right) => left.distance - right.distance || left.node - right.node);
  const byAngle = [...seen].sort((left, right) => left.angle - right.angle);

  for (const vertex of byDistance) {
    /*
      A wall of length L passing within R of the click has each end within L + R of it, and its nearer
      end within (L + 2R) / 2 — since the two ends' distances sum to at most L + 2R. Past the first,
      no later vertex ends anything; past the second, it is no pair's nearer end.
    */
    if (vertex.distance > limit() + reach) break;
    const here: SpanEnd = { kind: "vertex", node: vertex.node, at: vertex.at };

    /*
      Pairs, taking this vertex as the nearer end. Within 2R of the click any other vertex may do;
      beyond it only the ones nearly opposite, through a window of asin(2R/d) either side.
    */
    const others =
      vertex.distance > (limit() + 2 * reach) / 2
        ? []
        : vertex.distance <= 2 * reach
          ? byAngle
          : window(byAngle, vertex.angle + Math.PI, Math.asin((2 * reach) / vertex.distance));
    for (const other of others) {
      if (other.node === vertex.node) continue;
      if (other.distance < vertex.distance || (other.distance === vertex.distance && other.node < vertex.node)) {
        continue;
      }
      if (vertex.distance + other.distance > limit() + 2 * reach) continue;
      offer(here, { kind: "vertex", node: other.node, at: other.at }, null);
    }

    /*
      Square drops. The drop runs along the wall's normal through the vertex, and that line comes
      within R of the click only if the wall lies within asin(R/d) of square to the line from the vertex
      to the click.
    */
    const square = fold(vertex.angle + Math.PI / 2);
    const walls =
      vertex.distance <= reach
        ? index.byDirection
        : directionWindow(index.byDirection, square, Math.asin(Math.min(1, reach / vertex.distance)));
    for (const wall of walls) {
      if (wall.a === vertex.node || wall.b === vertex.node) continue;
      const foot = footOnSegment(vertex.at, wall);
      if (foot === null) continue;
      offer(here, { kind: "segment", edge: wall.edge, at: foot }, wall.edge);
    }
  }
  return best;
}

/** Entries of an angle-sorted list within `half` of `centre`, wrapping round ±π. */
function window<T extends { readonly angle: number }>(sorted: readonly T[], centre: number, half: number): T[] {
  if (half >= Math.PI) return [...sorted];
  const out: T[] = [];
  const take = (low: number, high: number) => {
    let at = lowerBound(sorted, low, (entry) => entry.angle);
    for (; at < sorted.length && sorted[at]!.angle <= high; at++) out.push(sorted[at]!);
  };
  let low = centre - half;
  let high = centre + half;
  // Bring the window into (−π, π], then take whatever spills past either end from the other.
  while (low > Math.PI) {
    low -= 2 * Math.PI;
    high -= 2 * Math.PI;
  }
  while (high < -Math.PI) {
    low += 2 * Math.PI;
    high += 2 * Math.PI;
  }
  take(Math.max(low, -Math.PI), Math.min(high, Math.PI));
  if (low < -Math.PI) take(low + 2 * Math.PI, Math.PI);
  if (high > Math.PI) take(-Math.PI, high - 2 * Math.PI);
  return out;
}

/** Walls whose direction is within `half` of `centre`, where direction wraps at π. */
function directionWindow(sorted: readonly Wall[], centre: number, half: number): Wall[] {
  if (half >= Math.PI / 2) return [...sorted];
  const out: Wall[] = [];
  const take = (low: number, high: number) => {
    let at = lowerBound(sorted, low, (wall) => wall.direction);
    for (; at < sorted.length && sorted[at]!.direction <= high; at++) out.push(sorted[at]!);
  };
  const low = centre - half;
  const high = centre + half;
  take(Math.max(low, 0), Math.min(high, Math.PI));
  if (low < 0) take(low + Math.PI, Math.PI);
  if (high > Math.PI) take(0, high - Math.PI);
  return out;
}

function lowerBound<T>(sorted: readonly T[], value: number, key: (entry: T) => number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (key(sorted[middle]!) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether a straight wall between two points meets no existing wall, apart from the one it lands on. */
function clear(index: SpanIndex, from: Vector2, to: Vector2, landing: number | null): boolean {
  let met = false;
  index.grid.inBox(
    Math.min(from.x, to.x),
    Math.min(from.y, to.y),
    Math.max(from.x, to.x),
    Math.max(from.y, to.y),
    (wall) => {
      if (met || wall.edge === landing) return;
      if (segmentMeeting(from, to, wall.p, wall.q)) met = true;
    },
  );
  return !met;
}

/** Where a point drops square onto a wall, or `null` when that falls off either end. */
function footOnSegment(point: Vector2, wall: Wall): Vector2 | null {
  const ex = wall.q.x - wall.p.x;
  const ey = wall.q.y - wall.p.y;
  const lengthSquared = ex * ex + ey * ey;
  const along = ((point.x - wall.p.x) * ex + (point.y - wall.p.y) * ey) / lengthSquared;
  if (along <= END_TOLERANCE || along >= 1 - END_TOLERANCE) return null;
  return { x: wall.p.x + along * ex, y: wall.p.y + along * ey };
}

// ---- Shared ----------------------------------------------------------------------------------

/** Shorter wins; lengths within `TIE` of each other go to the lower angle, so a tie is repeatable. */
function better(found: Candidate, best: Candidate | null): boolean {
  if (!best) return true;
  if (found.length < best.length * (1 - TIE)) return true;
  if (found.length > best.length * (1 + TIE)) return false;
  return found.angle < best.angle;
}

/**
 * An angle folded into [0, π), with anything just short of π counted as 0.
 *
 * "Just short" is 1e-6, not a rounding error: a search closing on a flat minimum can only place it to
 * about the square root of a float's precision, so a wall found straight across at π comes back 1e-8
 * short of it — and a tie between straight across and straight up then went to straight up.
 */
function fold(angle: number): number {
  let folded = angle % Math.PI;
  if (folded < 0) folded += Math.PI;
  return Math.PI - folded <= 1e-6 ? 0 : folded;
}

function distanceToSegment(point: Vector2, p: Vector2, q: Vector2): number {
  const ex = q.x - p.x;
  const ey = q.y - p.y;
  const lengthSquared = ex * ex + ey * ey;
  const along =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - p.x) * ex + (point.y - p.y) * ey) / lengthSquared));
  return Math.hypot(point.x - (p.x + along * ex), point.y - (p.y + along * ey));
}

