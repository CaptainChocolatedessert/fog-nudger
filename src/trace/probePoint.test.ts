import { describe, expect, it } from "vitest";

import { field as buildField, maskFromRows } from "./fixtures";
import { labelSpace } from "./label";
import { describePoint, readPoint } from "./probePoint";
import { GAP_FILLED, GAP_NONE } from "./gaps";
import { frameSkeleton } from "./wallGraph";

/** Gap labels of the same size as a fixture, with the listed indices marked as repaired. */
function repaired(width: number, height: number, indices: readonly number[]) {
  const data = new Uint8Array(width * height).fill(GAP_NONE);
  for (const index of indices) data[index] = GAP_FILLED;
  return { width, height, data };
}

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

/**
 * The arrangement the pipeline actually hands this module, which is NOT mask-plus-its-own-labelling.
 *
 * `probeMapFraction` passes the **composed ink mask** together with a labelling of the **framed
 * skeleton** — different rasters of the same size. That is the whole reason ink can be covered: the
 * skeleton is thinned, so a wall pixel off the centreline is *space* in the labelled raster and
 * carries the face label of the room beside it.
 *
 * A fixture that labelled the ink mask itself would give every ink pixel label 0 and would pass
 * whatever the module did with it, which is what the first version of this file did.
 */
const INK = [
  ".........",
  ".........",
  ".#######.",
  ".#######.",
  ".#######.",
  ".........",
  ".........",
];
/** The centreline of that wall, one pixel thick — what thinning leaves. */
const SKELETON = [
  ".........",
  ".........",
  ".........",
  ".#######.",
  ".........",
  ".........",
  ".........",
];

