import { describe, expect, it } from "vitest";

import { field, room } from "./fixtures";
import { detectPolarity } from "./polarity";

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

  it("reports an ink width matching the wall it was given", () => {
    // The readout is derived from the *chosen* polarity's thinness, so this also checks it is not
    // quietly reporting the losing reading's figure.
    const walls = room({ width: 60, height: 60, wall: 6, ink: 0.1, ground: 0.9 });
    const reading = detectPolarity(walls, options);
    expect(reading.polarity).toBe("dark-ink");
    expect(reading.inkWidth).not.toBeNull();
    expect(reading.inkWidth!).toBeGreaterThan(3);
    expect(reading.inkWidth!).toBeLessThan(10);
  });

  it("reports a null ink width when the chosen reading found nothing", () => {
    const reading = detectPolarity(field(30, 30, () => 0.5), options);
    expect(reading.inkWidth).toBeNull();
  });

  it("disqualifies a reading that would call most of the map ink", () => {
    const walls = room({ width: 50, height: 50, wall: 2, ink: 0.1, ground: 0.9 });
    const reading = detectPolarity(walls, options);
    const chosen =
      reading.polarity === "dark-ink" ? reading.darkCoverage : reading.lightCoverage;
    expect(chosen).toBeLessThanOrEqual(0.5);
  });
});
