/**
 * Roadmap step 5 — boundary tracing. One closed polygon per region, plus a ring per hole.
 *
 * ## Corners, not pixel centres
 *
 * The boundary is traced along the *cracks between* pixels rather than through their centres, so
 * every vertex lands on an integer lattice corner. That is the first of step 5's three
 * requirements and it is not cosmetic: a centre-following trace puts the boundary half a pixel
 * inside the region, so two regions either side of a wall each claim half a pixel of it and their
 * boundaries disagree by a pixel that belongs to neither. On the lattice they agree exactly.
 *
 * It also makes the arithmetic exact. Every coordinate is an integer, so the shoelace area of a
 * ring is an integer, and the invariant below holds to the last unit rather than to a tolerance.
 *
 * ## The invariant worth having
 *
 * **A region's ring areas sum to its pixel count.** Outer rings come out positive and holes
 * negative, so a room of 900 pixels with a 25-pixel pillar traces to +925 and -25. Nothing else
 * here checks tracing against labelling, and this checks it exactly — a dropped hole, a ring traced
 * the wrong way round, or a boundary off by a pixel all break it. It is asserted in the tests and
 * reported on every dry run.
 *
 * ## Diagonal pinches, and why the turn rule is the labeller's decision again
 *
 * Where two pixels of one region touch only at a corner, the traversal has a choice of two ways to
 * continue, and the choice decides whether the contour treats that touch as a join or a pinch.
 * Space is 4-connected (`label.ts`), so it must be a pinch: the contour turns hard, hugging the
 * pixel it is on, and the region comes out as two rings meeting at a point. Taking the other branch
 * would have the polygon contradict the labelling that produced it.
 *
 * ## Holes below the minimum area are dropped, and that is not optional
 *
 * The minimum-area filter in `label.ts` zeroes tiny regions, which does not delete them from the
 * picture — it turns each one into a *hole* in whatever encloses it. On this project's test map
 * that is 247 specks, every one of which would otherwise arrive here as a ring of its own, cost
 * vertices against the 8192-entry cap, and produce two Dynamic Fog walls around a speck of noise.
 * So the same threshold is applied again to holes, and anything too small to be its own region is
 * too small to be a hole in someone else's.
 *
 * Pure: no DOM, no SDK.
 */

import type { Ring } from "../geometry/ring";
import { doubleSignedArea } from "../geometry/ring";
import type { LabelledSpace, Region } from "./label";

export interface RegionContours {
  /** The `Region.id` these rings came from. */
  readonly id: number;
  /** Outer rings first, largest first; then holes, largest first. */
  readonly rings: readonly Ring[];
  readonly outerCount: number;
  readonly holeCount: number;
  readonly vertices: number;
  /**
   * Signed pixel area of the rings as traced, **before** the hole filter.
   *
   * Compare it against the region's own area: they must be equal. See the invariant above.
   */
  readonly tracedArea: number;
  /** Holes removed by the minimum-area filter, and the pixels they held. */
  readonly droppedHoles: number;
  readonly droppedHoleArea: number;
}

export interface TraceOptions {
  /**
   * Smallest hole to keep, in pixels. Below this the hole is filled in — the region simply covers
   * it.
   *
   * **Set it to the same figure as the region minimum**, for the reason in the module note: below
   * that threshold a thing is not worth being a region, and a dropped region reappears here as a
   * hole. Denominate it in grid squares at the call site, never in raster pixels (DESIGN.md §5).
   */
  readonly minHoleArea?: number;
}

/** Steps for the four directions, indexed by the direction codes used below. */
const STEP_X = [1, 0, -1, 0] as const;
const STEP_Y = [0, 1, 0, -1] as const;

/**
 * Trace every region in a labelled space.
 *
 * Each region is traced inside its own bounding box, so cost is proportional to the area regions
 * actually occupy rather than to the raster times the region count. The exterior's box is the whole
 * raster and there is no avoiding that; every other region is small.
 */
export function traceRegions(
  labelled: LabelledSpace,
  options: TraceOptions = {},
): RegionContours[] {
  return labelled.regions.map((region) => traceRegion(labelled, region, options));
}

