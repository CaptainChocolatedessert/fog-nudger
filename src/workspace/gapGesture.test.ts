/**
 * What a click on a gap ring means, with no DOM and no scene.
 *
 * The claim worth pinning hardest is the second: **a guess is never what a click accepts.** A
 * channel the flood ran out of budget on is ringed and cannot be closed, and a query that skipped it
 * by simply looking further would hand the GM a different gap entirely — accepting something they
 * were not aiming at, which is the one thing an irreversible-feeling action must never do.
 */

import { describe, expect, it } from "vitest";

import type { GapMark } from "../trace/gaps";
import {
  describeAccepted,
  describeSearch,
  markAt,
  RING_MIN_RADIUS,
  ringRadius,
} from "./gapGesture";

/** A mark at a raster position, sized and either acceptable or a guess. */
function mark(x: number, y: number, span = 4, fillable = true): GapMark {
  return { x, y, span, area: span * span, fillable, pixels: new Uint32Array() };
}

/**
 * A raster that is **not square**, which a mutation pass showed is load-bearing.
 *
 * A mark's x is divided by the width and its y by the height. On a square fixture those are the same
 * number, so swapping them changes nothing and the mistake passes every assertion here. Real maps are
 * rarely square, and the failure would be every ring offset along one axis.
 */
const RASTER = { width: 1000, height: 400 };
/**
 * Graph units per screen pixel, chosen so the map is 500 screen pixels across — its longer side, which
 * is what a graph unit is.
 *
 * Two raster pixels to one screen pixel, which is the zoom the search is actually used at: a gap is
 * a handful of raster pixels and the GM is looking at the map as a whole.
 */
const PER_PIXEL = 1 / 500;

/** A raster position as the surface would report it — a fraction of the map on each axis. */
function mapAt(x: number, y: number): { u: number; v: number } {
  return { u: x / RASTER.width, v: y / RASTER.height };
}

describe("how big a ring is", () => {
  it("never falls below the floor, which is what makes a tiny gap clickable", () => {
    // Four raster pixels across at this zoom is two screen pixels — smaller than a cursor.
    expect(ringRadius(mark(500, 200), RASTER, PER_PIXEL)).toBe(RING_MIN_RADIUS);
  });

  it("grows past the floor once the gap itself is bigger than it", () => {
    const big = ringRadius(mark(500, 200, 400), RASTER, PER_PIXEL);

    expect(big).toBeGreaterThan(RING_MIN_RADIUS);
    // 400 raster pixels is 200 screen pixels across, so 100 of radius, plus the padding.
    expect(big).toBeCloseTo(106);
  });

  it("is the size drawn on a portrait map too, not only a landscape one", () => {
    /*
      The regression for 2026-09-16. The scale came from the raster's **width** while `perPixel` came
      from the longer drawn side, which agree only when the width is the longer side. On a map taller
      than wide the ring hit-tested at two and a half times the radius the layer drew.

      This and the next test: two mutations restoring each old formula, two caught.
    */
    const tall = { width: 400, height: 1000 };
    // The same 400 raster pixels at the same two-to-one zoom: 200 screen pixels, 100 of radius.
    expect(ringRadius(mark(200, 500, 400), tall, PER_PIXEL)).toBeCloseTo(106);
  });
});

