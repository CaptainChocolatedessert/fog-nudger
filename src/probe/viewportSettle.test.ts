/**
 * The blank-and-restore decision, which has to be right before anyone stands in a room looking at
 * it.
 *
 * The overlay's whole safety property is that it is either absent or correct, never present and
 * wrong. That rests on two things being the right way round, and both of them fail *silently*: a
 * sheet that never blanks lies about where the ink is, and a sheet that never shows looks exactly
 * like a modal that does not composite. Neither announces which it is.
 */

import { describe, expect, it } from "vitest";

import { shouldShow, STILL_PIXELS, viewMoved, type ScreenPair } from "./viewportSettle";

const at = (ax: number, ay: number, bx: number, by: number): ScreenPair => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

describe("viewMoved", () => {
  it("treats the first poll as movement", () => {
    // Nothing to have been still relative to. Starting blank is the safe direction: the cost is one
    // settle interval of nothing, against a first frame drawn at a transform never checked.
    expect(viewMoved(null, at(0, 0, 100, 100))).toBe(true);
  });

  it("says a stationary view is stationary", () => {
    const held = at(10, 20, 300, 400);
    expect(viewMoved(held, at(10, 20, 300, 400))).toBe(false);
  });

  it("tolerates jitter up to the threshold, so the sheet is not blank permanently", () => {
    const held = at(10, 20, 300, 400);
    expect(viewMoved(held, at(10 + STILL_PIXELS, 20, 300, 400))).toBe(false);
    expect(viewMoved(held, at(10, 20 - STILL_PIXELS, 300, 400))).toBe(false);
  });

  it("notices a real move on any corner and either axis", () => {
    // All four independently, because a comparison that reads the same point twice passes every
    // test written with one moving corner and misses half the pans in a room.
    const held = at(10, 20, 300, 400);
    const nudge = STILL_PIXELS + 0.5;
    expect(viewMoved(held, at(10 + nudge, 20, 300, 400))).toBe(true);
    expect(viewMoved(held, at(10, 20 + nudge, 300, 400))).toBe(true);
    expect(viewMoved(held, at(10, 20, 300 + nudge, 400))).toBe(true);
    expect(viewMoved(held, at(10, 20, 300, 400 + nudge))).toBe(true);
  });

  it("notices a zoom, which moves the corners in opposite directions", () => {
    // The case a single-point probe cannot see: a zoom centred between the two corners leaves the
    // midpoint fixed while both ends travel. This is why the pair exists rather than one point.
    const held = at(100, 100, 300, 300);
    expect(viewMoved(held, at(50, 50, 350, 350))).toBe(true);
  });

  it("notices a zoom centred exactly on one of the two points", () => {
    // And the converse: zooming about corner A leaves A alone entirely. A one-point check anchored
    // there would report a still view through the whole gesture.
    const held = at(100, 100, 300, 300);
    expect(viewMoved(held, at(100, 100, 500, 500))).toBe(true);
  });
});

describe("shouldShow", () => {
  it("holds the sheet back until the view has been still long enough", () => {
    expect(shouldShow(0, 200)).toBe(false);
    expect(shouldShow(199, 200)).toBe(false);
  });

  it("shows once the settle time is reached", () => {
    expect(shouldShow(200, 200)).toBe(true);
    expect(shouldShow(5000, 200)).toBe(true);
  });

  it("shows immediately when no settling is asked for", () => {
    expect(shouldShow(0, 0)).toBe(true);
  });
});
