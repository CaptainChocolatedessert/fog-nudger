/**
 * The tone flood, against an oracle that shares none of its reasoning.
 *
 * The flood is a queue: take a pixel, push the neighbours that pass. The oracle is a **fixpoint**:
 * sweep the whole grid over and over, adding any pixel adjacent to one already taken that passes,
 * until a sweep changes nothing. Same answer, no shared code path — an error in the queue's head or
 * tail, in its bounds guards or in the order it visits cannot be made by the sweep as well.
 *
 * **Nineteen mutations, nineteen caught — after one survivor was answered with a fixture.** The ones
 * worth naming, because each is a real way to be wrong: dropping any one of the eight neighbour
 * steps; dropping either half of the tolerance band, or making both ends exclusive; and each of the
 * four edge guards, caught by seeds in the corners.
 *
 * **The survivor was `left`'s bounds comparison**, and it was the fixture's fault rather than a
 * question about the case. The rectangle it was written against had its seed at its own top-left
 * corner, so three of the four comparisons never had to move anything — "a fixture that is easy to
 * read can be too symmetric to fail" (§8), in its plainest form. The replacement grows in all four
 * directions from a seed inside it, and all four comparisons are now load-bearing.
 *
 * **Not mutated: dropping the `queued` mark.** It does not terminate rather than failing, so what it
 * would measure is the runner's timeout.
 */

import { describe, expect, it } from "vitest";

import { field, seededRandom } from "./fixtures";
import { floodByTone } from "./inkFlood";
import type { ScalarField } from "./field";

/** A field from rows of digits, each a tenth: `0` is black, `9` is near white. */
function toneFromRows(rows: readonly string[]): ScalarField {
  const height = rows.length;
  const width = rows[0]!.length;
  return field(width, height, (x, y) => Number(rows[y]![x]) / 10);
}

/**
 * Every pixel the flood should take, by repeated sweeps rather than by a queue.
 *
 * Deliberately the slowest possible statement of the answer: it re-examines the whole grid on every
 * pass and stops when a pass adds nothing. Nothing about *where* it looks depends on where it has
 * been, which is the property the implementation cannot share.
 */
function fixpoint(source: ScalarField, seedX: number, seedY: number, tolerance: number): Set<number> {
  const { width, height, data } = source;
  const seedTone = data[seedY * width + seedX]!;
  const taken = new Set<number>([seedY * width + seedX]);

  for (;;) {
    let added = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (taken.has(at)) continue;
        const tone = data[at]!;
        if (Math.abs(tone - seedTone) > tolerance) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (!taken.has(ny * width + nx)) continue;
            taken.add(at);
            added = true;
            break;
          }
          if (taken.has(at)) break;
        }
      }
    }
    if (!added) return taken;
  }
}

function taken(source: ScalarField, x: number, y: number, tolerance: number): Set<number> {
  const result = floodByTone(source, x, y, tolerance);
  expect(result).not.toBeNull();
  return new Set(Array.from(result!.pixels));
}

/** Render what was taken, so a failure reads as a picture rather than as a list of indices. */
function rows(source: ScalarField, filled: Set<number>): string[] {
  const out: string[] = [];
  for (let y = 0; y < source.height; y++) {
    let row = "";
    for (let x = 0; x < source.width; x++) row += filled.has(y * source.width + x) ? "#" : ".";
    out.push(row);
  }
  return out;
}

