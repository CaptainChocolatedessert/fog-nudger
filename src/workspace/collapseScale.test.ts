/**
 * Where *Collapse small regions*' handle starts and what its track spans.
 *
 * Four mutations on 2026-09-21 — four square ink widths, the ink width left in raster pixels, a top
 * that is not the whole map's area, and a floor that is not the square of the amounts' — four caught.
 */

import { describe, expect, it } from "vitest";

import { fromSlider, SLIDER_STEPS, toSlider } from "../sliderScale";
import { AREA_FLOOR, collapseLimits, FALLBACK_START, startingSize } from "./collapseScale";

describe("the size track", () => {
  it("runs from off to the area of the whole map", () => {
    const limits = collapseLimits({ x: 1, y: 0.75 })!;
    expect(limits.max).toBe(0.75);
    expect(fromSlider(0, limits, "log")).toBe(0);
    expect(fromSlider(SLIDER_STEPS, limits, "log")).toBeCloseTo(0.75, 6);
    // The first position past off is the floor, which is the square of the amounts' floor.
    expect(fromSlider(1, limits, "log")).toBeCloseTo(AREA_FLOOR, 12);
    expect(AREA_FLOOR).toBeCloseTo(2e-4 * 2e-4, 18);
  });

  it("has no track on a map with no area", () => {
    expect(collapseLimits({ x: 0, y: 1 })).toBeNull();
  });
});

describe("where the handle starts", () => {
  /*
    The Incandescent Grottoes: 3.4px ink on a raster 3,626 pixels across, whose longer side is one
    graph unit — so an ink width is 3.4 / 3626 of a unit and the start is eight of those squared.
  */
  it("is eight square ink widths, converted from the raster", () => {
    const start = startingSize(3.4, 3626);
    expect(start).toBeCloseTo(8 * (3.4 / 3626) ** 2, 15);
  });

  it("falls back to a fixed size with no ink width, or no raster scale", () => {
    expect(startingSize(null, 3626)).toBe(FALLBACK_START);
    expect(startingSize(3.4, null)).toBe(FALLBACK_START);
    expect(startingSize(0, 3626)).toBe(FALLBACK_START);
  });

  it("lands well inside the track rather than at either end, on a real map's figures", () => {
    const limits = collapseLimits({ x: 1, y: 2598 / 3626 })!;
    const position = toSlider(startingSize(3.4, 3626), limits, "log");
    expect(position).toBeGreaterThan(SLIDER_STEPS * 0.1);
    expect(position).toBeLessThan(SLIDER_STEPS * 0.6);
  });
});
