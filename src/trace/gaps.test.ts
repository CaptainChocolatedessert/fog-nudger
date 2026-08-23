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
const NEAR = { widthPx: 2, travelPx: 6, fillPx: 0 };
/** The same width, with enough travel allowed to walk right round a small room. */
const FAR = { widthPx: 2, travelPx: 60, fillPx: 0 };

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
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 0, travelPx: 6, fillPx: 0 });
    expect(found.marks).toEqual([]);
    expect(found.searchRadius).toBe(0);
    expect(found.channels).toBe(0);
  });

  it("finds nothing when the width rounds to nothing", () => {
    // A setting under one pixel cannot describe a break, and must leave the mask alone rather than
    // nearly so — the same exactness the opening's zero depends on.
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 0.4, travelPx: 6, fillPx: 0 });
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

    const found = findGaps(mask, { widthPx: 4, travelPx: 6, fillPx: 0 });
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
    const found = findGaps(maskFromRows(CRACKED_RING), { widthPx: 2, travelPx: 0, fillPx: 0 });
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
    expect(lit.map((i) => found.labels.data[i])).toEqual([GAP_OPEN, GAP_OPEN]);
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
 * The fill, which is the half that writes.
 *
 * The property doing the real work here is the last one: **nothing is ever filled that is not also
 * marked**. Everything else is the two sliders behaving independently, which is the point of having
 * two of them.
 */
describe("findGaps, filling", () => {
  it("fills nothing when the fill width is zero, which is off", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), NEAR);
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.filled).toBe(false);
    expect(found.filled).toBe(0);
    expect(found.filledArea).toBe(0);
    expect(found.fillRadius).toBe(0);
  });

  it("fills a break the fill width reaches, and says so on the mark", () => {
    const found = findGaps(maskFromRows(BROKEN_WALL), { widthPx: 2, travelPx: 6, fillPx: 2 });
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.filled).toBe(true);
    expect(found.filled).toBe(1);
    // The two pixels of the break, and they are exactly what the pipeline adds to the ink.
    expect(found.filledArea).toBe(2);
    expect(found.labels.data[4 * 12 + 5]).toBe(GAP_FILLED);
    expect(found.labels.data[4 * 12 + 6]).toBe(GAP_FILLED);
  });

  it("holds the marked set still while the fill sweeps across it", () => {
    // The workflow the two sliders exist for: settle what you are looking at, then move the other
    // one and watch the same set change state. Two breaks, one narrow and one wide.
    const mask = maskFromRows([
      "##################",
      "#................#",
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
    const marked = { widthPx: 4, travelPx: 6 };

    const none = findGaps(mask, { ...marked, fillPx: 0 });
    const narrow = findGaps(mask, { ...marked, fillPx: 2 });
    const both = findGaps(mask, { ...marked, fillPx: 4 });

    // The reference set does not move. That is the property the GM is relying on while sweeping.
    expect(none.marks).toHaveLength(2);
    expect(narrow.marks).toHaveLength(2);
    expect(both.marks).toHaveLength(2);
    expect(narrow.marks.map((m) => m.x)).toEqual(none.marks.map((m) => m.x));
    expect(both.marks.map((m) => m.x)).toEqual(none.marks.map((m) => m.x));

    // Only the state changes, and it changes in one direction as the fill widens.
    expect(none.marks.map((m) => m.filled)).toEqual([false, false]);
    expect(narrow.marks.map((m) => m.filled)).toEqual([true, false]);
    expect(both.marks.map((m) => m.filled)).toEqual([true, true]);
  });

  it("leaves a break only partly within the fill width open", () => {
    /*
      A break sealed along part of its length is still a break at the rest of it, so a partial fill
      is no fill at all and the mark has to keep saying so.

      A two-row wall broken three pixels wide through the upper row and one pixel wide through the
      lower one. The fill reaches the narrow half and not the wide half.

      The first draft of this fixture staggered the break diagonally instead, and the detector was
      right to report nothing: **space is 4-connected here**, so a diagonal step does not pass, and
      that wall is intact. Worth keeping as a note — a break drawn as a diagonal jog is not a break.
    */
    const mask = maskFromRows([
      "################",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#####...########",
      "######.#########",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#..............#",
      "################",
    ]);
    const found = findGaps(mask, { widthPx: 4, travelPx: 6, fillPx: 2 });
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.filled).toBe(false);
  });

  it("never fills anything it has not marked", () => {
    // The invariant the whole design rests on, asserted directly rather than inferred: every filled
    // pixel belongs to a channel that also produced a mark. A fill wider than the highlight widens
    // the search rather than acting unseen.
    const mask = maskFromRows(BROKEN_WALL);
    for (const fillPx of [0, 1, 2, 4, 8, 40]) {
      const found = findGaps(mask, { widthPx: 2, travelPx: 6, fillPx });
      let filledPixels = 0;
      for (const value of found.labels.data) if (value === GAP_FILLED) filledPixels += 1;
      expect(filledPixels).toBe(found.filledArea);
      // Anything filled is part of a mark, so a filled pixel count above zero demands a filled mark.
      expect(found.filled > 0).toBe(filledPixels > 0);
      expect(found.marks.filter((m) => m.filled)).toHaveLength(found.filled);
    }
  });

  it("widens the search rather than filling unseen if a caller passes a wider fill", () => {
    /*
      Unreachable through the controls, and kept deliberately.

      The fill control is a **share** of the marking width, so no position on its track can ask for
      something wider than what is marked — that is where the relationship is enforced. This pins
      the pure function's own contract underneath it: handed a wider fill anyway, it widens what it
      looks at rather than repairing something it never marked. The invariant is a property of this
      function, not a consequence of the UI being set up correctly.
    */
    const mask = maskFromRows(WIDE_BREAK);
    const found = findGaps(mask, { widthPx: 2, travelPx: 6, fillPx: 4 });
    expect(found.searchRadius).toBe(2);
    expect(found.marks).toHaveLength(1);
    expect(found.marks[0]!.filled).toBe(true);
  });

  it("does not fill a dead end the fill could easily reach", () => {
    // A notch connects nothing to anything, so sealing it could not help — and it carries no mark,
    // so filling it would break the invariant above. The fill here is wide enough to cover it twice
    // over and still leaves it alone.
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
      { widthPx: 2, travelPx: 6, fillPx: 2 },
    );
    expect(found.channels).toBe(1);
    expect(found.filledArea).toBe(0);
    expect(found.marks).toEqual([]);
  });
});
