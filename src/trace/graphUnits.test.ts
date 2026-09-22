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

import { clampToExtent, graphExtent, rasterPixelsPerGraphUnit } from "./graphUnits";

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

/**
 * Keeping a dragged vertex on the map.
 *
 * A drag is the one gesture handed a position past the map's edge, and Move stored it — leaving a
 * vertex that could not be grabbed again, because a press off the map is not a press. With the edge
 * walled it also split the wall and left a piece outside, unreachable (user, 2026-09-22, in a room).
 *
 * **Five mutations on 2026-09-22, five caught**: each of the four bounds dropped in turn, and both
 * axes clamped against the long side — which is the one that would pass on a square map.
 */
describe("clampToExtent", () => {
  /** A landscape map: x runs to 1, y stops short. */
  const WIDE = graphExtent(3300, 2550);

  it("leaves a position already on the map exactly where it is", () => {
    const held = clampToExtent(0.4, 0.3, WIDE);
    expect(held).toEqual({ x: 0.4, y: 0.3 });
  });

  /*
    Per axis, which is the whole behaviour a GM sees: pushed out through the left edge the vertex
    keeps following the pointer up and down rather than stopping where it crossed.
  */
  it("slides along the edge it met, keeping the other axis", () => {
    expect(clampToExtent(-0.5, 0.3, WIDE)).toEqual({ x: 0, y: 0.3 });
    expect(clampToExtent(0.4, -0.2, WIDE)).toEqual({ x: 0.4, y: 0 });
  });

  it("stops at the far edges, which are the map's own and not the unit square", () => {
    expect(clampToExtent(4, 0.3, WIDE)).toEqual({ x: 1, y: 0.3 });
    // The short side: a clamp against 1 would let the vertex sit well below the map.
    expect(clampToExtent(0.4, 4, WIDE)).toEqual({ x: 0.4, y: WIDE.y });
    expect(WIDE.y).toBeLessThan(1);
  });

  it("puts a position dragged past a corner in the corner", () => {
    expect(clampToExtent(-3, -3, WIDE)).toEqual({ x: 0, y: 0 });
    expect(clampToExtent(9, 9, WIDE)).toEqual({ x: 1, y: WIDE.y });
  });

  it("holds a portrait map the other way round", () => {
    const tall = graphExtent(2550, 3300);
    expect(clampToExtent(9, 9, tall)).toEqual({ x: tall.x, y: 1 });
  });
});
