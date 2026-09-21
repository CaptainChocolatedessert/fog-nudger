/**
 * Spur pruning on the graph, where a stub and an artefact are told apart by length alone.
 *
 * Two levels, and they are tested separately on purpose. `spursToPrune` is the *decision* — runs in,
 * indices out, no geometry — and it is where the cascade and the closed-loop guard live.
 * `pruneWallGraph` is the operation that supplies it with runs and takes the edges away, and what
 * it adds is the run decomposition, the length measurement and the compaction.
 *
 * The raster version these replace had a file of text-grid skeletons. It is gone with the code: the
 * pixel walk it tested does not exist any more, and a graph run is deleted whole.
 */

import { describe, expect, it } from "vitest";

import {
  documentPoint,
  longestRun,
  nodeDegrees,
  pruneWallGraph,
  spurEdgesToPrune,
  wallRunEdges,
  wallRuns,
  type WallGraph,
} from "./wallGraph";
import { spursToPrune, type PrunableRun } from "./spurs";

/** A graph from a list of points and the pairs joining them. Coordinates are map fractions. */
function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

describe("spursToPrune", () => {
  it("removes nothing at a limit of zero, which is the off position", () => {
    const runs: PrunableRun[] = [{ a: 0, b: 1, length: 0.001 }];
    expect(spursToPrune(runs, 0).removed.size).toBe(0);
    expect(spursToPrune(runs, 0).rounds).toBe(0);
  });

  it("takes a short run with a free end and leaves a long one", () => {
    const runs: PrunableRun[] = [
      // A wall in two halves meeting at node 1, with a short branch hanging off the join.
      { a: 0, b: 1, length: 10 },
      { a: 1, b: 2, length: 10 },
      { a: 1, b: 3, length: 2 },
    ];
    const result = spursToPrune(runs, 4);
    expect([...result.removed]).toEqual([2]);
    expect(result.length).toBe(2);
  });

  /*
    The cascade, which is the whole reason this runs in rounds.

    A chain of three short runs hanging off a wall is one spur three deep: only the outermost has a
    free end to begin with, and each removal frees the next. A single pass would take one of them.
  */
  it("frees the next run behind the one it removed, round by round", () => {
    const runs: PrunableRun[] = [
      { a: 0, b: 1, length: 100 },
      { a: 1, b: 2, length: 1 },
      { a: 2, b: 3, length: 1 },
      { a: 3, b: 4, length: 1 },
    ];
    const result = spursToPrune(runs, 2);
    expect([...result.removed].sort()).toEqual([1, 2, 3]);
    expect(result.rounds).toBe(3);
  });

  /*
    A round is decided before any of it is applied, or how much one round ate would depend on the
    order the runs happened to arrive in. Two spurs off one junction show it: both go in round one.
  */
  it("judges every run in a round against the same degrees", () => {
    const runs: PrunableRun[] = [
      { a: 0, b: 1, length: 100 },
      { a: 1, b: 2, length: 1 },
      { a: 1, b: 3, length: 1 },
    ];
    const result = spursToPrune(runs, 2);
    expect([...result.removed].sort()).toEqual([1, 2]);
    expect(result.rounds).toBe(1);
  });

  it("never takes a closed loop, however short", () => {
    // A loop contributes two to its own node's degree, so it can never present a free end — which
    // is the guard that stops a limit swallowing a room.
    const runs: PrunableRun[] = [{ a: 0, b: 0, length: 0.001 }];
    expect(spursToPrune(runs, 1).removed.size).toBe(0);
  });

  /*
    **A run that becomes free later is judged against the same limit, and this is what a room saw.**

    The cascade frees new ends round by round, but the limit never moves — so a long wall whose end
    was a junction, and which only becomes a dead end once the short spurs around it go, is kept
    because it is long. That is correct on its own terms: everything past the threshold is meant to be
    treated as deliberate.

    What makes it surprising is the *track*. Its top end is the longest spur measured on the graph as
    it was when the step opened, so a run that had no free end then was never a candidate and never
    counted — and at the far right, where a GM expects every dead end to go, those are exactly the
    walls left standing. Reported from a room on 2026-09-07 as "very long walls that do not enclose a
    space".
  */
  it("keeps a run that outgrew the limit before its end came free", () => {
    const runs: PrunableRun[] = [
      // A long wall between two junctions, with a short spur off each end.
      { a: 0, b: 1, length: 50 },
      { a: 0, b: 2, length: 1 },
      { a: 1, b: 3, length: 1 },
    ];
    const result = spursToPrune(runs, 5);
    // Both spurs go, and the wall between them is now free at both ends and still kept.
    expect([...result.removed].sort()).toEqual([1, 2]);
    expect(result.rounds).toBe(1);

    // Only a limit past its own length reaches it, which the track's top end does not offer.
    expect([...spursToPrune(runs, 50).removed].sort()).toEqual([0, 1, 2]);
  });

  it("takes a run free at both ends, which is a wall touching nothing", () => {
    const runs: PrunableRun[] = [{ a: 0, b: 1, length: 1 }];
    expect([...spursToPrune(runs, 2).removed]).toEqual([0]);
  });
});

