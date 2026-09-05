import { describe, expect, it } from "vitest";

import { documentPoint, type FrozenGraph } from "../trace/frozenGraph";
import { frozenEmission } from "./frozenEmission";

function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): FrozenGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

function loop(ids: readonly number[]): [number, number][] {
  return ids.map((id, index) => [id, ids[(index + 1) % ids.length]!] as [number, number]);
}

/** One square room filling the middle half of the map. */
const ROOM = graphOf(
  [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
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

describe("placing the frozen graph", () => {
  it("puts a fraction of the map where the map actually is, per axis", () => {
    const { regions } = frozenEmission(ROOM, BOUNDS, DPI);

    expect(regions).toHaveLength(1);
    const placed = regions[0]!.placed;
    // A quarter to three quarters of 800 wide from x=1000, and of 400 tall from y=-200.
    expect(placed.bounds.min.x).toBeCloseTo(1200, 6);
    expect(placed.bounds.max.x).toBeCloseTo(1600, 6);
    expect(placed.bounds.min.y).toBeCloseTo(-100, 6);
    expect(placed.bounds.max.y).toBeCloseTo(100, 6);
  });

  it("anchors the item at the middle of what it covers, with its rings relative to that", () => {
    const { regions } = frozenEmission(ROOM, BOUNDS, DPI);
    const placed = regions[0]!.placed;

    expect(placed.position.x).toBeCloseTo(1400, 6);
    expect(placed.position.y).toBeCloseTo(0, 6);
    for (const point of placed.rings[0]!) {
      expect(Math.abs(point.x)).toBeCloseTo(200, 6);
      expect(Math.abs(point.y)).toBeCloseTo(100, 6);
    }
  });

  it("reports the area in grid squares, which is a world measure and not a fraction", () => {
    const { regions } = frozenEmission(ROOM, BOUNDS, DPI);

    // 400 by 200 world units is 80,000, and a square is 100 x 100.
    expect(regions[0]!.squares).toBeCloseTo(8, 6);
  });

  it("survives a scene with no grid rather than reporting an infinity", () => {
    const { regions } = frozenEmission(ROOM, BOUNDS, 0);

    // Nothing about the geometry depends on the grid; only the label does, and it says zero.
    expect(regions[0]!.squares).toBe(0);
    expect(regions[0]!.placed.bounds.min.x).toBeCloseTo(1200, 6);
  });

  it("places the walls no ring covers, in the same world as the rooms", () => {
    // A room with a stub hanging into it: the stub is a bridge and emits as a line.
    const withStub = graphOf(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.5, 0.5],
      ],
      [...loop([0, 1, 2, 3]), [0, 4]],
    );
    const { walls, regions } = frozenEmission(withStub, BOUNDS, DPI);

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
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
      ],
      [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7])],
    );
    const { regions } = frozenEmission(nested, BOUNDS, DPI);

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
      points.push([0.5 + 0.4 * Math.cos(angle), 0.5 + 0.4 * Math.sin(angle)]);
    }
    const huge = graphOf(points, loop(points.map((_, i) => i)));

    const { regions } = frozenEmission(huge, BOUNDS, DPI);

    expect(regions).toHaveLength(1);
    expect(regions[0]!.overCap).toBe(true);
  });

  it("leaves nothing over the command cap, and says so per region", () => {
    const { regions } = frozenEmission(ROOM, BOUNDS, DPI);

    // A four-point room is nowhere near it. The flag exists for a graph edited past the limit, which
    // stage two cannot simplify its way out of because the vertices are the GM's.
    expect(regions[0]!.overCap).toBe(false);
  });
});
