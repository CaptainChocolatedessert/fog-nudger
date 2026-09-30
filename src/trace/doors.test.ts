import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import {
  cutDoors,
  doorEnds,
  fitDoor,
  normaliseDoors,
  placeDoors,
  segmentLength,
  type Door,
} from "./doors";
import { randomWallGraph, seededRandom } from "./fixtures";
import {
  insertEdge,
  mergeNodes,
  moveNode,
  removeEdges,
  simplifyWalls,
  splitEdgesAt,
  type EditResult,
} from "./planarOps";
import {
  compactNodes,
  decodeWallGraph,
  documentPoint,
  encodeWallGraph,
  nodeDegrees,
  type WallEdge,
  type WallGraph,
} from "./wallGraph";

const p = (x: number, y: number): Vector2 => documentPoint(x, y);

/** A straight wall from (0.1, 0.5) to (0.9, 0.5), one segment, carrying the given doors. */
function oneWall(doors: Door[]): WallGraph {
  return {
    nodes: [p(0.1, 0.5), p(0.9, 0.5)],
    edges: [{ a: 0, b: 1, doors: normaliseDoors(doors) }],
  };
}

/** Every door in a graph as its two ends in graph units. */
function doorPoints(graph: WallGraph): [Vector2, Vector2][] {
  const out: [Vector2, Vector2][] = [];
  for (const edge of graph.edges) {
    for (const door of edge.doors ?? []) out.push(doorEnds(graph, edge, door));
  }
  return out;
}

const close = (a: Vector2, b: Vector2, within = 1e-5): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= within;

describe("normaliseDoors", () => {
  it("sorts, merges overlapping and touching doors, and drops empty ones", () => {
    expect(
      normaliseDoors([
        { start: 0.5, end: 0.6 },
        { start: 0.1, end: 0.2 },
        { start: 0.2, end: 0.3 },
        { start: 0.55, end: 0.7 },
        { start: 0.8, end: 0.8 },
      ]),
    ).toEqual([
      { start: Math.fround(0.1), end: Math.fround(0.3) },
      { start: Math.fround(0.5), end: Math.fround(0.7) },
    ]);
  });

  it("keeps a door inside another as the outer one", () => {
    expect(normaliseDoors([{ start: 0.1, end: 0.5 }, { start: 0.2, end: 0.3 }])).toEqual([
      { start: Math.fround(0.1), end: Math.fround(0.5) },
    ]);
  });
});

describe("fitDoor", () => {
  it("keeps its length and centre when it fits", () => {
    const door = fitDoor(0.5, 0.2, 1)!;
    expect(door.start).toBeCloseTo(0.4, 12);
    expect(door.end).toBeCloseTo(0.6, 12);
  });

  it("slides inward at either end rather than shrinking", () => {
    expect(fitDoor(0.05, 0.2, 1)).toEqual({ start: 0, end: 0.2 });
    const late = fitDoor(0.98, 0.2, 1)!;
    expect(late.end).toBe(1);
    expect(late.end - late.start).toBeCloseTo(0.2, 12);
  });

  it("shrinks to the segment only when the segment is shorter than the door", () => {
    expect(fitDoor(0.3, 0.8, 0.5)).toEqual({ start: 0, end: 0.5 });
  });

  it("places nothing on a segment of no length", () => {
    expect(fitDoor(0, 0.1, 0)).toBeNull();
  });
});

describe("placeDoors", () => {
  it("keeps a door's place on the map when the segment it is on turns", () => {
    // A door centred at (0.5, 0.5), 0.1 long, re-placed on a segment through the same centre at 45°.
    const carried = [{ p: { x: 0.45, y: 0.5 }, q: { x: 0.55, y: 0.5 } }];
    const [door] = placeDoors(carried, { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });
    const a = { x: 0.2, y: 0.2 };
    const b = { x: 0.8, y: 0.8 };
    const length = segmentLength(a, b);
    expect(door!.end - door!.start).toBeCloseTo(0.1, 6);
    // Centred on the projection of (0.5, 0.5), which is (0.5, 0.5) itself on this line.
    expect((door!.start + door!.end) / 2).toBeCloseTo(length / 2, 6);
  });

  it("merges doors that the new segment brings together", () => {
    const carried = [
      { p: { x: 0.1, y: 0 }, q: { x: 0.3, y: 0 } },
      { p: { x: 0.35, y: 0 }, q: { x: 0.55, y: 0 } },
    ];
    // A segment only 0.3 long: both doors slide to fit and overlap.
    expect(placeDoors(carried, { x: 0, y: 0 }, { x: 0.3, y: 0 })).toHaveLength(1);
  });
});

