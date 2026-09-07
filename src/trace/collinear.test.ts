/**
 * The lossless pass: dropping points that lie exactly on the line between their neighbours.
 *
 * The whole value of this one is that it **cannot change a shape**, so the tests are about what it
 * refuses to touch as much as what it removes. The case that matters most is the staircase: a thinned
 * centreline of anything not exactly axis-aligned or exactly diagonal is a run of single-pixel steps,
 * every one of which is a real corner. A pass that flattened those would be simplification wearing a
 * lossless label.
 */

import { describe, expect, it } from "vitest";

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, freezeGraph } from "./frozenGraph";
import { dropCollinear } from "./simplify";
import type { FittedEdge } from "./faces";
import type { WallGraph } from "./wallGraph";

const at = (x: number, y: number): Vector2 => ({ x, y });

describe("dropCollinear", () => {
  it("collapses a straight axis-aligned run to its two ends", () => {
    const run = [at(0, 0), at(1, 0), at(2, 0), at(3, 0), at(4, 0)];
    expect(dropCollinear(run)).toEqual([at(0, 0), at(4, 0)]);
  });

  it("collapses an exact diagonal, which is just as straight", () => {
    const run = [at(0, 0), at(1, 1), at(2, 2), at(3, 3)];
    expect(dropCollinear(run)).toEqual([at(0, 0), at(3, 3)]);
  });

  /*
    The case this must NOT touch, and the reason the saving is a fact about a map rather than a
    constant. A wall at a shallow angle thins to alternating (1,0) and (1,1) steps; every interior
    point of that is off the line between its neighbours, so every one is a corner.
  */
  it("keeps every step of a staircase", () => {
    const stair = [at(0, 0), at(1, 0), at(2, 1), at(3, 1), at(4, 2)];
    expect(dropCollinear(stair)).toEqual(stair);
  });

  it("keeps a corner and drops the straight either side of it", () => {
    const bent = [at(0, 0), at(1, 0), at(2, 0), at(2, 1), at(2, 2)];
    expect(dropCollinear(bent)).toEqual([at(0, 0), at(2, 0), at(2, 2)]);
  });

  /*
    Greedy against the last point **kept**, not the last seen.

    Testing each candidate against its raw predecessor would collapse a run of four to three: the
    third point is not collinear with the second and fourth once the second is notionally gone, but
    it is collinear with the *first* and fourth, which is the comparison that matters.
  */
  it("collapses a long run all the way rather than one point at a time", () => {
    const run = Array.from({ length: 20 }, (_, i) => at(i, 5));
    expect(dropCollinear(run)).toHaveLength(2);
  });

  it("always keeps both ends, even when everything between them is straight", () => {
    const run = [at(3, 3), at(4, 3), at(5, 3)];
    const out = dropCollinear(run);
    expect(out[0]).toEqual(at(3, 3));
    expect(out[out.length - 1]).toEqual(at(5, 3));
  });

  it("drops a repeated point, which has no direction to contribute", () => {
    const run = [at(0, 0), at(1, 1), at(1, 1), at(2, 3)];
    expect(dropCollinear(run)).toEqual([at(0, 0), at(1, 1), at(2, 3)]);
  });

  it("leaves anything of two points or fewer exactly as it is", () => {
    expect(dropCollinear([])).toEqual([]);
    expect(dropCollinear([at(1, 1)])).toEqual([at(1, 1)]);
    expect(dropCollinear([at(1, 1), at(2, 2)])).toEqual([at(1, 1), at(2, 2)]);
  });

  it("copies rather than aliasing its input", () => {
    const run = [at(0, 0), at(1, 1)];
    expect(dropCollinear(run)).not.toBe(run);
  });
});

describe("the freeze applies it", () => {
  /**
   * One edge running straight across a 100x100 raster in ten steps.
   *
   * Ten fitted points, eight of them interior and every one on the same line — so the document
   * should hold a single segment between the edge's two nodes, and say it dropped eight points.
   */
  function straightRun(): { graph: WallGraph; fitted: FittedEdge[] } {
    const points = Array.from({ length: 10 }, (_, i) => at(10 + i * 5, 50));
    const graph = {
      width: 100,
      height: 100,
      nodes: [at(10, 50), at(55, 50)],
      edges: [{ a: 0, b: 1, points }],
    } as unknown as WallGraph;
    return { graph, fitted: [{ points }] };
  }

  it("stores one segment for a straight run and reports what it dropped", () => {
    const { graph, fitted } = straightRun();
    const frozen = freezeGraph(graph, fitted);

    expect(frozen.collinear).toBe(8);
    expect(frozen.graph.edges).toHaveLength(1);
    // The two ends are the derived graph's own nodes, reused by id — the point of freezing this way.
    expect(frozen.graph.nodes).toEqual([documentPoint(0.1, 0.5), documentPoint(0.55, 0.5)]);
  });

  /*
    A staircase through the freeze keeps every step, which is the same refusal one level up.

    Worth its own case rather than trusting the unit test above: the freeze divides by the raster
    before storing, and division is where an exact test could stop being exact. It does not here,
    because the pass runs on the raster coordinates *before* the division.
  */
  it("keeps every step of a staircase through the freeze", () => {
    const points = [at(10, 10), at(11, 10), at(12, 11), at(13, 11), at(14, 12)];
    const graph = {
      width: 100,
      height: 100,
      nodes: [at(10, 10), at(14, 12)],
      edges: [{ a: 0, b: 1, points }],
    } as unknown as WallGraph;

    const frozen = freezeGraph(graph, [{ points }]);
    expect(frozen.collinear).toBe(0);
    expect(frozen.graph.edges).toHaveLength(4);
  });
});
