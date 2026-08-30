/**
 * Thinning, checked on grids small enough to read.
 *
 * The properties that matter are structural — does it stay connected, does it reach the end of a
 * stroke, does it leave a loop as a loop — and every one of them is visible in a text grid. There is
 * no image here and no eyeballing: a failure prints as rows of characters.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { thin } from "./thinning";
import type { BinaryMask } from "./binarize";

/** Render a mask back to rows, so a failure is readable rather than a list of indices. */
function rows(mask: BinaryMask): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    out.push(row);
  }
  return out;
}

function countInk(mask: BinaryMask): number {
  let ink = 0;
  for (const value of mask.data) if (value === 1) ink += 1;
  return ink;
}

/** Ink pixels that touch, 8-connected, counted as components. */
function components(mask: BinaryMask): number {
  const seen = new Uint8Array(mask.data.length);
  let found = 0;
  for (let start = 0; start < mask.data.length; start++) {
    if (mask.data[start] !== 1 || seen[start] === 1) continue;
    found += 1;
    const stack = [start];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (seen[at] === 1) continue;
      seen[at] = 1;
      const x = at % mask.width;
      const y = (at - x) / mask.width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) continue;
          const next = ny * mask.width + nx;
          if (mask.data[next] === 1 && seen[next] === 0) stack.push(next);
        }
      }
    }
  }
  return found;
}

describe("thin", () => {
  it("reduces a thick horizontal bar to a single line", () => {
    const bar = maskFromRows([
      "..........",
      "..######..",
      "..######..",
      "..######..",
      "..........",
    ]);
    const result = thin(bar);
    expect(countInk(result.mask)).toBeLessThan(result.before);
    // One row of the three carries the whole skeleton: what is left is one pixel thick.
    for (let x = 0; x < 10; x++) {
      let column = 0;
      for (let y = 0; y < 5; y++) column += result.mask.data[y * 10 + x] ?? 0;
      expect(column).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a stroke connected end to end", () => {
    const bar = maskFromRows([
      "............",
      ".##########.",
      ".##########.",
      ".##########.",
      "............",
    ]);
    expect(components(thin(bar).mask)).toBe(1);
  });

  it("pulls back from a free end by about half the stroke width, which is a measured cost", () => {
    /*
      The design record justified thinning over a distance-transform medial axis on the grounds that
      the medial axis retracts half a wall width at a free end. It does — and so does this, by the
      same amount. Measured: (w + 1) / 2 pixels, two on a three-wide stroke and four on a seven-wide
      one.

      Pinned rather than hidden, because the number is the input to a decision nobody has made yet:
      whether a stub ending three pixels early matters enough to want end restoration. A test
      asserting the property the record *hoped* for would have failed, which is how this was found.
    */
    for (const [strokeWidth, expected] of [
      [3, 2],
      [5, 3],
      [7, 4],
    ] as const) {
      const rows = [".".repeat(20)];
      for (let i = 0; i < strokeWidth; i++) rows.push("." + "#".repeat(16) + "...");
      rows.push(".".repeat(20));

      const result = thin(maskFromRows(rows));
      let rightmost = -1;
      for (let i = 0; i < result.mask.data.length; i++) {
        if (result.mask.data[i] === 1) rightmost = Math.max(rightmost, i % result.mask.width);
      }
      // The ink ends at column 16.
      expect(16 - rightmost).toBe(expected);
    }
  });

  it("keeps a stub off a wall as a branch, which is the whole reason for the wall graph", () => {
    /*
      The deciding case in `DESIGN.md` §4. A region-first partition deletes this stub outright — a
      watershed provably drops every wall that separates nothing — and a stub that is gone stops
      blocking what it blocks. Here it comes out as an edge hanging off the wall's centreline,
      shortened at the tip and otherwise intact.
    */
    const result = thin(
      maskFromRows([
        "....................",
        ".##################.",
        ".##################.",
        ".##################.",
        ".......###..........",
        ".......###..........",
        ".......###..........",
        ".......###..........",
        ".......###..........",
        "....................",
      ]),
    );

    // One piece: the stub is still attached to the wall it hangs off.
    expect(components(result.mask)).toBe(1);

    // And it still hangs *down* from the wall rather than having been absorbed into it.
    let lowest = -1;
    for (let i = 0; i < result.mask.data.length; i++) {
      if (result.mask.data[i] === 1) {
        lowest = Math.max(lowest, Math.floor(i / result.mask.width));
      }
    }
    // The wall's centreline is row 2; the stub's ink runs to row 8 and its skeleton to row 6.
    expect(lowest).toBeGreaterThan(2);
    expect(lowest).toBe(6);
  });

  it("leaves a ring as a ring rather than filling or breaking it", () => {
    const ring = maskFromRows([
      "........",
      ".######.",
      ".######.",
      ".##..##.",
      ".##..##.",
      ".######.",
      ".######.",
      "........",
    ]);
    const result = thin(ring);
    // Still one component, and still enclosing something: the hole survives, which is the topology
    // half of "topology-preserving". A skeleton that filled the hole would report one room where
    // there are two.
    expect(components(result.mask)).toBe(1);
    const holeIntact = result.mask.data[3 * 8 + 3] === 0 && result.mask.data[4 * 8 + 4] === 0;
    expect(holeIntact).toBe(true);
  });

  it("leaves a line that is already one pixel wide alone", () => {
    const line = maskFromRows(["......", ".####.", "......"]);
    const result = thin(line);
    expect(rows(result.mask)).toEqual(rows(line));
  });

  it("reports what it did", () => {
    const bar = maskFromRows(["........", ".######.", ".######.", ".######.", "........"]);
    const result = thin(bar);
    expect(result.before).toBe(18);
    expect(result.after).toBe(countInk(result.mask));
    expect(result.after).toBeLessThan(result.before);
    expect(result.passes).toBeGreaterThan(0);
  });

  it("does nothing to an empty mask", () => {
    const empty = maskFromRows(["....", "....", "...."]);
    const result = thin(empty);
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
  });

  it("treats the border as background, so a stroke on the edge still thins", () => {
    // Counting off-image as ink would leave a rind down the edge of every map — the same failure the
    // morphology passes clamp against.
    const edge = maskFromRows(["####", "####", "....", "...."]);
    const result = thin(edge);
    expect(result.after).toBeLessThan(result.before);
  });
});
