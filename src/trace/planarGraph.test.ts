/**
 * Planarity: the invariant stage two has instead of the area check.
 *
 * The claim is not "the numbers are right" but "**the graph is still one a face traversal can be run
 * over**". A crossing at a point that is a node of neither wall does not make the faces wrong, it
 * makes them meaningless — so the useful assertion after every edit is that `findCrossings` comes
 * back empty.
 *
 * Coordinates here are fractions of the map, so the fixtures use tenths. Nothing depends on the
 * scale; using 0.1 rather than 10 is only a reminder that the document has no pixels in it.
 */

import { describe, expect, it } from "vitest";

import { findCrossings, insertEdge, segmentMeeting } from "./planarGraph";
import { documentPoint, nodeDegrees, type FrozenGraph } from "./frozenGraph";

const at = (x: number, y: number) => documentPoint(x, y);

/** A square room: four corners, four walls, meeting only at the corners. */
const ROOM: FrozenGraph = {
  nodes: [at(0.1, 0.1), at(0.9, 0.1), at(0.9, 0.9), at(0.1, 0.9)],
  edges: [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 3, b: 0 },
  ],
};

const nodeAt = (graph: FrozenGraph, x: number, y: number): number => {
  const want = at(x, y);
  return graph.nodes.findIndex((n) => n.x === want.x && n.y === want.y);
};

describe("segmentMeeting", () => {
  it("finds a proper crossing and splits both", () => {
    const meeting = segmentMeeting(at(0, 0), at(1, 0), at(0.5, -0.5), at(0.5, 0.5))!;
    expect(meeting.kind).toBe("crossing");
    expect(meeting.point.x).toBeCloseTo(0.5, 6);
    expect(meeting.point.y).toBeCloseTo(0, 6);
    expect(meeting.splitsFirst).toBe(true);
    expect(meeting.splitsSecond).toBe(true);
  });

  it("calls an end landing inside another segment a touch, and splits only that one", () => {
    // The T. The toucher already has a node there; the crossed wall does not, so only it is cut.
    const meeting = segmentMeeting(at(0, 0), at(1, 0), at(0.5, 0), at(0.5, 0.9))!;
    expect(meeting.kind).toBe("touch");
    expect(meeting.splitsFirst).toBe(true);
    expect(meeting.splitsSecond).toBe(false);
  });

  it("is silent when two segments merely share an end", () => {
    // A junction is the ordinary case. Reporting it would split at a node that already exists.
    expect(segmentMeeting(at(0, 0), at(1, 0), at(1, 0), at(1, 0.9))).toBeNull();
    expect(segmentMeeting(at(0, 0), at(1, 0), at(0, 0), at(0, -0.9))).toBeNull();
  });

  it("is silent when segments miss, including when their infinite lines would cross", () => {
    // The case a test that only checked the lines would pass wrongly.
    expect(segmentMeeting(at(0, 0), at(0.1, 0), at(0.5, -0.05), at(0.5, 0.05))).toBeNull();
    expect(segmentMeeting(at(0, 0), at(1, 0), at(0.5, 0.05), at(0.5, 0.2))).toBeNull();
  });

  it("treats a crossing a rounding error from an end as being AT the end", () => {
    // The one tolerance floats reintroduce, and what it is for: without it this splits the segment
    // into a piece of length 1e-12, putting two nodes at visually the same place and leaving the
    // graph technically planar and practically nonsense.
    const meeting = segmentMeeting(at(0, 0), at(1, 0), at(1e-12, -0.1), at(1e-12, 0.1));
    expect(meeting?.splitsFirst ?? false).toBe(false);
  });

  it("reports a collinear overlap rather than a point", () => {
    // Splitting cannot separate these, so it is named and left. A GM doubling a line to drag the
    // copy away passes through exactly this state.
    const meeting = segmentMeeting(at(0, 0), at(1, 0), at(0.4, 0), at(1.4, 0))!;
    expect(meeting.kind).toBe("overlap");
    expect(meeting.splitsFirst).toBe(false);
  });

  it("does not call two collinear segments meeting end to end an overlap", () => {
    expect(segmentMeeting(at(0, 0), at(0.5, 0), at(0.5, 0), at(1, 0))).toBeNull();
  });
});

