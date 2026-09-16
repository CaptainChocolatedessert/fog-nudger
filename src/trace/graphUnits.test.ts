/**
 * Graph units: the map image's longer side is 1.
 *
 * Small, and pinned because everything that measures the wall graph now leans on it — the fit, the
 * frame, placement in the world, and every readout that turns a setting back into pixels.
 *
 * Mutation-tested with the unit change on 2026-09-16: thirteen mutations across this module, the
 * build, the frame, emission and the gap ring's hit test, thirteen caught — four of them here.
 */

import { describe, expect, it } from "vitest";

import { graphExtent, rasterPixelsPerGraphUnit } from "./graphUnits";

describe("graphExtent", () => {
  it("makes the longer side exactly 1, whichever side that is", () => {
    expect(graphExtent(3300, 2550).x).toBe(1);
    expect(graphExtent(2550, 3300).y).toBe(1);
  });

  it("gives the shorter side its share of the longer, quantised as the document holds it", () => {
    // Quantised, so a coordinate placed at the extent is exactly the extent after a store round trip.
    expect(graphExtent(3300, 2550).y).toBe(Math.fround(2550 / 3300));
    expect(graphExtent(2550, 3300).x).toBe(Math.fround(2550 / 3300));
  });

  it("is a unit square for a square map, which is where the old unit and this one agree", () => {
    expect(graphExtent(1024, 1024)).toEqual({ x: 1, y: 1 });
  });

  it("is a unit square rather than a NaN for a size with no aspect", () => {
    // A zero or missing dimension would otherwise divide into NaN, which propagates silently through
    // placement and surfaces as geometry that will not render.
    expect(graphExtent(0, 100)).toEqual({ x: 1, y: 1 });
    expect(graphExtent(100, -1)).toEqual({ x: 1, y: 1 });
    expect(graphExtent(Number.NaN, 100)).toEqual({ x: 1, y: 1 });
  });
});

describe("rasterPixelsPerGraphUnit", () => {
  it("is the raster's longer side when the raster is the image", () => {
    expect(rasterPixelsPerGraphUnit(3300, graphExtent(3300, 2550))).toBeCloseTo(3300, 9);
    // A portrait map: the raster's width is the short side, and a unit is still its height.
    expect(rasterPixelsPerGraphUnit(2550, graphExtent(2550, 3300))).toBeCloseTo(3300, 3);
  });

  it("follows the raster, not the image, when the raster was reduced", () => {
    // Half size: a graph unit is half as many raster pixels, which is what keeps a setting in graph
    // units meaning the same stretch of map at any megapixel cap.
    expect(rasterPixelsPerGraphUnit(1650, graphExtent(3300, 2550))).toBeCloseTo(1650, 9);
  });

  it("is zero rather than an infinity for an extent with no width", () => {
    expect(rasterPixelsPerGraphUnit(100, { x: 0, y: 1 })).toBe(0);
  });
});
