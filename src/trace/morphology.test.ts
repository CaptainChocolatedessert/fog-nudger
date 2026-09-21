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
  healSeverances,
  openMask,
  radiusForWidth,
  removedInk,
} from "./morphology";
import { seededRandom } from "./fixtures";
import type { BinaryMask } from "./binarize";

/** Rows back out of a mask, so a fixture's expectation can be written the way it was written in. */
function rowsOf(mask: BinaryMask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

/**
 * A closing done the slow, obvious way: a square window per pixel, twice.
 *
 * **Shares no code with the implementation**, which is separable running-count passes over lines
 * addressed by a base and a stride. This is the definition — dilate is *any* ink in the window,
 * erode is *all* ink in the window — written so that agreeing with it says something.
 *
 * Off-image counts as **ink** for erosion, which is the implementation's deliberate clamp: for
 * filtering, counting it as ground would erode a band off every edge and delete a wall drawn along
 * the border.
 */
function slowBridge(mask: BinaryMask, radius: number): BinaryMask {
  const window = (
    source: BinaryMask,
    rule: (values: readonly number[]) => number,
    offEdge: number,
    reach: number,
  ): BinaryMask => {
    const data = new Uint8Array(source.data.length);
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const values: number[] = [];
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            const outside = nx < 0 || nx >= source.width || ny < 0 || ny >= source.height;
            values.push(outside ? offEdge : source.data[ny * source.width + nx]!);
          }
        }
        data[y * source.width + x] = rule(values);
      }
    }
    return { width: source.width, height: source.height, data };
  };
  const dilated = window(mask, (v) => (v.some((n) => n === 1) ? 1 : 0), 0, radius);
  // One short, as the implementation is: see `healSeverances` on why a square erosion cannot fit
  // inside a diagonal band.
  return window(dilated, (v) => (v.every((n) => n === 1) ? 1 : 0), 1, Math.max(0, radius - 1));
}

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
 * The closing — used only to *find* narrow gaps, never yet to seal one.
 *
 * The properties tested here are the opening's read backwards, and the one that matters is the
 * last: a closing must not move a wall. Everything the gap detector reports is the difference
 * between this and its input, so ink that drifted by a pixel would be reported as a gap.
 */
