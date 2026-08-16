import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { erosionCounts, estimateInkWidth, inkWidthFromThinness, thinness } from "./inkMetrics";

function mask(
  width: number,
  height: number,
  ink: (x: number, y: number) => boolean,
): BinaryMask {
  const out = emptyMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.data[y * width + x] = ink(x, y) ? 1 : 0;
  }
  return out;
}

/** A horizontal band `w` pixels thick, well clear of the image edges. */
const stroke = (w: number) =>
  mask(120, 40, (_x, y) => y >= 20 && y < 20 + w);

describe("erosionCounts", () => {
  it("counts ink and survivors separately", () => {
    const counts = erosionCounts(stroke(5));
    expect(counts.ink).toBe(120 * 5);
    // A five-thick band keeps its middle three rows, minus the two end columns each row loses.
    expect(counts.survivors).toBe(118 * 3);
  });

  it("treats the image edge as ground", () => {
    // Conservative on purpose: it can only make a shape look thinner, never thicker.
    const solid = mask(5, 5, () => true);
    expect(erosionCounts(solid)).toEqual({ ink: 25, survivors: 9 });
  });
});

describe("thinness", () => {
  it("scores a hairline at 1", () => {
    expect(thinness(stroke(1))).toBe(1);
  });

  it("scores a solid blob near 0", () => {
    expect(thinness(mask(200, 200, () => true))).toBeLessThan(0.05);
  });

  it("orders thin, thick and solid", () => {
    expect(thinness(stroke(1))).toBeGreaterThan(thinness(stroke(5)));
    expect(thinness(stroke(5))).toBeGreaterThan(thinness(mask(120, 40, () => true)));
  });

  it("is 0 for a mask with no ink, rather than NaN", () => {
    // A division by zero here would propagate into the polarity comparison and let an empty
    // reading win against a real one.
    expect(thinness(emptyMask(10, 10))).toBe(0);
  });
});

describe("inkWidthFromThinness", () => {
  it("inverts the 2/w relation", () => {
    expect(inkWidthFromThinness(0.5)).toBeCloseTo(4, 6);
    expect(inkWidthFromThinness(0.25)).toBeCloseTo(8, 6);
  });

  it("returns null for no ink rather than infinity", () => {
    expect(inkWidthFromThinness(0)).toBeNull();
    expect(inkWidthFromThinness(-1)).toBeNull();
  });
});

describe("estimateInkWidth", () => {
  it("recovers the width of a plain stroke", () => {
    // The claim the whole readout rests on. Checked across several widths rather than one, since a
    // single width is satisfied by constants that are not the formula.
    for (const w of [4, 6, 8, 12]) {
      const estimate = estimateInkWidth(stroke(w))!;
      expect(estimate).toBeGreaterThan(w - 1);
      expect(estimate).toBeLessThan(w + 1);
    }
  });

  it("saturates at 2 for anything thinner", () => {
    // Erosion removes a one-pixel and a two-pixel stroke alike, so both report 2. Pinned down
    // because every length derived from ink width inherits this floor.
    expect(estimateInkWidth(stroke(1))).toBeCloseTo(2, 6);
    expect(estimateInkWidth(stroke(2))).toBeCloseTo(2, 6);
  });

  it("is biased thin on a mixture, not averaged", () => {
    // The caveat stated as a test. An area-weighted *harmonic* mean is dominated by its smallest
    // terms, so a scattering of one-pixel specks drags the estimate below the arithmetic mean of
    // the widths actually present. Anyone reading the number needs this to be true and known.
    const withSpecks = mask(120, 60, (x, y) => {
      const band = y >= 10 && y < 20; // a ten-pixel stroke
      const speck = y === 40 && x % 3 === 0; // isolated single pixels
      return band || speck;
    });
    const estimate = estimateInkWidth(withSpecks)!;
    expect(estimate).toBeLessThan(10);
  });

  it("returns null for an empty mask", () => {
    expect(estimateInkWidth(emptyMask(8, 8))).toBeNull();
  });
});
