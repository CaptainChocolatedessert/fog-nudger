/**
 * Planarity: the invariant stage two has instead of the area check.
 *
 * The claim being tested is not "the numbers are right" but "**the graph is still one a face
 * traversal can be run over**". A crossing at a point that is a node of neither edge does not make
 * the faces wrong, it makes them meaningless — so the useful assertion after every edit is that
 * `findCrossings` comes back empty.
 */

import { describe, expect, it } from "vitest";

import { findCrossings, insertEdge, segmentMeeting } from "./planarGraph";
import { nodeDegrees, type FrozenGraph } from "./frozenGraph";

const at = (x: number, y: number) => ({ x, y });

/** A square room: four corners, four walls, meeting only at the corners. */
const ROOM: FrozenGraph = {
  width: 100,
  height: 100,
  nodes: [at(10, 10), at(90, 10), at(90, 90), at(10, 90)],
  edges: [
    { nodes: [0, 1] },
    { nodes: [1, 2] },
    { nodes: [2, 3] },
    { nodes: [3, 0] },
  ],
};

describe("segmentMeeting", () => {
  it("finds a proper crossing and splits both", () => {
    const meeting = segmentMeeting(at(0, 0), at(10, 0), at(5, -5), at(5, 5))!;
    expect(meeting.kind).toBe("crossing");
    expect(meeting.point).toEqual(at(5, 0));
    expect(meeting.splitsFirst).toBe(true);
    expect(meeting.splitsSecond).toBe(true);
  });

  it("calls an endpoint landing inside another segment a touch, and splits only that one", () => {
    // The T. The toucher already has a node there; the crossed edge does not, so only it is cut.
    const meeting = segmentMeeting(at(0, 0), at(10, 0), at(5, 0), at(5, 9))!;
    expect(meeting.kind).toBe("touch");
    expect(meeting.splitsFirst).toBe(true);
    expect(meeting.splitsSecond).toBe(false);
  });

  it("is silent when two segments merely share an endpoint", () => {
    // A junction is the ordinary case. Reporting it would split at a node that already exists.
    expect(segmentMeeting(at(0, 0), at(10, 0), at(10, 0), at(10, 9))).toBeNull();
    expect(segmentMeeting(at(0, 0), at(10, 0), at(0, 0), at(0, -9))).toBeNull();
  });

  it("is silent when segments miss, including when their infinite lines would cross", () => {
    // The case a test that only checked the lines would pass wrongly.
    expect(segmentMeeting(at(0, 0), at(10, 0), at(50, -5), at(50, 5))).toBeNull();
    expect(segmentMeeting(at(0, 0), at(10, 0), at(5, 5), at(5, 20))).toBeNull();
  });

  it("reports a collinear overlap rather than a point", () => {
    // Splitting cannot separate these, so it is named and left. A GM doubling a line to drag the
    // copy away passes through exactly this state.
    const meeting = segmentMeeting(at(0, 0), at(10, 0), at(4, 0), at(14, 0))!;
    expect(meeting.kind).toBe("overlap");
    expect(meeting.splitsFirst).toBe(false);
  });

  it("does not call two collinear segments meeting end to end an overlap", () => {
    expect(segmentMeeting(at(0, 0), at(10, 0), at(10, 0), at(20, 0))).toBeNull();
  });

  it("rounds a rational crossing to the nearest lattice point", () => {
    // Two integer segments generally cross at a rational point. Rounding keeps every later
    // comparison exact, at up to about seven tenths of a pixel of error.
    const meeting = segmentMeeting(at(0, 0), at(10, 3), at(0, 3), at(10, 0))!;
    expect(meeting.point).toEqual(at(5, 2));
    expect(Number.isInteger(meeting.point.x)).toBe(true);
    expect(Number.isInteger(meeting.point.y)).toBe(true);
  });
});

describe("findCrossings", () => {
  it("says a plain room is clean", () => {
    expect(findCrossings(ROOM)).toEqual([]);
  });

  it("finds a wall laid straight across a room", () => {
    const crossed: FrozenGraph = {
      ...ROOM,
      nodes: [...ROOM.nodes, at(50, 0), at(50, 100)],
      edges: [...ROOM.edges, { nodes: [4, 5] }],
    };
    const found = findCrossings(crossed);
    // Through the top wall and the bottom wall.
    expect(found).toHaveLength(2);
    expect(found.every((c) => c.kind === "crossing")).toBe(true);
  });
});