describe("cutDoors", () => {
  const doors: Door[] = [
    { start: 0.1, end: 0.2 },
    { start: 0.4, end: 0.6 },
  ];

  it("removes a door a cut lands strictly inside", () => {
    expect(cutDoors(doors, [0.5], [0.5, 0.5])).toEqual([[{ start: Math.fround(0.1), end: Math.fround(0.2) }], []]);
  });

  it("moves a door to the piece it lies in, measured from that piece's start", () => {
    const [first, second] = cutDoors(doors, [0.3], [0.3, 0.7]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second![0]!.start).toBeCloseTo(0.1, 6);
    expect(second![0]!.end).toBeCloseTo(0.3, 6);
  });

  it("leaves a door whole when a cut lands exactly on its end", () => {
    const [first, second] = cutDoors([{ start: 0.2, end: 0.5 }], [0.5], [0.5, 0.5]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("holds a door within a piece a rounding step shorter than the cut says", () => {
    const [, second] = cutDoors([{ start: 0.5, end: 1 }], [0.5], [0.5, 0.49]);
    expect(second![0]!.end).toBeCloseTo(0.49, 6);
  });
});

describe("the edits carry doors", () => {
  it("keeps a wall's own object, doors and all, when an edit elsewhere does not touch it", () => {
    const graph = oneWall([{ start: 0.2, end: 0.3 }]);
    const result = insertEdge(graph, [p(0.1, 0.8), p(0.9, 0.8)]);
    expect(result.graph.edges[0]).toBe(graph.edges[0]);
  });

  it("keeps a door where it was when a crossing splits its wall outside it", () => {
    const graph = oneWall([{ start: 0.1, end: 0.2 }]);
    const before = doorPoints(graph);
    const result = insertEdge(graph, [p(0.7, 0.2), p(0.7, 0.8)]);
    const after = doorPoints(result.graph);
    expect(after).toHaveLength(1);
    expect(close(after[0]![0], before[0]![0])).toBe(true);
    expect(close(after[0]![1], before[0]![1])).toBe(true);
  });

  it("removes a door when a crossing lands strictly inside it", () => {
    const graph = oneWall([{ start: 0.1, end: 0.4 }]);
    // The door runs from x = 0.2 to x = 0.5; a wall across it at x = 0.3.
    const result = insertEdge(graph, [p(0.3, 0.2), p(0.3, 0.8)]);
    expect(doorPoints(result.graph)).toHaveLength(0);
  });

  it("keeps a door's place when its wall is lengthened", () => {
    const graph = oneWall([{ start: 0.2, end: 0.3 }]);
    const before = doorPoints(graph);
    const result = moveNode(graph, 1, p(1.0, 0.5));
    const after = doorPoints(result.graph);
    expect(close(after[0]![0], before[0]![0])).toBe(true);
    expect(close(after[0]![1], before[0]![1])).toBe(true);
  });

  it("slides a door along when its wall is shortened past it, keeping its length", () => {
    const graph = oneWall([{ start: 0.5, end: 0.7 }]);
    const result = moveNode(graph, 1, p(0.6, 0.5));
    const edge = result.graph.edges[0]!;
    const door = edge.doors![0]!;
    expect(door.end - door.start).toBeCloseTo(0.2, 6);
    expect(door.end).toBeCloseTo(0.5, 6);
  });

  it("shrinks a door to its wall when the wall becomes shorter than it", () => {
    const graph = oneWall([{ start: 0.1, end: 0.7 }]);
    const result = moveNode(graph, 1, p(0.4, 0.5));
    const door = result.graph.edges[0]!.doors![0]!;
    expect(door.start).toBe(0);
    expect(door.end).toBeCloseTo(0.3, 6);
  });

  it("re-places a door when its wall's end is merged into another vertex", () => {
    const graph: WallGraph = {
      nodes: [p(0.1, 0.5), p(0.9, 0.5), p(0.95, 0.5), p(0.95, 0.9)],
      edges: [
        { a: 0, b: 1, doors: [{ start: Math.fround(0.3), end: Math.fround(0.4) }] },
        { a: 2, b: 3 },
      ],
    };
    const before = doorPoints(graph);
    const result = mergeNodes(graph, 1, 2);
    const after = doorPoints(result.graph);
    expect(after).toHaveLength(1);
    expect(close(after[0]![0], before[0]![0])).toBe(true);
  });

  it("splits a door's wall at a landing outside it, and removes it for one inside", () => {
    const graph = oneWall([{ start: 0.1, end: 0.2 }]);
    const outside = splitEdgesAt(graph, [{ edge: 0, at: p(0.6, 0.5) }]);
    expect(doorPoints(outside.graph)).toHaveLength(1);
    const inside = splitEdgesAt(graph, [{ edge: 0, at: p(0.25, 0.5) }]);
    expect(doorPoints(inside.graph)).toHaveLength(0);
  });

  it("takes a door with its wall when the wall is erased, and leaves the others", () => {
    const graph: WallGraph = {
      nodes: [p(0.1, 0.1), p(0.5, 0.1), p(0.9, 0.1)],
      edges: [
        { a: 0, b: 1, doors: [{ start: Math.fround(0.1), end: Math.fround(0.2) }] },
        { a: 1, b: 2, doors: [{ start: Math.fround(0.1), end: Math.fround(0.2) }] },
      ],
    };
    const result = removeEdges(graph, [0]);
    expect(doorPoints(result.graph)).toHaveLength(1);
    expect(result.graph.edges[0]).toBe(graph.edges[1]);
  });

  it("keeps doors through compaction", () => {
    const graph: WallGraph = {
      nodes: [p(0, 0), p(0.1, 0.1), p(0.5, 0.1)],
      edges: [{ a: 1, b: 2, doors: [{ start: Math.fround(0.1), end: Math.fround(0.2) }] }],
    };
    const compacted = compactNodes(graph);
    expect(compacted.nodes).toHaveLength(2);
    expect(doorPoints(compacted)[0]).toEqual(doorPoints(graph)[0]);
  });

  it("puts a door onto the chord when Straighten merges the segments around it", () => {
    // A slightly crooked wall of two segments, a door on the second.
    const graph: WallGraph = {
      nodes: [p(0.1, 0.5), p(0.5, 0.505), p(0.9, 0.5)],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2, doors: [{ start: Math.fround(0.1), end: Math.fround(0.2) }] },
      ],
    };
    const before = doorPoints(graph)[0]!;
    const result = simplifyWalls(graph, 0.01);
    expect(result.graph.edges).toHaveLength(1);
    const after = doorPoints(result.graph);
    expect(after).toHaveLength(1);
    const edge = result.graph.edges[0]!;
    expect(edge.doors![0]!.end - edge.doors![0]!.start).toBeCloseTo(0.1, 5);
    // Within the tolerance of where it was.
    const mid = (a: Vector2, b: Vector2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    expect(close(mid(after[0]![0], after[0]![1]), mid(before[0], before[1]), 0.01)).toBe(true);
  });

  it("keeps a door exactly when Straighten leaves its segment as it was", () => {
    const graph = oneWall([{ start: 0.2, end: 0.3 }]);
    const result = simplifyWalls(graph, 0.01);
    expect(result.graph.edges[0]!.doors).toBe(graph.edges[0]!.doors);
  });
});

describe("storing doors", () => {
  it("round-trips doors exactly", () => {
    const graph: WallGraph = {
      nodes: [p(0.1, 0.1), p(0.5, 0.1), p(0.9, 0.3)],
      edges: [
        { a: 0, b: 1 },
        {
          a: 1,
          b: 2,
          doors: normaliseDoors([
            { start: 0.01, end: 0.1 },
            { start: 0.2, end: 0.3 },
          ]),
        },
      ],
    };
    expect(decodeWallGraph(encodeWallGraph(graph))).toEqual(graph);
  });

  it("reads a version 4 document as one with no doors", () => {
    const graph: WallGraph = { nodes: [p(0.1, 0.1), p(0.5, 0.1)], edges: [{ a: 0, b: 1 }] };
    const decoded = decodeWallGraph(versionFour(graph));
    expect(decoded).toEqual(graph);
    expect(nodeDegrees(decoded!)).toEqual([1, 1]);
  });

  it("refuses a door on a segment that does not exist, or with its ends out of order", () => {
    const nodes = [p(0.1, 0.1), p(0.5, 0.1)];
    const edges = [{ a: 0, b: 1 }];
    expect(decodeWallGraph(versionFive(nodes, edges, [[0, 0.1, 0.2]]))).not.toBeNull();
    expect(decodeWallGraph(versionFive(nodes, edges, [[1, 0.1, 0.2]]))).toBeNull();
    expect(decodeWallGraph(versionFive(nodes, edges, [[0, 0.2, 0.1]]))).toBeNull();
    // A door of no length is not a door; written because a mutation accepting one survived.
    expect(decodeWallGraph(versionFive(nodes, edges, [[0, 0.1, 0.1]]))).toBeNull();
    expect(decodeWallGraph(versionFive(nodes, edges, [[0, -0.1, 0.1]]))).toBeNull();
  });
});

/*
  The store's bytes, written here by hand rather than through the encoder, so the decoder is tested
  against the layout the header describes and not against itself.
*/
function bytesFor(
  version: number,
  nodes: readonly Vector2[],
  edges: readonly { a: number; b: number }[],
  doors: readonly [number, number, number][] | null,
): string {
  const body: number[] = [];
  const varint = (value: number) => {
    let rest = value;
    while (rest >= 0x80) {
      body.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    body.push(rest);
  };
  const float = (value: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) body.push(view.getUint8(i));
  };
  varint(nodes.length);
  for (const node of nodes) {
    float(node.x);
    float(node.y);
  }
  varint(edges.length);
  for (const edge of edges) {
    varint(edge.a);
    varint(edge.b);
  }
  if (doors) {
    varint(doors.length);
    for (const [edge, start, end] of doors) {
      varint(edge);
      float(start);
      float(end);
    }
  }
  let hash = 0x811c9dc5;
  for (const byte of body) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const all = [version, hash & 0xff, (hash >>> 8) & 0xff, (hash >>> 16) & 0xff, hash >>> 24, ...body];
  return btoa(String.fromCharCode(...all));
}

const versionFour = (graph: WallGraph) =>
  bytesFor(4, graph.nodes, graph.edges, null);
const versionFive = (
  nodes: readonly Vector2[],
  edges: readonly { a: number; b: number }[],
  doors: readonly [number, number, number][],
) => bytesFor(5, nodes, edges, doors);

/*
  ## The sweep, against an oracle that shares none of the implementation's reasoning

  Random graphs with random doors, and random edits of every kind that rebuilds a segment. The oracle
  never looks at a cut, a piece or a projection the code made. It works from geometry alone:

  - **An edit that moves nothing** (a new wall, a split, an erase, compaction) must leave every door
    exactly where it was when some one segment of the new graph still holds both its ends, and remove
    it otherwise — that is what "a vertex strictly inside removes it" and "erasing its wall takes it"
    come to, stated without either.
  - **A move or a merge** re-places the doors on the moved segments. The oracle finds the placement by
    searching every position a door of the kept length can take along the new segment for the one whose
    midpoint is nearest the old midpoint — a numerical minimum rather than a projection — then applies
    the rule above.
  - **Straighten** is checked more weakly, since which chord replaced which segment is exactly what the
    oracle would have to share: every door afterwards lies within the tolerance of a door before it,
    and every door before it either survives within the tolerance or was near a vertex that could have
    cut it.

  And for everything: each door lies within its segment, and doors on one segment never overlap.
*/

const EPS = 1e-5;

function distanceToSegment(point: Vector2, a: Vector2, b: Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const t = span > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span)) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function withRandomDoors(graph: WallGraph, next: () => number): WallGraph {
  const edges: WallEdge[] = graph.edges.map((edge) => {
    const length = segmentLength(graph.nodes[edge.a]!, graph.nodes[edge.b]!);
    if (next() > 0.35 || !(length > 0.02)) return edge;
    const doors: Door[] = [];
    const count = next() < 0.3 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const s = next() * length;
      const e = next() * length;
      const [start, end] = s < e ? [s, e] : [e, s];
      if (end - start > length * 0.02) doors.push({ start, end });
    }
    const normalised = normaliseDoors(doors).filter((door) => door.end <= length);
    return normalised.length > 0 ? { a: edge.a, b: edge.b, doors: normalised } : edge;
  });
  return { nodes: graph.nodes, edges };
}

