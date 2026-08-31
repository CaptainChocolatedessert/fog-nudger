/**
 * Douglas–Peucker, and the bound that makes a tolerance safe.
 *
 * Tracing produces polygons that are correct and unusable. A boundary at native resolution has a
 * vertex wherever it turns, which on real ink is most of the way along it, and an item's command
 * array caps at exactly 8192 entries (`DESIGN.md` §7).
 *
 * ## The bound that makes a tolerance safe
 *
 * Douglas–Peucker keeps a subset of the original vertices and discards only points lying within
 * `tolerance` of the chord replacing them, so **the simplified boundary stays inside a band of
 * `tolerance` either side of the traced one**. That is the whole argument for the default, and it is
 * why the parameter is denominated in ink width rather than raster pixels — a tolerance in pixels
 * means nothing without knowing how thick the linework is.
 *
 * **What the bound guards has changed, and the cap outlived its original reason.** Region-first, the
 * danger was a boundary crossing the middle of a wall and meeting the room on the other side, so
 * "keep the tolerance below half the measured ink width" provably prevented a merge. Under the wall
 * graph a face boundary *is* the wall's centreline and both faces are assembled from the same fitted
 * edge, so they move together and that sliver cannot open. The cap in `settings.ts` stays because it
 * is conservative; the risk it now guards — a corner cut across a doorway — has not been derived.
 * Do not raise it on the strength of the old argument being obsolete.
 *
 * This is a bound on *displacement*, not a promise about topology. Two things it does not cover are
 * named rather than glossed: a doorway notch shallower than the tolerance can be cut off entirely,
 * and Douglas–Peucker can in principle produce a self-intersection. Both need a tolerance comparable
 * to a room feature to happen at all, which the default is far below.
 *
 * ## What used to be here
 *
 * A per-region path — `simplifyRegions`, `simplifyRegion`, `simplifyRings`, `simplifyRing`,
 * `simplifyStats`, `describeSimplification` — with an escalation ladder that raised one region's
 * tolerance at a time. It went on 2026-08-31, unreferenced since step D. Escalation is **global**
 * now, because two faces sharing a wall are assembled from one fitted edge and a region escalated
 * alone would stop matching its neighbour; it lives in `graphRegions.ts`, which also carries the
 * rule that a region over the cap is never *split* — a join between two shapes becomes a wall across
 * the middle of a room.
 *
 * `simplifyRing` is worth one line of its own: it was the closed-ring version, cutting the loop at
 * the vertex furthest from the first so the recursion had an anchor. Nothing simplifies a closed
 * ring any more — `faces.ts` fits **edges**, which are open — so the cut-point argument is history
 * rather than machinery.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

/** Item command arrays cap at exactly this. Bisected in a room by the sibling; `DESIGN.md` §7. */
export const COMMAND_CAP = 8192;

/**
 * Douglas–Peucker on an open polyline, keeping both ends.
 *
 * Iterative rather than recursive. The recursion depth is data-dependent — shallow when splits land
 * near the middle, and approaching one frame per retained point when they do not — and a boundary
 * traced at native resolution can run to six figures of points. An explicit stack costs nothing and
 * removes the question.
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
