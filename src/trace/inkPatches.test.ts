/**
 * What *Suppress speckles* offers, and what one press takes.
 *
 * Every fixture here is a mask drawn as text, because that is what this decides on — no image, no
 * tone, no tolerance. The awkward cases are the ones a room would find: a ring cut off by the map's
 * edge, a ring that is broken, and ink sitting inside a ring.
 *
 * **Nine mutations on 2026-09-22, six caught and three equivalent**, at the foot of this file.
 */

import { describe, expect, it } from "vitest";

import type { BinaryMask } from "./binarize";
import { walkIslands } from "./inkIslands";
import { patchAt, patchPixels, patchesUnder } from "./inkPatches";

/** A mask from rows of `#` for ink and `.` for ground. */
function maskOf(rows: readonly string[]): BinaryMask {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "#") data[y * width + x] = 1;
    });
  });
  return { width, height, data };
}

/** What `patchPixels` took, drawn back out the same way, so a failure reads as a picture. */
function takenRows(mask: BinaryMask, taken: readonly number[]): string[] {
  const grid = Array.from({ length: mask.height }, () => ".".repeat(mask.width).split(""));
  for (const index of taken) {
    const x = index % mask.width;
    grid[(index - x) / mask.width]![x] = "#";
  }
  return grid.map((row) => row.join(""));
}

const take = (rows: readonly string[], pick: (patches: ReturnType<typeof patchesUnder>) => number): string[] => {
  const mask = maskOf(rows);
  const walk = walkIslands(mask);
  const patches = patchesUnder(walk, 99);
  return takenRows(mask, patchPixels(mask, walk, patches[pick(patches)]!));
};

describe("what is on offer", () => {
  /*
    A pit derives as a ring and a speck derives solid, so one span rule reaches both — the measurement
    behind this is in the module's own notes.
  */
  it("offers every lump under the span, largest first", () => {
    const walk = walkIslands(
      maskOf([
        "..........",
        ".#####....",
        ".#...#....",
        ".#...#..#.",
        ".#####....",
        "..........",
        ".##.......",
        ".##.......",
      ]),
    );

    const patches = patchesUnder(walk, 99);
    expect(patches.map((patch) => patch.span)).toEqual([5, 2, 1]);
  });

  /*
    **At or under, and the boundary is the assertion**: a lump whose span is exactly the setting is
    offered. A mutation pass found nothing here pinned that — every fixture sat comfortably either side.
  */
  it("offers a lump whose span is exactly the setting, and leaves out anything over it", () => {
    const walk = walkIslands(maskOf([".....", ".###.", ".....", ".##..", "....."]));
    expect(patchesUnder(walk, 3).map((patch) => patch.span)).toEqual([3, 2]);
    expect(patchesUnder(walk, 2).map((patch) => patch.span)).toEqual([2]);
    expect(patchesUnder(walk, 1)).toEqual([]);
    expect(patchesUnder(walk, 0)).toEqual([]);
    expect(patchesUnder(walk, -1)).toEqual([]);
  });

  it("finds the lump under a pixel, and nothing under ground", () => {
    const mask = maskOf([".....", ".##..", ".....", "....#"]);
    const walk = walkIslands(mask);
    expect(patchAt(walk, 1 * 5 + 2)?.span).toBe(2);
    expect(patchAt(walk, 0)).toBeNull();
    expect(patchAt(walk, -1)).toBeNull();
    expect(patchAt(walk, 999)).toBeNull();
  });

  /*
    The free click is not bounded by the span: a press on a lump bigger than the slider takes it, which
    is how this tool absorbs Suppress blob's gesture.
  */
  it("finds a lump the span would not have offered", () => {
    const mask = maskOf(["#####", "#...#", "#...#", "#####"]);
    const walk = walkIslands(mask);
    expect(patchesUnder(walk, 3)).toEqual([]);
    expect(patchAt(walk, 0)?.span).toBe(5);
  });
});