describe("insertEdge", () => {
  it("splits an existing edge at an INTERIOR vertex a new wall meets", () => {
    // A wall drawn as two segments, met head-on at its middle vertex. Nothing crosses a segment's
    // interior, so the intersection test alone finds nothing to cut — and yet that vertex is now a
    // junction of four, and it is only an *interior point* of the wall, which the traversal cannot
    // turn at. Found by mutation testing rather than by the fixtures.
    const wall: FrozenGraph = {
      width: 40,
      height: 40,
      nodes: [at(0, 10), at(10, 10), at(20, 10)],
      edges: [{ nodes: [0, 1, 2] }],
    };
    const result = insertEdge(wall, [at(10, 0), at(10, 20)]);
    const middle = result.graph.nodes.findIndex((n) => n.x === 10 && n.y === 10);
    expect(nodeDegrees(result.graph)[middle]).toBe(4);
  });

  it("leaves the graph planar after a wall crosses two others", () => {
    // The property that matters, asserted directly rather than by counting splits.
    const result = insertEdge(ROOM, [at(50, 0), at(50, 100)]);
    expect(findCrossings(result.graph)).toEqual([]);
    expect(result.splits).toBe(2);
  });

  it("puts a real junction where the crossing was", () => {
    // Not merely "an edge was cut": the point has to be one *shared* id that four edge-ends meet at,
    // or the traversal still cannot turn there.
    const result = insertEdge(ROOM, [at(50, 0), at(50, 100)]);
    const degrees = nodeDegrees(result.graph);
    const top = result.graph.nodes.findIndex((n) => n.x === 50 && n.y === 10);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(degrees[top]).toBe(4);
  });

  it("splits at an interior vertex a STUB ends on, not just one a wall passes through", () => {
    // The weaker version of the case above, and the one an occurrence threshold gets wrong: a stub
    // ending on the middle of a wall makes that vertex occur exactly **twice** — once as the wall's
    // interior point, once as the stub's end. A wall passing straight through makes it occur three
    // times, so a test using only that case passes with the threshold set one too high.
    const wall: FrozenGraph = {
      width: 40,
      height: 40,
      nodes: [at(0, 10), at(10, 10), at(20, 10)],
      edges: [{ nodes: [0, 1, 2] }],
    };
    const result = insertEdge(wall, [at(10, 10), at(10, 0)]);
    const middle = result.graph.nodes.findIndex((n) => n.x === 10 && n.y === 10);
    expect(nodeDegrees(result.graph)[middle]).toBe(3);
  });

  it("keeps the ids of every edge it did not touch", () => {
    // The whole document rests on shared identity surviving an edit. An edge nothing crossed must
    // come back as the same object, not a rebuilt copy that happens to look the same.
    const result = insertEdge(ROOM, [at(20, 20), at(30, 30)]);
    expect(result.splits).toBe(0);
    for (let i = 0; i < ROOM.edges.length; i++) {
      expect(result.graph.edges[i]).toBe(ROOM.edges[i]);
    }
  });

  it("attaches to an existing node rather than duplicating it", () => {
    // A GM clicking exactly on a corner means "join here". Exact coordinate equality decides it,
    // which is the standing rule: anything we emitted is exact, so no epsilon is wanted.
    const before = ROOM.nodes.length;
    const result = insertEdge(ROOM, [at(10, 10), at(40, 40)]);
    const corner = result.graph.nodes.findIndex((n) => n.x === 10 && n.y === 10);
    expect(corner).toBe(0);
    expect(result.graph.nodes.length).toBe(before + 1);
    expect(nodeDegrees(result.graph)[0]).toBe(3);
  });

  it("splits the crossed edge when a new wall's END lands inside it", () => {
    // The T. Only the crossed wall is cut; the new one already has a node there.
    const result = insertEdge(ROOM, [at(50, 50), at(50, 10)]);
    expect(result.splits).toBe(1);
    expect(findCrossings(result.graph)).toEqual([]);
    const join = result.graph.nodes.findIndex((n) => n.x === 50 && n.y === 10);
    expect(nodeDegrees(result.graph)[join]).toBe(3);
  });

  it("reports a collinear overlap and does not pretend to have fixed it", () => {
    const result = insertEdge(ROOM, [at(30, 10), at(70, 10)]);
    expect(result.overlaps).toBeGreaterThan(0);
  });

  it("refuses to build an edge out of one point", () => {
    const result = insertEdge(ROOM, [at(40, 40), at(40, 40)]);
    expect(result.graph).toBe(ROOM);
    expect(result.splits).toBe(0);
  });

  it("splits a multi-segment wall at every crossing along it", () => {
    // A polyline crossing the room's left wall, then its right wall, then out again.
    const result = insertEdge(ROOM, [at(0, 50), at(50, 50), at(100, 50)]);
    expect(findCrossings(result.graph)).toEqual([]);
    expect(result.splits).toBe(2);
    const left = result.graph.nodes.findIndex((n) => n.x === 10 && n.y === 50);
    const right = result.graph.nodes.findIndex((n) => n.x === 90 && n.y === 50);
    const degrees = nodeDegrees(result.graph);
    expect(degrees[left]).toBe(4);
    expect(degrees[right]).toBe(4);
  });

  it("cuts one wall segment twice in the right order", () => {
    // Two crossings on the *same* segment, which is what a wall crossed by two others looks like.
    // The order matters and nothing else here exercises it: cuts applied out of order thread the
    // rebuilt wall through its own split points backwards, so the pieces zigzag and overlap.
    //
    // Drawn right-to-left on purpose: the cuts are then *discovered* at x=70 before x=30, so the
    // insertion order is the reverse of the order along the wall and the sort is doing real work.
    // Drawn the other way they happen to arrive already sorted, and this passed without it.
    const result = insertEdge(ROOM, [at(70, 0), at(70, 30), at(30, 30), at(30, 0)]);
    expect(findCrossings(result.graph)).toEqual([]);

    // The top wall is now three pieces, and their x ranges run 10 -> 30 -> 70 -> 90 in order.
    const onTop = result.graph.edges
      .map((edge) => edge.nodes.map((id) => result.graph.nodes[id]!))
      .filter((pts) => pts.every((p) => p.y === 10))
      .map((pts) => [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))])
      .sort((a, b) => a[0]! - b[0]!);
    expect(onTop).toEqual([
      [10, 30],
      [30, 70],
      [70, 90],
    ]);
  });

  it("keeps every node still referenced by some edge", () => {
    // A split that dropped a node would leave the table holding a point nothing draws — harmless
    // today and a trap for anything that iterates nodes to render handles.
    const result = insertEdge(ROOM, [at(50, 0), at(50, 100)]);
    const referenced = new Set<number>();
    for (const edge of result.graph.edges) for (const id of edge.nodes) referenced.add(id);
    for (let id = 0; id < ROOM.nodes.length; id++) expect(referenced.has(id)).toBe(true);
  });
});