describe("findCrossings", () => {
  it("says a plain room is clean", () => {
    expect(findCrossings(ROOM)).toEqual([]);
  });

  it("finds a wall laid straight across a room", () => {
    const crossed: FrozenGraph = {
      nodes: [...ROOM.nodes, at(0.5, 0), at(0.5, 1)],
      edges: [...ROOM.edges, { a: 4, b: 5 }],
    };
    const found = findCrossings(crossed);
    // Through the top wall and the bottom wall.
    expect(found).toHaveLength(2);
    expect(found.every((c) => c.kind === "crossing")).toBe(true);
  });
});

describe("insertEdge", () => {
  it("leaves the graph planar after a wall crosses two others", () => {
    // The property that matters, asserted directly rather than by counting splits.
    const result = insertEdge(ROOM, [at(0.5, 0), at(0.5, 1)]);
    expect(findCrossings(result.graph)).toEqual([]);
    expect(result.splits).toBe(2);
  });

  it("puts a real junction where the crossing was", () => {
    // Not merely "a wall was cut": the point has to be one *shared* id that four segments meet at,
    // or the traversal still cannot turn there.
    const result = insertEdge(ROOM, [at(0.5, 0), at(0.5, 1)]);
    const top = nodeAt(result.graph, 0.5, 0.1);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(nodeDegrees(result.graph)[top]).toBe(4);
  });

  it("keeps the identity of every wall it did not touch", () => {
    // The document rests on shared identity surviving an edit. A segment nothing crossed must come
    // back as the same object, not a rebuilt copy that happens to look the same.
    const result = insertEdge(ROOM, [at(0.2, 0.2), at(0.3, 0.3)]);
    expect(result.splits).toBe(0);
    for (let i = 0; i < ROOM.edges.length; i++) {
      expect(result.graph.edges[i]).toBe(ROOM.edges[i]);
    }
  });

  it("reuses a node the caller resolved onto rather than duplicating it", () => {
    // The tool decides what "near enough to snap" means and passes the snapped point; this only has
    // to not duplicate it. Exact match, because the caller already did the deciding.
    const before = ROOM.nodes.length;
    const result = insertEdge(ROOM, [at(0.1, 0.1), at(0.4, 0.4)]);
    expect(nodeAt(result.graph, 0.1, 0.1)).toBe(0);
    expect(result.graph.nodes.length).toBe(before + 1);
    expect(nodeDegrees(result.graph)[0]).toBe(3);
  });

  it("splits the crossed wall when a new wall's END lands inside it", () => {
    // The T. Only the crossed wall is cut; the new one already has a node there.
    const result = insertEdge(ROOM, [at(0.5, 0.5), at(0.5, 0.1)]);
    expect(result.splits).toBe(1);
    expect(findCrossings(result.graph)).toEqual([]);
    expect(nodeDegrees(result.graph)[nodeAt(result.graph, 0.5, 0.1)]).toBe(3);
  });

  it("makes a junction where a new wall ends on an existing BEND", () => {
    // The case the polyline form got wrong. A wall drawn as two segments, met head-on at its middle
    // vertex: nothing crosses a segment's interior, so the intersection sweep finds nothing to cut.
    // With segments there is nothing to cut — the vertex is already a node — and the degree simply
    // becomes three. The defect is gone rather than repaired.
    const bent: FrozenGraph = {
      nodes: [at(0, 0.5), at(0.5, 0.5), at(1, 0.5)],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    };
    const result = insertEdge(bent, [at(0.5, 0.5), at(0.5, 0)]);
    expect(result.splits).toBe(0);
    expect(nodeDegrees(result.graph)[1]).toBe(3);
    expect(findCrossings(result.graph)).toEqual([]);
  });

  it("reports a collinear overlap and does not pretend to have fixed it", () => {
    expect(insertEdge(ROOM, [at(0.3, 0.1), at(0.7, 0.1)]).overlaps).toBeGreaterThan(0);
  });

  it("refuses to build a wall out of one point", () => {
    const result = insertEdge(ROOM, [at(0.4, 0.4), at(0.4, 0.4)]);
    expect(result.graph).toBe(ROOM);
    expect(result.splits).toBe(0);
  });

  it("splits a multi-segment wall at every crossing along it", () => {
    const result = insertEdge(ROOM, [at(0, 0.5), at(0.5, 0.5), at(1, 0.5)]);
    expect(findCrossings(result.graph)).toEqual([]);
    expect(result.splits).toBe(2);
    const degrees = nodeDegrees(result.graph);
    expect(degrees[nodeAt(result.graph, 0.1, 0.5)]).toBe(4);
    expect(degrees[nodeAt(result.graph, 0.9, 0.5)]).toBe(4);
  });

  it("cuts one wall twice in the right order", () => {
    // Two crossings on the *same* segment, which is what a wall crossed by two others looks like.
    //
    // Drawn right-to-left on purpose: the cuts are then discovered at the higher x first, so the
    // insertion order is the reverse of the order along the wall and the sort is doing real work.
    // Drawn the other way they arrive already sorted and this passes without it.
    const result = insertEdge(ROOM, [at(0.7, 0), at(0.7, 0.3), at(0.3, 0.3), at(0.3, 0)]);
    expect(findCrossings(result.graph)).toEqual([]);

    // The top wall is now three pieces, running 0.1 -> 0.3 -> 0.7 -> 0.9 in order.
    const spans = result.graph.edges
      .map((e) => [result.graph.nodes[e.a]!, result.graph.nodes[e.b]!] as const)
      .filter(([p, q]) => p.y === at(0, 0.1).y && q.y === at(0, 0.1).y)
      .map(([p, q]) => [Math.min(p.x, q.x), Math.max(p.x, q.x)])
      .sort((a, b) => a[0]! - b[0]!)
      .map((span) => span.map((v) => Number(v.toFixed(3))));
    expect(spans).toEqual([
      [0.1, 0.3],
      [0.3, 0.7],
      [0.7, 0.9],
    ]);
  });

  it("never produces a wall of zero length, on ordinary input or on sub-pixel input", () => {
    // A general invariant rather than a targeted one. `insertEdge` has a guard against a cut landing
    // on a segment's own end, and that guard is **not isolated by this test**: reaching it needs a
    // segment a float32 unit or two long, and several attempts to construct one landed either side
    // of the knife edge. What this does assert is the property the guard exists for, over both a
    // normal graph and one far below pixel scale.
    for (const [graph, wall] of [
      [ROOM, [at(0.5, 0), at(0.5, 1)]],
      [
        { nodes: [at(0.5, 0.5), at(0.5 + 1e-7, 0.5)], edges: [{ a: 0, b: 1 }] },
        [at(0.5 + 5e-8, 0.4), at(0.5 + 5e-8, 0.6)],
      ],
    ] as const) {
      for (const edge of insertEdge(graph, wall).graph.edges) expect(edge.a).not.toBe(edge.b);
    }
  });

  it("keeps every node still referenced by some wall", () => {
    // A split that dropped a node would leave the table holding a point nothing draws — harmless
    // today and a trap for anything that iterates nodes to render handles.
    const result = insertEdge(ROOM, [at(0.5, 0), at(0.5, 1)]);
    const referenced = new Set<number>();
    for (const edge of result.graph.edges) {
      referenced.add(edge.a);
      referenced.add(edge.b);
    }
    for (let id = 0; id < ROOM.nodes.length; id++) expect(referenced.has(id)).toBe(true);
  });
});
