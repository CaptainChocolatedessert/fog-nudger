/**
 * The island filter, against grids small enough to read.
 *
 * The property that matters most is the one that is easiest to get backwards: a decoration touching
 * a wall **diagonally** must be part of the wall, not an island. Under 4-connectivity it would look
 * separate, and deleting it would edit ink the space labelling one stage later treats as
 * load-bearing — a silent change to the partition made by a control that claims only to tidy.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { removeSmallInkIslands } from "./inkIslands";

function rows(mask: { width: number; height: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    out.push(row);
  }
  return out;
}

describe("removeSmallInkIslands", () => {
  it("is off at zero, returning the very same mask", () => {
    // Identity rather than equality: this is the default, so the common path must not even copy.
    const mask = maskFromRows(["#.#", ".#.", "#.#"]);
    const result = removeSmallInkIslands(mask, 0);
    expect(result.mask).toBe(mask);
    expect(result.removed).toBe(0);
  });

  it("clears an island shorter than the threshold on both sides", () => {
    const mask = maskFromRows([
      "#######",
      ".......",
      "..##...",
      "..##...",
      ".......",
    ]);
    expect(rows(removeSmallInkIslands(mask, 4).mask)).toEqual([
      "#######",
      ".......",
      ".......",
      ".......",
      ".......",
    ]);
  });

  it("keeps an island that is long in only one direction", () => {
    // The measure is the *longest* side, because that is what says "stubby". A one-pixel-tall run
    // of five is not stubby, whatever its area.
    const mask = maskFromRows([".....", "#####", "....."]);
    expect(rows(removeSmallInkIslands(mask, 5).mask)).toEqual(rows(mask));
  });

  it("keeps a decoration joined to a wall by a diagonal", () => {
    // The whole reason this labels 8-connected. The block is small enough to be removed on its own,
    // but its top-left corner meets the wall's last pixel corner-to-corner, so it is part of the
    // wall network.
    //
    // The wall stops at column 3 and the block starts at column 4 on the row below: that is a
    // genuine diagonal. An earlier version ran the wall to column 4, which put the block *directly
    // beneath* it — a vertical touch, so the test passed while testing nothing about diagonals.
    const mask = maskFromRows([
      "####...",
      "....##.",
      "....##.",
      ".......",
    ]);
    expect(rows(removeSmallInkIslands(mask, 4).mask)).toEqual(rows(mask));
  });

  it("removes the same decoration once the diagonal is gone", () => {
    // The contrast case, so the test above is known to be testing connectivity rather than size.
    // The wall keeps its length — shortening it below the threshold would remove the wall too, and
    // the test would pass for the wrong reason.
    const mask = maskFromRows([
      "####.....",
      "......##.",
      "......##.",
      ".........",
    ]);
    expect(rows(removeSmallInkIslands(mask, 4).mask)).toEqual([
      "####.....",
      ".........",
      ".........",
      ".........",
    ]);
  });

  it("counts what it removed", () => {
    const mask = maskFromRows(["#######", ".......", "..##...", "..##..."]);
    const result = removeSmallInkIslands(mask, 4);
    expect(result.removed).toBe(1);
    expect(result.removedArea).toBe(4);
  });

  it("reports the longest side of the largest survivor", () => {
    const mask = maskFromRows(["#######", ".......", "..##..."]);
    expect(removeSmallInkIslands(mask, 3).largestKeptSpan).toBe(7);
  });

  it("removes several islands at once and leaves the network", () => {
    // Every island needs a clear row above and below it. The first version put one on the row
    // directly above the bottom wall, where it was 4-connected to the border and correctly kept —
    // which read as the filter under-removing rather than as the fixture touching.
    const mask = maskFromRows([
      "##########",
      "#........#",
      "#..#...#.#",
      "#........#",
      "#...#....#",
      "#........#",
      "##########",
    ]);
    const result = removeSmallInkIslands(mask, 3);
    expect(result.removed).toBe(3);
    expect(rows(result.mask)).toEqual([
      "##########",
      "#........#",
      "#........#",
      "#........#",
      "#........#",
      "#........#",
      "##########",
    ]);
  });

  it("never adds ink", () => {
    const mask = maskFromRows(["#.#.#", ".#.#.", "#.#.#", ".#.#.", "#.#.#"]);
    const result = removeSmallInkIslands(mask, 3);
    for (let i = 0; i < mask.data.length; i++) {
      if (result.mask.data[i] === 1) expect(mask.data[i]).toBe(1);
    }
  });

  it("handles a mask that is entirely one island", () => {
    const mask = maskFromRows(["###", "###", "###"]);
    expect(rows(removeSmallInkIslands(mask, 3).mask)).toEqual(rows(mask));
    expect(rows(removeSmallInkIslands(mask, 4).mask)).toEqual(["...", "...", "..."]);
  });

  it("handles an empty mask and a blank one", () => {
    expect(removeSmallInkIslands(maskFromRows([]), 3).removed).toBe(0);
    expect(removeSmallInkIslands(maskFromRows(["...", "..."]), 3).removed).toBe(0);
  });

  it("does not overflow its stack on a component filling the raster", () => {
    // The reason the flood fill uses an explicit stack rather than recursion. A component spanning
    // the whole image is the ordinary case here, not the pathological one — the wall network is
    // exactly that.
    const size = 200;
    const mask = maskFromRows(Array.from({ length: size }, () => "#".repeat(size)));
    expect(() => removeSmallInkIslands(mask, 10)).not.toThrow();
    expect(removeSmallInkIslands(mask, 10).removed).toBe(0);
  });
});
