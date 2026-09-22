/**
 * The set *Erase chain* takes: everything joined to the wall under the pointer.
 *
 * **The oracle shares none of the implementation's reasoning.** `connectedEdges` builds a vertex
 * adjacency and walks it breadth-first; the oracle below repeatedly sweeps every wall and takes any
 * that shares a vertex id with the set so far, until a sweep adds nothing. Quadratic and obviously
 * correct, which is what an oracle is for — it is the fixpoint of the rule stated directly.
 *
 * **Eight mutations on 2026-09-22, eight caught**, listed at the foot of this file.
 */

import { describe, expect, it } from "vitest";

import { connectedEdges } from "./connected";
import { documentPoint, type WallGraph } from "./wallGraph";

function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** The rule stated as a fixpoint, with no adjacency and no queue. */
function reachableBySweeping(graph: WallGraph, from: number): number[] {
  if (from < 0 || from >= graph.edges.length) return [];
  const taken = new Set<number>([from]);
  for (;;) {
    let grew = false;
    for (let index = 0; index < graph.edges.length; index++) {
      if (taken.has(index)) continue;
      const edge = graph.edges[index]!;
      for (const other of taken) {
        const against = graph.edges[other]!;
        const shares =
          edge.a === against.a || edge.a === against.b || edge.b === against.a || edge.b === against.b;
        if (shares) {
          taken.add(index);
          grew = true;
          break;
        }
      }
    }
    if (!grew) return [...taken].sort((a, b) => a - b);
  }
}

const sorted = (indices: readonly number[]): number[] => [...indices].sort((a, b) => a - b);

describe("connectedEdges", () => {
  /*
    Two separate things on one map: a room, and a stranded scribble inside it. Clicking the scribble
    takes the scribble; clicking the room takes the room. That is the tool's whole use case.
  */
  it("takes the stranded thing and leaves the room it sits in", () => {
    const graph = graphOf(
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
        [0.4, 0.4],
        [0.5, 0.45],
        [0.45, 0.55],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 4],
      ],
    );

    expect(sorted(connectedEdges(graph, 5))).toEqual([4, 5, 6]);
    expect(sorted(connectedEdges(graph, 0))).toEqual([0, 1, 2, 3]);
  });

  /*
    Touching is not joining. Two walls whose ends hold the same coordinates but different ids are two
    sets — the document's identity rule, and the reason the preview is the thing that answers "is this
    one piece or two".
  */
  it("does not join two walls that only share a coordinate", () => {
    const graph = graphOf(
      [
        [0.2, 0.2],
        [0.5, 0.5],
        [0.5, 0.5],
        [0.8, 0.8],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );

    expect(connectedEdges(graph, 0)).toEqual([0]);
  });

  it("follows a branch, and round a loop, from any wall in it", () => {
    // A triangle with a tail hanging off one corner.
    const graph = graphOf(
      [
        [0.2, 0.2],
        [0.6, 0.2],
        [0.4, 0.6],
        [0.9, 0.1],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 0],
        [1, 3],
      ],
    );

    expect(sorted(connectedEdges(graph, 3))).toEqual([0, 1, 2, 3]);
    expect(sorted(connectedEdges(graph, 1))).toEqual([0, 1, 2, 3]);
  });

  it("answers nothing for an index that names no wall", () => {
    const graph = graphOf(
      [
        [0.2, 0.2],
        [0.6, 0.2],
      ],
      [[0, 1]],
    );

    expect(connectedEdges(graph, -1)).toEqual([]);
    expect(connectedEdges(graph, 1)).toEqual([]);
    expect(connectedEdges(graph, 7)).toEqual([]);
  });

  it("takes a lone wall, and both of a pair that meet end to end", () => {
    const graph = graphOf(
      [
        [0.1, 0.1],
        [0.2, 0.2],
        [0.3, 0.3],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );

    expect(sorted(connectedEdges(graph, 0))).toEqual([0, 1]);
  });

  /*
    Random graphs against the oracle, with the generator made to reach the case that matters: several
    separate components, so a run that took everything would fail rather than pass by luck.
  */
  it("agrees with the sweeping oracle over random graphs, which do have several components", () => {
    let seed = 424242;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    let sawSeveral = 0;
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const nodeCount = 6 + Math.floor(random() * 14);
      const points: [number, number][] = [];
      for (let i = 0; i < nodeCount; i++) points.push([random(), random()]);
      const edges: [number, number][] = [];
      const edgeCount = 3 + Math.floor(random() * 12);
      for (let i = 0; i < edgeCount; i++) {
        const a = Math.floor(random() * nodeCount);
        const b = Math.floor(random() * nodeCount);
        if (a !== b) edges.push([a, b]);
      }
      if (edges.length === 0) continue;
      const graph = graphOf(points, edges);
      const from = Math.floor(random() * edges.length);

      const mine = sorted(connectedEdges(graph, from));
      expect(mine).toEqual(reachableBySweeping(graph, from));
      checked += 1;
      if (mine.length < edges.length) sawSeveral += 1;
    }

    // The generator reached the case, rather than agreeing on graphs that were all one piece.
    expect(checked).toBeGreaterThan(250);
    expect(sawSeveral).toBeGreaterThan(100);
  });
});

/*
  **The mutations, 2026-09-22 — eight run, eight caught:**

  1. Walk from only the first end of each wall (`edge.a`), never the second.
  2. Walk from only the second end.
  3. Take the neighbour without marking it seen, which cannot terminate on a loop. **Written up in
     advance as a hang and it was not** — the run failed inside its timeout, because the queue grows
     without bound and the process dies rather than spinning quietly. Caught, and the prediction was
     wrong.
  4. Return only the starting wall.
  5. Return every wall in the graph.
  6. Skip the walk's first step by starting the head at 1.
  7. Drop the range check on the index, so a hover past the end of the table answers with wall 0's set.
  8. Build the adjacency from `edge.a` alone.
*/
