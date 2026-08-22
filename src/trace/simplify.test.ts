import { describe, expect, it } from "vitest";

import { commandCount, doubleSignedArea, type Ring } from "../geometry/ring";
import { traceRegions, type RegionContours } from "./contours";
import { maskFromRows } from "./fixtures";
import { labelSpace } from "./label";
import {
  COMMAND_CAP,
  describeSimplification,
  simplifyPolyline,
  simplifyRegion,
  simplifyRegions,
  simplifyRing,
  simplifyStats,
} from "./simplify";

/** A ring with `count` points around a circle of the given radius, centred on the origin. */
function circle(count: number, radius: number): Ring {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/** The furthest any point of `ring` sits from the nearest edge of `reference`. */
function maximumDeviation(ring: Ring, reference: Ring): number {
  let worst = 0;
  for (const point of ring) {
    let nearest = Infinity;
    for (let i = 0; i < reference.length; i++) {
      const a = reference[i]!;
      const b = reference[(i + 1) % reference.length]!;
      nearest = Math.min(nearest, distanceToSegment(point, a, b));
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
});

describe("simplifyRing", () => {
  it("reduces a many-sided circle and keeps it closed and convex", () => {
    const ring = circle(400, 100);
    const simplified = simplifyRing(ring, 2);

    expect(simplified.length).toBeLessThan(60);
    expect(simplified.length).toBeGreaterThan(8);
    // No repeated closing point — that is the CLOSE command's job, and a duplicate would stroke as
    // a dot at one corner of every room.
    expect(simplified[simplified.length - 1]).not.toEqual(simplified[0]);
  });

  it("stays inside the tolerance band it promises", () => {
    // The whole safety argument rests on this: every retained vertex is an original one, and every
    // dropped one lay within `tolerance` of the chord. If the band held only loosely, "keep the
    // tolerance under half the ink width" would not bound anything.
    const ring = circle(400, 100);
    for (const tolerance of [0.5, 2, 8]) {
      expect(maximumDeviation(ring, simplifyRing(ring, tolerance))).toBeLessThanOrEqual(
        tolerance + 1e-9,
      );
    }
  });

  it("leaves a rectangle exactly alone", () => {
    // A traced room is mostly straight runs already, and simplification must not shave its corners.
    const rectangle: Ring = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 0, y: 40 },
    ];
    expect(simplifyRing(rectangle, 3)).toEqual(rectangle);
  });

  it("keeps a doorway notch that is deeper than the tolerance", () => {
    // The failure mode DESIGN.md §5 warns about, in its recognisable form: cutting across the mouth
    // of a notch bridges into whatever the notch opens onto. A notch ten pixels deep must survive a
    // two-pixel tolerance.
    const withNotch: Ring = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 0 },
      { x: 90, y: 0 },
      { x: 90, y: 60 },
      { x: 0, y: 60 },
    ];
    expect(simplifyRing(withNotch, 2)).toEqual(withNotch);
  });

  it("does not reduce a ring that is already minimal", () => {
    const triangle: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(simplifyRing(triangle, 50)).toEqual(triangle);
  });
});

