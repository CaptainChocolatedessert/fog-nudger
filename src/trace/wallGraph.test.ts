import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { buildWallGraph, frameSkeleton, type WallGraph } from "./wallGraph";

/**
 * Fixtures are skeletons — already one pixel wide — and never draw their own border, because
 * `buildWallGraph` paints the frame itself. Keep linework **two** pixels clear of the edge: one
 * pixel in is 8-adjacent to the frame and fuses with it.
 */
function graphOf(rows: readonly string[], weldRadius: number): WallGraph {
  return buildWallGraph(maskFromRows(rows), weldRadius);
}

/** A crossroads drawn as two T-junctions one pixel apart — the cluster thinning actually leaves. */
const JUNCTION_CLUSTER = [
  ".............",
  ".............",
  "......#......",
  "......#......",
  "......#......",
  "..#######....",
  ".....#.......",
  ".....#.......",
  ".....#.......",
  ".............",
  ".............",
];

/**
 * One straight run with a one-pixel break in it.
 *
 * Two things about the spacing are deliberate, and both were got wrong first. The runs are **longer
 * than any radius tested**, or a run's own two ends weld to each other, which makes it a closed
 * nothing and drops it. And the whole thing is kept **further from the edge than the radius**, or
 * the run's end welds to the border frame and starts at (0, 0). Both are real behaviours; neither is
 * what these tests are about.
 */
const BROKEN_RUN = [
  "...................",
  "...................",
  "...................",
  "...................",
  "....#####.#####....",
  "...................",
  "...................",
  "...................",
  "...................",
];

/** A diagonal staircase, where a pixel's two forward neighbours are adjacent to each other. */
const STAIRCASE = [
  ".........",
  "..#......",
  "..##.....",
  "...##....",
  "....##...",
  ".....#...",
  ".........",
];

describe("the border frame", () => {
  it("paints the raster edge into the skeleton", () => {
    const framed = frameSkeleton(maskFromRows(["...", "...", "..."]));
    expect([...framed.data]).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  });

  it("is why the map's exterior is a face at all", () => {
    // Without it the outer face is unbounded and has no polygon. With it, an empty raster is one
    // ring and one interior.
    const graph = graphOf([".....", ".....", ".....", ".....", "....."], 0);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.a).toBe(graph.edges[0]!.b);
  });
});

describe("chains", () => {
  it("leaves no skeleton pixel unclaimed on a staircase", () => {
    // The chain walk steps orthogonally first. Taking the diagonal would step straight over the
    // near neighbour and orphan it.
    expect(graphOf(STAIRCASE, 0).stats.orphans).toBe(0);
  });

  it("keeps every step to an 8-neighbour, which the area check depends on", () => {
    for (const rows of [JUNCTION_CLUSTER, BROKEN_RUN, STAIRCASE]) {
      for (const radius of [0, 2, 3]) {
        for (const edge of graphOf(rows, radius).edges) {
          for (let i = 1; i < edge.points.length; i++) {
            const dx = Math.abs(edge.points[i]!.x - edge.points[i - 1]!.x);
            const dy = Math.abs(edge.points[i]!.y - edge.points[i - 1]!.y);
            expect(Math.max(dx, dy), `step ${dx},${dy} in ${rows.length}-row fixture`).toBe(1);
          }
        }
      }
    }
  });
});

describe("welding junction clusters", () => {
  it("leaves the cluster in place when welding is off", () => {
    const graph = graphOf(JUNCTION_CLUSTER, 0);
    // Four arms, the one-pixel connector between the two junctions, and the frame.
    expect(graph.edges).toHaveLength(6);
    expect(graph.stats.dropped).toBe(0);

    const connector = graph.edges.find(
      (edge) => edge.points.length === 2 && edge.a !== edge.b,
    );
    expect(connector).toBeDefined();
  });

  it("collapses it to one node and drops the connector", () => {
    const graph = graphOf(JUNCTION_CLUSTER, 2);
    expect(graph.stats.dropped).toBe(1);
    expect(graph.edges).toHaveLength(5);

    // All four arms still meet, now at a single node.
    const arms = graph.edges.filter((edge) => edge.a !== edge.b);
    expect(arms).toHaveLength(4);
    const shared = new Set(arms.flatMap((edge) => [edge.a, edge.b]));
    expect(shared.size).toBe(5);
  });

  it("does not weld the arm ends along with it", () => {
    // The failure this guards is a radius large enough to swallow a short arm, which would delete
    // a wall outright rather than tidy a junction.
    const graph = graphOf(JUNCTION_CLUSTER, 2);
    for (const edge of graph.edges) {
      if (edge.a === edge.b) continue;
      expect(edge.points.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("joining where exactly two ends meet", () => {
  it("keeps a break open when the radius does not reach across it", () => {
    const graph = graphOf(BROKEN_RUN, 1);
    expect(graph.stats.merged).toBe(0);
    // Two separate runs, plus the frame.
    expect(graph.edges).toHaveLength(3);
  });

  it("welds the break shut and joins the two runs into one edge", () => {
    const graph = graphOf(BROKEN_RUN, 3);
    expect(graph.stats.merged).toBe(1);
    expect(graph.edges).toHaveLength(2);

    const run = graph.edges.find((edge) => edge.a !== edge.b);
    expect(run).toBeDefined();
    expect(run!.points[0]).toEqual({ x: 4, y: 4 });
    expect(run!.points[run!.points.length - 1]).toEqual({ x: 14, y: 4 });
  });

  it("is the cost of the weld radius, stated: it closes a gap it can reach across", () => {
    // Not a bug. It is the same operation that tidies a junction cluster, and it is why the radius
    // needs the Walls step to draw the graph rather than the skeleton — a doorway two pixels wide
    // disappears here with nothing else to show for it.
    const open = graphOf(BROKEN_RUN, 1);
    const shut = graphOf(BROKEN_RUN, 3);
    expect(open.edges.length).toBeGreaterThan(shut.edges.length);
  });
});
