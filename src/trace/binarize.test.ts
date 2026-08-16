import { describe, expect, it } from "vitest";

import {
  countInk,
  emptyMask,
  globalBinarize,
  maskAt,
  sauvolaBinarize,
  sauvolaBothPolarities,
} from "./binarize";
import { invertField } from "./field";
import { field, room } from "./fixtures";

describe("sauvolaBinarize", () => {
  it("finds a room's walls and leaves its floor alone", () => {
    const walls = room({ width: 40, height: 40, wall: 3, ink: 0.1, ground: 0.9 });
    const mask = sauvolaBinarize(walls, { radius: 8, k: 0.34 });

    // A wall pixel and a floor pixel, checked individually rather than by a count — a count is
    // consistent with the right answer and with several wrong ones.
    expect(maskAt(mask, 1, 20)).toBe(1);
    expect(maskAt(mask, 20, 20)).toBe(0);
  });

  it("leaves a flat field entirely blank", () => {
    // The property Sauvola exists for: in a neighbourhood with no variation the threshold drops well
    // below the mean, so evenly textured parchment produces no ink at all. A global cutoff at the
    // mean would have marked roughly half of this.
    const flat = field(30, 30, () => 0.6);
    expect(countInk(sauvolaBinarize(flat, { radius: 6, k: 0.34 }))).toBe(0);
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
    const mask = sauvolaBinarize(gapped, { radius: 8, k: 0.34 });
    expect(maskAt(mask, 20, 1)).toBe(0);
  });

  it("survives a degenerate field", () => {
    const mask = sauvolaBinarize({ width: 0, height: 0, data: new Float32Array(0) });
    expect(mask.width).toBe(0);
    expect(countInk(mask)).toBe(0);
  });
});

describe("sauvolaBothPolarities", () => {
  it("gives the same dark mask as the single-polarity call", () => {
    const walls = room({ width: 30, height: 30, wall: 2, ink: 0.15, ground: 0.85 });
    const options = { radius: 6, k: 0.34 };
    const both = sauvolaBothPolarities(walls, options);
    expect([...both.dark.data]).toEqual([...sauvolaBinarize(walls, options).data]);
  });

  it("matches running the whole thing again on an inverted field", () => {
    // The optimisation being checked: variance is invariant under negation, so one pair of
    // summed-area tables yields both polarities. If that identity is ever wrong, the light reading
    // silently drifts from what a real second pass would have produced.
    const walls = room({ width: 30, height: 30, wall: 2, ink: 0.85, ground: 0.15 });
    const options = { radius: 6, k: 0.34 };

    const cheap = sauvolaBothPolarities(walls, options).light;
    const honest = sauvolaBinarize(invertField(walls), options);
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

describe("globalBinarize", () => {
  it("cuts at the level", () => {
    const ramp = field(4, 1, (x) => x / 4);
    const mask = globalBinarize(ramp, 0.5);
    expect([...mask.data]).toEqual([1, 1, 0, 0]);
  });
});

describe("emptyMask", () => {
  it("is all ground", () => {
    expect(countInk(emptyMask(5, 5))).toBe(0);
  });
});

describe("maskAt", () => {
  it("reads outside the image as ground", () => {
    const mask = emptyMask(3, 3);
    mask.data[4] = 1;
    expect(maskAt(mask, 1, 1)).toBe(1);
    expect(maskAt(mask, -1, 1)).toBe(0);
    expect(maskAt(mask, 3, 1)).toBe(0);
  });
});
