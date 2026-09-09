import { describe, expect, it } from "vitest";

import { field as buildField, maskFromRows } from "./fixtures";
import { labelSpace } from "./label";
import { describePoint, readPoint } from "./probePoint";

/** A paint layer of the same size as a fixture, with the listed indices painted. */
function painted(width: number, height: number, indices: readonly number[]) {
  const data = new Uint8Array(width * height);
  for (const index of indices) data[index] = 1;
  return { width, data };
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
/**
 * A wall spanning the raster, so the space above it and the space below are separate regions.
 *
 * It stopped one pixel short at each end until 2026-09-08, and the **border frame** closed those
 * gaps — with the frame gone they let the two sides join round the ends into one region, which is
 * what the "ink off the centreline" case needs to tell apart. Spanning edge to edge says the same
 * thing about the map without depending on something painted around it.
 */
const SKELETON = [
  ".........",
  ".........",
  ".........",
  "#########",
  ".........",
  ".........",
  ".........",
];

const wall = {
  ink: maskFromRows(INK),
  /*
    The skeleton as `buildSkeletonGraph` labels it — unframed since 2026-09-08.

    The border frame used to be painted in here too, so the outside was a bounded face and the frame
    itself was skeleton-without-being-ink. With it gone, the space outside the room is an ordinary
    labelled region like any other, and the probe answers about it in the ordinary way.
  */
  labelled: labelSpace(maskFromRows(SKELETON), { minArea: 0 }),
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

  /*
    Unlabelled space is unreachable now, and that is worth an assertion rather than a deletion.

    It used to be reachable at exactly one place: the one-pixel border frame, which was skeleton
    without being ink. The frame went on 2026-09-08, and every space labelling in the pipeline runs
    at `minArea` 0 — so nothing is unlabelled and a corner of the raster is ordinary outside space.
    If this ever starts reporting `unlabelled` again, something has begun filtering regions.
  */
  it("gives the raster's corner an ordinary region, now that nothing frames it", () => {
    const reading = readPoint(wall.field, wall.ink, wall.labelled, 0, 0);
    expect(reading.kind).not.toBe("unlabelled");
    expect(reading.region).toBeGreaterThan(0);
  });

  it("says space when no partition has been derived, whether or not it is ink", () => {
    // The reading steps. Ink is still reportable; coverage is not, and inventing a verdict from the
    // absence of one is the failure this case exists to avoid.
    expect(readPoint(wall.field, wall.ink, null, 4, 3).kind).toBe("ink");
    expect(readPoint(wall.field, wall.ink, null, 4, 0).kind).toBe("space");
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

  /*
    Nothing is ever "discarded" or below a "minimum area", and the wording must not imply otherwise.

    The smallest-room control was deleted in August, the border frame in September, and every space
    labelling in the pipeline runs at `minArea` 0 — so a probe can only land on ink, on a region, or
    on space with no partition derived yet. A line offering a GM one of the retired explanations
    would send them looking for a control that is not there.
  */
  it("offers no explanation that belongs to a deleted control", () => {
    const line = describePoint(readPoint(wall.field, wall.ink, wall.labelled, 0, 0));
    expect(line).not.toContain("minimum area");
    expect(line).not.toContain("discarded");
    expect(line).not.toContain("border frame");
  });

  it("sends a GM to the erase brush rather than the threshold for ink they drew", () => {
    // Ink over a *pale* pixel, which is the case that would otherwise read as the binariser going
    // wrong: the tone flatly contradicts the verdict, and only naming the layer explains it.
    const line = describePoint(
      readPoint(wall.field, wall.ink, wall.labelled, 4, 3, {
        suppress: null,
        ink: painted(9, 7, [3 * 9 + 4]),
      }),
    );

    expect(line).toContain("YOU DREW");
    expect(line).toContain("Add ink");
    // Every one of the ink message's clauses points at the wrong control here.
    expect(line).not.toContain("binariser is wrong");
    expect(line).not.toContain("gap repair");
  });

  it("sends a GM to the erase brush rather than the threshold for ink they suppressed", () => {
    /*
      The more valuable of the pair, and the reason it is worth a kind of its own.

      This is a **dark** pixel the trace calls ground — the picture and the reading contradicting each
      other — which reads exactly like a broken threshold. Without naming the layer, the obvious next
      move is an hour on the wrong slider.
    */
    const line = describePoint(
      readPoint(wall.field, wall.ink, wall.labelled, 5, 5, {
        suppress: painted(9, 7, [5 * 9 + 5]),
        ink: null,
      }),
    );

    expect(line).toContain("YOU SUPPRESSED");
    expect(line).toContain("Suppress ink");
    expect(line).toContain("moving it will not bring the mark back");
  });

  it("calls a suppressed pixel the GM drew back over ink, not suppressed", () => {
    /*
      Attribution where the two layers disagree, and the composition settles it: added ink composes
      **last**, so a pixel the GM suppressed and then drew back over really is ink. Reporting it as
      suppressed would send them to erase a mark that is not what is covering it.
    */
    const at = 3 * 9 + 4;
    const line = describePoint(
      readPoint(wall.field, wall.ink, wall.labelled, 4, 3, {
        suppress: painted(9, 7, [at]),
        ink: painted(9, 7, [at]),
      }),
    );

    expect(line).toContain("YOU DREW");
    expect(line).not.toContain("YOU SUPPRESSED");
  });

  it("ignores a paint layer that is not this raster rather than mis-indexing it", () => {
    /*
      The pipeline resamples a layer to the run's raster before composing, so these normally agree.
      A caller handing over the *stored* layer instead would otherwise read index 50 of a narrower
      raster — some distance from the pixel being asked about — and report confidently about it.
    */
    const line = describePoint(
      readPoint(wall.field, wall.ink, wall.labelled, 5, 5, {
        suppress: painted(4, 4, [5 * 4 + 5]),
        ink: null,
      }),
    );

    expect(line).not.toContain("YOU SUPPRESSED");
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