describe("floodByTone", () => {
  it("takes a uniform patch and stops at the step around it", () => {
    const source = toneFromRows([
      "9999999",
      "9000099",
      "9000099",
      "9000099",
      "9999999",
    ]);
    expect(rows(source, taken(source, 2, 2, 0.12))).toEqual([
      ".......",
      ".####..",
      ".####..",
      ".####..",
      ".......",
    ]);
  });

  /**
   * The case that took the tool back to a room: an anti-aliased diagonal edge.
   *
   * The dark fringe along a staircase touches the mark **only at its corners**, so a 4-connected
   * flood steps around exactly those pixels and leaves the fill ringed with black. Every other
   * fixture in this file passes 4-connected.
   */
  it("crosses a staircase edge, where the dark pixels touch only at their corners", () => {
    const source = toneFromRows([
      "0999",
      "0099",
      "0009",
      "0000",
    ]);
    expect(rows(source, taken(source, 0, 0, 0.12))).toEqual([
      "#...",
      "##..",
      "###.",
      "####",
    ]);
  });

  it("measures against the seed, not the neighbour, so it cannot walk a gradient", () => {
    // Each step is 0.1, which is inside the tolerance from its neighbour and outside it from the
    // seed after two steps. A neighbour-relative flood takes the whole row.
    const source = toneFromRows(["0123456789"]);
    expect(rows(source, taken(source, 0, 0, 0.15))).toEqual(["##........"]);
  });

  it("includes a pixel exactly at the tolerance, at both ends of the band", () => {
    const source = toneFromRows(["3535"]);
    // Seed 0.3; 0.5 is exactly 0.2 away. Reaching index 3 requires index 2's 0.3 as well.
    expect(rows(source, taken(source, 0, 0, 0.2))).toEqual(["####"]);
    expect(rows(source, taken(source, 0, 0, 0.19))).toEqual(["#..."]);

    const upward = toneFromRows(["5351"]);
    // Seed 0.5, so 0.3 is inside at 0.2 and 0.1 is outside.
    expect(rows(upward, taken(upward, 0, 0, 0.2))).toEqual(["###."]);
  });

  it("takes only the seed at a tolerance of zero, unless a neighbour matches exactly", () => {
    const source = toneFromRows(["550", "055"]);
    expect(rows(source, taken(source, 0, 0, 0))).toEqual(["##.", ".##"]);
  });

  it("returns null for a seed outside the field, and the seed's own tone for one inside", () => {
    const source = toneFromRows(["05", "50"]);
    expect(floodByTone(source, -1, 0, 0.1)).toBeNull();
    expect(floodByTone(source, 0, 2, 0.1)).toBeNull();
    expect(floodByTone(source, 2, 0, 0.1)).toBeNull();
    expect(floodByTone(source, 1, 0, 0.1)!.seedTone).toBeCloseTo(0.5, 6);
  });

  /**
   * The seed sits inside the fill rather than on its edge, and that is the whole point of the shape.
   *
   * A rectangle whose seed is at its top-left corner never makes `left` or `top` move, so three of
   * the four bounds comparisons decide nothing — the first version of this test was that rectangle,
   * and dropping the `left` comparison survived it. This one grows in all four directions from the
   * seed, so each comparison is the only thing standing between the answer and the seed's own column.
   */
  it("reports the rectangle the fill lies in, growing in all four directions", () => {
    const source = toneFromRows([
      "99999999",
      "99000099",
      "90000009",
      "99000099",
      "99999999",
    ]);
    expect(floodByTone(source, 4, 2, 0.12)!.bounds).toEqual({ left: 1, top: 1, right: 6, bottom: 3 });
  });

  it("floods from a corner without reading outside the field", () => {
    const source = toneFromRows(["00", "00"]);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      expect(taken(source, x, y, 0.05).size).toBe(4);
    }
  });

  /**
   * The sweep, and it is made to reach its case rather than only to pass.
   *
   * Random tone grids at three tolerances. A flood that took everything or only the seed would agree
   * with the oracle trivially, so the run asserts it met **both** a fill that stopped short of the
   * grid and a fill of more than one pixel — a green light from a sweep that never met a boundary
   * would be a statement about nothing.
   */
  it("agrees with a fixpoint oracle over random fields", () => {
    const next = seededRandom(20260917);
    let sawPartial = 0;
    let sawGrown = 0;

    for (let run = 0; run < 240; run++) {
      const width = 3 + Math.floor(next() * 9);
      const height = 3 + Math.floor(next() * 9);
      // Quantised, so exact-boundary comparisons happen often rather than never.
      const source = field(width, height, () => Math.floor(next() * 6) / 10);
      const x = Math.floor(next() * width);
      const y = Math.floor(next() * height);
      const tolerance = [0, 0.1, 0.25][run % 3]!;

      const mine = taken(source, x, y, tolerance);
      const theirs = fixpoint(source, x, y, tolerance);
      expect(rows(source, mine)).toEqual(rows(source, theirs));

      if (mine.size < width * height) sawPartial++;
      if (mine.size > 1) sawGrown++;
    }

    expect(sawPartial).toBeGreaterThan(100);
    expect(sawGrown).toBeGreaterThan(100);
  });
});