describe("simplifyRegion", () => {
  /** A region whose boundary is a heavily-wobbled circle, so it costs many commands. */
  function wobblyRegion(points: number): RegionContours {
    const rings: Ring[] = [
      Array.from({ length: points }, (_, i) => {
        const angle = (i / points) * Math.PI * 2;
        const radius = 500 + (i % 2 === 0 ? 6 : 0);
        return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
      }),
    ];
    return {
      id: 1,
      rings,
      outerCount: 1,
      holeCount: 0,
      vertices: points,
      tracedArea: 0,
      filledHoles: 0,
      filledHoleArea: 0,
      filledHoleFloorArea: 0,
    };
  }

  it("leaves an ordinary region at the tolerance it was given", () => {
    const simplified = simplifyRegion(wobblyRegion(400), {
      tolerance: 2,
      maxTolerance: 64,
    });
    expect(simplified.escalations).toBe(0);
    expect(simplified.tolerance).toBe(2);
    expect(simplified.overCap).toBe(false);
  });

  it("raises the tolerance rather than splitting a region over the cap", () => {
    // Splitting is the obvious remedy and it is the trap: Dynamic Fog derives a wall from every
    // shape boundary, so the join becomes a wall across a room. The count of items must not go up.
    const simplified = simplifyRegion(wobblyRegion(30_000), {
      tolerance: 0.5,
      maxTolerance: 256,
      maxCommands: 200,
    });

    expect(simplified.escalations).toBeGreaterThan(0);
    expect(simplified.tolerance).toBeGreaterThan(0.5);
    expect(simplified.commands).toBeLessThanOrEqual(200);
    expect(simplified.overCap).toBe(false);
    expect(simplified.rings.length).toBe(1);
  });

  it("reports a region it still cannot fit rather than crushing or splitting it", () => {
    const simplified = simplifyRegion(wobblyRegion(30_000), {
      tolerance: 0.5,
      // A ceiling below anything that could reduce a 500-radius circle to ten commands.
      maxTolerance: 1,
      maxCommands: 10,
    });

    expect(simplified.overCap).toBe(true);
    expect(simplified.tolerance).toBe(1);
    expect(simplified.rings.length).toBe(1);
  });

  it("gives up rather than spinning when asked not to simplify at all", () => {
    // Doubling zero is zero. Without a guard the escalation ladder never climbs and never stops.
    const simplified = simplifyRegion(wobblyRegion(5_000), {
      tolerance: 0,
      maxTolerance: 64,
      maxCommands: 10,
    });
    expect(simplified.overCap).toBe(true);
    expect(simplified.escalations).toBe(0);
  });

  it("lands an escalated region exactly where starting at that tolerance would", () => {
    // Escalation must not leave a region worse off than a run that had asked for the loose tolerance
    // in the first place — otherwise the tolerance a region reports is not the tolerance describing
    // its shape, and the displacement bound is stated against the wrong number.
    const region = wobblyRegion(30_000);
    const escalated = simplifyRegion(region, { tolerance: 1, maxTolerance: 4, maxCommands: 1 });
    const direct = simplifyRegion(region, { tolerance: 4, maxTolerance: 4 });

    expect(escalated.tolerance).toBe(4);
    expect(escalated.rings).toEqual(direct.rings);
  });

  it("keeps an escalated region inside the tolerance it ended at", () => {
    // The property the ladder must not break, and the one the whole safety argument is stated
    // against: whatever tolerance a region reports, its boundary is within that of the traced one.
    // A ladder that measured each rung against the previous rung's output would drift by the sum of
    // the rungs instead, and the reported figure would understate the error.
    const region = wobblyRegion(30_000);
    const escalated = simplifyRegion(region, { tolerance: 0.5, maxTolerance: 64, maxCommands: 200 });

    expect(escalated.escalations).toBeGreaterThan(1);
    expect(maximumDeviation(region.rings[0]!, escalated.rings[0]!)).toBeLessThanOrEqual(
      escalated.tolerance + 1e-9,
    );
  });

  it("counts commands the way the path builder will", () => {
    const simplified = simplifyRegion(wobblyRegion(400), { tolerance: 2, maxTolerance: 64 });
    expect(simplified.commands).toBe(commandCount(simplified.rings));
  });

  it("keeps a ring the tolerance would have annihilated, rather than losing it", () => {
    // A ring small against the tolerance flattens onto its own diagonal and stops being a shape.
    // For a hole that means the region covers whatever the hole was hiding; for a small room it
    // means the room is simply absent from the output. Vertices are the cheap thing here, so the
    // original is kept — a ring that collapses is tiny, and keeping it whole costs a handful of
    // commands.
    const region: RegionContours = {
      id: 1,
      rings: [circle(40, 100), circle(12, 1)],
      outerCount: 1,
      holeCount: 1,
      vertices: 52,
      tracedArea: 0,
      filledHoles: 0,
      filledHoleArea: 0,
      filledHoleFloorArea: 0,
    };
    const simplified = simplifyRegion(region, { tolerance: 10, maxTolerance: 10 });

    expect(simplified.preservedRings).toBe(1);
    expect(simplified.rings).toHaveLength(2);
    expect(simplified.rings[1]).toHaveLength(12);
  });
});

describe("simplifyRegions over a traced map", () => {
  const rows = [
    "..................",
    ".################.",
    ".#......#........#",
    ".#..##..#..####..#",
    ".#..##..#..#..#..#",
    ".#......#..####..#",
    ".########........#",
    ".#...............#",
    ".################.",
    "..................",
  ];

  it("keeps every region as exactly one item", () => {
    // One shape per region is the architecture (DESIGN.md §4). If this ever stops holding, a wall
    // has appeared somewhere the map does not have one.
    const labelled = labelSpace(maskFromRows(rows));
    const traced = traceRegions(labelled);
    const simplified = simplifyRegions(traced, { tolerance: 0.5, maxTolerance: 16 });

    expect(simplified).toHaveLength(traced.length);
    expect(simplified.every((region) => region.commands <= COMMAND_CAP)).toBe(true);
  });

  it("does not turn a room inside out", () => {
    // A cheap topology check that a displacement bound does not give on its own: a ring whose area
    // changed sign has been folded, and a hole that became an outer ring reveals what it was
    // hiding.
    const labelled = labelSpace(maskFromRows(rows));
    const traced = traceRegions(labelled);
    const simplified = simplifyRegions(traced, { tolerance: 1, maxTolerance: 16 });

    for (let i = 0; i < traced.length; i++) {
      const before = traced[i]!.rings.map((ring) => Math.sign(doubleSignedArea(ring)));
      const after = simplified[i]!.rings.map((ring) => Math.sign(doubleSignedArea(ring)));
      expect(after).toEqual(before);
    }
  });
});

describe("describeSimplification", () => {
  it("says something when there is nothing to say", () => {
    // A stage that goes quiet on an empty result cannot be told apart from a stage that never ran.
    expect(describeSimplification(simplifyStats([]))).toBe("nothing to simplify");
  });

  it("names the worst region and whether anything is still over the cap", () => {
    const labelled = labelSpace(maskFromRows(["#####", "#...#", "#.#.#", "#...#", "#####"]));
    const stats = simplifyStats(
      simplifyRegions(traceRegions(labelled), { tolerance: 0.5, maxTolerance: 16 }),
    );
    const line = describeSimplification(stats);

    expect(line).toContain("path commands");
    expect(line).toContain("still over the cap");
    expect(stats.overCap).toBe(0);
  });
});
