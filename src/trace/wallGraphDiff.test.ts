/**
 * What the GM changed, and — the part worth pinning — the two ways of asking that must agree.
 *
 * The interesting assertions here are not "an added wall reads as added". They are the three things
 * the comparison deliberately does **not** care about: which way round a segment is stored, how the
 * nodes are numbered, and whether the table has been compacted since. Every one of those moves under
 * ordinary editing, and a diff that noticed any of them would report changes the GM did not make —
 * which on this surface means offering to show them a delta that is mostly noise.
 *
 * Eight mutations tried, eight caught: dropping the endpoint ordering, keying on node ids instead of
 * coordinates, keying on x alone, using a set instead of counts, swapping added and removed, never
 * emitting the unclaimed remainder, `graphsDiffer` reporting false for a missing base, and
 * `graphsDiffer` trusting its segment-count short-circuit instead of going on to the geometry.
 */

import { describe, expect, it } from "vitest";

import { diffWallGraphs, graphsDiffer } from "./wallGraphDiff";
import type { WallGraph } from "./wallGraph";

/**
 * A graph from a list of points and the pairs joining them.
 *
 * Coordinates are eighths, which float32 holds exactly, so nothing here depends on the quantisation
 * the real document applies on its way in.
 */
function graph(points: readonly [number, number][], edges: readonly [number, number][]): WallGraph {
  return {
    nodes: points.map(([x, y]) => ({ x, y })),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** A segment as a flat tuple, so a delta can be compared without writing four objects a line. */
const flat = (s: { a: { x: number; y: number }; b: { x: number; y: number } }) =>
  [s.a.x, s.a.y, s.b.x, s.b.y] as const;

/** A square room: four corners, four walls. The base for most of what follows. */
const ROOM = graph(
  [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ],
);

describe("diffWallGraphs", () => {
  it("finds nothing between a graph and itself", () => {
    const delta = diffWallGraphs(ROOM, ROOM);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it("reports a wall the GM drew as added, and nothing as removed", () => {
    // A stub off the top-left corner, hanging into open space.
    const withStub = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.25, 0.125],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [0, 4],
      ],
    );

    const delta = diffWallGraphs(ROOM, withStub);
    expect(delta.removed).toEqual([]);
    expect(delta.added.map(flat)).toEqual([[0.25, 0.25, 0.25, 0.125]]);
  });

  it("reports a wall the GM erased as removed, and nothing as added", () => {
    const doorway = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );

    const delta = diffWallGraphs(ROOM, doorway);
    expect(delta.added).toEqual([]);
    expect(delta.removed.map(flat)).toEqual([[0.25, 0.75, 0.25, 0.25]]);
  });

  it("reports a moved vertex as both — every segment touching it goes and comes back", () => {
    /*
      The decision this pins (user, 2026-09-14): there is no third category for a move. Dragging the
      top-right corner changes the two walls that meet there, so each one is removed at its old
      position and added at its new one. Two symbols cover the whole delta, and they are the same
      amber-and-cyan pair the painted ink already uses.
    */
    const nudged = graph(
      [
        [0.25, 0.25],
        [0.875, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );

    const delta = diffWallGraphs(ROOM, nudged);
    expect(delta.added.map(flat)).toEqual([
      [0.25, 0.25, 0.875, 0.25],
      [0.875, 0.25, 0.75, 0.75],
    ]);
    expect(delta.removed.map(flat)).toEqual([
      [0.25, 0.25, 0.75, 0.25],
      [0.75, 0.25, 0.75, 0.75],
    ]);
  });

  it("does not care which way round a segment is stored", () => {
    // Every edge reversed. Nothing about the drawing changed, and `insertEdge` takes the ends in the
    // order the GM drew them, so this is an ordinary difference between two honest graphs.
    const reversed = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
      [
        [1, 0],
        [2, 1],
        [3, 2],
        [0, 3],
      ],
    );

    const delta = diffWallGraphs(ROOM, reversed);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it("does not care how the nodes are numbered", () => {
    /*
      The case that decides the whole design. `compactNodes` renumbers every id after a gesture and
      pruning compacts as well, so a diff by id would report an entire map as changed the first time
      either ran — and would report it as *wrong output* rather than as an error.
    */
    const renumbered = graph(
      [
        [0.75, 0.75],
        [0.25, 0.75],
        [0.25, 0.25],
        [0.75, 0.25],
      ],
      [
        [2, 3],
        [3, 0],
        [0, 1],
        [1, 2],
      ],
    );

    expect(diffWallGraphs(ROOM, renumbered)).toEqual({ added: [], removed: [] });
  });

  it("survives a node table with entries no wall uses", () => {
    // What erasing and merging leave behind, and what not compacting would leave a great deal of.
    const withOrphans = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.5, 0.5],
        [0.1, 0.1],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );

    expect(diffWallGraphs(ROOM, withOrphans)).toEqual({ added: [], removed: [] });
  });

  it("counts copies, so doubling a wall reads as one addition", () => {
    /*
      Coincident segments are a state the document can pass through — doubling a line in order to
      drag the copy elsewhere is a legal intermediate, and §5 is explicit that a degenerate state is
      warned about rather than prevented. A set-based comparison would call the second copy identical
      to the first and report no change at all.
    */
    const doubled = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
      [
        [0, 1],
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );

    const delta = diffWallGraphs(ROOM, doubled);
    expect(delta.removed).toEqual([]);
    expect(delta.added.map(flat)).toEqual([[0.25, 0.25, 0.75, 0.25]]);
  });

  it("tells two segments apart when only their y differs", () => {
    // A key built from x alone would call these the same wall.
    const base = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.5],
        [0.75, 0.5],
      ],
      [[0, 1]],
    );
    const moved = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.5],
        [0.75, 0.5],
      ],
      [[2, 3]],
    );

    const delta = diffWallGraphs(base, moved);
    expect(delta.added.map(flat)).toEqual([[0.25, 0.5, 0.75, 0.5]]);
    expect(delta.removed.map(flat)).toEqual([[0.25, 0.25, 0.75, 0.25]]);
  });
});

describe("graphsDiffer", () => {
  it("says no for a graph that is still what was derived", () => {
    expect(graphsDiffer(ROOM, ROOM)).toBe(false);
  });

  it("agrees with the delta when only the numbering moved", () => {
    const renumbered = graph(
      [
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.25, 0.25],
      ],
      [
        [3, 0],
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );

    expect(graphsDiffer(ROOM, renumbered)).toBe(false);
    expect(diffWallGraphs(ROOM, renumbered)).toEqual({ added: [], removed: [] });
  });

  it("catches a graph with the same number of walls in different places", () => {
    /*
      The short-circuit on segment count is a speed path and must not become the answer. Erase one
      wall and draw another somewhere else and the totals match exactly.
    */
    const swapped = graph(
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.5, 0.9],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    );

    expect(swapped.edges.length).toBe(ROOM.edges.length);
    expect(graphsDiffer(ROOM, swapped)).toBe(true);
  });

  it("assumes a graph with no stored base was edited", () => {
    /*
      The loud direction, deliberately. A graph saved by a build that kept no base says nothing about
      whether it was worked on, and the two mistakes are not equal: a mark nobody needed costs a mark,
      where a missing one lets a GM regenerate away an evening with nothing said.
    */
    expect(graphsDiffer(null, ROOM)).toBe(true);
  });

  it("reports nothing when there is no graph either way", () => {
    expect(graphsDiffer(null, null)).toBe(false);
  });

  it("reports a difference when the graph is gone and a base remains", () => {
    expect(graphsDiffer(ROOM, null)).toBe(true);
  });
});