describe("closeMask", () => {
  it("leaves the mask exactly as it was at radius zero", () => {
    const mask = maskFromRows(["#.#.#", ".###.", "#.#.#"]);
    expect(rows(closeMask(mask, 0))).toEqual(rows(mask));
  });

  it("fills a gap narrower than twice the radius", () => {
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

  it("leaves a gap wider than twice the radius open", () => {
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
    // be reported as a gap, which is a detector inventing its own findings.
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

/**
 * Putting back what the opening severed, and nothing else.
 *
 * The three claims worth testing are the three the design rests on: it restores a severance, it
 * refuses a doorway, and it can never put back a pixel that was not ink. The last is an
 * **invariant** rather than a case, so it is swept rather than exampled.
 */
describe("healSeverances", () => {
  /*
    A wall two pixels thick with a one-pixel nick out of its middle.

    The nick is ground after the opening and was ink before it, and it sits in a channel narrower
    than `2 * radius` — all three conditions, so it comes back.
  */
  const NICKED = maskFromRows([
    "..........",
    "##########",
    "####..####",
    "##########",
    "..........",
  ]);

  it("does nothing at a radius of zero, and hands the mask straight back", () => {
    // Radius zero is the filter being off, so there is no damage to repair. The same object, not a
    // copy, on this file's convention for an operation that does nothing.
    const healed = healSeverances(NICKED, NICKED, 0);
    expect(healed.mask).toBe(NICKED);
    expect(healed.restored).toBe(0);
  });

  it("puts back ink the opening removed from a narrow channel", () => {
    const opened = openMask(NICKED, 1);
    // The opening has taken something out: without this the test below could pass on a mask the
    // filter never touched.
    expect(removedInk(NICKED, opened)).toBeGreaterThan(0);

    const healed = healSeverances(opened, NICKED, 1);
    expect(healed.restored).toBeGreaterThan(0);
    // And what it restored is exactly ink that was there: nothing outside the original.
    for (let i = 0; i < healed.mask.data.length; i++) {
      if (healed.mask.data[i] === 1) expect(NICKED.data[i]).toBe(1);
    }
  });

  it("refuses a doorway, which is the whole reason for the continuity check", () => {
    /*
      **The case that fails without the intersection.** A wall with a real opening in it — ground
      before the filter ran and ground after — sitting in a channel a plain closing would seal.

      Asserted by comparing against the closing itself: the closing fills the doorway, and the heal
      must not. Without the `original` term the two would be equal, which is the mutation.
    */
    const DOORWAY = maskFromRows([
      "..........",
      "####..####",
      "####..####",
      "####..####",
      "..........",
    ]);
    const closed = closeMask(DOORWAY, 2);
    expect(removedInk(closed, DOORWAY)).toBeGreaterThan(0);

    const healed = healSeverances(DOORWAY, DOORWAY, 2);
    expect(healed.restored).toBe(0);
    expect(rowsOf(healed.mask)).toEqual(rowsOf(DOORWAY));
  });

  it("heals a severed diagonal wall, which a symmetric closing never does", () => {
    /*
      **The case that changed the implementation** (room, 2026-09-21). A square erosion cannot fit
      inside a thin diagonal band — the `(2r+1)` window needs that many consecutive full rows and
      columns, and a diagonal never offers them — so a symmetric closing dilates the gap shut and
      then erodes the bridge straight back off. Measured at the time: a severed two-pixel diagonal
      wall healed at **no radius at all**, and at every radius once the erosion was one short.

      Asserted against the closing, so the fixture states the difference rather than just the
      outcome: `closeMask` does not cover the cut and the heal does.
    */
    const W = 22;
    const H = 22;
    const onWall = (x: number, y: number): boolean => x >= y && x < y + 2;
    const cut = (y: number): boolean => y >= 10 && y < 12;
    const build = (ink: (x: number, y: number) => boolean): BinaryMask => {
      const data = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (ink(x, y)) data[y * W + x] = 1;
      }
      return { width: W, height: H, data };
    };
    const original = build(onWall);
    const filtered = build((x, y) => onWall(x, y) && !cut(y));

    // The symmetric closing leaves the cut open, which is what the old implementation did.
    const closed = closeMask(filtered, 2);
    let coveredByClosing = 0;
    for (let i = 0; i < closed.data.length; i++) {
      if (closed.data[i] === 1 && filtered.data[i] === 0 && original.data[i] === 1) {
        coveredByClosing += 1;
      }
    }
    expect(coveredByClosing).toBe(0);

    // The asymmetric bridge closes it, and puts back only ink that was there.
    const healed = healSeverances(filtered, original, 2);
    expect(healed.restored).toBeGreaterThan(0);
    for (let i = 0; i < healed.mask.data.length; i++) {
      if (healed.mask.data[i] === 1) expect(original.data[i]).toBe(1);
    }
  });

  it("cannot resurrect a stroke the filter removed whole", () => {
    // A hairline with nothing surviving on either side: the closing has nothing to bridge between,
    // so there is no channel and nothing comes back however much ink the reading had there.
    const HAIRLINE = maskFromRows(["......", "......", "######", "......", "......"]);
    const opened = openMask(HAIRLINE, 2);
    expect(opened.data.some((v) => v === 1)).toBe(false);
    expect(healSeverances(opened, HAIRLINE, 2).restored).toBe(0);
  });

  it("agrees with a closing computed the slow way, over random masks", () => {
    /*
      The oracle: a square window per pixel, twice, sharing no code with the separable passes. What
      is compared is the **restored set** rather than the closing, so the intersection is in the
      comparison rather than assumed away.
    */
    const next = seededRandom(20260921);
    let sawRestoration = false;
    for (let trial = 0; trial < 60; trial++) {
      const width = 12;
      const height = 9;
      const data = new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) data[i] = next() < 0.55 ? 1 : 0;
      const original: BinaryMask = { width, height, data };
      const radius = 1 + Math.floor(next() * 2);
      const opened = openMask(original, radius);
      const healed = healSeverances(opened, original, radius);

      const oracle = slowBridge(opened, radius);
      const expected = new Uint8Array(opened.data);
      for (let i = 0; i < expected.length; i++) {
        if (oracle.data[i] === 1 && opened.data[i] === 0 && original.data[i] === 1) expected[i] = 1;
      }
      expect([...healed.mask.data], `trial ${trial}`).toEqual([...expected]);
      if (healed.restored > 0) sawRestoration = true;
    }
    // A sweep that never met its case is a green light about nothing.
    expect(sawRestoration).toBe(true);
  });

  it("never puts back a pixel that was not ink, over random masks", () => {
    /*
      **The safety claim, stated directly.** An opening only removes, so `filtered ⊆ original`; the
      heal may only add from `original`; therefore `filtered ⊆ healed ⊆ original` always. This is
      what lets it run with nothing to set and nothing to confirm.
    */
    const next = seededRandom(717);
    for (let trial = 0; trial < 80; trial++) {
      const width = 14;
      const height = 11;
      const data = new Uint8Array(width * height);
      for (let i = 0; i < data.length; i++) data[i] = next() < 0.5 ? 1 : 0;
      const original: BinaryMask = { width, height, data };
      const radius = 1 + Math.floor(next() * 3);
      const opened = openMask(original, radius);
      const healed = healSeverances(opened, original, radius);
      for (let i = 0; i < data.length; i++) {
        if (opened.data[i] === 1) expect(healed.mask.data[i], `trial ${trial}`).toBe(1);
        if (healed.mask.data[i] === 1) expect(original.data[i], `trial ${trial}`).toBe(1);
      }
    }
  });
});