const wall = {
  ink: maskFromRows(INK),
  // `frameSkeleton` paints the one-pixel border, exactly as `buildWallGraph` does, so the faces are
  // bounded and the frame itself is skeleton-without-being-ink.
  labelled: labelSpace(frameSkeleton(maskFromRows(SKELETON)), { minArea: 0 }),
  field: buildField(9, 7, (x, y) => (INK[y]![x] === "#" ? 0.12 : 0.94)),
};

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
    const reading = readPoint(wall.field, wall.ink, wall.labelled, 2, 2);
    expect(reading.kind).toBe("ink");
    expect(reading.luminance).toBeCloseTo(0.12);
  });

  it("gives ink off the centreline the face it sits inside", () => {
    /*
      The correction this module needed. It used to short-circuit on the mask and report region 0 for
      every ink pixel without consulting the labelling — right when regions were the space between
      the strokes, wrong the moment a face boundary became the wall's centreline. Half of every
      wall's thickness is inside the face beside it, so most ink a GM probes is covered.
    */
    const above = readPoint(wall.field, wall.ink, wall.labelled, 4, 2);
    const below = readPoint(wall.field, wall.ink, wall.labelled, 4, 4);

    expect(above.kind).toBe("ink");
    expect(below.kind).toBe("ink");
    expect(above.region).toBeGreaterThan(0);
    expect(below.region).toBeGreaterThan(0);
    // And they are the faces on opposite sides of the wall, not one face reported twice.
    expect(above.region).not.toBe(below.region);
  });

  it("reports ink ON the centreline as belonging to neither face", () => {
    // The one ink pixel that genuinely is not inside anything: it is the boundary itself.
    const reading = readPoint(wall.field, wall.ink, wall.labelled, 4, 3);
    expect(reading.kind).toBe("ink");
    expect(reading.region).toBe(0);
  });

  it("calls unlabelled space the border frame rather than a filtered region", () => {
    // Not ink, no face label. Under the graph the only way to reach this is the one-pixel frame
    // `frameSkeleton` paints round the raster: the smallest-room filter is gone and every space
    // labelling in the pipeline runs at minArea 0, so nothing else can be unlabelled.
    const reading = readPoint(wall.field, wall.ink, wall.labelled, 0, 0);
    expect(reading.kind).toBe("unlabelled");
    expect(reading.region).toBe(0);
  });

  it("says space when no partition has been derived, whether or not it is ink", () => {
    // The reading steps. Ink is still reportable; coverage is not, and inventing a verdict from the
    // absence of one is the failure this case exists to avoid.
    expect(readPoint(wall.field, wall.ink, null, 4, 3).kind).toBe("ink");
    expect(readPoint(wall.field, wall.ink, null, 4, 0).kind).toBe("space");
  });

  it("separates ink the repair invented from ink the map has", () => {
    /*
      The composed mask is base ink plus whatever the repair filled, and the probe is handed the
      composed one — so a repaired pixel used to come back as ordinary ink, with the "nearly white"
      warning attached because the map genuinely has nothing there. Every clause of that answer was
      misdirection: the threshold did not put it there, and the binariser is not wrong. It sent a GM
      to the threshold when the control responsible is the break repair.

      Reachable whenever the repair is on, and most likely to fire exactly when someone is probing to
      find out why a wall looks odd.
    */
    const index = 3 * 9 + 4;
    const labels = repaired(9, 7, [index]);

    const invented = readPoint(wall.field, wall.ink, wall.labelled, 4, 3, labels);
    expect(invented.kind).toBe("invented-ink");

    // Its neighbour along the same wall is the map's own ink and must still read as ink.
    expect(readPoint(wall.field, wall.ink, wall.labelled, 5, 3, labels).kind).toBe("ink");
    // And with no repair running at all, nothing is invented.
    expect(readPoint(wall.field, wall.ink, wall.labelled, 4, 3, null).kind).toBe("ink");
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
    const line = describePoint(readPoint(field, mask, labelled, 1, 1));
    expect(line).toContain("IS covered");
    expect(line).toContain("rendering question");
  });

  it("says ink off the centreline IS covered, where it used to say the opposite", () => {
    // The sentence that was wrong. This is the highest-value diagnostic in the project — it settled
    // the bare-map defect after four wrong explanations argued from aggregates — so it telling a GM
    // that ink is covered by nothing was expensive.
    const line = describePoint(readPoint(wall.field, wall.ink, wall.labelled, 4, 2));
    expect(line).toContain("IS covered");
    expect(line).toContain("centreline");
    expect(line).not.toContain("nothing covers it");
  });

  it("says a centreline pixel is the boundary rather than the interior of either face", () => {
    const line = describePoint(readPoint(wall.field, wall.ink, wall.labelled, 4, 3));
    expect(line).toContain("centreline itself");
    expect(line).not.toContain("IS covered");
  });

  it("names the border frame instead of a minimum area that no longer exists", () => {
    const line = describePoint(readPoint(wall.field, wall.ink, wall.labelled, 0, 0));
    expect(line).toContain("border frame");
    expect(line).not.toContain("minimum area");
    expect(line).not.toContain("discarded");
  });

  it("sends a GM to the repair rather than the threshold for invented ink", () => {
    const labels = repaired(9, 7, [3 * 9 + 4]);
    const line = describePoint(readPoint(wall.field, wall.ink, wall.labelled, 4, 3, labels));

    expect(line).toContain("INVENTED");
    expect(line).toContain("break repair");
    // The ink message's advice is the wrong advice here and must not appear.
    expect(line).not.toContain("binariser is wrong");
  });

  it("flags ink that has no business being ink", () => {
    // The case worth shouting about: a near-white pixel called ink means the binariser is wrong
    // there, and saying only "it is ink" would bury that under a true but useless statement.
    const white = buildField(5, 5, () => 0.95);
    const line = describePoint(readPoint(white, mask, labelSpace(mask), 2, 2));
    expect(line).toContain("nearly white");
  });

  it("does not cry wolf over ink that is genuinely dark", () => {
    const line = describePoint(readPoint(field, mask, labelSpace(mask), 2, 2));
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
      expect(describePoint(readPoint(field, mask, labelled, x!, y!)).length).toBeGreaterThan(20);
    }
    // And the two cases the plain fixture cannot reach.
    for (const [x, y] of [
      [4, 2],
      [0, 0],
    ]) {
      expect(
        describePoint(readPoint(wall.field, wall.ink, wall.labelled, x!, y!)).length,
      ).toBeGreaterThan(20);
    }
  });
});
