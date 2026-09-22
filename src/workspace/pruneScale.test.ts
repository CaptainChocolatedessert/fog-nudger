/**
 * Where *Prune the dead ends*' handle starts and what its track spans.
 *
 * Four mutations on 2026-09-22 — two ink widths, the ink width left in raster pixels, a floor that is
 * not the shared one, and a track accepted at the floor — four caught.
 */

import { describe, expect, it } from "vitest";

import { fromSlider, SLIDER_STEPS, toSlider } from "../sliderScale";
import { TRACK_FLOOR } from "./graphScale";
import { FALLBACK_START, pruneLimits, startingLength } from "./pruneScale";

describe("the length track", () => {
  it("runs from off, through the shared floor, up to the longest wall run", () => {
    const limits = pruneLimits(0.2)!;
    expect(fromSlider(0, limits, "log")).toBe(0);
    expect(fromSlider(1, limits, "log")).toBeCloseTo(TRACK_FLOOR, 12);
    expect(fromSlider(SLIDER_STEPS, limits, "log")).toBeCloseTo(0.2, 6);
  });

  it("has no track with nothing measured, or nothing longer than the floor", () => {
    expect(pruneLimits(null)).toBeNull();
    expect(pruneLimits(TRACK_FLOOR / 2)).toBeNull();
  });
});

describe("where the handle starts", () => {
  // The Incandescent Grottoes: 3.4px ink on a raster 3,626 pixels across its longer side.
  it("is four ink widths, converted from the raster", () => {
    expect(startingLength(3.4, 3626)).toBeCloseTo((4 * 3.4) / 3626, 15);
  });

  it("falls back to a fixed length with no ink width, or no raster scale", () => {
    expect(startingLength(null, 3626)).toBe(FALLBACK_START);
    expect(startingLength(3.4, null)).toBe(FALLBACK_START);
    expect(startingLength(-1, 3626)).toBe(FALLBACK_START);
  });

  it("lands inside the track on a real map's figures, where the longest run is a good part of the map", () => {
    const limits = pruneLimits(0.3)!;
    const position = toSlider(startingLength(3.4, 3626), limits, "log");
    expect(position).toBeGreaterThan(SLIDER_STEPS * 0.1);
    expect(position).toBeLessThan(SLIDER_STEPS * 0.8);
  });
});
