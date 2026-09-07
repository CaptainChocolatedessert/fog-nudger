/**
 * Spur pruning on the graph, where a stub and an artefact are told apart by length alone.
 *
 * Two levels, and they are tested separately on purpose. `spursToPrune` is the *decision* — runs in,
 * indices out, no geometry — and it is where the cascade and the closed-loop guard live.
 * `pruneFrozenGraph` is the operation that supplies it with runs and takes the edges away, and what
 * it adds is the run decomposition, the length measurement and the compaction.
 *
 * The raster version these replace had a file of text-grid skeletons. It is gone with the code: the
 * pixel walk it tested does not exist any more, and a graph run is deleted whole.
 */

import { describe, expect, it } from "vitest";

import {
  documentPoint,
  longestSpur,
  nodeDegrees,
  pruneFrozenGraph,
  wallRunEdges,
  wallRuns,
  type FrozenGraph,
} from "./frozenGraph";
import { spursToPrune, type PrunableRun } from "./spurs";

/** A graph from a list of points and the pairs joining them. Coordinates are map fractions. */
function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): FrozenGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

describe("spursToPrune", () => {
  it("removes nothing at a budget of zero, which is the off position", () => {
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
    // is the guard that stops a budget swallowing a room.
    const runs: PrunableRun[] = [{ a: 0, b: 0, length: 0.001 }];
    expect(spursToPrune(runs, 1).removed.size).toBe(0);
  });

  /*
    **A run that becomes free later is judged against the same budget, and this is what a room saw.**

    The cascade frees new ends round by round, but the budget never moves — so a long wall whose end
    was a junction, and which only becomes a dead end once the short spurs around it go, is kept
    because it is long. That is correct on its own terms: everything past the threshold is meant to be
    treated as deliberate.

    What makes it surprising is the *track*. Its top end is the longest spur measured on the graph as
    it was when the step opened, so a run that had no free end then was never a candidate and never
    counted — and at the far right, where a GM expects every dead end to go, those are exactly the
    walls left standing. Reported from a room on 2026-09-07 as "very long walls that do not enclose a
    space".
  */
  it("keeps a run that outgrew the budget before its end came free", () => {
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

    // Only a budget past its own length reaches it, which the track's top end does not offer.
    expect([...spursToPrune(runs, 50).removed].sort()).toEqual([0, 1, 2]);
  });

  it("takes a run free at both ends, which is a wall touching nothing", () => {
    const runs: PrunableRun[] = [{ a: 0, b: 1, length: 1 }];
    expect([...spursToPrune(runs, 2).removed]).toEqual([0]);
  });
});

describe("pruneFrozenGraph", () => {
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

  it("leaves the graph alone at a budget of zero", () => {
    const result = pruneFrozenGraph(wallWithBoth, 0);
    expect(result.graph).toBe(wallWithBoth);
    expect(result.removed).toBe(0);
  });

  it("takes the short spur and keeps the stub", () => {
    // The spur is 0.1 long along itself and the stub 0.2, so a budget between them separates them.
    const result = pruneFrozenGraph(wallWithBoth, 0.15);
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
    budget far shorter than the linework it actually holds.
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
    expect(pruneFrozenGraph(straight, 0.3).removed).toBe(1);
    expect(pruneFrozenGraph(doubled, 0.3).removed).toBe(0);
  });

  it("erodes the whole graph once the budget passes a wall's own arms", () => {
    // Deliberate over-reach, the same kind the ink filters have: every arm of a junction becomes a
    // dead end once its neighbours go. Visible, because the graph is drawn.
    const result = pruneFrozenGraph(wallWithBoth, 1);
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
    const result = pruneFrozenGraph(room, 0.5);
    // The spur goes; the four walls of the room stay, because the loop through them presents no
    // free end at any budget.
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

describe("longestSpur", () => {
  it("measures only the runs pruning could reach", () => {
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
    /*
      The room's own perimeter is a closed run of length 4 and can never be pruned. If it counted,
      the slider's top would be ten times the only setting that does anything — which on a real map,
      whose exterior wall is one enormous run, is the difference between a usable track and one where
      everything useful sits in the first percent.
    */
    expect(longestSpur(room)).toBeCloseTo(0.4, 5);
  });

  it("is zero when there is nothing to prune", () => {
    const loop = graphOf(
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    );
    expect(longestSpur(loop)).toBe(0);
  });
});
