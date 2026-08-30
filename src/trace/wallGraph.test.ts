import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { buildFaces } from "./faces";
import { labelSpace } from "./label";
import { buildWallGraph, frameSkeleton, type WallGraph } from "./wallGraph";

/**
 * Fixtures are skeletons — already one pixel wide — and never draw their own border, because
 * `buildWallGraph` paints the frame itself. Keep linework **two** pixels clear of the edge: one
 * pixel in is 8-adjacent to the frame and fuses with it.
 */
function graphOf(rows: readonly string[]): WallGraph {
  return buildWallGraph(maskFromRows(rows));
}

/** Every skeleton pixel that reached the graph. */
function claimed(graph: WallGraph): Set<string> {
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    for (const point of edge.points) seen.add(`${point.x},${point.y}`);
  }
  return seen;
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

/**
 * A pixel with **four** neighbours falling in two contiguous runs.
 *
 * (4,4) touches (5,3), (5,4) and (5,5) — one run around the ring — and (3,4) on its own. Two runs, so
 * the crossing number calls it an ordinary path pixel; four neighbours, so it is really a junction.
 * The free end at (3,4) is what gets stranded when the walk believes the crossing number.
 */
const FOUR_NEIGHBOUR_PATH = [
  ".........",
  ".........",
  ".........",
  ".....#...",
  "...###...",
  ".....#...",
  ".........",
  ".........",
  ".........",
];

/** A single pixel with nothing adjacent to it. */
const SPECK = [
  ".........",
  ".........",
  ".........",
  "....#....",
  ".........",
  ".........",
  ".........",
];

/** One run with a corner in it, which puts a two-end node in the middle. */
const BENT_RUN = [
  ".........",
  ".........",
  ".........",
  "...###...",
  ".....#...",
  ".....#...",
  ".........",
  ".........",
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
    // Without it the outer face is unbounded and has no polygon at all. With it, an empty raster is
    // one ring around one interior.
    const graph = graphOf([".....", ".....", ".....", ".....", "....."]);
    const faces = buildFaces(graph, labelSpace(graph.framed, { minArea: 0 }));
    expect(faces.faces).toHaveLength(1);
    expect(faces.faces[0]!.interior).toBe(9);
  });

  it("fragments at its own corners, which is the cost of counting neighbours", () => {
    // The pixel beside a corner touches the pixel on the adjoining side diagonally, so it has three
    // neighbours and reads as a junction. The frame therefore arrives as several edges with a
    // half-pixel triangle at each corner, and those triangles are removed downstream with every
    // other sub-pixel sliver. Recorded rather than fixed: the alternative is the crossing number,
    // which strands pixels.
    const graph = graphOf([".....", ".....", ".....", ".....", "....."]);
    expect(graph.edges.length).toBeGreaterThan(1);
  });
});

describe("chains", () => {
  it("leaves no skeleton pixel unclaimed on a staircase", () => {
    // The chain walk steps orthogonally first. Taking the diagonal would step straight over the
    // near neighbour and orphan it.
    expect(graphOf(STAIRCASE).stats.orphans).toBe(0);
  });

  it("keeps every step to an 8-neighbour, which the area check depends on", () => {
    for (const rows of [JUNCTION_CLUSTER, BROKEN_RUN, STAIRCASE, FOUR_NEIGHBOUR_PATH]) {
      for (const edge of graphOf(rows).edges) {
        for (let i = 1; i < edge.points.length; i++) {
          const dx = Math.abs(edge.points[i]!.x - edge.points[i - 1]!.x);
          const dy = Math.abs(edge.points[i]!.y - edge.points[i - 1]!.y);
          expect(Math.max(dx, dy), `step ${dx},${dy} in a ${rows.length}-row fixture`).toBe(1);
        }
      }
    }
  });
});

describe("claiming every pixel", () => {
  it("leaves no skeleton pixel out of the graph, on any fixture", () => {
    for (const rows of [JUNCTION_CLUSTER, BROKEN_RUN, STAIRCASE, FOUR_NEIGHBOUR_PATH]) {
      const graph = graphOf(rows);
      const seen = claimed(graph);
      const { width, height, data } = graph.framed;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[y * width + x] !== 1) continue;
          expect(seen.has(`${x},${y}`), `pixel ${x},${y} reached no edge`).toBe(true);
        }
      }
      expect(graph.stats.orphans).toBe(0);
    }
  });

  it("counts a node as a node by its neighbours, not by contiguous runs", () => {
    /*
      The regression for the defect that made the area check fail on a real map.

      The crossing number counts contiguous *runs* of ink around the ring, so a pixel with four
      neighbours in two runs reads as an ordinary path pixel. The walk then passes straight through
      it, consuming it, and whichever branch it did not take is stranded — here the free end at the
      left, which vanished from the graph entirely. It is skeleton, so the labelling does not count
      it as space either, and the face it sits in comes up one interior point short.

      Spur pruning still counts runs, where that is the right measure. These are different jobs.
    */
    const graph = graphOf(FOUR_NEIGHBOUR_PATH);
    expect(claimed(graph).has("3,4")).toBe(true);
  });

  it("erases an isolated speck rather than leaving it in the graph", () => {
    // A pixel with no neighbours is a component with no edges: it contributes no cycle, so it ends
    // up neither inside a face nor on any boundary and the area identity comes up short by it.
    const graph = graphOf(SPECK);
    expect(graph.framed.data[3 * 9 + 4]).toBe(0);
    expect(graph.stats.orphans).toBe(0);
  });
});

describe("joining where exactly two ends meet", () => {
  it("leaves a break in the linework open", () => {
    // Nothing welds any more, so a break stays a break however narrow it is. Closing one is the gap
    // repair's job, where a GM can see it happen.
    const runs = graphOf(BROKEN_RUN).edges.filter((edge) =>
      edge.points.every((point) => point.y === 4),
    );
    expect(runs).toHaveLength(2);
  });

  it("joins two chains at a node where exactly two ends meet", () => {
    // A node with two ends is not a junction, so the chains through it are one edge. This is the
    // one part of the sibling's welding that survives; joining *through a junction* is forbidden,
    // because it would destroy the incidence the faces are read from.
    const graph = graphOf(BENT_RUN);
    const run = graph.edges.find((edge) => edge.a !== edge.b);
    expect(run).toBeDefined();
    expect(run!.points.length).toBeGreaterThan(4);
  });
});
