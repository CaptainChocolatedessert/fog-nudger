/**
 * What a click near a proposed mend means, with no DOM and no scene.
 *
 * Three mutations on 2026-09-16 — the floor removed, the first ring rather than the nearest, and a
 * click measured in graph units instead of screen pixels — three caught.
 */

import { describe, expect, it } from "vitest";

import type { Mend } from "../trace/mends";
import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";
import { describeMends, mendAt, mendCentre, mendRingRadius } from "./mendGesture";

/** A mend between two points in graph units. */
function mend(ax: number, ay: number, bx: number, by: number): Mend {
  return {
    from: 0,
    to: { kind: "vertex", node: 1 },
    start: { x: ax, y: ay },
    end: { x: bx, y: by },
    length: Math.hypot(bx - ax, by - ay),
  };
}

/** Graph units per screen pixel with the map's longer side 1000 pixels across. */
const PER_PIXEL = 1 / 1000;

describe("a mend's ring", () => {
  it("is centred on the middle of the mend", () => {
    expect(mendCentre(mend(0.2, 0.4, 0.4, 0.5))).toEqual({ x: 0.30000000000000004, y: 0.45 });
  });

  it("never falls below the ink tool's floor, which is what makes a short mend clickable", () => {
    // 0.002 across is two screen pixels at this zoom.
    expect(mendRingRadius(mend(0.5, 0.5, 0.502, 0.5), PER_PIXEL)).toBe(RING_MIN_RADIUS);
  });

  it("grows to clear a long mend by the ink tool's padding", () => {
    // 0.1 across is 100 screen pixels, so 50 of radius and the padding.
    expect(mendRingRadius(mend(0.5, 0.5, 0.6, 0.5), PER_PIXEL)).toBeCloseTo(50 + RING_PADDING, 9);
  });
});

describe("which mend a click lands in", () => {
  const mends = [mend(0.2, 0.2, 0.202, 0.2), mend(0.6, 0.6, 0.6, 0.602)];

  it("finds the mend under the pointer", () => {
    expect(mendAt(mends, 0.6, 0.601, PER_PIXEL)).toBe(1);
  });

  it("reaches the ring's edge the same distance in every direction", () => {
    // The floor is 11 screen pixels, which is 0.011 at this zoom — across, and up and down alike.
    const centre = mendCentre(mends[0]!);
    expect(mendAt(mends, centre.x + 0.0105, centre.y, PER_PIXEL)).toBe(0);
    expect(mendAt(mends, centre.x, centre.y + 0.0105, PER_PIXEL)).toBe(0);
    expect(mendAt(mends, centre.x, centre.y + 0.0115, PER_PIXEL)).toBeNull();
  });

  it("picks the nearest centre when rings overlap, not the first in the list", () => {
    const close = [mend(0.5, 0.5, 0.502, 0.5), mend(0.51, 0.5, 0.512, 0.5)];
    expect(mendAt(close, 0.511, 0.5, PER_PIXEL)).toBe(1);
    expect(mendAt(close, 0.501, 0.5, PER_PIXEL)).toBe(0);
  });

  it("finds nothing outside every ring, and nothing with no scale to measure in", () => {
    expect(mendAt(mends, 0.9, 0.9, PER_PIXEL)).toBeNull();
    expect(mendAt(mends, 0.2, 0.2, 0)).toBeNull();
  });
});

describe("what the state line says", () => {
  it("says there are none, and names the control that would change it", () => {
    expect(describeMends(0)).toContain("no gaps");
    expect(describeMends(0)).toContain("Largest gap to look for");
  });

  it("counts them, in the singular for one", () => {
    expect(describeMends(1)).toBe("1 gap in the walls to mend");
    expect(describeMends(3)).toBe("3 gaps in the walls to mend");
  });
});
