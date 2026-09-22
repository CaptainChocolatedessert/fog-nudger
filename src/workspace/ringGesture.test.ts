/**
 * What a click near a ringed proposal means, with no DOM and no scene.
 *
 * Four mutations on 2026-09-21, when this was *Collapse small regions*' alone — the floor removed, the
 * first ring rather than the nearest, a click measured in graph units instead of screen pixels, and the
 * ring centred on a point rather than the bounds — four caught. Re-run when it became shared on
 * 2026-09-22, four caught.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";
import { describeCollapses, describePrunes, ringAt, ringCentre, ringRadius } from "./ringGesture";

/** The corners of a square of side `size` with its corner at `(x, y)`, in graph units. */
function square(x: number, y: number, size: number): Vector2[] {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];
}

/** Graph units per screen pixel with the map's longer side 1000 pixels across. */
const PER_PIXEL = 1 / 1000;

describe("a ring", () => {
  it("is centred on the middle of the points' bounds", () => {
    expect(ringCentre(square(0.25, 0.5, 0.125))).toEqual({ x: 0.3125, y: 0.5625 });
  });

  it("never falls below the floor the other ringed tools use", () => {
    // 0.002 across is two screen pixels at this zoom.
    expect(ringRadius(square(0.5, 0.5, 0.002), PER_PIXEL)).toBe(RING_MIN_RADIUS);
  });

  it("grows to clear larger points by the same padding", () => {
    const across = Math.hypot(0.06, 0.06) * 1000;
    expect(ringRadius(square(0.5, 0.5, 0.06), PER_PIXEL)).toBeCloseTo(across / 2 + RING_PADDING, 6);
  });
});

describe("which ring a click lands in", () => {
  const targets = [square(0.2, 0.2, 0.002), square(0.6, 0.6, 0.002)];

  it("finds the ring under the pointer, and nothing between rings", () => {
    expect(ringAt(targets, 0.601, 0.601, PER_PIXEL)).toBe(1);
    expect(ringAt(targets, 0.4, 0.4, PER_PIXEL)).toBeNull();
  });

  it("reaches the ring's edge in screen pixels, not graph units", () => {
    const centre = ringCentre(targets[0]!);
    expect(ringAt(targets, centre.x + 0.0105, centre.y, PER_PIXEL)).toBe(0);
    expect(ringAt(targets, centre.x + 0.0115, centre.y, PER_PIXEL)).toBeNull();
    // Zoomed out ten times, the same graph distance is a tenth of the pixels and lands inside.
    expect(ringAt(targets, centre.x + 0.0115, centre.y, PER_PIXEL * 10)).toBe(0);
  });

  it("picks the nearest centre when rings overlap, not the first in the list", () => {
    const close = [square(0.5, 0.5, 0.002), square(0.51, 0.5, 0.002)];
    expect(ringAt(close, 0.5095, 0.501, PER_PIXEL)).toBe(1);
  });
});

describe("what the state line says", () => {
  it("counts small regions, and says what to do when there are none", () => {
    expect(describeCollapses(1)).toBe("1 small region to collapse");
    expect(describeCollapses(3)).toBe("3 small regions to collapse");
    expect(describeCollapses(0)).toMatch(/drag the size up/);
  });

  it("counts dead ends the same way", () => {
    expect(describePrunes(1)).toBe("1 dead end to prune");
    expect(describePrunes(2)).toBe("2 dead ends to prune");
    expect(describePrunes(0)).toMatch(/drag the length up/);
  });
});
