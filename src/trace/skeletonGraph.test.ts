import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { resolveFaces, walkCycles } from "./faces";
import { buildSkeletonGraph, eraseSpecks, type SkeletonGraph } from "./skeletonGraph";

/**
 * Fixtures are skeletons — already one pixel wide — and never draw their own border, because
 * `buildSkeletonGraph` paints the frame itself. Keep linework **two** pixels clear of the edge: one
 * pixel in is 8-adjacent to the frame and fuses with it.
 */
function graphOf(rows: readonly string[]): SkeletonGraph {
  return buildSkeletonGraph(maskFromRows(rows));
}

/** Every skeleton pixel that reached the graph. */
function claimed(graph: SkeletonGraph): Set<string> {
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
 * **The spacing was deliberate for reasons that no longer exist.** Both were about welding: a short
 * run's own two ends welded to each other and became a closed nothing, and a run near the edge
 * welded to the border frame. The weld radius was deleted on 2026-08-30 — nothing here moves a
 * point any more — so neither constraint binds for the reason it was written down.
 *
 * The margin is kept anyway, and the honest statement of why is now weaker still: a border frame
 * used to be painted round the raster, so a run *adjacent* to the edge would have met it as an
 * ordinary junction and this fixture would have been about two things at once. Nothing paints a
 * frame any more, so even that constraint is gone and the run length is arbitrary. Left as it is
 * because a fixture that reads clearly costs nothing and re-deriving its minimum would be work in
 * service of nothing.
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

describe("erasing specks", () => {
  /*
    ## The border frame is GONE — 2026-09-08 (user)

    This block used to assert that the raster's outer row and column were painted into the skeleton,
    and that this was *why the map's exterior was a face at all*: the graph's outer face is unbounded
    and has no polygon, so without a frame there is no exterior region to emit.

    Not emitting one is now the point. Everything is fogged by default and an emitted shape is what
    Owlbear will let a GM **reveal**, so an exterior with no shape stays fogged and unrevealable —
    which is what "not an explorable space" means on most maps. It also removes an identification
    problem with no sound answer: a line across a page separating two buildings carves a *framed*
    outside into two faces, and there is no rule that picks "the exterior" correctly. Unframed, there
    is exactly one unbounded face by topology, on every map.

    What survives from that function is the speck erase, which is a different job wearing the same
    name for a while.
  */
  it("erases a pixel with no neighbours rather than leaving it in the graph", () => {
    // A component with no edges contributes no cycle, so it would end up neither inside a face nor
    // on any boundary — and would be reported as an orphan, which is linework the walk lost. It is
    // not: it is a speck. The island filter normally takes these upstream; this is the backstop.
    const speck = eraseSpecks(maskFromRows(["...", ".#.", "..."]));
    expect([...speck.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("leaves a pixel that has a neighbour alone", () => {
    const pair = eraseSpecks(maskFromRows(["...", ".##", "..."]));
    expect([...pair.data]).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0]);
  });

  it("adds nothing at the raster's edge", () => {
    // The frame's absence, stated as the assertion that would fail if it came back.
    const empty = eraseSpecks(maskFromRows(["...", "...", "..."]));
    expect([...empty.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("gives an empty raster no faces at all", () => {
    // With the frame this was one ring around one interior. Without it there is no linework, so
    // there is nothing to enclose anything.
    const graph = graphOf([".....", ".....", ".....", ".....", "....."]);
    expect(walkCycles(resolveFaces(graph).graph).cycles).toHaveLength(0);
  });
});

describe("claiming every pixel", () => {
  it("leaves no skeleton pixel out of the graph, on any fixture", () => {
    for (const rows of [JUNCTION_CLUSTER, BROKEN_RUN, STAIRCASE, FOUR_NEIGHBOUR_PATH]) {
      const graph = graphOf(rows);
      const seen = claimed(graph);
      const { width, height, data } = graph.skeleton;
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
    expect(graph.skeleton.data[3 * 9 + 4]).toBe(0);
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
    /*
      **Cleaned first**, and this test was passing for the wrong reason until 2026-09-08.

      The corner of an L is a junction cluster: with 8-connectivity the pixel before the turn touches
      both the corner and the pixel after it, so three mutually adjacent pixels bound a half-pixel
      triangle and the run comes out of `buildSkeletonGraph` as *four* edges, two of them parallel. Only
      after sliver removal is it the single chain this is about.

      What made it pass before was the border frame: `find` returned a frame edge, which is nine
      points long, so the assertion never looked at the bent run at all. Removing the frame exposed
      it — an accidental demonstration of why the sweep matters more than a fixture.
    */
    const graph = resolveFaces(graphOf(BENT_RUN)).graph;
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.points.length).toBeGreaterThan(4);
  });
});
