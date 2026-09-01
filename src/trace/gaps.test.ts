/**
 * The gap detector, against the cases that killed two earlier definitions.
 *
 * Every fixture is drawn as a text grid, per the standing rule: a predicate fixture can be wrong
 * before the code is, and step 4 shipped two that were. Here that matters more than usual, because
 * half of these exist precisely to distinguish a break from something that merely looks like one.
 *
 * ## Every room has to be wider than the closing
 *
 * The first draft of this file was wrong in a way worth recording, since anyone editing it will
 * meet the same thing. A closing at radius `r` fills **any** ground narrower than about `2r`, and
 * that includes a room. Fixtures drawn three pixels tall against a two-pixel radius came back with
 * their whole interiors reported as breaks — the code was right and the drawings were not. So every
 * room here is comfortably wider than the setting used on it, and so is every space between two
 * pieces of ink that is not meant to be a break.
 *
 * ## Why the travel distance is small in most of these
 *
 * A fixture with a border wall is one connected loop of ink, so the two banks of any break in it
 * can be reached the long way round. Six pixels of travel is short enough that the long way round
 * does not count, which is the whole point of the control — and one test walks the same crack back
 * to "intact" by opening the travel up, so the meaning is pinned in both directions.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { findGaps, GAP_FILLED, GAP_NONE, GAP_OPEN } from "./gaps";

/** Seals breaks up to two pixels; treats ink more than six pixels apart along itself as separate. */
const NEAR = { widthPx: 2, travelPx: 6 };
/** The same width, with enough travel allowed to walk right round a small room. */
const FAR = { widthPx: 2, travelPx: 60 };

/** A wall across a bordered box, with a two-pixel break in it. */
const BROKEN_WALL = [
  "############",
  "#..........#",
  "#..........#",
  "#..........#",
  "#####..#####",
  "#..........#",
  "#..........#",
  "#..........#",
  "############",
];

/** The same shape one size up, with a four-pixel break — wide enough to need a wider setting. */
const WIDE_BREAK = [
  "##############",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "######....####",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "#............#",
  "##############",
];

