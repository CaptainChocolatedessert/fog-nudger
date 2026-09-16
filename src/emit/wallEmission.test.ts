import { describe, expect, it } from "vitest";

import { documentPoint, type WallGraph } from "../trace/wallGraph";
import { wallEmission } from "./wallEmission";

function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

function loop(ids: readonly number[]): [number, number][] {
  return ids.map((id, index) => [id, ids[(index + 1) % ids.length]!] as [number, number]);
}

/**
 * The map's extent in graph units: an image twice as wide as it is tall, so the longer side is 1 and
 * the other is 0.5. It matches the world box below, which is how a map is placed unless a GM has
 * stretched it.
 *
 * Three mutations on 2026-09-16 — placed at one by one, one scale for both axes, and the area not
 * divided by the extent — three caught.
 */
const EXTENT = { x: 1, y: 0.5 };

/** One room filling the middle half of the map on each axis — in graph units, so y is halved. */
const ROOM = graphOf(
  [
    [0.25, 0.125],
    [0.75, 0.125],
    [0.75, 0.375],
    [0.25, 0.375],
  ],
  loop([0, 1, 2, 3]),
);

/**
 * A map that is **not square and not at the origin**, which is what makes the placement testable.
 *
 * 800 wide by 400 tall starting at (1000, -200). A single uniform scale, or an origin quietly
 * assumed to be zero, gives the right answer on a square map at the origin and the wrong one here.
 */
const BOUNDS = { min: { x: 1000, y: -200 }, max: { x: 1800, y: 200 } };
/** World units per grid square. */
const DPI = 100;

describe("placing the wall graph", () => {
  it("puts a point in graph units where the map actually is, per axis", () => {
    const { regions } = wallEmission(ROOM, BOUNDS, DPI, EXTENT);

    expect(regions).toHaveLength(1);
    const placed = regions[0]!.placed;
    // A quarter to three quarters of 800 wide from x=1000, and of 400 tall from y=-200.
    expect(placed.bounds.min.x).toBeCloseTo(1200, 6);
    expect(placed.bounds.max.x).toBeCloseTo(1600, 6);
    expect(placed.bounds.min.y).toBeCloseTo(-100, 6);
    expect(placed.bounds.max.y).toBeCloseTo(100, 6);
  });

  it("anchors the item at the middle of what it covers, with its rings relative to that", () => {
    const { regions } = wallEmission(ROOM, BOUNDS, DPI, EXTENT);
    const placed = regions[0]!.placed;

    expect(placed.position.x).toBeCloseTo(1400, 6);
    expect(placed.position.y).toBeCloseTo(0, 6);
    for (const point of placed.rings[0]!) {
      expect(Math.abs(point.x)).toBeCloseTo(200, 6);
      expect(Math.abs(point.y)).toBeCloseTo(100, 6);
    }
  });

  it("reports the area in grid squares, which is a world measure and not graph units", () => {
    const { regions } = wallEmission(ROOM, BOUNDS, DPI, EXTENT);

    // 400 by 200 world units is 80,000, and a square is 100 x 100.
    expect(regions[0]!.squares).toBeCloseTo(8, 6);
  });

  it("survives a scene with no grid rather than reporting an infinity", () => {
    const { regions } = wallEmission(ROOM, BOUNDS, 0, EXTENT);

    // Nothing about the geometry depends on the grid; only the label does, and it says zero.
    expect(regions[0]!.squares).toBe(0);
    expect(regions[0]!.placed.bounds.min.x).toBeCloseTo(1200, 6);
  });

  it("places the walls no ring covers, in the same world as the rooms", () => {
    // A room with a stub hanging into it: the stub is a bridge and emits as a line.
    const withStub = graphOf(
      [
        [0.25, 0.125],
        [0.75, 0.125],
        [0.75, 0.375],
        [0.25, 0.375],
        [0.5, 0.25],
      ],
      [...loop([0, 1, 2, 3]), [0, 4]],
    );
    const { walls, regions } = wallEmission(withStub, BOUNDS, DPI, EXTENT);

    expect(regions).toHaveLength(1);
    expect(walls).toHaveLength(1);
    expect(walls[0]!.points[0]!.x).toBeCloseTo(1200, 6);
    expect(walls[0]!.points[0]!.y).toBeCloseTo(-100, 6);
    // The stub's tip is the middle of the map, which is the middle of the world box.
    expect(walls[0]!.points[1]!.x).toBeCloseTo(1400, 6);
    expect(walls[0]!.points[1]!.y).toBeCloseTo(0, 6);
  });

  it("takes a hole out of the area, so a courtyard is not counted as floor", () => {
    const nested = graphOf(
      [
        [0.25, 0.125],
        [0.75, 0.125],
        [0.75, 0.375],
        [0.25, 0.375],
        [0.4, 0.2],
        [0.6, 0.2],
        [0.6, 0.3],
        [0.4, 0.3],
      ],
      [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7])],
    );
    const { regions } = wallEmission(nested, BOUNDS, DPI, EXTENT);

    expect(regions).toHaveLength(2);
    const [outer, inner] = regions;
    // The band is 8 squares less the 1.28 the courtyard takes; the courtyard is its own room.
    expect(outer!.squares).toBeCloseTo(8 - 1.28, 5);
    expect(inner!.squares).toBeCloseTo(1.28, 5);
  });

  it("flags a room too detailed for one item rather than letting it be truncated", () => {
    /*
      A ring of nine thousand vertices, which is past the eight-thousand-command limit an Owlbear
      item accepts.

      Stage one would meet this by simplifying harder and refitting everything. **Stage two must
      not**: the vertices are the GM's, and moving them to fit a transport limit would edit their
      work to make it sendable. So it is flagged, skipped and named — which is also what stage one
      does once its ladder runs out.
    */
    const count = 9000;
    const points: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      points.push([0.5 + 0.4 * Math.cos(angle), 0.25 + 0.2 * Math.sin(angle)]);
    }
    const huge = graphOf(points, loop(points.map((_, i) => i)));

    const { regions } = wallEmission(huge, BOUNDS, DPI, EXTENT);

    expect(regions).toHaveLength(1);
    expect(regions[0]!.overCap).toBe(true);
  });

  it("follows a map stretched out of proportion, because the extent is the image's", () => {
    /*
      A GM can drag a map taller in Owlbear without changing its image. The graph is in the image's
      units, so each axis has to stretch to the box on its own — using the box's aspect, or one scale
      for both axes, would put the rooms somewhere the map no longer is.
    */
    const tall = { min: { x: 1000, y: -200 }, max: { x: 1800, y: 600 } };
    const placed = wallEmission(ROOM, tall, DPI, EXTENT).regions[0]!.placed;

    // Still a quarter to three quarters of each side: 1200 to 1600 across, 0 to 400 down.
    expect(placed.bounds.min.x).toBeCloseTo(1200, 6);
    expect(placed.bounds.max.x).toBeCloseTo(1600, 6);
    expect(placed.bounds.min.y).toBeCloseTo(0, 6);
    expect(placed.bounds.max.y).toBeCloseTo(400, 6);
  });

  it("leaves nothing over the command cap, and says so per region", () => {
    const { regions } = wallEmission(ROOM, BOUNDS, DPI, EXTENT);

    // A four-point room is nowhere near it. The flag exists for a graph edited past the limit, which
    // stage two cannot simplify its way out of because the vertices are the GM's.
    expect(regions[0]!.overCap).toBe(false);
  });
});