/** Each door sits within its segment, and doors on one segment are sorted and apart. */
function assertWellFormed(graph: WallGraph): void {
  for (const edge of graph.edges) {
    if (!edge.doors) continue;
    expect(edge.doors.length).toBeGreaterThan(0);
    const length = segmentLength(graph.nodes[edge.a]!, graph.nodes[edge.b]!);
    let last = -Infinity;
    for (const door of edge.doors) {
      expect(door.start).toBeGreaterThanOrEqual(0);
      expect(door.end).toBeGreaterThan(door.start);
      expect(door.end).toBeLessThanOrEqual(length + EPS);
      expect(door.start).toBeGreaterThan(last);
      last = door.end;
    }
  }
}

/** The segments of a graph, as geometry. */
function segments(graph: WallGraph): [Vector2, Vector2][] {
  return graph.edges.map((edge) => [graph.nodes[edge.a]!, graph.nodes[edge.b]!]);
}

/**
 * Whether some one segment of the graph holds both points.
 *
 * **Tight, at 2e-7 of the map**: a split point is quantised to float32, so a piece can sit a rounding step
 * (about 6e-8 here) off the line it was cut from, and nothing looser is needed. A looser test calls a
 * door held by a piece that a vertex a few ten-millionths inside it has already cut — which the random
 * graphs do produce, where the crossing sweep leaves two vertices that close together.
 */
