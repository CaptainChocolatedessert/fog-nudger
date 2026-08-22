/**
 * Roadmap step 6 — simplification. Douglas–Peucker over the traced rings, ported from the sibling
 * and re-aimed.
 *
 * Tracing produces polygons that are correct and unusable. A room at native resolution has a vertex
 * wherever its boundary turns, which on real ink is most of the way along it, and an item's command
 * array caps at exactly 8192 entries (DESIGN.md §7). Nothing is visible in a room until this stage
 * exists, which is why steps 5 and 6 are a pair.
 *
 * ## The bound that makes a tolerance safe
 *
 * Douglas–Peucker keeps a subset of the original vertices and discards only points lying within
 * `tolerance` of the chord replacing them, so **the simplified boundary stays inside a band of
 * `tolerance` either side of the traced one**. Error in the inward direction eats into the room and
 * is merely ugly. Error outward runs into the wall, which DESIGN.md §4 actually *wants* up to about
 * half the wall's thickness — and which becomes the merge failure this project fears most past it,
 * because a boundary that crosses the middle of a partition can meet the room on the other side.
 *
 * So the rule is a single inequality: **keep the tolerance below half the measured ink width** and
 * the boundary provably cannot cross the centre of a wall. That is the whole argument for the
 * default, and it is why §5 insists this parameter be denominated in ink width rather than raster
 * pixels — a tolerance in pixels means nothing without knowing how thick the linework is.
 *
 * This is a bound on *displacement*, not a promise about topology. Two things it does not cover are
 * named rather than glossed: a doorway notch shallower than the tolerance can be cut off entirely,
 * and Douglas–Peucker on a closed ring can in principle produce a self-intersection. Both need a
 * tolerance comparable to a room feature to happen at all, which the default is far below.
 *
 * ## Meeting the cap by simplifying harder, never by splitting
 *
 * Splitting an oversized region into two adjacent shapes is the obvious remedy and it is the
 * sharpest trap in the design: Dynamic Fog derives a wall from every shape boundary, so the join
 * becomes a wall across the middle of a room (DESIGN.md §10). So a region over the cap has its
 * tolerance doubled and is re-simplified from the *original* rings, which keeps the displacement
 * bound above stated against the tolerance the region actually ended at rather than against the sum
 * of every rung of the ladder.
 *
 * Escalation stops at a ceiling, and a region still over the cap after that is **reported rather
 * than fixed**. Emitting it would fail at the SDK boundary; splitting it would put a wall through a
 * room; and quietly crushing it to fit would produce a room shaped like nothing on the map. Naming
 * it is the honest option, and the number is the signal that either the ink is far noisier than
 * expected or a region has merged into something enormous.
 *
 * ## Why the exterior is not special-cased, though §4 says it could be
 *
 * DESIGN.md §4 grants the exterior a much looser setting than any room: there is no room out there
 * to clip and nobody to cut off. It gets none, because the pipeline deliberately does not know
 * which region the exterior is — §4 removed that classification precisely because no rule for it
 * survived contact with real maps.
 *
 * The escalation ladder covers the case anyway, and covers it without a guess. Only a region whose
 * boundary is enormous escalates at all, the exterior's boundary wraps every room on the map, and
 * an ordinary room never comes close to the cap and so keeps the tight tolerance. The exterior ends
 * up loosely simplified because it is large, not because something decided it was the outside.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { commandCount, MIN_RING_POINTS, type Ring } from "../geometry/ring";
import type { RegionContours } from "./contours";

/** Item command arrays cap at exactly this. Bisected in a room by the sibling; DESIGN.md §7. */
export const COMMAND_CAP = 8192;

export interface SimplifyOptions {
  /**
   * Douglas–Peucker tolerance in raster pixels.
   *
   * **Denominate it in measured ink width at the call site** (DESIGN.md §5), and keep it below half
   * that width for the reason in the module note.
   */
  readonly tolerance: number;
  /**
   * Ceiling on the escalated tolerance, in raster pixels.
   *
   * Reached only by a region that cannot fit the command cap at anything gentler, which in practice
   * means the outside. Past this the region is reported as over the cap rather than simplified
   * further, because there is no tolerance at which a crushed room is a useful answer.
   */
  readonly maxTolerance: number;
  /** Overridable only so tests can drive escalation on a fixture small enough to read. */
  readonly maxCommands?: number;
}

