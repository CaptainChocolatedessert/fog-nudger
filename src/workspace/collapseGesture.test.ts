/**
 * What a click near a small region means, with no DOM and no scene.
 *
 * Four mutations on 2026-09-21 — the floor removed, the first ring rather than the nearest, a click
 * measured in graph units instead of screen pixels, and the ring centred on an outline point rather
 * than the bounds — four caught.
 */

import { describe, expect, it } from "vitest";

import type { Collapse } from "../trace/collapse";
import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";
import { collapseAt, collapseCentre, collapseRingRadius, describeCollapses } from "./collapseGesture";

/** A square region of side `size` with its corner at `(x, y)`, in graph units. */
function square(x: number, y: number, size: number): Collapse {
  return {
    face: 0,
    area: size * size,
    outline: [
      { x, y },
      { x: x + size, y },
      { x: x + size, y: y + size },
      { x, y: y + size },
    ],
    edges: [],
    connections: [],
    centre: null,
    vertices: [],
  };
}

/** Graph units per screen pixel with the map's longer side 1000 pixels across. */
const PER_PIXEL = 1 / 1000;

describe("a small region's ring", () => {
  it("is centred on the middle of the region's bounds", () => {
    expect(collapseCentre(square(0.25, 0.5, 0.125))).toEqual({ x: 0.3125, y: 0.5625 });
  });

  it("never falls below the floor the other ringed tools use", () => {
    // 0.002 across is two screen pixels at this zoom.
    expect(collapseRingRadius(square(0.5, 0.5, 0.002), PER_PIXEL)).toBe(RING_MIN_RADIUS);
  });

  it("grows to clear a larger region by the same padding", () => {
    // A 0.06 square is about 85 pixels corner to corner, so about 42 of radius and the padding.
    const across = Math.hypot(0.06, 0.06) * 1000;
    expect(collapseRingRadius(square(0.5, 0.5, 0.06), PER_PIXEL)).toBeCloseTo(across / 2 + RING_PADDING, 6);
  });
});

describe("which region a click lands in", () => {
  const regions = [square(0.2, 0.2, 0.002), square(0.6, 0.6, 0.002)];

  it("finds the region under the pointer, and nothing between rings", () => {
    expect(collapseAt(regions, 0.601, 0.601, PER_PIXEL)).toBe(1);
    expect(collapseAt(regions, 0.4, 0.4, PER_PIXEL)).toBeNull();
  });

  it("reaches the ring's edge in screen pixels, not graph units", () => {
    const centre = collapseCentre(regions[0]!);
    expect(collapseAt(regions, centre.x + 0.0105, centre.y, PER_PIXEL)).toBe(0);
    expect(collapseAt(regions, centre.x + 0.0115, centre.y, PER_PIXEL)).toBeNull();
    // Zoomed out ten times, the same graph distance is a tenth of the pixels and lands inside.
    expect(collapseAt(regions, centre.x + 0.0115, centre.y, PER_PIXEL * 10)).toBe(0);
  });

  it("picks the nearest centre when rings overlap, not the first in the list", () => {
    const close = [square(0.5, 0.5, 0.002), square(0.51, 0.5, 0.002)];
    expect(collapseAt(close, 0.5095, 0.501, PER_PIXEL)).toBe(1);
  });

  it("says how many there are, and what to do when there are none", () => {
    expect(describeCollapses(1)).toBe("1 small region to collapse");
    expect(describeCollapses(3)).toBe("3 small regions to collapse");
    expect(describeCollapses(0)).toMatch(/drag the size up/);
  });
});
