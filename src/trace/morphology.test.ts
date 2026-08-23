/**
 * The opening, checked against grids small enough to read.
 *
 * Two properties matter more than the rest, and both fail quietly:
 *
 * - **A radius of zero changes nothing.** It is the default, so every map that never touches the
 *   control depends on it — and "nearly identical" would be a mask silently different from the one
 *   every existing measurement was taken against.
 * - **A thick wall crossed by a thin line keeps the wall.** That is the entire point of an opening
 *   over a plain erosion, and getting it wrong severs walls, which merges rooms.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import {
  closeMask,
  dilateMask,
  erodeMask,
  openMask,
  radiusForWidth,
  removedInk,
} from "./morphology";

/** Render a mask back to text, so a failure reads as a picture rather than as an index. */
function rows(mask: { width: number; height: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    out.push(row);
  }
  return out;
}

describe("radiusForWidth", () => {
  it("is zero for zero, which is what makes the control default to off", () => {
    expect(radiusForWidth(0)).toBe(0);
    expect(radiusForWidth(-1)).toBe(0);
    expect(radiusForWidth(Number.NaN)).toBe(0);
  });

  it("halves the width, since erosion clears half a mark from each side", () => {
    expect(radiusForWidth(2)).toBe(1);
    expect(radiusForWidth(4)).toBe(2);
    expect(radiusForWidth(10)).toBe(5);
  });

  it("rounds rather than truncating, so a sub-pixel setting is not silently off", () => {
    expect(radiusForWidth(1)).toBe(1);
    expect(radiusForWidth(3)).toBe(2);
  });
});

describe("a radius of zero", () => {
  it("leaves the mask exactly as it was", () => {
    const mask = maskFromRows(["#.#", ".#.", "###"]);
    expect(rows(openMask(mask, 0))).toEqual(rows(mask));
    expect(rows(erodeMask(mask, 0))).toEqual(rows(mask));
    expect(rows(dilateMask(mask, 0))).toEqual(rows(mask));
  });
});

describe("erodeMask", () => {
  it("clears a one-pixel line entirely at radius one", () => {
    const mask = maskFromRows([".....", "#####", "....."]);
    expect(rows(erodeMask(mask, 1))).toEqual([".....", ".....", "....."]);
  });

  it("thins a thick block rather than clearing it", () => {
    // The property that makes erosion alone the wrong control: what survives comes back narrower,
    // and since regions are bounded by ink, narrower ink means every region has grown.
    //
    // Padded with ground, because a block running to all four edges has nothing to erode against
    // under the border rule above — the first version of this fixture was that block, and it
    // asserted the off-image-is-ground behaviour this module deliberately does not have.
    const mask = maskFromRows([
      ".......",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".......",
    ]);
    expect(rows(erodeMask(mask, 1))).toEqual([
      ".......",
      ".......",
      "..###..",
      "..###..",
      "..###..",
      ".......",
      ".......",
    ]);
  });

  it("clamps at the border rather than treating outside as ground", () => {
    // Counting off-image as ground would erode a band off every edge, deleting a wall drawn along
    // the map's border — and the dilation cannot restore what no longer exists.
    const mask = maskFromRows(["###", "###", "###"]);
    expect(rows(erodeMask(mask, 1))).toEqual(["###", "###", "###"]);
  });
});

describe("dilateMask", () => {
  it("grows ink by the radius", () => {
    const mask = maskFromRows([".....", "..#..", "....."]);
    expect(rows(dilateMask(mask, 1))).toEqual([".###.", ".###.", ".###."]);
  });
});