describe("findGaps", () => {
  it("finds nothing when the width is zero, which is off", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 0, travelPx: 6 });
    expect(found.marks).toEqual([]);
    expect(found.searchRadius).toBe(0);
    expect(found.channels).toBe(0);
  });

  it("finds nothing when the width rounds to nothing", () => {
    // A setting under one pixel cannot describe a break, and must leave the mask alone rather than
    // nearly so — the same exactness the opening's zero depends on.
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 0.4, travelPx: 6 });
    expect(found.searchRadius).toBe(0);
    expect(found.channels).toBe(0);
  });

  it("marks a break through a wall", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), NEAR);
    expect(found.marks).toHaveLength(1);
    expect(found.through).toBe(1);

    const [mark] = found.marks;
    // The two ground pixels of the wall's own row and nothing above or below them: the closing
    // converts only what is narrow, and the rooms either side are wide open.
    expect(mark!.area).toBe(2);
    expect(mark!.x).toBeCloseTo(5.5, 5);
    expect(mark!.y).toBeCloseTo(4, 5);
  });

  it("leaves a break wider than the setting alone, and finds it once the setting reaches it", () => {
    // The control doing its job, rather than the detector changing its mind. Four pixels of ground
    // is not a candidate at a two-pixel setting and is one at a four-pixel setting.
    const mask = maskFromRows(WIDE_BREAK);
    expect(findGaps(mask, NEAR).channels).toBe(0);

    const found = findGaps(mask, { widthPx: 4, travelPx: 6 });
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.area).toBe(4);
    expect(found.marks[0]!.span).toBe(4);
    expect(found.marks[0]!.y).toBeCloseTo(7, 5);
  });

  it("ignores a notch in a wall's edge", () => {
    // The ragged-edge case, and the reason a raw closing on its own produces confetti. The banks
    // wrap round the notch continuously, so it is a dead end and never reaches the travel test.
    const found = findGaps(
      maskFromRows([
        "############",
        "#..........#",
        "#..........#",
        "#..........#",
        "#####.######",
        "############",
        "#..........#",
        "#..........#",
        "#..........#",
        "############",
      ]),
      NEAR,
    );
    expect(found.channels).toBe(1);
    expect(found.through).toBe(0);
    expect(found.marks).toEqual([]);
  });

  it("ignores a pocket of ground the ink encloses", () => {
    const found = findGaps(
      maskFromRows([
        "##############",
        "#............#",
        "#............#",
        "#............#",
        "#....#####...#",
        "#....##.##...#",
        "#....#####...#",
        "#............#",
        "#............#",
        "#............#",
        "##############",
      ]),
      NEAR,
    );
    expect(found.channels).toBe(1);
    expect(found.through).toBe(0);
    expect(found.marks).toEqual([]);
  });

  it("marks a crack in a freestanding wall, which separates no space at all", () => {
    // The case that killed the first definition. Sealing this crack divides nothing — the wall
    // touches nothing — but the wall is broken and a GM should see it.
    const found = findGaps(
      maskFromRows([
        "################",
        "#..............#",
        "#..............#",
        "#..............#",
        "#....###.###...#",
        "#..............#",
        "#..............#",
        "#..............#",
        "################",
      ]),
      NEAR,
    );
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.x).toBeCloseTo(8, 5);
    expect(found.marks[0]!.y).toBeCloseTo(4, 5);
  });

  /**
   * A closed ring standing clear of the walls, cracked at the bottom.
   *
   * The margins are load-bearing. An earlier draft stood the ring one pixel from the border, and
   * that seam is itself narrow enough for the closing to fill — so the fixture reported two breaks
   * and the second one was real. Three pixels of clearance all round is what keeps this fixture
   * about the crack.
   */
  const CRACKED_RING = [
    "################",
    "#..............#",
    "#..............#",
    "#..............#",
    "#....######....#",
    "#....#....#....#",
    "#....#....#....#",
    "#....#....#....#",
    "#....##.###....#",
    "#..............#",
    "#..............#",
    "#..............#",
    "################",
  ];

  it("marks a crack in a ring, where both banks are the same blob of ink", () => {
    // The case that killed the second definition. The banks meet by going the long way round, so
    // blob identity says "connected" while the travel distance says "not from here".
    const found = findGaps(maskFromRows(CRACKED_RING), NEAR);
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.x).toBeCloseTo(7, 5);
    expect(found.marks[0]!.y).toBeCloseTo(8, 5);
  });

  it("calls that same crack intact once the travel distance reaches round the ring", () => {
    // The control's meaning, pinned in the other direction: allowed enough travel, the two banks
    // are one piece of linework that happens to be pinched here, and the mark goes away.
    const found = findGaps(maskFromRows(CRACKED_RING), FAR);
    expect(found.through).toBe(1);
    expect(found.marks).toEqual([]);
  });

  it("marks every break that passes through when the travel distance is zero", () => {
    const found = findGaps(maskFromRows(CRACKED_RING), { widthPx: 2, travelPx: 0 });
    expect(found.marks).toHaveLength(1);
  });

  it("finds both breaks on a wall with two of them", () => {
    const found = findGaps(
      maskFromRows([
        "################",
        "#..............#",
        "#..............#",
        "#..............#",
        "###..#####..####",
        "#..............#",
        "#..............#",
        "#..............#",
        "################",
      ]),
      NEAR,
    );
    expect(found.marks).toHaveLength(2);
    // Reported in scan order, so a caller can rely on the list rather than sorting it.
    expect(found.marks.map((mark) => mark.x)).toEqual([3.5, 10.5]);
  });

  it("puts an elbowed channel's mark at the centre of the box its span measures", () => {
    // Two L-shaped walls one pixel apart, so the channel between them turns a corner. That is what
    // a *merged* channel looks like, and merging is the normal case as the width rises — so this is
    // the shape the mark has to survive, not a compact break.
    //
    // The mark and `span` are read together: the surface draws a ring centred on x/y and sized from
    // span. The centroid of this channel is (8.4, 7.4), pulled towards the longer arm and away from
    // the box it is being sized against. The box's own centre is (10, 9), which is what a ring
    // concentric with its radius needs. Neither point is inside a channel this concave, and nothing
    // cheap would be — the claim here is only that the two halves of the mark agree.
    const found = findGaps(
      maskFromRows([
        "####################",
        "#..................#",
        "#..................#",
        "#..................#",
        "#..................#",
        "#....##########....#",
        "#....#.............#",
        "#....#.########....#",
        "#....#.#...........#",
        "#....#.#...........#",
        "#....#.#...........#",
        "#....#.#...........#",
        "#....#.#...........#",
        "#..................#",
        "#..................#",
        "#..................#",
        "#..................#",
        "####################",
      ]),
      NEAR,
    );
    expect(found.marks).toHaveLength(1);
    const [mark] = found.marks;
    // Nine along the top arm, six down the side: columns 6 to 14, rows 6 to 12.
    expect(mark!.area).toBe(15);
    expect(mark!.span).toBe(9);
    expect(mark!.x).toBeCloseTo(10, 5);
    expect(mark!.y).toBeCloseTo(9, 5);
  });

  it("labels the marked channels and nothing else", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), NEAR);
    const lit: number[] = [];
    for (let i = 0; i < found.labels.data.length; i++) {
      if (found.labels.data[i] !== GAP_NONE) lit.push(i);
    }
    // Row 4, columns 5 and 6 — the break itself. Ink is never included: what gets painted in the
    // gap colour has to be ground the trace found nothing in, or the mark would sit on top of the
    // linework it is complaining about.
    expect(lit).toEqual([4 * 12 + 5, 4 * 12 + 6]);
    // Repaired, which is what everything found is unless the search ran out of budget examining it.
    expect(lit.map((i) => found.labels.data[i])).toEqual([GAP_FILLED, GAP_FILLED]);
  });

  it("does not turn the map's border into a break", () => {
    // The closing clamps at the edge rather than treating off-image as ground, so a wall drawn
    // along the border is not eroded into a break by the very check meant to find them.
    const found = findGaps(
      maskFromRows([
        "############",
        "#..........#",
        "#..........#",
        "#..........#",
        "#..........#",
        "############",
      ]),
      NEAR,
    );
    expect(found.channels).toBe(0);
    expect(found.marks).toEqual([]);
  });

  it("leaves an intact map silent", () => {
    const found = findGaps(
      maskFromRows([
        "##############",
        "#.....#......#",
        "#.....#......#",
        "#.....#......#",
        "#.....#......#",
        "##############",
      ]),
      NEAR,
    );
    expect(found.channels).toBe(0);
    expect(found.marks).toEqual([]);
    expect(found.budgetHits).toBe(0);
  });

  it("survives an empty raster", () => {
    const found = findGaps(maskFromRows([]), NEAR);
    expect(found.marks).toEqual([]);
    expect(found.labels.width).toBe(0);
  });
});