function heldByOneSegment(graph: WallGraph, pair: [Vector2, Vector2]): boolean {
  const within = 2e-7;
  return segments(graph).some(
    ([a, b]) => distanceToSegment(pair[0], a, b) <= within && distanceToSegment(pair[1], a, b) <= within,
  );
}

/** Union of overlapping door intervals along one line, as the oracle's own merge. */
function unionAlong(a: Vector2, b: Vector2, pairs: [Vector2, Vector2][]): [Vector2, Vector2][] {
  const length = segmentLength(a, b);
  const along = (point: Vector2) => ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length;
  const intervals = pairs
    .map(([s, e]) => [along(s), along(e)].sort((x, y) => x - y) as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + EPS) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const at = (d: number): Vector2 => ({ x: a.x + ((b.x - a.x) * d) / length, y: a.y + ((b.y - a.y) * d) / length });
  return merged.map(([s, e]) => [at(s), at(e)]);
}

/** Every expected pair matched by exactly one actual pair, ends in either order. */
function assertSameDoors(
  actual: [Vector2, Vector2][],
  expected: [Vector2, Vector2][],
  tolerance = EPS,
  label = "",
): void {
  const left = [...actual];
  for (const [s, e] of expected) {
    const found = left.findIndex(
      ([x, y]) => (close(x, s, tolerance) && close(y, e, tolerance)) || (close(x, e, tolerance) && close(y, s, tolerance)),
    );
    expect(found, `${label}: expected a door from (${s.x}, ${s.y}) to (${e.x}, ${e.y}) among ${JSON.stringify(left)}`).toBeGreaterThanOrEqual(0);
    left.splice(found, 1);
  }
  expect(left, `${label}: unexpected doors`).toHaveLength(0);
}

