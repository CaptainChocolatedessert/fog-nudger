import { describe, expect, it } from "vitest";

import { field as buildField, maskFromRows } from "./fixtures";
import { describePoint, readPoint } from "./probePoint";

/*
  Seven mutations, seven caught (2026-09-24, after the region answer was deleted): the coverage claim
  put back into the ground message, ink checked before added ink, the raster bound off by one, round
  for floor, ground reported as ink, the retired *Suppress ink* name, and the paint layer's width check.
*/

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

/** A thick wall across open ground, which is what a probe is usually aimed at. */
const INK = [
  ".........",
  ".........",
  ".#######.",
  ".#######.",
  ".#######.",
  ".........",
  ".........",
];

const wall = {
  ink: maskFromRows(INK),
  field: buildField(9, 7, (x, y) => (INK[y]![x] === "#" ? 0.12 : 0.94)),
};

describe("readPoint", () => {
  it("names ground as space, and reports how bright it actually is", () => {
    const reading = readPoint(field, mask, 1, 1);
    expect(reading.kind).toBe("space");
    expect(reading.luminance).toBeCloseTo(0.93);
  });

  it("names ink as ink, and reports how dark it actually is", () => {
    // The tone is the point. "It is ink" and "it is ink and it is nearly white" are the same
    // sentence about the mask and completely different findings about the binariser.
    const reading = readPoint(wall.field, wall.ink, 2, 2);
    expect(reading.kind).toBe("ink");
    expect(reading.luminance).toBeCloseTo(0.12);
  });

  it("says when the point missed the map altogether", () => {
    for (const [x, y] of [
      [-1, 2],
      [2, -1],
      [5, 2],
      [2, 5],
    ]) {
      expect(readPoint(field, mask, x!, y!).kind).toBe("outside-raster");
    }
  });

  it("floors a fractional coordinate rather than rounding it", () => {
    // World-to-raster arithmetic lands between pixels. Rounding would read the neighbour at the
    // boundary, which is exactly where a probe is most likely to be aimed.
    expect(readPoint(field, mask, 2.9, 2.9).kind).toBe("ink");
    expect(readPoint(field, mask, 3.1, 2.9).kind).toBe("space");
  });
});

describe("describePoint", () => {
  /*
    The sentence that was deleted on 2026-09-24, and the reason it must not come back.

    The probe used to name the region a point was in, from a labelling of the raster that was a
    different partition from the one drawn — so a click on the outside, which is never emitted, was
    told *"inside region 1, which is emitted as its own shape — so this point IS covered."* The drawn
    fill answers which region a point is in and whether it is emitted. A probe answer that claims
    either is claiming something it cannot see, so every kind is checked, the painted ones included.
  */
  it("never claims a point is covered, emitted or in a region", () => {
    const layers = {
      suppress: painted(9, 7, [0, 5 * 9 + 5]),
      ink: painted(9, 7, [3 * 9 + 4]),
    };
    for (const [x, y] of [
      [0, 0],
      [4, 0],
      [2, 2],
      [4, 3],
      [5, 5],
      [-1, -1],
    ]) {
      const line = describePoint(readPoint(wall.field, wall.ink, x!, y!, layers));
      expect(line).not.toMatch(/covered|emitted|region|face/i);
    }
  });

  it("offers no explanation that belongs to a deleted control or a retired name", () => {
    for (const [x, y] of [
      [0, 0],
      [2, 2],
      [5, 5],
    ]) {
      const line = describePoint(
        readPoint(wall.field, wall.ink, x!, y!, {
          suppress: painted(9, 7, [5 * 9 + 5]),
          ink: null,
        }),
      );
      expect(line).not.toContain("minimum area");
      expect(line).not.toContain("discarded");
      expect(line).not.toContain("border frame");
      expect(line).not.toContain("Regions");
      expect(line).not.toContain("Suppress ink");
    }
  });

  it("sends a GM to the erase brush rather than the threshold for ink they drew", () => {
    // Ink over a *pale* pixel, which is the case that would otherwise read as the binariser going
    // wrong: the tone flatly contradicts the verdict, and only naming the layer explains it.
    const line = describePoint(
      readPoint(wall.field, wall.ink, 4, 3, {
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
      readPoint(wall.field, wall.ink, 5, 5, {
        suppress: painted(9, 7, [5 * 9 + 5]),
        ink: null,
      }),
    );

    expect(line).toContain("YOU SUPPRESSED");
    // The tool's name in the strip, which was *Suppress ink* until the brushes merged.
    expect(line).toContain("brush under Suppress.");
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
      readPoint(wall.field, wall.ink, 4, 3, {
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
      readPoint(wall.field, wall.ink, 5, 5, {
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
    const line = describePoint(readPoint(white, mask, 2, 2));
    expect(line).toContain("nearly white");
  });

  it("does not cry wolf over ink that is genuinely dark", () => {
    const line = describePoint(readPoint(field, mask, 2, 2));
    expect(line).toContain("expected answer");
    expect(line).not.toContain("nearly white");
  });

  it("says something in every case", () => {
    for (const [x, y] of [
      [1, 1],
      [2, 2],
      [-1, -1],
    ]) {
      expect(describePoint(readPoint(field, mask, x!, y!)).length).toBeGreaterThan(20);
    }
  });
});
