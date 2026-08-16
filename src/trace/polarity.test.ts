import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { field, room } from "./fixtures";
import { detectPolarity, thinness } from "./polarity";

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

describe("thinness", () => {
  it("scores a hairline at 1", () => {
    // Nothing survives eroding a one-pixel line, which is the definition this measure rests on.
    expect(thinness(mask(20, 20, (_x, y) => y === 10))).toBe(1);
  });

  it("scores a solid blob near 0", () => {
    // A filled square loses only its rim, so most of it survives.
    expect(thinness(mask(40, 40, () => true))).toBeLessThan(0.15);
  });

  it("puts a thick stroke between the two", () => {
    const thin = thinness(mask(40, 40, (_x, y) => y === 20));
    const thick = thinness(mask(40, 40, (_x, y) => y >= 18 && y <= 22));
    const solid = thinness(mask(40, 40, () => true));

    expect(thin).toBeGreaterThan(thick);
    expect(thick).toBeGreaterThan(solid);
  });

  it("is 0 for a mask with no ink, rather than NaN", () => {
    // A division by zero here would propagate into the comparison and make an empty reading win.
    expect(thinness(emptyMask(10, 10))).toBe(0);
  });

  it("treats the image edge as ground", () => {
    // Conservative on purpose: it can only make a shape look thinner, never thicker.
    expect(thinness(mask(5, 5, () => true))).toBeGreaterThan(0);
  });
});

describe("detectPolarity", () => {
  const options = { radius: 8, k: 0.34 };

  it("reads dark linework on a light ground", () => {
    const walls = room({ width: 50, height: 50, wall: 2, ink: 0.1, ground: 0.9 });
    const reading = detectPolarity(walls, options);
    expect(reading.polarity).toBe("dark-ink");
    expect(reading.confident).toBe(true);
  });

  it("reads light linework on a dark ground", () => {
    const walls = room({ width: 50, height: 50, wall: 2, ink: 0.9, ground: 0.1 });
    const reading = detectPolarity(walls, options);
    expect(reading.polarity).toBe("light-ink");
    expect(reading.confident).toBe(true);
  });

  it("gets a dark-walled map with a dark exterior right, where the minority rule fails", () => {
    // The case the thinness measure exists for, and the reason "the ink is the minority class" was
    // rejected. Dark walls, light room floors, and a dark fill outside the room: most of the image
    // is dark, so an area-based rule would call the ink light and invert the entire trace. The
    // linework is still the only thin thing in the picture.
    const map = field(60, 60, (x, y) => {
      const inRoom = x >= 10 && x < 50 && y >= 10 && y < 50;
      if (!inRoom) return 0.15; // dark exterior
      const onWall = x < 13 || y < 13 || x >= 47 || y >= 47;
      return onWall ? 0.05 : 0.95; // dark wall, light floor
    });

    const reading = detectPolarity(map, options);
    expect(reading.polarity).toBe("dark-ink");

    // And the rule being replaced would indeed have gone the other way on this fixture, which is
    // what makes it a fair test rather than a restatement of the answer.
    let dark = 0;
    for (const value of map.data) if (value < 0.5) dark += 1;
    expect(dark / map.data.length).toBeGreaterThan(0.5);
  });

  it("returns the mask for the polarity it chose", () => {
    const walls = room({ width: 40, height: 40, wall: 2, ink: 0.9, ground: 0.1 });
    const reading = detectPolarity(walls, options);
    // Light ink means the chosen mask must mark the bright wall, not the dark floor.
    expect(reading.mask.data[reading.mask.width * 20 + 1]).toBe(1);
    expect(reading.mask.data[reading.mask.width * 20 + 20]).toBe(0);
  });

  it("is not confident about a flat field, and still returns something usable", () => {
    // A blank asset is a real state. Reporting low confidence beats inventing a verdict, and
    // returning a mask anyway keeps the caller's code on one path.
    const reading = detectPolarity(field(30, 30, () => 0.5), options);
    expect(reading.confident).toBe(false);
    expect(reading.mask.width).toBe(30);
  });

  it("disqualifies a reading that would call most of the map ink", () => {
    const walls = room({ width: 50, height: 50, wall: 2, ink: 0.1, ground: 0.9 });
    const reading = detectPolarity(walls, options);
    const chosen =
      reading.polarity === "dark-ink" ? reading.darkCoverage : reading.lightCoverage;
    expect(chosen).toBeLessThanOrEqual(0.5);
  });
});