/**
 * Where the oracle puts a door of `length` on segment a→b: nearest its old midpoint, found by a
 * golden-section search over every position the door can take — a numerical minimum, not a projection.
 */
function searchedPlacement(a: Vector2, b: Vector2, mid: Vector2, doorLength: number): [Vector2, Vector2] | null {
  const length = segmentLength(a, b);
  if (!(length > 0)) return null;
  const kept = Math.min(doorLength, length);
  const at = (d: number): Vector2 => ({ x: a.x + ((b.x - a.x) * d) / length, y: a.y + ((b.y - a.y) * d) / length });
  const cost = (start: number) => {
    const s = at(start);
    const e = at(start + kept);
    return Math.hypot((s.x + e.x) / 2 - mid.x, (s.y + e.y) / 2 - mid.y);
  };
  const ratio = (Math.sqrt(5) - 1) / 2;
  let low = 0;
  let high = length - kept;
  for (let i = 0; i < 200 && high - low > 1e-15; i++) {
    const left = high - ratio * (high - low);
    const right = low + ratio * (high - low);
    if (cost(left) <= cost(right)) high = right;
    else low = left;
  }
  const start = (low + high) / 2;
  return [at(start), at(start + kept)];
}

type Edit = { kind: string; result: EditResult; moved?: { node: number; to: Vector2 }; removed?: Set<number> };

