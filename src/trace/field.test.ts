import { describe, expect, it } from "vitest";

import { blur, luminanceField } from "./field";
import { field, greyImage } from "./fixtures";

describe("luminanceField", () => {
  it("maps grey to its own level", () => {
    // The coefficients sum to one, so a grey of v/255 lands at v/255 exactly and a failure reads as
    // a number rather than as a near-miss.
    const out = luminanceField(greyImage(2, 1, (x) => [x === 0 ? 0 : 255]));
    expect(out.data[0]).toBeCloseTo(0, 6);
    expect(out.data[1]).toBeCloseTo(1, 6);
  });

  it("weights green above red above blue", () => {
    const image = { width: 3, height: 1, data: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255] };
    const [red, green, blue] = luminanceField(image).data;
    expect(green!).toBeGreaterThan(red!);
    expect(red!).toBeGreaterThan(blue!);
  });

  it("composites transparent pixels over white", () => {
    // Same rule as the histogram, and load-bearing for the same reason: a transparent margin read as
    // ink would ring the map in a false wall that traces perfectly cleanly.
    const out = luminanceField(greyImage(2, 2, () => [0, 0]));
    for (const value of out.data) expect(value).toBeCloseTo(1, 6);
  });
});

describe("blur", () => {
  it("returns a copy for a non-positive sigma", () => {
    const original = field(3, 3, (x) => x);
    const out = blur(original, 0);
    expect([...out.data]).toEqual([...original.data]);
    expect(out.data).not.toBe(original.data);
  });

  it("preserves a flat field", () => {
    // The kernel is normalised and the edges are clamped, so a constant must survive exactly. If it
    // does not, the edges are darkening and every later threshold is wrong near the border.
    const out = blur(field(9, 9, () => 0.7), 1.5);
    for (const value of out.data) expect(value).toBeCloseTo(0.7, 5);
  });

  it("spreads a single bright pixel into its neighbours", () => {
    const out = blur(field(9, 9, (x, y) => (x === 4 && y === 4 ? 1 : 0)), 1);
    const at = (x: number, y: number) => out.data[y * out.width + x]!;
    expect(at(4, 4)).toBeLessThan(1);
    expect(at(5, 4)).toBeGreaterThan(0);
    expect(at(4, 4)).toBeGreaterThan(at(5, 4));
  });

  it("conserves total intensity", () => {
    const original = field(11, 11, (x, y) => (x === 5 && y === 5 ? 1 : 0));
    const sum = (values: Float32Array) => values.reduce((a, b) => a + b, 0);
    expect(sum(blur(original, 1.5).data)).toBeCloseTo(sum(original.data), 4);
  });

  it("handles a degenerate field", () => {
    expect(blur({ width: 0, height: 0, data: new Float32Array(0) }, 2).data).toHaveLength(0);
  });
});
