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
import { enclosureMap, patchAt, patchEnclosing, patchPixels, patchesUnder } from "./inkPatches";

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

describe("what encloses a press", () => {
  const enclosing = (rows: readonly string[], x: number, y: number) => {
    const mask = maskOf(rows);
    const walk = walkIslands(mask);
    return patchEnclosing(walk, enclosureMap(mask, walk), y * mask.width + x);
  };

  /*
    The case the room asked for: a press in the middle of a pit, which is not ink and carries no ring
    because the span never offered it.
  */
  it("answers with the ring a press landed inside", () => {
    const rows = ["........", ".#####..", ".#...#..", ".#...#..", ".#####..", "........"];
    expect(enclosing(rows, 3, 2)?.span).toBe(5);
  });

  it("answers with the lump itself when the press lands on ink", () => {
    const rows = ["........", ".#####..", ".#...#..", ".#...#..", ".#####..", "........"];
    expect(enclosing(rows, 1, 1)?.span).toBe(5);
  });

  it("says nothing for a press on open map, which reaches the border", () => {
    const rows = ["........", ".#####..", ".#...#..", ".#...#..", ".#####..", "........"];
    expect(enclosing(rows, 7, 0)).toBeNull();
    expect(enclosing(rows, 6, 3)).toBeNull();
  });

  it("says nothing when the ring is broken, since the flood walks out", () => {
    const rows = ["........", ".#####..", ".#...#..", ".#......", ".#####..", "........"];
    expect(enclosing(rows, 3, 2)).toBeNull();
  });

  /*
    **There is no bound on what a press inside can take** (user, 2026-09-22: *"It should delete the
    whole wall network if that's what the user clicks."*). The first version stopped at a budget, which
    made a press inside a room answer with nothing; now it answers with the walls around it.
  */
  it("answers with whatever encloses the press, however large", () => {
    const rows = [
      "............",
      ".##########.",
      ".#........#.",
      ".#..####..#.",
      ".#..#..#..#.",
      ".#..####..#.",
      ".#........#.",
      ".##########.",
      "............",
    ];
    // Between the two: the outer ring. Inside the inner one: the inner ring.
    expect(enclosing(rows, 2, 2)?.span).toBe(10);
    expect(enclosing(rows, 5, 4)?.span).toBe(4);
  });

  /*
    A speck inside the pit is touched by the same flood, so the answer has to tell the thing that wraps
    the space from the thing sitting in it.

    **The inner lump here holds more ink than the ring does**, which is what makes this about wrapping
    rather than about size. The first version had a single speck inside, where picking the larger lump
    gives the same answer — a mutation pass removing the containment test passed it.
  */
  it("takes the lump that wraps the space, even when the one inside holds more ink", () => {
    const rows = [
      "..............",
      ".############.",
      ".#..........#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#.########.#.",
      ".#..........#.",
      ".############.",
      "..............",
    ];
    // Pressed in the gap between the two, not on either: the ring is 44 pixels of ink and the block
    // inside it is 64, so picking by size would answer with the block.
    expect(enclosing(rows, 2, 2)?.span).toBe(12);
  });

  /*
    **The image's border is what makes the outside the outside.** A channel that escapes only through
    the top row is open map, not a pocket — and a mutation pass that stopped seeding the top and bottom
    rows passed every other fixture here, because they all escape sideways.
  */
  it("counts ground that escapes through the top as outside", () => {
    expect(enclosing(["#.#", "#.#", "###"], 1, 1)).toBeNull();
    // The same shape closed at the top does enclose it.
    expect(enclosing(["###", "#.#", "###"], 1, 1)?.span).toBe(3);
  });

  /*
    **Two lumps can wrap one pocket**, when the inner one is broken so the space inside it joins the
    space between them. The larger wins: it is the thing that actually encloses the ground, and taking
    it takes the other with it.
  */
  it("takes the larger of two lumps that both wrap the space", () => {
    const rows = [
      "..........",
      ".########.",
      ".#......#.",
      ".#.####.#.",
      ".#.#..#.#.",
      ".#.#....#.",
      ".#.####.#.",
      ".#......#.",
      ".########.",
      "..........",
    ];
    // The inner box is open on its right, so a press in its middle touches both rings.
    expect(enclosing(rows, 4, 4)?.span).toBe(8);
  });

  /*
    **Four-connected, so a diagonal is not a way out.** The diamond's sides meet only at their corners,
    so an eight-connected flood slips between them and reaches the border — and reports that nothing
    encloses a point that plainly is enclosed.
  */
  it("does not leak diagonally out of a shape whose sides meet at corners", () => {
    const rows = ["..#..", ".#.#.", "#...#", ".#.#.", "..#.."];
    expect(enclosing(rows, 2, 2)?.span).toBe(5);
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
  **The enclosing lookup became a map — 2026-09-22**, when the bound on it was removed (user: *"It
  should delete the whole wall network if that's what the user clicks."*). A per-press flood with no
  bound would walk a room on every pointer move, since the cursor asks the same question; one pass over
  the raster answers it everywhere instead.

  **Six mutations on the map, four caught and two equivalent.** Caught: never seeding the image's
  border, so open map reads as enclosed; flooding the outside 8-connected, which slips out between sides
  that meet at their corners; dropping the containment test, which then answers with a speck sitting
  inside rather than the ring around it; and skipping the ink shortcut.

  **Two survived and were checked by hand.** Preferring the largest wrapping lump over the smallest is
  unreachable: a lump the pocket *touches* and whose box *contains* the pocket cannot be one of two, since
  a second such lump would have to be reached past the first. And clearing the outside marker at the end
  is cosmetic — the lookup reads a negative label as no lump either way, so it is there to make the
  array's meaning plain rather than to change an answer.

  **Measured on a 3626x2598 raster with 2,476 lumps**: the walk 47ms, the map **321ms** and 36MB, and a
  lookup 0.0003ms. The map is built on first need and dropped when the ink changes, so a GM who never
  presses inside anything never pays for it.

  - Growing the flood's box by one: where the margin would matter the lump's own bounding box is
    entirely its own pixels, so there are no seeds either way and the answer is the same. It is written
    for the reader rather than for the arithmetic.
*/