export function traceRegion(
  labelled: LabelledSpace,
  region: Region,
  options: TraceOptions = {},
): RegionContours {
  const minHoleArea = options.minHoleArea ?? 0;
  const { labels, width } = labelled;

  // A one-pixel margin all round, so the pixel outside the region's box is always readable and
  // always "not this region". Without it every neighbour lookup needs a bounds test, and the tests
  // are the part that gets a boundary wrong at the raster's edge.
  const boxWidth = region.maxX - region.minX + 3;
  const boxHeight = region.maxY - region.minY + 3;
  const originX = region.minX - 1;
  const originY = region.minY - 1;

  const inside = new Uint8Array(boxWidth * boxHeight);
  for (let y = region.minY; y <= region.maxY; y++) {
    const sourceRow = y * width;
    const targetRow = (y - originY) * boxWidth - originX;
    for (let x = region.minX; x <= region.maxX; x++) {
      if (labels[sourceRow + x] === region.id) inside[targetRow + x] = 1;
    }
  }

  // Outgoing boundary edges, four bits per lattice vertex. Bit `d` means "an edge leaves this
  // vertex heading in direction `d`", where 0 is +x, 1 is +y, 2 is -x, 3 is -y.
  //
  // The four sides of an inside pixel are wound so the region is always on the same hand: +x along
  // the top, +y down the right, -x back along the bottom, -y up the left. That consistency is what
  // makes the sign of the area meaningful, and it is why nothing here needs a point-in-polygon test
  // to tell a hole from an outer boundary.
  const vertexWidth = boxWidth + 1;
  const out = new Uint8Array(vertexWidth * (boxHeight + 1));

  for (let y = 1; y < boxHeight - 1; y++) {
    const row = y * boxWidth;
    for (let x = 1; x < boxWidth - 1; x++) {
      if (inside[row + x] !== 1) continue;
      const topLeft = y * vertexWidth + x;
      const bottomLeft = topLeft + vertexWidth;
      if (inside[row - boxWidth + x] !== 1) out[topLeft] = out[topLeft]! | 1;
      if (inside[row + x + 1] !== 1) out[topLeft + 1] = out[topLeft + 1]! | 2;
      if (inside[row + boxWidth + x] !== 1) out[bottomLeft + 1] = out[bottomLeft + 1]! | 4;
      if (inside[row + x - 1] !== 1) out[bottomLeft] = out[bottomLeft]! | 8;
    }
  }

  const outers: { ring: Ring; doubleArea: number }[] = [];
  const holes: { ring: Ring; doubleArea: number }[] = [];
  let tracedDoubleArea = 0;

  for (let start = 0; start < out.length; start++) {
    // A vertex can carry two outgoing edges — that is the diagonal pinch — so it may start two
    // separate rings, hence the loop rather than an `if`.
    while (out[start] !== 0) {
      const ring = walk(out, vertexWidth, start, originX, originY);
      const doubleArea = doubleSignedArea(ring);
      tracedDoubleArea += doubleArea;
      (doubleArea >= 0 ? outers : holes).push({ ring, doubleArea });
    }
  }

  let droppedHoles = 0;
  let droppedHoleDoubleArea = 0;
  const keptHoles = holes.filter((hole) => {
    if (-hole.doubleArea >= minHoleArea * 2) return true;
    droppedHoles += 1;
    droppedHoleDoubleArea += -hole.doubleArea;
    return false;
  });

  // Largest first within each class, and outer rings before holes. Even-odd fill makes the order
  // irrelevant to what is drawn; it matters for reading a log line, where ring 0 should be the
  // shape a human would call the region.
  outers.sort((a, b) => b.doubleArea - a.doubleArea);
  keptHoles.sort((a, b) => a.doubleArea - b.doubleArea);

  const rings = [...outers, ...keptHoles].map((entry) => entry.ring);
  let vertices = 0;
  for (const ring of rings) vertices += ring.length;

  return {
    id: region.id,
    rings,
    outerCount: outers.length,
    holeCount: keptHoles.length,
    vertices,
    tracedArea: tracedDoubleArea / 2,
    droppedHoles,
    droppedHoleArea: droppedHoleDoubleArea / 2,
  };
}

/**
 * Follow one closed ring from a starting vertex, consuming the edges it uses.
 *
 * Collinear steps are collapsed as they are walked, which is lossless and is the difference between
 * a straight wall costing two vertices and costing one per pixel. It is not simplification — no
 * point that carries any shape is discarded, and step 6 still has everything it needs.
 */
