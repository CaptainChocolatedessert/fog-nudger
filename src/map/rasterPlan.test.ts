import { describe, expect, it } from "vitest";

import { MEGAPIXEL_BUDGET, megapixels, planRaster } from "./rasterPlan";

describe("planRaster", () => {
  it("leaves an ordinary map at native resolution", () => {
    // 16 megapixels — the common case, and the whole point of the module is that it passes through
    // untouched rather than being resampled for no reason.
    const plan = planRaster(4000, 4000);
    expect(plan).toMatchObject({ width: 4000, height: 4000, factor: 1, capped: false });
  });

  it("never upscales a small image", () => {
    const plan = planRaster(200, 150);
    expect(plan).toMatchObject({ width: 200, height: 150, factor: 1, capped: false });
  });

  it("reduces by an integer factor when the budget is exceeded", () => {
    const plan = planRaster(8000, 8000, 48);
    expect(plan.factor).toBe(2);
    expect(plan.width).toBe(4000);
    expect(plan.height).toBe(4000);
    expect(plan.capped).toBe(true);
  });

  it("reduces far enough to actually fit, not just one step", () => {
    // A 30x over-budget image must not come back one halving down and still over. The property
    // that matters is the result being inside the budget, whatever factor that took.
    const plan = planRaster(40000, 40000, 4);
    expect(megapixels(plan.width, plan.height)).toBeLessThanOrEqual(4);
    expect(plan.factor).toBeGreaterThan(1);
  });

  it("keeps the factor integral, so the reduction is uniform", () => {
    // The reason this matters is not tidiness: a fractional ratio resamples different parts of the
    // image against different sub-pixel phases and thins linework unevenly, which is how a wall
    // acquires a gap that is not on the map.
    for (const size of [5000, 9000, 13000, 21000]) {
      const plan = planRaster(size, size, 12);
      expect(Number.isInteger(plan.factor)).toBe(true);
      expect(plan.width).toBe(Math.floor(size / plan.factor));
    }
  });

  it("preserves aspect ratio closely under reduction", () => {
    const plan = planRaster(8000, 4000, 8);
    const sourceAspect = 8000 / 4000;
    const rasterAspect = plan.width / plan.height;
    expect(Math.abs(sourceAspect - rasterAspect)).toBeLessThan(0.01);
  });

  it("respects a dimension ceiling even when the pixel budget is satisfied", () => {
    // Long and thin: 20000x100 is only 2 megapixels, so nothing but the dimension limit catches it.
    const plan = planRaster(20000, 100, MEGAPIXEL_BUDGET, 16384);
    expect(plan.width).toBeLessThanOrEqual(16384);
    expect(plan.factor).toBe(2);
  });

  it("returns a zero plan for a degenerate image rather than throwing", () => {
    // A broken asset is reported by the caller. Throwing here would turn a bad image into a crash
    // in a surface that has no way to distinguish the two.
    for (const [w, h] of [
      [0, 0],
      [-10, 40],
      [Number.NaN, 100],
    ] as const) {
      const plan = planRaster(w, h);
      expect(plan.width).toBe(0);
      expect(plan.height).toBe(0);
    }
  });

  it("terminates on an absurd image instead of looping forever", () => {
    const plan = planRaster(1_000_000, 1_000_000, 0.001);
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });
});
