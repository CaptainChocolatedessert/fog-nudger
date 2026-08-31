/**
 * Spur pruning, on grids where a stub and an artefact are told apart by hand first.
 *
 * The whole difficulty of this control is that a spur and a stub look identical locally, so every
 * fixture here is a skeleton with both in it and the assertion is which one survived.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { pruneSpurs } from "./spurs";
import type { BinaryMask } from "./binarize";

function rows(mask: BinaryMask): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    out.push(row);
  }
  return out;
}

/**
 * A one-pixel wall with a two-pixel spur up and a five-pixel stub down.
 *
 * The wall's own arms are eight and nine pixels, well past the budgets used below. That matters:
 * an arm is a dead-end branch like any other, and a budget longer than one takes it. See the
 * erosion test at the bottom — the property is real and it is what makes a high setting dangerous.
 */
const wallWithBoth = [
  "....................",
  ".........#..........",
  ".........#..........",
  ".##################.",
  ".........#..........",
  ".........#..........",
  ".........#..........",
  ".........#..........",
  ".........#..........",
  "....................",
];

const wallOnly = [
  "....................",
  "....................",
  "....................",
  ".##################.",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
];

describe("pruneSpurs", () => {
  it("is off at zero and returns the skeleton untouched", () => {
    const skeleton = maskFromRows(wallWithBoth);
    const result = pruneSpurs(skeleton, 0);
    expect(rows(result.mask)).toEqual(wallWithBoth);
    expect(result.removed).toBe(0);
  });

  it("removes a short spur and keeps a long stub", () => {
    // The one thing this control is for. Three is longer than the two-pixel spur and shorter than
    // the five-pixel stub, so exactly one of them goes.
    const result = pruneSpurs(maskFromRows(wallWithBoth), 3);
    expect(rows(result.mask)).toEqual([
      "....................",
      "....................",
      "....................",
      ".##################.",
      ".........#..........",
      ".........#..........",
      ".........#..........",
      ".........#..........",
      ".........#..........",
      "....................",
    ]);
    expect(result.removed).toBe(1);
    expect(result.pixels).toBe(2);
  });

  it("takes both when the budget covers both", () => {
    const result = pruneSpurs(maskFromRows(wallWithBoth), 6);
    expect(rows(result.mask)).toEqual(wallOnly);
    expect(result.removed).toBe(2);
  });

  it("does not eat the wall it is pruning from", () => {
    // The junction pixel belongs to the arms that survive. Deleting it would break the wall in two,
    // which is the failure this whole project is most afraid of wearing a very small hat. It is also
    // where the neighbour-count version of this went wrong: a branch that stopped one pixel short
    // left a nub, and one that stepped too far turned along the wall and ate it.
    const result = pruneSpurs(maskFromRows(wallWithBoth), 3);
    expect(rows(result.mask)[3]).toBe(".##################.");
  });

  it("leaves a lone speck alone, because that is the island filter's job", () => {
    // A pixel with no neighbours is not a dead-end branch, and removing it here would be this
    // control quietly doing another one's work with a different number on it.
    const speck = ["......", "..#...", "......"];
    const result = pruneSpurs(maskFromRows(speck), 5);
    expect(rows(result.mask)).toEqual(speck);
    expect(result.removed).toBe(0);
  });

  it("removes a spur exposed by removing another one", () => {
    /*
      Why pruning iterates. The centre pixel below carries three arms; taking the two short ones off
      leaves the third as an ordinary line end rather than a junction, and a single pass would have
      stopped with a shape nobody asked for.
    */
    const branchy = maskFromRows([
      ".........",
      "....#....",
      "....#....",
      ".####....",
      "....#....",
      "....#....",
      ".........",
    ]);
    const result = pruneSpurs(branchy, 3);
    expect(result.rounds).toBeGreaterThan(1);
    expect(result.removed).toBeGreaterThanOrEqual(2);
  });

  it("keeps a closed loop, which has no free end to walk from", () => {
    const loop = [
      "......",
      ".####.",
      ".#..#.",
      ".#..#.",
      ".####.",
      "......",
    ];
    const result = pruneSpurs(maskFromRows(loop), 4);
    expect(rows(result.mask)).toEqual(loop);
    expect(result.removed).toBe(0);
  });

  it("counts a free-floating fragment once, not once per end", () => {
    /*
      A branch attached to a wall has one free end; a fragment floating on its own has two, so it
      used to be walked from both — `removed` 2 and `pixels` 6 for the three pixels below, which
      actually delete once each. The mask was always right, because deletion is deferred to the end
      of the round and writing 0 twice is writing 0. The numbers a GM reads were not.

      Isolated fragments are the island filter's business, so this fires only on what that filter
      left behind — which is exactly the case where a count is being consulted to decide whether to
      reach for it.
    */
    const fragment = maskFromRows([
      "........",
      "........",
      "..###...",
      "........",
      "........",
    ]);
    const result = pruneSpurs(fragment, 5);

    expect(result.removed).toBe(1);
    expect(result.pixels).toBe(3);
    expect(rows(result.mask).join("")).not.toContain("#");
  });

  it("reports pixels as well as branches, since one long spur is not two short ones", () => {
    const result = pruneSpurs(maskFromRows(wallWithBoth), 6);
    expect(result.removed).toBe(2);
    expect(result.pixels).toBe(7);
  });

  it("erodes the whole graph when the budget is longer than the walls themselves", () => {
    /*
      The property that makes a high setting destructive, asserted rather than discovered in a room.

      Every arm of a junction is a dead-end branch, so a budget longer than an arm takes it — and
      removing one turns its junction into an ordinary pixel, exposing the next arm, until nothing is
      left but branches longer than the budget. The wall here is eighteen pixels in two arms of eight
      and nine, and a budget of nine eats all of it.

      This is the same shape as the two ink filters, whose maxima also go past useful: defensible only
      because the skeleton is drawn on screen, so a GM sees the map disappear rather than getting a
      quietly wrong graph. It is the reason the control's default is off.
    */
    const result = pruneSpurs(maskFromRows(wallWithBoth), 9);
    const surviving = rows(result.mask).join("").split("#").length - 1;
    expect(surviving).toBeLessThan(5);
  });

  it("is stable: pruning an already-pruned skeleton changes nothing", () => {
    // The property that makes the slider well behaved. Dragging it up and back must not leave the
    // skeleton somewhere neither position produced, which is the non-monotonic failure the two-slider
    // gap design collapsed under.
    const once = pruneSpurs(maskFromRows(wallWithBoth), 3);
    const twice = pruneSpurs(once.mask, 3);
    expect(rows(twice.mask)).toEqual(rows(once.mask));
    expect(twice.removed).toBe(0);
  });
});