/**
 * The repair, which is the half that writes.
 *
 * There is no separate fill width any more. Finding and repairing were briefly two controls so a GM
 * could settle a stable set of candidates and then sweep the repair across it; a room showed the
 * premise was false — channels **merge** as the radius grows, so the candidate set is not stable and
 * raising the marking width could prevent a repair a lower one allowed. One width is well behaved
 * because what it tunes is the set of pixels repaired, which grows, rather than a set of discrete
 * marks, which does not.
 *
 * So everything found is repaired, and the property doing the real work is the last one here:
 * **nothing is repaired that is not also marked**.
 */
describe("findGaps, repairing", () => {
  it("repairs the break it finds and says so on the mark", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), NEAR);
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.filled).toBe(true);
    expect(found.filled).toBe(1);
    // The two pixels of the break, and they are exactly what the pipeline adds to the ink.
    expect(found.filledArea).toBe(2);
    expect(found.labels.data[4 * 12 + 5]).toBe(GAP_FILLED);
    expect(found.labels.data[4 * 12 + 6]).toBe(GAP_FILLED);
  });

  it("repairs more as the width grows, and never less", () => {
    /*
      The property that makes one control tunable where two were not: the repaired pixel set only
      grows. The *count* of marks is deliberately not asserted — channels merge, so it can fall
      while the repaired area rises, which is exactly the behaviour that sank the two-slider design.
    */
    const mask = maskFromRows([
      "##################",
      "#................#",
      "#................#",
      "#................#",
      "#................#",
      "#................#",
      "#####.#######....#",
      "#................#",
      "#................#",
      "#................#",
      "#................#",
      "#................#",
      "#................#",
      "##################",
    ]);
    const areas = [1, 2, 3, 4, 6].map(
      (widthPx) => findGaps(mask, { widthPx, travelPx: 6 }).filledArea,
    );
    for (let i = 1; i < areas.length; i++) {
      expect(areas[i]!).toBeGreaterThanOrEqual(areas[i - 1]!);
    }
    // And it does actually reach the wide break rather than being flat at zero throughout.
    expect(areas[areas.length - 1]!).toBeGreaterThan(areas[0]!);
  });

  it("repairs nothing when the width is off", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 0, travelPx: 6 });
    expect(found.filled).toBe(0);
    expect(found.filledArea).toBe(0);
    expect(found.marks).toEqual([]);
  });

  it("never repairs anything it has not marked", () => {
    // The invariant the whole design rests on, asserted directly rather than inferred: every
    // repaired pixel belongs to a channel that also produced a mark.
    const mask = maskFromRows(BROKEN_WALL);
    for (const widthPx of [0, 1, 2, 4, 8]) {
      const found = findGaps(mask, { widthPx, travelPx: 6 });
      let repairedPixels = 0;
      for (const value of found.labels.data) if (value === GAP_FILLED) repairedPixels += 1;
      expect(repairedPixels).toBe(found.filledArea);
      expect(found.filled > 0).toBe(repairedPixels > 0);
      expect(found.marks.filter((m) => m.filled)).toHaveLength(found.filled);
    }
  });

  it("marks a break it could not examine, and refuses to fill it", () => {
    /*
      The guessed-break state, which nothing in this suite could reach until the flood budget became
      injectable — `GAP_OPEN` appeared in no test at all, and `budgetHits` was only ever asserted to
      be zero.

      It matters because it is the one place the design's central invariant is *deliberately* one-
      sided. A channel whose flood ran out was never proved broken, so it carries a mark and no fill:
      marking on a guess is a warning, inventing ink on a guess is not. The record had this state down
      as never observed and therefore possibly deletable; it is reachable in bulk, because the budget
      is spent across the whole call and once it is gone every remaining channel exhausts at depth
      zero.

      A budget of 1 is spent by the first channel's first frontier, so the break here is guessed
      rather than measured. `BROKEN_WALL` rather than the cracked ring only because that fixture is
      module-scoped and this block cannot see the other one.
    */
    const found = findGaps(maskFromRows(BROKEN_WALL), { ...NEAR, floodBudget: 1 });

    expect(found.budgetHits).toBeGreaterThan(0);
    expect(found.marks.length, "a guess is still marked").toBeGreaterThan(0);
    expect(found.marks.every((mark) => !mark.filled), "and never filled").toBe(true);
    expect(found.filled).toBe(0);
    expect(found.filledArea).toBe(0);

    const values = new Set(found.labels.data);
    expect(values.has(GAP_OPEN), "painted as an open break").toBe(true);
    expect(values.has(GAP_FILLED), "and nothing painted as repaired").toBe(false);
  });

  it("does not repair a dead end", () => {
    // A notch connects nothing to anything, so sealing it could not help — and it carries no mark,
    // so repairing it would break the invariant above.
    const found = findGaps(
      maskFromRows([
        "############",
        "#..........#",
        "#..........#",
        "#..........#",
        "#####.######",
        "############",
        "#..........#",
        "#..........#",
        "#..........#",
        "############",
      ]),
      NEAR,
    );
    expect(found.channels).toBe(1);
    expect(found.filledArea).toBe(0);
    expect(found.marks).toEqual([]);
  });
});
