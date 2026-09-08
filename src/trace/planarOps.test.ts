/**
 * The edits, and the one property every one of them has to keep.
 *
 * **Planarity after the edit** is the invariant stage two has instead of the area check, so almost
 * every test here ends by asserting `findCrossings` is empty. The rest is about *identity*: an edit
 * must not renumber, duplicate or quietly drop the ids the GM's other walls are hanging on, because
 * ids are the only stable thing in this document.
 *
 * Coordinates are fractions of the map. The fixtures use tenths as a reminder that there are no
 * pixels in here.
 */

import { describe, expect, it } from "vitest";

import { findCrossings } from "./planarGraph";
import { insertEdge, mergeNodes, moveNode, nearestNode } from "./planarOps";
import { documentPoint, nodeDegrees, wallRuns, type WallGraph } from "./wallGraph";

const at = (x: number, y: number) => documentPoint(x, y);

/** A square room: four corners, four walls, meeting only at the corners. */
const ROOM: WallGraph = {
  nodes: [at(0.1, 0.1), at(0.9, 0.1), at(0.9, 0.9), at(0.1, 0.9)],
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 3, b: 0 },
  ],
};

/** A room with a stub hanging off the middle of its top wall. */
const WITH_STUB: WallGraph = {
  nodes: [at(0.1, 0.1), at(0.5, 0.1), at(0.9, 0.1), at(0.9, 0.9), at(0.1, 0.9), at(0.5, 0.4)],
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 3, b: 4 },
    { a: 4, b: 0 },
    { a: 1, b: 5 },
  ],
};

describe("moveNode", () => {
  it("moves the vertex and leaves everything else alone", () => {
    const result = moveNode(ROOM, 0, at(0.2, 0.2));
    expect(result.graph.nodes[0]).toEqual(at(0.2, 0.2));
    expect(result.graph.nodes.slice(1)).toEqual(ROOM.nodes.slice(1));
    expect(result.splits).toBe(0);
    expect(findCrossings(result.graph)).toEqual([]);
  });

  it("keeps a moved wall's identity, because ids are what moved is not", () => {
    // The subtle one. Dragging a corner changes the *coordinates* two walls are drawn at, but not
    // the pair of ids that names either of them — so both segments must come back by reference.
    // A rebuilt copy here would break the cheapest way a caller has of telling what an edit touched.
    const result = moveNode(ROOM, 0, at(0.2, 0.2));
    for (let i = 0; i < ROOM.edges.length; i++) {
      expect(result.graph.edges[i]).toBe(ROOM.edges[i]);
    }
  });

  it("splits a wall the vertex was dragged across", () => {
    // The question that was raised against building the drag tool at all. It is the same sweep
    // `insertEdge` runs, discovered on release — the stub's free tip is dragged through the room's
    // right-hand wall, and that wall has to be cut where it now passes.
    const result = moveNode(WITH_STUB, 5, at(1.2, 0.4));
    expect(findCrossings(result.graph)).toEqual([]);
    // Two, not one: `splits` counts cuts on segments that already existed, and in a *move* both
    // sides of the crossing did. The wall is cut where the stub now passes through it, and the stub
    // is cut at the same point — which it must be, or the crossing would not become a junction.
    expect(result.splits).toBe(2);
    // Exactly one four-way junction, where there was none before. The crossing lands part-way up the
    // wall at a point neither shape names, so it is found by degree rather than by coordinate — a
    // hard-coded position here would be asserting the arithmetic of the fixture, not the behaviour.
    const degrees = nodeDegrees(result.graph);
    expect(degrees.filter((d) => d === 4)).toHaveLength(1);
    expect(nodeDegrees(WITH_STUB).filter((d) => d === 4)).toHaveLength(0);
  });

  it("does nothing when the vertex has not actually moved", () => {
    const result = moveNode(ROOM, 0, at(0.1, 0.1));
    expect(result.graph).toBe(ROOM);
    expect(result.splits).toBe(0);
  });

  it("ignores a vertex that does not exist", () => {
    expect(moveNode(ROOM, 99, at(0.5, 0.5)).graph).toBe(ROOM);
    expect(moveNode(ROOM, -1, at(0.5, 0.5)).graph).toBe(ROOM);
  });

  it("does not sweep walls the vertex never touched", () => {
    // Only segments meeting the moved node can have started crossing something, which is why the
    // sweep is targeted. If it were sweeping everything this would still pass — so the assertion
    // that matters is the count of *splits*, which stays at zero for a move that crosses nothing.
    const result = moveNode(WITH_STUB, 5, at(0.5, 0.5));
    expect(result.splits).toBe(0);
    expect(findCrossings(result.graph)).toEqual([]);
  });
});

