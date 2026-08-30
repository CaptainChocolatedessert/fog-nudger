import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { coveredArea, deriveGraphRegions, type GraphRegionOptions } from "./graphRegions";

const BASE: GraphRegionOptions = {
  spurPrunePx: 0,
  minArea: 0,
  tolerance: 0.5,
  maxTolerance: 4,
};

/**
 * Ink, not a skeleton — this is the whole chain, so it thins first. Two rooms sharing a wall, drawn
 * three pixels thick so thinning has something to do.
 */
const TWO_ROOMS = [
  "......................",
  "......................",
  "..#################...",
  "..#################...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..#################...",
  "..#################...",
  "......................",
  "......................",
];

/**
 * One room with a stub wall reaching into it from the left — the case a partition deletes outright
 * and a graph keeps. The stub separates nothing, so a watershed drops it; here it survives as a
 * branch, and shows up as a cycle enclosing no area.
 */
const ROOM_WITH_STUB = [
  "...................",
  "...................",
  "..###############..",
  "..###############..",
  "..##...........##..",
  "..##...........##..",
  "..#######......##..",
  "..#######......##..",
  "..##...........##..",
  "..##...........##..",
  "..###############..",
  "..###############..",
  "...................",
];

describe("regions derived from the wall graph", () => {
  it("finds both rooms and the space around them", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    expect(result.faces.disagreements).toBe(0);
    expect(result.faces.exact).toBe(result.faces.checked);
    // Two rooms plus the exterior, which the border frame makes an ordinary bounded face.
    expect(result.regions.length).toBeGreaterThanOrEqual(3);
  });

  it("gives the two rooms the identical points along the wall they share", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);

    // Every emitted vertex that two faces both use must be exactly one point. Fitting per ring
    // instead of per edge is what would break this, silently, by up to the tolerance.
    const counts = new Map<string, number>();
    for (const region of result.regions) {
      const own = new Set<string>();
      for (const ring of region.rings) {
        for (const point of ring) own.add(`${point.x},${point.y}`);
      }
      for (const key of own) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Shared vertices exist at all — otherwise the assertion is vacuous.
    expect([...counts.values()].some((count) => count > 1)).toBe(true);
    for (const [key, count] of counts) {
      expect(count, `vertex ${key} shared by ${count} faces`).toBeLessThanOrEqual(4);
    }
  });

  it("keeps a stub wall, which is the whole reason for the pivot", () => {
    const result = deriveGraphRegions(maskFromRows(ROOM_WITH_STUB), BASE);
    // A stub separates nothing, so the same face lies on both sides of it — the bridge criterion.
    // A watershed over regions would have deleted it outright.
    //
    // It does **not** show up as a zero-area cycle: joined to a wall, a stub is a slit *inside* the
    // room's own cycle, walked out and back. Counting degenerate cycles finds none of these, which
    // is what the first version of this test got wrong.
    expect(result.bridges).toBeGreaterThan(0);
    expect(result.degenerateCycles).toBe(0);
    expect(result.faces.exact).toBe(result.faces.checked);
  });

  it("holds the area identity whatever the pruning", () => {
    for (const spurPrunePx of [0, 3, 7]) {
      const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), { ...BASE, spurPrunePx });
      expect(result.faces.exact, `prune ${spurPrunePx}`).toBe(result.faces.checked);
      expect(result.faces.disagreements).toBe(0);
      expect(result.graph.stats.orphans).toBe(0);
    }
  });

  it("drops a face below the minimum and says how much it dropped", () => {
    const generous = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    const strict = deriveGraphRegions(maskFromRows(TWO_ROOMS), { ...BASE, minArea: 100 });

    expect(strict.regions.length).toBeLessThan(generous.regions.length);
    expect(strict.discarded).toBeGreaterThan(0);
    expect(strict.discardedArea).toBeGreaterThan(0);
  });

  it("escalates the tolerance globally, so shared walls cannot come apart", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 16,
      maxCommands: 12,
    });

    expect(result.escalations).toBeGreaterThan(0);
    // One tolerance for the whole map, not one per region — that is what makes the shared points
    // above stay shared.
    expect(result.tolerance).toBeGreaterThan(0.1);
  });

  it("covers the raster it was given", () => {
    const rows = TWO_ROOMS;
    const result = deriveGraphRegions(maskFromRows(rows), BASE);
    const raster = rows[0]!.length * rows.length;
    // The faces tile the framed raster, so together they account for nearly all of it — the
    // shortfall is the half-pixel the boundary runs through the wall on either side.
    expect(coveredArea(result.regions)).toBeGreaterThan(raster * 0.5);
    expect(coveredArea(result.regions)).toBeLessThanOrEqual(raster);
  });
});