export interface SimplifiedRegion {
  readonly id: number;
  readonly rings: readonly Ring[];
  /** Command-array entries this region would cost, by `commandCount`. */
  readonly commands: number;
  /** The tolerance this region ended up simplified at, after any escalation. */
  readonly tolerance: number;
  /** How many times the tolerance had to be doubled to fit the cap. */
  readonly escalations: number;
  /** Still over the cap at the ceiling tolerance. Cannot be emitted; must be reported. */
  readonly overCap: boolean;
  /**
   * Rings kept at full detail because reducing them would have removed them entirely.
   *
   * A ring small against the tolerance collapses to two points and stops being a shape at all, and
   * for a region that means the room simply vanishes from the output. Vertices are the cheap thing
   * here and a room is not, so the original is kept instead — which costs at most a handful of
   * commands, since a ring that collapses is by definition tiny.
   */
  readonly preservedRings: number;
  readonly verticesBefore: number;
  readonly vertices: number;
}

export function simplifyRegions(
  regions: readonly RegionContours[],
  options: SimplifyOptions,
): SimplifiedRegion[] {
  return regions.map((region) => simplifyRegion(region, options));
}

export function simplifyRegion(
  region: RegionContours,
  options: SimplifyOptions,
): SimplifiedRegion {
  const cap = options.maxCommands ?? COMMAND_CAP;
  const ceiling = Math.max(options.tolerance, options.maxTolerance);

  let tolerance = options.tolerance;
  let escalations = 0;
  let result = simplifyRings(region.rings, tolerance);
  let commands = commandCount(result.rings);

  // `tolerance > 0` is not decoration: doubling zero is zero, so without it a caller asking for no
  // simplification at all would spin here forever on any region over the cap.
  while (commands > cap && tolerance > 0 && tolerance < ceiling) {
    tolerance = Math.min(tolerance * 2, ceiling);
    escalations += 1;
    // From the original rings every time, which costs a little and is worth it for not having to
    // rely on an argument. The two are in fact identical while the tolerance only rises — Douglas-
    // Peucker picks the same split point in an interval whatever the tolerance, so the retained sets
    // nest and re-running on the survivors reproduces the same descent. That was checked rather than
    // assumed: two hundred thousand random polylines found no rising ladder that differed, and a
    // *falling* one differed within four. Correct either way; this way needs no proof to read.
    result = simplifyRings(region.rings, tolerance);
    commands = commandCount(result.rings);
  }

  let vertices = 0;
  for (const ring of result.rings) vertices += ring.length;

  return {
    id: region.id,
    rings: result.rings,
    commands,
    tolerance,
    escalations,
    overCap: commands > cap,
    preservedRings: result.preserved,
    verticesBefore: region.vertices,
    vertices,
  };
}

export function simplifyRings(
  rings: readonly Ring[],
  tolerance: number,
): { rings: Ring[]; preserved: number } {
  let preserved = 0;
  const out = rings.map((ring) => {
    const simplified = simplifyRing(ring, tolerance);
    if (simplified !== ring && simplified.length < MIN_RING_POINTS) {
      preserved += 1;
      return ring;
    }
    return simplified;
  });
  return { rings: out, preserved };
}

/**
 * Douglas–Peucker on a closed ring.
 *
 * A loop has no endpoints to anchor the recursion, so it is cut at the vertex furthest from the
 * first — the point most likely to be a real corner, and therefore the least damaging place to
 * force a vertex to be kept.
 *
 * May return fewer than three points where the tolerance is large against the ring — a small room
 * flattens onto its own diagonal. Callers must not emit that; `simplifyRings` keeps the original
 * instead, and the module note says why removing a region is never the right way to save vertices.
 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (!(tolerance > 0) || ring.length <= MIN_RING_POINTS) return ring;

  const first = ring[0]!;
  let furthest = 0;
  let furthestDistance = -1;
  for (let i = 1; i < ring.length; i++) {
    const distance = squaredDistance(first, ring[i]!);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthest = i;
    }
  }

  const front = simplifyPolyline(ring.slice(0, furthest + 1), tolerance);
  const back = simplifyPolyline([...ring.slice(furthest), first], tolerance);
  // `front` ends at the cut and `back` starts there and ends back at `first`; drop both duplicates,
  // so the ring keeps the "no repeated closing point" convention the path builder expects.
  return [...front, ...back.slice(1, -1)];
}

/**
 * Douglas–Peucker on an open polyline, keeping both ends.
 *
 * Iterative rather than recursive. The recursion depth is data-dependent — shallow when splits land
 * near the middle, and approaching one frame per retained point when they do not — and a ring traced
 * at native resolution can run to six figures of points. An explicit stack costs nothing and removes
 * the question.
 */