function randomEdit(graph: WallGraph, next: () => number): Edit | null {
  const referenced = nodeDegrees(graph)
    .map((degree, id) => (degree > 0 ? id : -1))
    .filter((id) => id >= 0);
  if (referenced.length < 2 || graph.edges.length === 0) return null;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const roll = next();
  if (roll < 0.25) {
    const result = insertEdge(graph, [p(next() * 1.1, next() * 1.1), p(next() * 1.1, next() * 1.1)]);
    return { kind: "insert", result };
  }
  if (roll < 0.45) {
    const node = pick(referenced);
    const to = p(next() * 1.1, next() * 1.1);
    return { kind: "move", result: moveNode(graph, node, to), moved: { node, to } };
  }
  if (roll < 0.55) {
    const from = pick(referenced);
    const into = pick(referenced);
    if (from === into) return null;
    return { kind: "merge", result: mergeNodes(graph, from, into), moved: { node: from, to: graph.nodes[into]! } };
  }
  if (roll < 0.7) {
    const edge = Math.floor(next() * graph.edges.length);
    const { a, b } = graph.edges[edge]!;
    const t = next();
    const from = graph.nodes[a]!;
    const to = graph.nodes[b]!;
    const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    return { kind: "split", result: splitEdgesAt(graph, [{ edge, at }]) };
  }
  if (roll < 0.85) {
    const removed = new Set<number>();
    for (let i = 0; i < graph.edges.length; i++) if (next() < 0.15) removed.add(i);
    return { kind: "remove", result: removeEdges(graph, removed), removed };
  }
  return { kind: "compact", result: { graph: compactNodes(graph), splits: 0, overlaps: 0 } };
}

/** What the oracle expects an edit that moved at most one vertex to leave. */
function expectedDoors(before: WallGraph, edit: Edit): [Vector2, Vector2][] {
  const after = edit.result.graph;
  const expected: [Vector2, Vector2][] = [];
  before.edges.forEach((edge, index) => {
    if (!edge.doors || edit.removed?.has(index)) return;
    const pairs = edge.doors.map((door) => doorEnds(before, edge, door));
    const moved = edit.moved;
    const touches = moved && (edge.a === moved.node || edge.b === moved.node);
    if (!touches) {
      for (const pair of pairs) if (heldByOneSegment(after, pair)) expected.push(pair);
      return;
    }
    const a = edge.a === moved.node ? moved.to : before.nodes[edge.a]!;
    const b = edge.b === moved.node ? moved.to : before.nodes[edge.b]!;
    // A merge that closes a wall up drops it, and its doors with it.
    if (segmentLength(a, b) === 0) return;
    const placed = pairs
      .map(([s, e]) =>
        searchedPlacement(a, b, { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }, segmentLength(s, e)),
      )
      .filter((pair): pair is [Vector2, Vector2] => pair !== null);
    for (const pair of unionAlong(a, b, placed)) if (heldByOneSegment(after, pair)) expected.push(pair);
  });
  return expected;
}

