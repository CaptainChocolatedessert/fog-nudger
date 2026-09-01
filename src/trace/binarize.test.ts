import { describe, expect, it } from "vitest";

import { countInk, emptyMask, sauvolaBothPolarities, type BinaryMask } from "./binarize";
import type { ScalarField } from "./field";
import { field, room } from "./fixtures";

/** The dark reading, which is what the pipeline uses on a map drawn in dark ink. */
const darkMask = (input: ScalarField, options?: { radius: number; k: number }): BinaryMask =>
  sauvolaBothPolarities(input, options).dark;

/**
 * The honest second pass, kept here rather than in the module because nothing in the pipeline
 * inverts a field: polarity is settled by choosing between the two masks one pass produces, and
 * this exists solely to check that cheap route against the expensive one it replaced.
 */
function invertField(input: ScalarField): ScalarField {
  const out = new Float32Array(input.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - input.data[i]!;
  return { width: input.width, height: input.height, data: out };
}

describe("sauvolaBothPolarities, reading ink as dark", () => {
  it("finds a room's walls and leaves its floor alone", () => {
    const walls = room({ width: 40, height: 40, wall: 3, ink: 0.1, ground: 0.9 });
    const mask = darkMask(walls, { radius: 8, k: 0.34 });

    // A wall pixel and a floor pixel, checked individually rather than by a count — a count is
    // consistent with the right answer and with several wrong ones.
    expect(mask.data[20 * mask.width + 1]).toBe(1);
    expect(mask.data[20 * mask.width + 20]).toBe(0);
  });

  it("leaves a flat field entirely blank", () => {
    // The property Sauvola exists for: in a neighbourhood with no variation the threshold drops well
    // below the mean, so evenly textured parchment produces no ink at all. A global cutoff at the
    // mean would have marked roughly half of this.
    const flat = field(30, 30, () => 0.6);
    expect(countInk(darkMask(flat, { radius: 6, k: 0.34 }))).toBe(0);
  });

  it("does not mark a gap in a wall as ink", () => {
    // The doorway case. If binarisation bridges the gap, every downstream stage sees a closed room
    // and the leak this project fears most is hidden before labelling ever runs.
    const gapped = room({
      width: 40,
      height: 40,
      wall: 3,
      ink: 0.1,
      ground: 0.9,
      gap: [16, 24],
    });
    const mask = darkMask(gapped, { radius: 8, k: 0.34 });
    expect(mask.data[1 * mask.width + 20]).toBe(0);
  });

  it("survives a degenerate field", () => {
    const mask = darkMask({ width: 0, height: 0, data: new Float32Array(0) });
    expect(mask.width).toBe(0);
    expect(countInk(mask)).toBe(0);
  });
});

describe("sauvolaBothPolarities", () => {
  it("matches running the whole thing again on an inverted field", () => {
    // The optimisation being checked: variance is invariant under negation, so one pair of
    // summed-area tables yields both polarities. If that identity is ever wrong, the light reading
    // silently drifts from what a real second pass would have produced.
    //
    // The fixture is a spread of levels rather than a two-tone room, and that is load-bearing. A
    // drawn room has its ink and its paper far from any threshold, so every pixel votes the same way
    // under quite badly wrong arithmetic — the version of this test that used one scored a pass with
    // the light branch's threshold shifted by a tenth. Here the levels cover the whole range, so
    // some pixels always sit against the cut and a small error in it moves them.
    const spread = field(40, 40, (x, y) => ((x * 37 + y * 17) % 101) / 100);
    const options = { radius: 6, k: 0.34 };

    const cheap = sauvolaBothPolarities(spread, options).light;
    const honest = sauvolaBothPolarities(invertField(spread), options).dark;
    expect([...cheap.data]).toEqual([...honest.data]);
  });

  it("does not simply produce complementary masks", () => {
    // Worth pinning down, because "the other polarity is the inverse" is the intuitive and wrong
    // model. Sauvola's threshold is asymmetric about the mean, so a pixel can be ink under both
    // readings or neither — which is why the polarity decision has to look at the masks.
    const walls = room({ width: 30, height: 30, wall: 2, ink: 0.15, ground: 0.85 });
    const { dark, light } = sauvolaBothPolarities(walls, { radius: 6, k: 0.34 });

    let complementary = true;
    for (let i = 0; i < dark.data.length; i++) {
      if (dark.data[i]! + light.data[i]! !== 1) {
        complementary = false;
        break;
      }
    }
    expect(complementary).toBe(false);
  });
});

describe("emptyMask", () => {
  it("is all ground", () => {
    expect(countInk(emptyMask(5, 5))).toBe(0);
  });
});
