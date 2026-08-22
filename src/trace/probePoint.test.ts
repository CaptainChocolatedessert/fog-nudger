import { describe, expect, it } from "vitest";

import { field as buildField } from "./fixtures";
import { maskFromRows } from "./fixtures";
import { labelSpace } from "./label";
import { describePoint, readPoint } from "./probePoint";

const rows = [
  "#####",
  "#...#",
  "#.#.#",
  "#...#",
  "#####",
];
const mask = maskFromRows(rows);
/** Ink dark, floor bright — so a reading can be checked against its own tone. */
const field = buildField(5, 5, (x, y) => (rows[y]![x] === "#" ? 0.15 : 0.93));

describe("readPoint", () => {
  it("names the region a floor pixel belongs to", () => {
    const labelled = labelSpace(mask);
    const reading = readPoint(field, mask, labelled, 1, 1);

    expect(reading.kind).toBe("region");
    expect(reading.region).toBe(labelled.regions[0]!.id);
    expect(reading.luminance).toBeCloseTo(0.93);
  });

  it("names ink as ink, and reports how dark it actually is", () => {
    // The tone is the point. "It is ink" and "it is ink and it is nearly white" are the same
    // sentence about the mask and completely different findings about the binariser.
    const reading = readPoint(field, mask, labelSpace(mask), 2, 2);
    expect(reading.kind).toBe("ink");
    expect(reading.luminance).toBeCloseTo(0.15);
    expect(reading.region).toBe(0);
  });

  it("separates floor the filter discarded from ink", () => {
    // Three outcomes that look identical on screen — covered floor, discarded floor, ink — and only
    // this can tell them apart. The pillar's own cell is floor here, dropped for being one pixel.
    const holed = maskFromRows(["#####", "#...#", "#.#.#", "#...#", "#####"]);
    const inner = maskFromRows(["#####", "#####", "##.##", "#####", "#####"]);
    const labelled = labelSpace(inner, { minArea: 4 });
    const reading = readPoint(field, inner, labelled, 2, 2);

    expect(reading.kind).toBe("discarded");
    expect(reading.region).toBe(0);
    expect(readPoint(field, holed, labelSpace(holed), 2, 2).kind).toBe("ink");
  });

  it("says when the point missed the map altogether", () => {
    const labelled = labelSpace(mask);
    for (const [x, y] of [
      [-1, 2],
      [2, -1],
      [5, 2],
      [2, 5],
    ]) {
      expect(readPoint(field, mask, labelled, x!, y!).kind).toBe("outside-raster");
    }
  });

  it("floors a fractional coordinate rather than rounding it", () => {
    // World-to-raster arithmetic lands between pixels. Rounding would read the neighbour at the
    // boundary, which is exactly where a probe is most likely to be aimed.
    const labelled = labelSpace(mask);
    expect(readPoint(field, mask, labelled, 2.9, 2.9).kind).toBe("ink");
    expect(readPoint(field, mask, labelled, 3.1, 2.9).kind).toBe("region");
  });
});

describe("describePoint", () => {
  it("says a covered point is covered, which is the finding that ends the question", () => {
    const labelled = labelSpace(mask);
    const line = describePoint(readPoint(field, mask, labelled, 1, 1), 4);
    expect(line).toContain("IS covered");
    expect(line).toContain("rendering question");
  });

  it("flags ink that has no business being ink", () => {
    // The case worth shouting about: a near-white pixel called ink means the binariser is wrong
    // there, and saying only "it is ink" would bury that under a true but useless statement.
    const white = buildField(5, 5, () => 0.95);
    const line = describePoint(readPoint(white, mask, labelSpace(mask), 2, 2), 4);
    expect(line).toContain("nearly white");
  });

  it("does not cry wolf over ink that is genuinely dark", () => {
    const line = describePoint(readPoint(field, mask, labelSpace(mask), 2, 2), 4);
    expect(line).toContain("expected answer");
    expect(line).not.toContain("nearly white");
  });

  it("says something in every case", () => {
    const labelled = labelSpace(mask);
    for (const [x, y] of [
      [1, 1],
      [2, 2],
      [-1, -1],
    ]) {
      expect(describePoint(readPoint(field, mask, labelled, x!, y!), 4).length).toBeGreaterThan(20);
    }
  });
});
