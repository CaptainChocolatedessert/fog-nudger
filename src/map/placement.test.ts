import { describe, expect, it } from "vitest";

import {
  absorbedDrift,
  aspectMismatch,
  createPlacement,
  toWorldPoint,
  type WorldBounds,
} from "./placement";

/**
 * Deliberately asymmetric in every respect: the origin is not zero, the two axes have different
 * lengths, and the world scale differs per axis. This is the sibling's "too symmetric to fail"
 * lesson in the place it matters most — a square map at the origin cannot tell a correct transform
 * from a flipped or a transposed one, so every fixture here is chosen so that a wrong transform
 * produces a visibly wrong number.
 */
const bounds: WorldBounds = { min: { x: -300, y: 150 }, max: { x: 500, y: 550 } };
const RASTER_WIDTH = 400;
const RASTER_HEIGHT = 100;

describe("createPlacement", () => {
  it("scales each axis independently", () => {
    const placement = createPlacement(bounds, RASTER_WIDTH, RASTER_HEIGHT);
    // 800 world units over 400 px, and 400 over 100. Two different numbers, which is the entire
    // point: a single width-derived scale would put both at 2 and drift progressively down the map.
    expect(placement.unitsPerPixelX).toBe(2);
    expect(placement.unitsPerPixelY).toBe(4);
  });

  it("puts the raster origin at the bounds minimum", () => {
    const placement = createPlacement(bounds, RASTER_WIDTH, RASTER_HEIGHT);
    expect(toWorldPoint(placement, 0, 0)).toEqual({ x: -300, y: 150 });
  });

  it("puts the far corner at the bounds maximum", () => {
    // The corner that disagrees under every wrong transform — flipped, transposed, or scaled from
    // one axis. The origin alone agrees with several of those.
    const placement = createPlacement(bounds, RASTER_WIDTH, RASTER_HEIGHT);
    expect(toWorldPoint(placement, RASTER_WIDTH, RASTER_HEIGHT)).toEqual({ x: 500, y: 550 });
  });

  it("does not transpose the axes", () => {
    const placement = createPlacement(bounds, RASTER_WIDTH, RASTER_HEIGHT);
    // One pixel right is 2 units of x and no y at all; one pixel down is 4 units of y and no x.
    expect(toWorldPoint(placement, 1, 0)).toEqual({ x: -298, y: 150 });
    expect(toWorldPoint(placement, 0, 1)).toEqual({ x: -300, y: 154 });
  });

  it("yields a zero scale rather than an infinity for a zero-sized raster", () => {
    // A NaN would propagate silently through every downstream coordinate and surface much later as
    // geometry that refuses to render. Collapsing onto the origin is visibly wrong in a log.
    const placement = createPlacement(bounds, 0, 0);
    expect(placement.unitsPerPixelX).toBe(0);
    expect(placement.unitsPerPixelY).toBe(0);
    expect(toWorldPoint(placement, 10, 10)).toEqual({ x: -300, y: 150 });
  });
});

describe("aspectMismatch", () => {
  it("is zero when the bounds match the raster's aspect", () => {
    const square: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 900, y: 300 } };
    expect(aspectMismatch(square, 300, 100)).toBe(0);
  });

  it("grows with the disagreement", () => {
    const square: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
    const slight = aspectMismatch(square, 101, 100);
    const gross = aspectMismatch(square, 200, 100);
    expect(slight).toBeGreaterThan(0);
    expect(gross).toBeGreaterThan(slight);
  });

  it("is zero on a degenerate input instead of NaN", () => {
    const flat: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
    expect(aspectMismatch(flat, 100, 100)).toBe(0);
    const square: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
    expect(aspectMismatch(square, 0, 0)).toBe(0);
  });
});

describe("absorbedDrift", () => {
  it("is zero when both axes scale identically", () => {
    const square: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 200, y: 100 } };
    expect(absorbedDrift(createPlacement(square, 200, 100))).toBe(0);
  });

  it("reports how far a single scale would have pushed the bottom edge", () => {
    // The ratio-versus-displacement confusion this exists to prevent: the bounds below are only 1%
    // off the raster's aspect, which sounds negligible, and it is ten world units at the bottom of
    // the map — several times the width of the linework on a typical map.
    const nudged: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 990 } };
    const drift = absorbedDrift(createPlacement(nudged, 1000, 1000));
    expect(drift).toBeCloseTo(10, 6);
  });
});