export function simplifyPolyline(
  points: readonly Vector2[],
  tolerance: number,
): Vector2[] {
  if (points.length <= 2 || !(tolerance > 0)) return [...points];

  const toleranceSquared = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;

    const a = points[start]!;
    const b = points[end]!;
    let furthest = -1;
    let furthestDistance = 0;

    for (let i = start + 1; i < end; i++) {
      const distance = squaredDistanceToSegment(points[i]!, a, b);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthest = i;
      }
    }

    if (furthest !== -1 && furthestDistance > toleranceSquared) {
      keep[furthest] = 1;
      stack.push([start, furthest], [furthest, end]);
    }
  }

  const out: Vector2[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === 1) out.push(points[i]!);
  }
  return out;
}

function squaredDistanceToSegment(point: Vector2, a: Vector2, b: Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return squaredDistance(point, a);

  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const ex = point.x - (a.x + t * dx);
  const ey = point.y - (a.y + t * dy);
  return ex * ex + ey * ey;
}

function squaredDistance(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export interface SimplifyStats {
  readonly regions: number;
  readonly verticesBefore: number;
  readonly vertices: number;
  /** Total command-array entries across every region, one item per region. */
  readonly commands: number;
  readonly worstCommands: number;
  readonly worstId: number;
  /** Regions whose tolerance had to be raised to fit the cap. */
  readonly escalated: number;
  /** The largest tolerance any region ended at. */
  readonly maxTolerance: number;
  /** Regions that still exceed the cap and therefore cannot be emitted as they stand. */
  readonly overCap: number;
  readonly preservedRings: number;
}

export function simplifyStats(regions: readonly SimplifiedRegion[]): SimplifyStats {
  let verticesBefore = 0;
  let vertices = 0;
  let commands = 0;
  let worstCommands = 0;
  let worstId = 0;
  let escalated = 0;
  let maxTolerance = 0;
  let overCap = 0;
  let preservedRings = 0;

  for (const region of regions) {
    verticesBefore += region.verticesBefore;
    vertices += region.vertices;
    commands += region.commands;
    if (region.commands > worstCommands) {
      worstCommands = region.commands;
      worstId = region.id;
    }
    if (region.escalations > 0) escalated += 1;
    if (region.tolerance > maxTolerance) maxTolerance = region.tolerance;
    if (region.overCap) overCap += 1;
    preservedRings += region.preservedRings;
  }

  return {
    regions: regions.length,
    verticesBefore,
    vertices,
    commands,
    worstCommands,
    worstId,
    escalated,
    maxTolerance,
    overCap,
    preservedRings,
  };
}

/** One line, in every case including the empty one. */
export function describeSimplification(stats: SimplifyStats): string {
  if (stats.regions === 0) return "nothing to simplify";

  const reduction =
    stats.verticesBefore === 0 ? 0 : 1 - stats.vertices / stats.verticesBefore;

  return (
    `${stats.verticesBefore} vertices -> ${stats.vertices} ` +
    `(${(reduction * 100).toFixed(1)}% away), ${stats.commands} path commands across ` +
    `${stats.regions} items; worst region ${stats.worstId} at ${stats.worstCommands} of ` +
    `${COMMAND_CAP}; ${stats.escalated} needed a looser tolerance, up to ` +
    `${stats.maxTolerance.toFixed(2)}px; ${stats.overCap} still over the cap; ` +
    `${stats.preservedRings} rings too small to reduce and kept whole`
  );
}
