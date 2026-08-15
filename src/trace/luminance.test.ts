import { describe, expect, it } from "vitest";

import {
  describeHistogram,
  luminanceHistogram,
  meanLuminance,
  otsuSplit,
  type PixelImage,
} from "./luminance";

/**
 * Fixtures are built in code, never loaded. That is a standing rule for this project rather than a
 * convenience: nothing in the test suite should require looking at an image to know whether it
 * passed.
 *
 * `shade` returns a grey level 0–255 plus an alpha. Grey is used throughout because the luminance
 * coefficients sum to one, so a grey of `v` lands in bucket `v` exactly and a failure is readable
 * as a number rather than as a near-miss.
 */
function image(
  width: number,
  height: number,
  shade: (x: number, y: number) => readonly [number, number] | readonly [number],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const [grey, alpha = 255] = shade(x, y);
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
      data[i + 3] = alpha;
    }
  }
  return { width, height, data };
}

describe("luminanceHistogram", () => {
  it("counts every pixel exactly once", () => {
    const histogram = luminanceHistogram(image(7, 5, () => [128]));
    expect(histogram.total).toBe(35);
    expect(histogram.counts[128]).toBe(35);
  });

  it("puts a grey level in its own bucket", () => {
    const histogram = luminanceHistogram(image(2, 2, (x) => [x === 0 ? 40 : 220]));
    expect(histogram.counts[40]).toBe(2);
    expect(histogram.counts[220]).toBe(2);
  });

  it("composites transparent pixels over white, so they read as ground", () => {
    // A map asset with transparent margins is ordinary. Treating alpha as darkness would ring the
    // whole map in a false wall — and a false wall that is a closed loop traces perfectly cleanly
    // while being completely wrong, which is the worst shape a bug can take here.
    const histogram = luminanceHistogram(image(4, 4, () => [0, 0]));
    expect(histogram.counts[255]).toBe(16);
    expect(histogram.counts[0]).toBe(0);
  });

  it("handles an empty image without throwing", () => {
    const histogram = luminanceHistogram({ width: 0, height: 0, data: [] });
    expect(histogram.total).toBe(0);
  });
});

describe("otsuSplit", () => {
  it("separates ink from ground on a bimodal image", () => {
    // One pixel in ten is ink, which is the shape a dungeon map's histogram actually has.
    const histogram = luminanceHistogram(image(10, 10, (x, y) => [x === 0 && y < 10 ? 40 : 220]));
    const split = otsuSplit(histogram);

    expect(split).not.toBeNull();
    expect(split!.darkShare).toBeCloseTo(0.1, 6);
    expect(split!.threshold).toBeGreaterThanOrEqual(40);
    expect(split!.threshold).toBeLessThan(220);
    expect(split!.darkMean).toBeCloseTo(40 / 255, 3);
    expect(split!.lightMean).toBeCloseTo(220 / 255, 3);
  });

  it("reports a majority-dark image, which is what inverted polarity looks like", () => {
    // The signal step 3 needs: light ink on dark ground puts most of the image in the dark class.
    // A binarizer assuming dark-on-light would produce the exact complement of the right answer.
    const histogram = luminanceHistogram(image(10, 10, (x) => [x === 0 ? 230 : 30]));
    const split = otsuSplit(histogram);
    expect(split!.darkShare).toBeCloseTo(0.9, 6);
  });

  it("returns null for a flat image rather than inventing a threshold", () => {
    // A blank asset is a real state. A fabricated threshold would be indistinguishable from a real
    // one in the log, which is the failure this project keeps having to design against.
    expect(otsuSplit(luminanceHistogram(image(4, 4, () => [200])))).toBeNull();
  });

  it("returns null for an empty histogram", () => {
    expect(otsuSplit(luminanceHistogram({ width: 0, height: 0, data: [] }))).toBeNull();
  });

  it("reports means belonging to the chosen threshold", () => {
    // Three levels, so the means cannot come out right by coincidence: whichever way the split
    // falls, one class holds two of the levels and its mean must be between them.
    const histogram = luminanceHistogram(
      image(3, 1, (x) => [x === 0 ? 10 : x === 1 ? 20 : 250]),
    );
    const split = otsuSplit(histogram)!;
    expect(split.darkMean).toBeLessThan(split.lightMean);
    expect(split.darkShare).toBeGreaterThan(0);
    expect(split.darkShare).toBeLessThan(1);
  });
});

describe("describeHistogram", () => {
  it("puts an all-white image in the last band", () => {
    const profile = describeHistogram(luminanceHistogram(image(4, 4, () => [255])));
    expect(profile.split("|")).toHaveLength(16);
    expect(profile.split("|")[15]).toBe("100");
    expect(profile.split("|")[0]).toBe(".");
  });

  it("distinguishes an empty band from a nearly-empty one", () => {
    // The distinction is the point. "Nothing in this band" and "a rounding error's worth in this
    // band" are different facts about a map, and a profile that renders both as 0 hides the one
    // that matters — a scattering of ink where there should be none.
    const histogram = luminanceHistogram(
      image(100, 10, (x, y) => [x === 0 && y === 0 ? 8 : 255]),
    );
    const bands = describeHistogram(histogram).split("|");
    expect(bands[0]).toBe("0");
    expect(bands[1]).toBe(".");
    expect(bands[15]).toBe("99");
  });

  it("says so when there are no pixels", () => {
    expect(describeHistogram(luminanceHistogram({ width: 0, height: 0, data: [] }))).toBe(
      "no pixels",
    );
  });
});

describe("meanLuminance", () => {
  it("is the average shade", () => {
    const histogram = luminanceHistogram(image(2, 1, (x) => [x === 0 ? 0 : 255]));
    expect(meanLuminance(histogram)).toBeCloseTo(0.5, 6);
  });

  it("is zero for an empty image", () => {
    expect(meanLuminance(luminanceHistogram({ width: 0, height: 0, data: [] }))).toBe(0);
  });
});