describe("which ring a click lands in", () => {
  it("finds the mark under the pointer", () => {
    const marks = [mark(200, 100), mark(800, 300)];
    const { u, v } = mapAt(800, 300);

    expect(markAt(marks, RASTER, u, v, PER_PIXEL)).toBe(1);
  });

  it("finds nothing when the click is outside every ring", () => {
    const { u, v } = mapAt(950, 380);

    expect(markAt([mark(200, 100)], RASTER, u, v, PER_PIXEL)).toBeNull();
  });

  it("finds a mark clicked near but not exactly on, out to the ring's edge", () => {
    // The floor is 11 screen pixels; the map is 500 across, so that is 0.022 of it.
    const marks = [mark(500, 200)];
    const { u, v } = mapAt(500, 200);

    expect(markAt(marks, RASTER, u + 0.02, v, PER_PIXEL)).toBe(0);
    expect(markAt(marks, RASTER, u + 0.03, v, PER_PIXEL)).toBeNull();
  });

  it("reaches as far up and down as it does across, because the ring is a circle on screen", () => {
    /*
      The other half of the 2026-09-16 regression. `u` and `v` are fractions of each side and
      `perPixel` is one number for both axes, so dividing a fraction by it measured the vertical
      offset in the wrong unit: on this map, two and a half times too far. A click inside the drawn
      ring above or below its centre was refused.
    */
    const marks = [mark(500, 200)];
    const { u, v } = mapAt(500, 200);
    // The floor is 11 screen pixels, which is 22 raster pixels at this zoom, whichever way you go.
    const down = (rasterPixels: number) => v + rasterPixels / RASTER.height;

    expect(markAt(marks, RASTER, u, down(20), PER_PIXEL)).toBe(0);
    expect(markAt(marks, RASTER, u, down(24), PER_PIXEL)).toBeNull();
  });

  it("never picks a guess, and does not pick something else instead of one", () => {
    /*
      The assertion that matters most here.

      A guess is ringed and cannot be accepted. Skipping it as a *candidate* is right; skipping it and
      carrying on to a further acceptable mark is not — the GM aimed at the guess and would get a
      gap somewhere else closed. So a click on a guess finds nothing at all, even with an
      acceptable mark close enough to reach.
    */
    const guess = mark(500, 200, 4, false);
    const acceptable = mark(508, 200);
    const { u, v } = mapAt(500, 200);

    expect(markAt([guess], RASTER, u, v, PER_PIXEL)).toBeNull();
    // And with the acceptable one present, a click dead on the guess picks the acceptable one only
    // because it genuinely overlaps — never because the guess "passed the click through".
    expect(markAt([guess, acceptable], RASTER, u, v, PER_PIXEL)).toBe(1);
  });

  it("picks the nearest centre when rings overlap, not the first in the list", () => {
    /*
      Rings overlap freely once several gaps sit close together. Picking by list order would make
      which one you get depend on the raster scan order the search happened to walk in — invisible,
      and different every time the search re-runs after an accept.
    */
    const marks = [mark(500, 200), mark(510, 200)];

    expect(markAt(marks, RASTER, mapAt(510, 200).u, mapAt(510, 200).v, PER_PIXEL)).toBe(1);
    expect(markAt(marks, RASTER, mapAt(500, 200).u, mapAt(500, 200).v, PER_PIXEL)).toBe(0);
  });

  it("finds nothing rather than dividing by a raster that does not exist", () => {
    /*
      Aimed at the marks that make the division produce **NaN** rather than Infinity, which is what a
      mutation pass showed the first version of this test missed.

      An offset of Infinity fails the radius comparison and is refused whether or not the guard is
      there. `0 / 0` is NaN, and every comparison against NaN is false — so a click that lands exactly
      on such a mark passes *both* the radius test and the nearest-so-far test, and is accepted. The
      guard is the only thing standing in front of that.
    */
    expect(markAt([mark(0, 0)], { width: 0, height: 0 }, 0, 0, PER_PIXEL)).toBeNull();
    expect(markAt([mark(500, 200)], RASTER, 0.5, 0.5, 0)).toBeNull();
  });
});

describe("what the state line says", () => {
  it("says there are none rather than saying nothing", () => {
    // "Found nothing" and "did not run" look identical from a blank line, which is the failure §8 is
    // about. This one also names the control that would change the answer.
    expect(describeSearch(0, 0)).toContain("no gaps found");
  });

  it("names the acceptable count, and the guesses separately when there are any", () => {
    /*
      The correction the reading's own gap line needed once: stating a total as though it were the
      acceptable count implies a larger total still. Five found of which two are guesses is "3 gaps
      found, 2 not examined", never "5 gaps found, 2 not examined".
    */
    expect(describeSearch(3, 3)).toBe("3 gaps found · click a ring to accept one");
    expect(describeSearch(5, 3)).toContain("3 gaps found, 2 not examined");
  });

  it("says one gap rather than 1 gaps", () => {
    expect(describeSearch(1, 1)).toContain("1 gap ");
  });

  it("says what an accept did and what is left, including that it is not saved", () => {
    const line = describeAccepted(4, 120, 7);

    expect(line).toContain("4 gaps");
    expect(line).toContain("120 px");
    expect(line).toContain("7 left");
    // The whole of what makes Done meaningful: an accept is in hand, not in the scene.
    expect(line).toContain("not saved");
  });

  it("says none are left rather than leaving a zero to read", () => {
    expect(describeAccepted(1, 30, 0)).toContain("none left");
  });
});
