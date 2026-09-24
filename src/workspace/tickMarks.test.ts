/**
 * Where a slider's tick marks go, and which one a value is nearest.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { SLIDER_STEPS, toSlider, type ScaleLimits } from "../sliderScale";
import { tickIndex, tickPositions } from "./tickMarks";

const LIMITS: ScaleLimits = { min: 0, max: 3, step: 0.5 };

describe("tickPositions", () => {
  it("puts one tick on every stop, both ends included", () => {
    // 0, 0.5, 1, 1.5, 2, 2.5, 3 — seven ticks over a range six steps wide.
    const positions = tickPositions(LIMITS, "linear");
    expect(positions).toHaveLength(7);
    expect(positions[0]).toBe(toSlider(0, LIMITS, "linear"));
    expect(positions[positions.length - 1]).toBe(toSlider(3, LIMITS, "linear"));
  });

  it("adds one final tick at the top when it is a genuinely later stop", () => {
    // Whole steps from 0 by 0.4 reach 1.6; the remainder to 1.9 is 0.75 of a step, which
    // `tickIndex` rounds up to the next stop — a real, distinct one, so it earns its own mark.
    const limits: ScaleLimits = { min: 0, max: 1.9, step: 0.4 };
    const positions = tickPositions(limits, "linear");
    expect(positions).toHaveLength(6); // 0, 0.4, 0.8, 1.2, 1.6, 1.9
    expect(positions[4]).toBe(toSlider(1.6, limits, "linear"));
    expect(positions[5]).toBe(toSlider(1.9, limits, "linear"));
  });

  it("does not double a tick that already sits exactly on the top", () => {
    // 0.4 divides 2 evenly, so the last whole step already lands on the declared max — the top is
    // not a *separate* real position here, and drawing it twice would be one mark, badly rendered.
    const limits: ScaleLimits = { min: 0, max: 2, step: 0.4 };
    const positions = tickPositions(limits, "linear");
    expect(positions).toHaveLength(6); // 0, 0.4, 0.8, 1.2, 1.6, 2 — not seven
    expect(positions[positions.length - 1]).toBe(toSlider(2, limits, "linear"));
  });

  it("does not give the top its own tick when it is under half a step past the last one", () => {
    /*
      **The room-reported bug.** Whole steps from 0 by 0.4 reach 2.0; the remainder to the declared
      max of 2.1 is a quarter of a step, which `tickIndex` rounds *down* to the same stop as 2.0 —
      so under the old rule, which drew the top regardless of size, this pair sat a quarter of a
      step apart while every other pair sat a full step apart: close enough on screen to read as one
      tick, doubled, rather than two.
    */
    const limits: ScaleLimits = { min: 0, max: 2.1, step: 0.4 };
    const positions = tickPositions(limits, "linear");
    expect(positions).toHaveLength(6); // 0, 0.4, 0.8, 1.2, 1.6, 2.0 — not 2.1 as well
    expect(positions[positions.length - 1]).toBe(toSlider(2.0, limits, "linear"));
    expect(positions[positions.length - 1]).not.toBe(toSlider(2.1, limits, "linear"));
  });

  it("is empty on a track with no step or no range", () => {
    expect(tickPositions({ min: 0, max: 3, step: 0 }, "linear")).toEqual([]);
    expect(tickPositions({ min: 3, max: 3, step: 0.5 }, "linear")).toEqual([]);
  });

  it("covers the whole track, floor to top", () => {
    const positions = tickPositions(LIMITS, "linear");
    expect(positions[0]).toBe(0);
    expect(positions[positions.length - 1]).toBe(SLIDER_STEPS);
  });
});

describe("tickIndex", () => {
  it("counts whole steps from the floor", () => {
    expect(tickIndex(0, LIMITS)).toBe(0);
    expect(tickIndex(0.5, LIMITS)).toBe(1);
    expect(tickIndex(1.5, LIMITS)).toBe(3);
    expect(tickIndex(3, LIMITS)).toBe(6);
  });

  it("rounds a value that has drifted off its own grid to the nearest tick", () => {
    // Stored before this control had a measured step, say — still reads as the tick it is closest
    // to rather than refusing to answer.
    expect(tickIndex(0.42, LIMITS)).toBe(1);
    expect(tickIndex(0.24, LIMITS)).toBe(0);
  });

  it("is zero rather than dividing by nothing on a stepless track", () => {
    expect(tickIndex(1, { min: 0, max: 3, step: 0 })).toBe(0);
  });
});