describe("pruneWallGraph", () => {
  /**
   * A horizontal wall of four segments with a two-segment spur up and a longer stub down.
   *
   * Both are dead-end branches off the same junction and only their length separates them, which is
   * the whole difficulty of this control.
   */
  const wallWithBoth = graphOf(
    [
      [0.1, 0.5],
      [0.3, 0.5],
      [0.5, 0.5],
      [0.7, 0.5],
      [0.9, 0.5],
      [0.5, 0.45],
      [0.5, 0.4],
      [0.5, 0.7],
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [2, 5],
      [5, 6],
      [2, 7],
    ],
  );

  /*
    What the editor draws in red, and the rule is narrower than "the ends of the doomed walls".

    A stub meets the wall it hangs off at a junction, and that junction keeps its other walls — so
    pruning leaves it exactly where it is. Marking it would be the preview claiming more than the
    button takes, on the one control whose whole problem is that a limit is impossible to picture.
  */
  it("marks the vertices that go, and not the junction that stays", () => {
    const going = spurEdgesToPrune(wallWithBoth, 0.15);

    // The spur is nodes 2-5-6 off the junction at 2. Its own two vertices go; node 2 does not.
    expect([...going.vertices].sort((a, b) => a - b)).toEqual([5, 6]);
    expect(going.vertices.has(2)).toBe(false);
    expect(going.edges.size).toBe(2);

    // And the operation agrees: the survivors are exactly the vertices not marked.
    const pruned = pruneWallGraph(wallWithBoth, 0.15);
    expect(pruned.graph.nodes).toHaveLength(wallWithBoth.nodes.length - going.vertices.size);
  });

  /*
    **Five mutations, five caught**, one only after this file was strengthened: anchors taking every
    endpoint, the two sets swapping, anchors always empty, a doomed edge counting as kept, and the
    off-state result carrying an anchor — which survived until the off-state test asserted the set
    it had never looked at.
  */
  it("names the junction a doomed run hangs off, apart from the vertices that go", () => {
    /*
      **The over-claim the preview makes, kept out of the answer it makes it from** (user,
      2026-09-21): *"when a stub turns red, its base vertex should, too, even though it's not
      actually disappearing."* A stub worth pruning is a couple of pixels at map zoom, and two red
      handles either end of it are far easier to catch than one.

      The two sets are asserted **disjoint and covering**, which is the property that lets the layer
      union them without asking anything else: every endpoint of a doomed edge is in exactly one,
      by whether a surviving wall still names it. Merging them in here instead would have left the
      operation and the log reading a set that claims the junction goes, and it does not — the
      survivor count below is what would catch that.
    */
    const going = spurEdgesToPrune(wallWithBoth, 0.15);

    // The spur is nodes 2-5-6 off the junction at 2: its own two go, and 2 is what it hangs off.
    expect([...going.anchors]).toEqual([2]);
    expect(going.vertices.has(2)).toBe(false);

    // Disjoint, and between them exactly the endpoints of the doomed edges.
    const endpoints = new Set<number>();
    for (const index of going.edges) {
      endpoints.add(wallWithBoth.edges[index]!.a);
      endpoints.add(wallWithBoth.edges[index]!.b);
    }
    expect(endpoints.size).toBeGreaterThan(0);
    for (const id of going.anchors) expect(going.vertices.has(id)).toBe(false);
    expect([...going.vertices, ...going.anchors].sort((a, b) => a - b)).toEqual(
      [...endpoints].sort((a, b) => a - b),
    );

    // And the operation still agrees with `vertices` alone, which is the set that is true.
    const pruned = pruneWallGraph(wallWithBoth, 0.15);
    expect(pruned.graph.nodes).toHaveLength(wallWithBoth.nodes.length - going.vertices.size);
  });

  it("names no junction for a wall that hangs off nothing", () => {
    // Both ends go, so there is nothing for the run to hang off and the marked set is empty. This
    // is what stops `anchors` degenerating into "the endpoints of the doomed edges".
    const adrift = graphOf(
      [
        [0.4, 0.4],
        [0.45, 0.4],
      ],
      [[0, 1]],
    );
    const going = spurEdgesToPrune(adrift, 0.2);
    expect([...going.vertices].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(going.anchors.size).toBe(0);
  });

  it("takes both ends of a wall that touches nothing", () => {
    const adrift = graphOf(
      [
        [0.4, 0.4],
        [0.45, 0.4],
      ],
      [[0, 1]],
    );
    const going = spurEdgesToPrune(adrift, 0.2);
    expect([...going.vertices].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("marks nothing when the limit is off", () => {
    const going = spurEdgesToPrune(wallWithBoth, 0);
    expect(going.edges.size).toBe(0);
    expect(going.vertices.size).toBe(0);
    // The anchors too. Added after a mutation survived: the early return builds its own empty
    // result, so a set added to the shape has to be asserted here or the off state never checks it.
    expect(going.anchors.size).toBe(0);
  });

  it("leaves the graph alone at a limit of zero", () => {
    const result = pruneWallGraph(wallWithBoth, 0);
    expect(result.graph).toBe(wallWithBoth);
    expect(result.removed).toBe(0);
  });

  it("takes the short spur and keeps the stub", () => {
    // The spur is 0.1 long along itself and the stub 0.2, so a limit between them separates them.
    const result = pruneWallGraph(wallWithBoth, 0.15);
    expect(result.removed).toBe(1);
    expect(result.segments).toBe(2);
    expect(result.length).toBeCloseTo(0.1, 5);

    // The stub survives with its tip, and the spur's two vertices are gone from the table.
    const ys = result.graph.nodes.map((node) => node.y);
    expect(ys.some((y) => Math.abs(y - 0.7) < 1e-6)).toBe(true);
    expect(ys.filter((y) => y < 0.5 - 1e-6)).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(6);
    expect(result.graph.edges).toHaveLength(5);
  });

  /*
    The measurement follows the wall rather than joining its ends.

    A spur that doubles back has its ends close together and is long along itself. Two graphs
    identical but for one vertex have to be treated differently, or a curled spur is pruned at a
    limit far shorter than the linework it actually holds.
  */
  it("measures a run along itself, not end to end", () => {
    // A wall through node 1 so that node is a junction and the branch off it is a run of its own.
    const straight = graphOf(
      [
        [0.1, 0.5],
        [0.5, 0.5],
        [0.5, 0.4],
        [0.5, 0.3],
        [0.9, 0.5],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [1, 4],
      ],
    );
    const doubled = graphOf(
      [
        [0.1, 0.5],
        [0.5, 0.5],
        [0.5, 0.1],
        [0.5, 0.3],
        [0.9, 0.5],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [1, 4],
      ],
    );
    // Both spurs end 0.2 from the junction. The first is 0.2 along itself; the second is 0.6.
    expect(pruneWallGraph(straight, 0.3).removed).toBe(1);
    expect(pruneWallGraph(doubled, 0.3).removed).toBe(0);
  });

  it("erodes the whole graph once the limit passes a wall's own arms", () => {
    // Deliberate over-reach, the same kind the ink filters have: every arm of a junction becomes a
    // dead end once its neighbours go. Visible, because the graph is drawn.
    const result = pruneWallGraph(wallWithBoth, 1);
    expect(result.graph.edges).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(0);
  });

  it("never opens a room, because a loop is not a spur", () => {
    const room = graphOf(
      [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.8, 0.8],
        [0.2, 0.8],
        [0.5, 0.9],
        [0.5, 0.8],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 5],
        [5, 3],
        [3, 0],
        [5, 4],
      ],
    );
    const result = pruneWallGraph(room, 0.5);
    // The spur goes; the four walls of the room stay, because the loop through them presents no
    // free end at any limit.
    expect(result.removed).toBe(1);
    expect(result.graph.edges).toHaveLength(5);
    expect(nodeDegrees(result.graph).every((degree) => degree === 2)).toBe(true);
  });
});

describe("wallRunEdges", () => {
  /*
    The edges have to come out of the walk rather than be recovered from the node ids afterwards.

    Two distinct segments can join the same pair of vertices — a doubled wall, which is a legal state
    to pass through in the editor — and a lookup by endpoints would have to guess between them.
  */
  it("gives the same runs as the node walk, segment for segment", () => {
    const tee = graphOf(
      [
        [0.1, 0.5],
        [0.5, 0.5],
        [0.9, 0.5],
        [0.5, 0.9],
      ],
      [
        [0, 1],
        [1, 2],
        [1, 3],
      ],
    );
    const nodes = wallRuns(tee);
    const edges = wallRunEdges(tee);
    expect(edges).toHaveLength(nodes.length);
    nodes.forEach((run, index) => {
      expect(edges[index]).toHaveLength(run.length - 1);
    });
    expect(edges.flat().sort()).toEqual([0, 1, 2]);
  });
});

describe("longestRun", () => {
  /*
    Every run, and that changed on 2026-09-07 after a room found the consequence.

    It measured only *spurs* — runs with a free end — which is what pruning can reach at that instant.
    But pruning cascades: a run between two junctions becomes a dead end once the spurs around it go,
    and it was then judged against a limit whose maximum had never counted it. So the far right of
    the track left exactly those walls standing.
  */
  it("counts a run with no free end, because pruning can reach it later", () => {
    const room = graphOf(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0.5, 1.4],
        [0.5, 1],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 5],
        [5, 3],
        [3, 0],
        [5, 4],
      ],
    );
    // The spur off the bottom wall is 0.4; the room's own perimeter is a closed run of 4. The bound
    // has to be the larger, or a limit can never be set high enough to erode the room's arms once
    // the spur has gone and left them free.
    expect(longestRun(room)).toBeCloseTo(4, 6);
  });

  it("is a bound on what any limit could ever prune", () => {
    const chain = graphOf(
      [
        [0, 0],
        [0.5, 0],
        [0.9, 0],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );
    /*
      The property the maximum has to have: at this limit nothing is refused for being too long, so
      everything with a free end goes and what is left is only what cycles hold in place.
    */
    const limit = longestRun(chain);
    expect(pruneWallGraph(chain, limit).graph.edges).toHaveLength(0);
  });

  it("is zero when there is nothing to measure", () => {
    expect(longestRun({ nodes: [], edges: [] })).toBe(0);
  });
});