describe("what a press takes", () => {
  it("takes a speck, which encloses nothing", () => {
    expect(take([".....", "..#..", ".....", "....."], () => 0)).toEqual([
      ".....",
      "..#..",
      ".....",
      ".....",
    ]);
  });

  /*
    The point of the whole thing: a ring and its middle, which is the pit a big black shape derives as.
  */
  it("takes a ring and everything inside it", () => {
    expect(
      take(
        ["........", ".#####..", ".#...#..", ".#...#..", ".#####..", "........"],
        () => 0,
      ),
    ).toEqual(["........", ".#####..", ".#####..", ".#####..", ".#####..", "........"]);
  });

  it("takes ink sitting inside the ring with it", () => {
    expect(
      take(
        ["........", ".#####..", ".#...#..", ".#.#.#..", ".#####..", "........"],
        () => 0,
      ),
    ).toEqual(["........", ".#####..", ".#####..", ".#####..", ".#####..", "........"]);
  });

  /*
    The map's edge is a boundary rather than a way in (user, 2026-09-22). Without that rule the flood
    walks in along the open side and a pit drawn against the edge keeps its middle.
  */
  /*
    **Open along the edge, which is the case the rule is for.** The arc reaches the border at its two
    ends and the middle is bounded by the border itself, so nothing but the edge rule closes it.

    The first version of this fixture drew the ring's left side *on* the border, which is closed by the
    lump alone — a mutation pass removing the edge rule passed it, and that is how the gap was found.
  */
  it("fills a ring left open by the map's edge", () => {
    expect(
      take(["###.....", "..#.....", "..#.....", "###.....", "........"], () => 0),
    ).toEqual(["###.....", "###.....", "###.....", "###.....", "........"]);
  });

  it("still fills one whose side is drawn along the edge", () => {
    expect(
      take(["####....", "#...#...", "#...#...", "####....", "........"], () => 0),
    ).toEqual(["####....", "#####...", "#####...", "####....", "........"]);
  });

  /*
    And says so when a ring is broken: the flood reaches the middle through the gap, so only the arc
    goes. The rings are drawn before the press, so this is visible rather than surprising.
  */
  it("takes only the arc when the ring is broken", () => {
    expect(
      take(["........", ".#####..", ".#...#..", ".#......", ".#####..", "........"], () => 0),
    ).toEqual(["........", ".#####..", ".#...#..", ".#......", ".#####..", "........"]);
  });

  it("takes a lump that touches two edges, filling against both", () => {
    expect(take(["#####", "#...#", "#...#", "#####"], () => 0)).toEqual([
      "#####",
      "#####",
      "#####",
      "#####",
    ]);
  });
});

/*
  **The mutations, 2026-09-22 — nine run, six caught, three equivalent.**

  Two of the first pass's five survivors were **real gaps in these fixtures**, and both are now pinned:
  nothing asserted the span boundary, every lump sitting comfortably either side of the setting; and
  the edge fixture drew the ring's side *on* the border, which the lump closes by itself, so removing
  the edge rule passed. The open-arc fixture above is the case the rule is actually for.

  Caught: offering only spans strictly under the setting; sorting smallest first; dropping the edge
  rule; blocking a whole border side instead of the touched stretch; taking the lump without what it
  encloses; flooding 8-connected.

  **Equivalent, and kept as statements of intent** — each was checked by hand rather than explained
  away:

  - `!(maxSpan > 0)` against `maxSpan < 0`: a setting of zero excludes every lump through the filter
    below in any case, since a span is at least one. The guard still decides negatives, which the
    mutant keeps.
  - `patchAt`'s `label === 0` check: without it the lookup is `islands[-1]`, which is undefined, and
    the function answers `null` anyway.
  - Growing the flood's box by one: where the margin would matter the lump's own bounding box is
    entirely its own pixels, so there are no seeds either way and the answer is the same. It is written
    for the reader rather than for the arithmetic.
*/
