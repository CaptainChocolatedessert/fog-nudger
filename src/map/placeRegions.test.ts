import { describe, expect, it } from "vitest";

import type { Ring } from "../geometry/ring";
import { createPlacement } from "./placement";
import { fractionWithin, placeRegion, placeRegions, placedBounds } from "./placeRegions";

/**
 * A map whose world box is **not** a uniform scaling of its raster, and whose scales differ between
 * the axes by a round factor so a swap is unmissable.
 *
 * Chosen against the sibling's "too symmetric to fail" lesson, which DESIGN.md §9 raises again for
 * exactly this stage. A square raster on a square world box cannot tell a correct transform from a
 * transposed one, and the test map this project measures on has a 0.000% aspect mismatch — so if
 * the fixtures matched the real map, the whole per-axis machinery would sit unexercised.
 *
 * 200 raster px across a 2000-unit box is 10 units per pixel; 100 px down a 500-unit box is 5.
 */
const placement = createPlacement(
  { min: { x: 1000, y: -400 }, max: { x: 3000, y: 100 } },
  200,
  100,
);

/** An L, asymmetric in both axes and about both diagonals. */
const lShape: Ring = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 20 },
  { x: 20, y: 20 },
  { x: 20, y: 80 },
  { x: 0, y: 80 },
];

describe("placeRegion", () => {
  it("scales each axis by its own factor", () => {
    // A single width-derived scale would put every y at twice its true offset here. That was a real
    // bug in the sibling and it was invisible in pixel space.
    const placed = placeRegion({ id: 1, rings: [lShape] }, placement);

    expect(placed.bounds).toEqual({
      min: { x: 1000, y: -400 },
      max: { x: 1400, y: 0 },
    });
  });

  it("anchors the item at the centre of its own box", () => {
    const placed = placeRegion({ id: 1, rings: [lShape] }, placement);
    expect(placed.position).toEqual({ x: 1200, y: -200 });
  });

  it("returns rings relative to the position, so the two reconstruct the world point", () => {
    // The contract with the path builder: commands are relative to `position` (measured in a room,
    // DESIGN.md §4). A module that returned absolute commands would place every region one map-width
    // away from where it belongs, and nothing here would look wrong on its own.
    const placed = placeRegion({ id: 1, rings: [lShape] }, placement);
    const first = placed.rings[0]![0]!;

    expect({
      x: first.x + placed.position.x,
      y: first.y + placed.position.y,
    }).toEqual({ x: 1000, y: -400 });
  });

  it("keeps an asymmetric shape the way round it was", () => {
    // The check a symmetric fixture cannot make. The L is 40 raster px wide and 80 tall; at 10 units
    // per pixel across and 5 down that becomes 400 wide and 400 tall — equal, which is precisely the
    // coincidence a transposed transform would hide behind. So the shape is checked corner by
    // corner instead: the long arm must still run *down*, and the foot must still run *right*.
    const placed = placeRegion({ id: 1, rings: [lShape] }, placement);
    const ring = placed.rings[0]!;

    // The tall arm: raster (20,20) -> (20,80) is a descent of 60px, so 300 world units down.
    expect(ring[4]!.y - ring[3]!.y).toBe(300);
    expect(ring[4]!.x - ring[3]!.x).toBe(0);
    // The foot: raster (0,0) -> (40,0) is 40px across, so 400 world units right.
    expect(ring[1]!.x - ring[0]!.x).toBe(400);
    expect(ring[1]!.y - ring[0]!.y).toBe(0);
  });

  it("places a hole with the same transform as the ring it sits in", () => {
    // Holes are just further rings and must not acquire an anchor of their own — a hole placed
    // against its own centre would land somewhere else entirely and stop cutting anything.
    const outer: Ring = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hole: Ring = [
      { x: 40, y: 40 },
      { x: 60, y: 40 },
      { x: 60, y: 60 },
      { x: 40, y: 60 },
    ];
    const placed = placeRegion({ id: 1, rings: [outer, hole] }, placement);

    expect(placed.rings[1]![0]).toEqual({ x: -100, y: -50 });
    expect(placed.bounds.min).toEqual({ x: 1000, y: -400 });
  });

  it("survives a region with no rings at all", () => {
    const placed = placeRegion({ id: 7, rings: [] }, placement);
    expect(placed.rings).toEqual([]);
    expect(placed.position).toEqual({ x: 0, y: 0 });
  });
});

describe("placeRegions and placedBounds", () => {
  it("fills the map's world box when a region runs to every raster edge", () => {
    // The one scale error that *is* catchable without a room. A flip or a transpose leaves this
    // check perfectly happy — the geometry still fills the same box — which is why DESIGN.md sends
    // step 7 to a room with an asymmetric shape rather than trusting numbers like these.
    const wholeRaster: Ring = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    const placed = placeRegions(
      [
        { id: 1, rings: [wholeRaster] },
        { id: 2, rings: [lShape] },
      ],
      placement,
    );

    expect(placedBounds(placed)).toEqual({
      min: { x: 1000, y: -400 },
      max: { x: 3000, y: 100 },
    });
  });

  it("reports no bounds rather than an empty box when nothing was placed", () => {
    expect(placedBounds([])).toBeNull();
    expect(placedBounds([{ id: 1, rings: [], position: { x: 0, y: 0 }, bounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } } }])).toBeNull();
  });
});

describe("fractionWithin", () => {
  it("reports a position as a share of the map, which is what a GM can check", () => {
    const bounds = { min: { x: 1000, y: -400 }, max: { x: 3000, y: 100 } };
    expect(fractionWithin(bounds, { x: 1500, y: -400 })).toEqual({ x: 0.25, y: 0 });
    expect(fractionWithin(bounds, { x: 3000, y: 100 })).toEqual({ x: 1, y: 1 });
  });

  it("does not divide by a degenerate box", () => {
    const bounds = { min: { x: 5, y: 5 }, max: { x: 5, y: 5 } };
    expect(fractionWithin(bounds, { x: 5, y: 5 })).toEqual({ x: 0, y: 0 });
  });
});
