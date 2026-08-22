import { describe, expect, it } from "vitest";

import { doubleSignedArea } from "../geometry/ring";
import { squareRing, squareWithHoleRings } from "./fogProbeGeometry";

describe("squareRing", () => {
  it("is centred on the origin and has the requested side length", () => {
    expect(squareRing(10)).toEqual([
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 },
    ]);
  });

  it("does not repeat the first point as the last", () => {
    // Closing is the CLOSE command's job. A repeated point would put a zero-length edge in the
    // path, which strokes into a dot at one corner of every room.
    const ring = squareRing(10);
    expect(ring[ring.length - 1]).not.toEqual(ring[0]);
  });
});

describe("squareWithHoleRings", () => {
  /**
   * The two rings wind the same way on purpose. Under even-odd that still cuts a hole, so the probe
   * tests the fill rule rather than accidentally relying on winding — a fixture that wound them
   * oppositely would pass whether or not the fill rule was honoured, and could not tell the two
   * outcomes apart.
   */
  it("winds the hole the same way as the outer ring", () => {
    const [outer, hole] = squareWithHoleRings(10, 4);
    expect(doubleSignedArea(outer!)).toBeGreaterThan(0);
    expect(doubleSignedArea(hole!)).toBeGreaterThan(0);
  });

  it("puts the hole inside the outer ring", () => {
    const [outer, hole] = squareWithHoleRings(10, 4);
    expect(Math.abs(doubleSignedArea(hole!))).toBeLessThan(Math.abs(doubleSignedArea(outer!)));
  });
});