describe("doors through random edits, against a geometric oracle", () => {
  it("every edit that rebuilds a segment carries its doors by the rules", () => {
    const next = seededRandom(2029);
    const reached = { insert: 0, move: 0, merge: 0, split: 0, remove: 0, compact: 0, removedInside: 0, moved: 0 };
    let checked = 0;
    for (let seed = 0; seed < 400; seed++) {
      let graph = withRandomDoors(randomWallGraph(next, 3 + Math.floor(next() * 6)), next);
      for (let step = 0; step < 6; step++) {
        const edit = randomEdit(graph, next);
        if (!edit || edit.result.overlaps > 0) continue;
        const after = edit.result.graph;
        assertWellFormed(after);
        const tolerance = 1e-6;
        assertSameDoors(doorPoints(after), expectedDoors(graph, edit), tolerance, edit.kind);
        reached[edit.kind as keyof typeof reached] += 1;
        const beforeCount = doorPoints(graph).length;
        if (!edit.moved && !edit.removed && doorPoints(after).length < beforeCount) reached.removedInside += 1;
        if (edit.moved && graph.edges.some((e) => e.doors && (e.a === edit.moved!.node || e.b === edit.moved!.node))) {
          reached.moved += 1;
        }
        checked += 1;
        graph = after;
      }
    }
    // A sweep has to be shown to reach its cases, not only to pass.
    expect(checked).toBeGreaterThan(1500);
    for (const [kind, count] of Object.entries(reached)) expect(count, kind).toBeGreaterThan(20);
    // A long sweep, given its own timeout: under the full suite's load it passes the 5 s default
    // and reads like a real failure (DESIGN.md §8, *A long sweep needs its own timeout*).
  }, 30_000);

  it("Straighten keeps every door near where it was", () => {
    const next = seededRandom(9);
    let survived = 0;
    let doorsSeen = 0;
    for (let seed = 0; seed < 300; seed++) {
      // Crooked walls: a random graph with every vertex nudged, so Straighten has bends to take out.
      const base = randomWallGraph(next, 3 + Math.floor(next() * 6));
      const graph = withRandomDoors(
        {
          nodes: base.nodes.map((node) => p(node.x + (next() - 0.5) * 0.02, node.y + (next() - 0.5) * 0.02)),
          edges: base.edges,
        },
        next,
      );
      const tolerance = 0.005 + next() * 0.03;
      const result = simplifyWalls(graph, tolerance);
      if (result.overlaps > 0) continue;
      assertWellFormed(result.graph);
      const before = doorPoints(graph);
      const after = doorPoints(result.graph);
      const mid = ([s, e]: [Vector2, Vector2]) => ({ x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 });
      // Nothing appears from nowhere: each door afterwards passes within the tolerance of a door's
      // old midpoint.
      for (const [s, e] of after) {
        expect(before.some((old) => distanceToSegment(mid(old), s, e) <= tolerance + EPS)).toBe(true);
      }
      // Nothing vanishes unexplained: each door before survives near its old midpoint, or a vertex of
      // the new graph came near enough to have cut it.
      for (const old of before) {
        doorsSeen += 1;
        const m = mid(old);
        if (after.some(([s, e]) => distanceToSegment(m, s, e) <= tolerance + EPS)) {
          survived += 1;
          continue;
        }
        const reach = tolerance + segmentLength(old[0], old[1]) + EPS;
        expect(result.graph.nodes.some((node) => close(node, m, reach))).toBe(true);
      }
    }
    expect(doorsSeen).toBeGreaterThan(300);
    expect(survived).toBeGreaterThan(doorsSeen * 0.8);
    // A long sweep, given its own timeout: under the full suite's load it passes the 5 s default
    // and reads like a real failure (DESIGN.md §8, *A long sweep needs its own timeout*).
  }, 30_000);
});