describe("openMask", () => {
  it("deletes a thin line", () => {
    const mask = maskFromRows([".....", "#####", "....."]);
    expect(rows(openMask(mask, 1))).toEqual([".....", ".....", "....."]);
  });

  it("keeps a thick block at its original width", () => {
    // Padded, so the erosion inside genuinely has something to bite on — otherwise the border rule
    // makes this pass without the dilation ever mattering, which is a test of nothing. Against a
    // plain erosion this block comes back three wide; restoring the width is why dilation is here.
    const mask = maskFromRows([
      ".......",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".......",
    ]);
    expect(rows(openMask(mask, 1))).toEqual([
      ".......",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".#####.",
      ".......",
    ]);
  });

  it("keeps a thick wall crossed by a thin line, and drops the line", () => {
    // The case this control exists for: a printed floor grid meeting a drawn wall. The wall must
    // survive at full width — severing it merges two rooms, which is this project's worst failure.
    const mask = maskFromRows([
      "..###..",
      "..###..",
      "#######",
      "..###..",
      "..###..",
    ]);
    expect(rows(openMask(mask, 1))).toEqual([
      "..###..",
      "..###..",
      "..###..",
      "..###..",
      "..###..",
    ]);
  });

  it("leaves a mark exactly at the threshold alone", () => {
    // Three wide against a radius of one: the window fits inside it, so the centre column survives
    // erosion and the dilation puts the rest back.
    const mask = maskFromRows(["...", "###", "###", "###", "..."]);
    expect(rows(openMask(mask, 1))).toEqual(["...", "###", "###", "###", "..."]);
  });

  it("removes speckle of any shape", () => {
    const mask = maskFromRows(["#...#", ".....", "..#..", ".....", "#...#"]);
    expect(rows(openMask(mask, 1))).toEqual([
      ".....",
      ".....",
      ".....",
      ".....",
      ".....",
    ]);
  });

  it("never adds ink where there was none", () => {
    // An opening is bounded above by its input. If this failed, the mask would gain ink from
    // nowhere — which as a closing rather than an opening would fill a doorway and merge two rooms.
    const mask = maskFromRows(["#.#.#", ".###.", "#.#.#", ".###.", "#.#.#"]);
    const opened = openMask(mask, 1);
    for (let i = 0; i < mask.data.length; i++) {
      if (opened.data[i] === 1) expect(mask.data[i]).toBe(1);
    }
  });

  it("is idempotent, as an opening must be", () => {
    // Running it twice is running it once. A failure here means the passes disagree with each
    // other, which on a real map shows as ink creeping by a pixel per run.
    const mask = maskFromRows([
      "..###..",
      "..###..",
      "#######",
      "..###..",
      "..###..",
      ".......",
      "#.#.#.#",
    ]);
    const once = openMask(mask, 1);
    expect(rows(openMask(once, 1))).toEqual(rows(once));
  });

  it("handles an empty mask", () => {
    expect(rows(openMask(maskFromRows([]), 2))).toEqual([]);
  });
});

/**
 * The closing — used only to *find* narrow breaks, never yet to seal one.
 *
 * The properties tested here are the opening's read backwards, and the one that matters is the
 * last: a closing must not move a wall. Everything the gap detector reports is the difference
 * between this and its input, so ink that drifted by a pixel would be reported as a break.
 */
describe("closeMask", () => {
  it("leaves the mask exactly as it was at radius zero", () => {
    const mask = maskFromRows(["#.#.#", ".###.", "#.#.#"]);
    expect(rows(closeMask(mask, 0))).toEqual(rows(mask));
  });

  it("fills a break narrower than twice the radius", () => {
    const mask = maskFromRows([
      ".......",
      ".......",
      "###.###",
      ".......",
      ".......",
    ]);
    expect(rows(closeMask(mask, 1))).toEqual([
      ".......",
      ".......",
      "#######",
      ".......",
      ".......",
    ]);
  });

  it("leaves a break wider than twice the radius open", () => {
    // The doorway case. A closing whose radius exceeds a doorway seals it, and a sealed doorway
    // looks like perfectly good wall — which is why the marks come before any control that does it.
    const mask = maskFromRows([
      ".........",
      ".........",
      "##.....##",
      ".........",
      ".........",
    ]);
    expect(rows(closeMask(mask, 1))).toEqual(rows(mask));
  });

  it("never removes ink that was there", () => {
    // A closing is bounded below by its input, exactly as an opening is bounded above by it.
    const mask = maskFromRows(["#.#.#", ".###.", "#.#.#", ".###.", "#.#.#"]);
    const closed = closeMask(mask, 1);
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 1) expect(closed.data[i]).toBe(1);
    }
  });

  it("does not thicken a wall standing clear of anything", () => {
    // The property the gap marks rest on. Ink that grew would come back as ground-turned-ink and
    // be reported as a break, which is a detector inventing its own findings.
    const mask = maskFromRows([
      ".........",
      ".........",
      "..#####..",
      ".........",
      ".........",
    ]);
    expect(rows(closeMask(mask, 1))).toEqual(rows(mask));
  });

  it("does not erode a wall drawn along the border", () => {
    // Borders clamp rather than counting off-image as ground. Counting it as ground would let the
    // erosion half eat a band off every edge that the dilation had already put back.
    // The room inside has to be wider than the closing, or it fills legitimately and the fixture
    // is testing the wrong thing — which is what the first draft of this one did.
    const mask = maskFromRows(["#######", "#.....#", "#.....#", "#.....#", "#######"]);
    expect(rows(closeMask(mask, 1))).toEqual(rows(mask));
  });

  it("is idempotent, as a closing must be", () => {
    const mask = maskFromRows([
      "..###..",
      "..###..",
      "#######",
      "..#.#..",
      "..###..",
      ".......",
      "#.#.#.#",
    ]);
    const once = closeMask(mask, 1);
    expect(rows(closeMask(once, 1))).toEqual(rows(once));
  });

  it("handles an empty mask", () => {
    expect(rows(closeMask(maskFromRows([]), 2))).toEqual([]);
  });
});

describe("removedInk", () => {
  it("counts what the opening cleared", () => {
    const mask = maskFromRows([".....", "#####", "....."]);
    expect(removedInk(mask, openMask(mask, 1))).toBe(5);
  });

  it("is zero when nothing changed", () => {
    const mask = maskFromRows(["###", "###", "###"]);
    expect(removedInk(mask, openMask(mask, 1))).toBe(0);
  });
});