function walk(
  out: Uint8Array,
  vertexWidth: number,
  start: number,
  originX: number,
  originY: number,
): Ring {
  const points: { x: number; y: number }[] = [];
  let vertex = start;
  let direction = firstDirection(out[start]!);
  let previousDirection = -1;

  for (;;) {
    out[vertex] = out[vertex]! & ~(1 << direction);
    // A vertex is only worth recording where the boundary actually turns.
    if (direction !== previousDirection) {
      points.push({
        x: (vertex % vertexWidth) + originX,
        y: Math.floor(vertex / vertexWidth) + originY,
      });
    }
    previousDirection = direction;

    vertex += STEP_X[direction]! + STEP_Y[direction]! * vertexWidth;
    if (vertex === start) break;

    // Turn toward the region first, then go straight, then turn away. The first of those is what
    // makes a diagonal pinch pinch rather than join: it hugs the pixel being traced and leaves the
    // one touching it at the corner to its own ring. Only one of the three can exist at a vertex
    // carrying a single edge, so the priority only ever decides the two-edge case.
    const next = out[vertex]!;
    const towards = (direction + 1) & 3;
    const away = (direction + 3) & 3;
    if (next & (1 << towards)) direction = towards;
    else if (next & (1 << direction)) direction = direction;
    else if (next & (1 << away)) direction = away;
    else {
      // Unreachable: every vertex an edge arrives at has an unconsumed edge leaving it, because the
      // edges of a region's boundary pair up exactly. Bailing out rather than looping forever means
      // a bug in the edge construction shows up as a short ring in a test, not as a hung tab.
      break;
    }
  }

  // No trimming of the start vertex, and that is a claim rather than an oversight: it can never sit
  // in the middle of a straight run.
  //
  // Rings are started from the lowest-numbered vertex that still has an unconsumed edge, and every
  // vertex an edge *arrives* at has one leaving it. So no earlier vertex is reachable at all, which
  // leaves the start vertex only +x and +y to leave by, and only -x and -y to be re-entered from.
  // Those sets are disjoint, so the first and last steps of a ring always differ in direction and
  // the start is always a genuine corner.
  //
  // Written down because the guard for the other case is one line and looks obviously prudent. It
  // was there, no fixture could make it fire, and code that cannot run is worse than the argument
  // for why it cannot.
  return points;
}

function firstDirection(bits: number): number {
  if (bits & 1) return 0;
  if (bits & 2) return 1;
  if (bits & 4) return 2;
  return 3;
}

export interface ContourStats {
  readonly regions: number;
  readonly rings: number;
  readonly holes: number;
  /**
   * Rings beyond the first outer one, summed over regions.
   *
   * A region traces to more than one outer ring only where it pinches to a point at a diagonal, so
   * this is a count of how often the map's ink comes to a corner-to-corner touch. Information, not
   * an alarm: it is normal on hand-drawn linework and says something moved if it jumps between runs.
   */
  readonly extraOuterRings: number;
  readonly vertices: number;
  readonly maxVertices: number;
  readonly maxVerticesId: number;
  readonly droppedHoles: number;
  /**
   * Regions whose traced area disagrees with the pixel count that produced them.
   *
   * Must be zero. It is the one exact check tracing has against labelling, and anything above zero
   * means the geometry does not describe the region it claims to.
   */
  readonly areaMismatches: number;
}

export function contourStats(
  labelled: LabelledSpace,
  contours: readonly RegionContours[],
): ContourStats {
  const areaById = new Map(labelled.regions.map((region) => [region.id, region.area]));

  let rings = 0;
  let holes = 0;
  let extraOuterRings = 0;
  let vertices = 0;
  let maxVertices = 0;
  let maxVerticesId = 0;
  let droppedHoles = 0;
  let areaMismatches = 0;

  for (const region of contours) {
    rings += region.rings.length;
    holes += region.holeCount;
    extraOuterRings += Math.max(0, region.outerCount - 1);
    vertices += region.vertices;
    droppedHoles += region.droppedHoles;
    if (region.vertices > maxVertices) {
      maxVertices = region.vertices;
      maxVerticesId = region.id;
    }
    if (region.tracedArea !== areaById.get(region.id)) areaMismatches += 1;
  }

  return {
    regions: contours.length,
    rings,
    holes,
    extraOuterRings,
    vertices,
    maxVertices,
    maxVerticesId,
    droppedHoles,
    areaMismatches,
  };
}

/**
 * One line, and one in every case including the empty one — a stage that goes quiet when it finds
 * nothing cannot be told apart from a stage that never ran.
 */
export function describeContours(stats: ContourStats): string {
  if (stats.regions === 0) return "no regions to trace";

  return (
    `${stats.regions} regions -> ${stats.rings} rings (${stats.holes} holes, ` +
    `${stats.extraOuterRings} extra outer rings from diagonal pinches); ` +
    `${stats.vertices} vertices, worst region ${stats.maxVerticesId} at ${stats.maxVertices}; ` +
    `${stats.droppedHoles} holes filled in below the minimum; ` +
    `area check ${stats.areaMismatches === 0 ? "exact" : `FAILED on ${stats.areaMismatches}`}`
  );
}