describe("mergeNodes", () => {
  it("makes two vertices genuinely one, by reference", () => {
    // Not "two points that hold equal coordinates" — that is what the emitted fog degrades to and
    // the reason editing cannot be done there. After a merge the walls share an id.
    //
    // The stub's free tip is folded into a far corner, which is the shape a snapped drag makes. It
    // has to be a *non-adjacent* pair to show the degree rising: merging two ends of one wall
    // collapses that wall instead, which is the next test.
    const result = mergeNodes(WITH_STUB, 5, 3);
    const degrees = nodeDegrees(result.graph);
    expect(degrees[3]).toBe(3);
    expect(degrees[5]).toBe(0);
    for (const edge of result.graph.edges) {
      expect(edge.a).not.toBe(5);
      expect(edge.b).not.toBe(5);
    }
  });

  it("drops the wall that was being closed up rather than keeping it at zero length", () => {
    // Merging the two ends of one wall collapses it. Keeping it would leave a segment from a node
    // to itself — a wall of no length that nothing draws and nothing downstream expects.
    const result = mergeNodes(ROOM, 1, 0);
    expect(result.graph.edges.length).toBe(ROOM.edges.length - 1);
    for (const edge of result.graph.edges) expect(edge.a).not.toBe(edge.b);
  });

  it("leaves the folded vertex in the table rather than renumbering", () => {
    // Renumbering would invalidate every id the caller holds — including, mid-gesture, the one being
    // dragged. An unreferenced node costs eight bytes; a renumber costs correctness.
    const result = mergeNodes(WITH_STUB, 5, 3);
    expect(result.graph.nodes.length).toBe(WITH_STUB.nodes.length);
    expect(result.graph.nodes[5]).toEqual(WITH_STUB.nodes[5]);
  });

  it("leaves the graph planar", () => {
    expect(findCrossings(mergeNodes(WITH_STUB, 5, 4).graph)).toEqual([]);
  });

  it("does not hand back the pre-merge segment by reference", () => {
    // The bug this caught, kept as its own test because the failure was *silent*: uncut segments are
    // returned by reference to preserve identity, and a merge renames an id — so returning the
    // original described the segment as it was before the merge and undid the whole operation. It
    // reported success, with a graph that had not changed at all.
    const result = mergeNodes(WITH_STUB, 5, 3);
    const stub = result.graph.edges.find((e) => e.a === 1 || e.b === 1);
    expect(result.graph.edges).not.toContain(WITH_STUB.edges[5]);
    expect(stub).toBeDefined();
  });

  it("refuses the degenerate arguments rather than corrupting the graph", () => {
    expect(mergeNodes(ROOM, 2, 2).graph).toBe(ROOM);
    expect(mergeNodes(ROOM, 99, 0).graph).toBe(ROOM);
    expect(mergeNodes(ROOM, 0, 99).graph).toBe(ROOM);
  });

  it("keeps the walls chainable afterwards", () => {
    // A merge that left a dangling id would show up here rather than in the degree count: `wallRuns`
    // walks the edges, so a reference to a node nothing else holds breaks the chaining.
    const result = mergeNodes(WITH_STUB, 5, 3);
    const runs = wallRuns(result.graph);
    const segments = runs.reduce((total, run) => total + run.length - 1, 0);
    expect(segments).toBe(result.graph.edges.length);
  });
});

describe("nearestNode", () => {
  it("finds the vertex under the cursor within the radius", () => {
    expect(nearestNode(ROOM, at(0.11, 0.11), 0.05)).toBe(0);
  });

  it("finds nothing when the nearest is outside the radius", () => {
    // What the modifier key produces by simply not calling this, and what an empty patch of map
    // produces on its own. Both mean "place a new point here".
    expect(nearestNode(ROOM, at(0.5, 0.5), 0.05)).toBeNull();
  });

  it("takes the nearest rather than the first inside the radius", () => {
    const two: WallGraph = {
      nodes: [at(0.4, 0.5), at(0.6, 0.5)],
      edges: [{ a: 0, b: 1 }],
    };
    expect(nearestNode(two, at(0.58, 0.5), 0.3)).toBe(1);
    expect(nearestNode(two, at(0.42, 0.5), 0.3)).toBe(0);
  });

  it("leaves out the vertex being dragged, so it cannot snap to itself", () => {
    // Without this a drag would merge the dragged node into itself the moment it started, which is
    // a no-op that reads as the drag not working.
    expect(nearestNode(ROOM, at(0.1, 0.1), 0.05)).toBe(0);
    expect(nearestNode(ROOM, at(0.1, 0.1), 0.05, 0)).toBeNull();
  });

  it("breaks a tie on the lower id, repeatably", () => {
    // Two vertices equidistant are indistinguishable to the GM; what matters is that the answer does
    // not flicker between frames while they hold the cursor still.
    const pair: WallGraph = {
      nodes: [at(0.4, 0.5), at(0.6, 0.5)],
      edges: [{ a: 0, b: 1 }],
    };
    expect(nearestNode(pair, at(0.5, 0.5), 0.3)).toBe(0);
    expect(nearestNode(pair, at(0.5, 0.5), 0.3)).toBe(0);
  });
});

describe("insertEdge, after the split from planarGraph", () => {
  it("still splits what a new wall crosses", () => {
    // The behaviour that moved modules. Its own suite is in `planarGraph.test.ts`; this is the guard
    // against the move having broken the wiring.
    const result = insertEdge(ROOM, [at(0.5, 0), at(0.5, 1)]);
    expect(result.splits).toBe(2);
    expect(findCrossings(result.graph)).toEqual([]);
  });

  it("counts a wall doubled back on itself as one overlap, not two", () => {
    // The state the record names as legal and passing-through: doubling a line in order to drag the
    // copy away. Both halves are new, so the pair is checked from both ends unless the sweep dedupes
    // it — and a doubled count is the only place that shows, because the cuts themselves dedupe by
    // node id. Nothing else here exercises a changed-against-changed pair.
    const result = insertEdge(ROOM, [at(0.3, 0.5), at(0.7, 0.5), at(0.3, 0.5)]);
    expect(result.overlaps).toBe(1);
  });

  it("splits a new wall that crosses ITSELF", () => {
    // Gained by the restructure rather than designed: the sweep now checks changed segments against
    // each other as well as against the rest, so a self-crossing polyline is cut where it meets.
    const result = insertEdge(ROOM, [at(0.3, 0.3), at(0.6, 0.6), at(0.6, 0.3), at(0.3, 0.6)]);
    expect(findCrossings(result.graph)).toEqual([]);
  });
});
