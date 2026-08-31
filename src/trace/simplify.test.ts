import { describe, expect, it } from "vitest";

import type { Ring } from "../geometry/ring";
import { simplifyPolyline } from "./simplify";

/** A ring with `count` points around a circle of the given radius, centred on the origin. */
function circle(count: number, radius: number): Ring {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/** Most of a circle, as an OPEN polyline — what `simplifyPolyline` is actually given. */
function openArc(count: number, radius: number): Ring {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / (count - 1)) * Math.PI * 1.5;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/**
 * The furthest any point of `points` sits from the nearest segment of `reference`.
 *
 * The reference is treated as **open**, and that is the whole of the care needed here. A closed
 * version of this lived beside it while `simplifyRing` existed, wrapping the last point back to the
 * first — and measuring an open polyline against a closed reference is wrong in the silent
 * direction: the invented closing segment can only bring a point *nearer*, so the deviation comes
 * back no larger than the truth and usually smaller. The assertion would read as strict and hold
 * loosely.
 */
function maximumDeviationOpen(points: Ring, reference: Ring): number {
  let worst = 0;
  for (const point of points) {
    let nearest = Infinity;
    for (let i = 0; i < reference.length - 1; i++) {
      nearest = Math.min(nearest, distanceToSegment(point, reference[i]!, reference[i + 1]!));
    }
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

describe("simplifyPolyline", () => {
  it("keeps both ends", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPolyline(points, 1)).toEqual([points[0], points[2]]);
  });

  it("keeps a point that carries the shape", () => {
    // The mutation that matters: a simplifier that drops everything between the ends would pass the
    // test above and destroy every corner on the map.
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 9 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPolyline(points, 1)).toHaveLength(3);
  });

  it("does nothing at zero tolerance", () => {
    const points = circle(20, 10);
    expect(simplifyPolyline(points, 0)).toHaveLength(20);
  });

  it("survives a polyline long enough to blow a recursive stack", () => {
    // A ring traced at native resolution runs to six figures of points, and Douglas–Peucker's
    // recursion depth is data-dependent. A monotone staircase is the shape that splits worst.
    const points = Array.from({ length: 200_000 }, (_, i) => ({ x: i, y: Math.sqrt(i) }));
    expect(() => simplifyPolyline(points, 0.5)).not.toThrow();
  });

  it("stays inside the tolerance band it promises", () => {
    /*
      The whole safety argument rests on this: every retained vertex is an original one, and every
      dropped one lay within `tolerance` of the chord. If the band held only loosely, "keep the
      tolerance under half the ink width" — the rule `settings.ts` caps the control against — would
      not bound anything.

      **This assertion used to be on `simplifyRing`**, which is dead: under the graph, `faces.ts`
      fits *edges*, which are open polylines, and assembles rings from them. Nothing simplifies a
      closed ring any more. Moving it here rather than deleting it with the rest is the point —
      trimming this file to "the simplifyPolyline cases" would otherwise have taken the only test of
      the displacement bound with it.
    */
    const arc = openArc(400, 100);
    for (const tolerance of [0.5, 2, 8]) {
      expect(
        maximumDeviationOpen(arc, simplifyPolyline(arc, tolerance)),
        `tolerance ${tolerance}`,
      ).toBeLessThanOrEqual(tolerance + 1e-9);
    }
  });
});
