/**
 * The document's construction and its encoding.
 *
 * Three separate claims. **`freezeGraph` preserves shared identity** — two rooms either side of a
 * wall reference the same ids, which is the entire reason editing lives in metadata rather than in
 * the scene. **The round trip is exact**, because stage two never re-derives, so a graph that comes
 * back slightly different is a graph the GM's edits were made against and no longer have. And
 * **coordinates are fractions of the map**, so the document does not depend on a raster that exists
 * only because of our memory budget.
 */

import { describe, expect, it } from "vitest";

import { buildWallGraph } from "./wallGraph";
import { maskFromRows } from "./fixtures";
import { resolveFaces } from "./faces";
import { simplifyPolyline } from "./simplify";
import {
  decodeFrozenGraph,
  documentPoint,
  encodeFrozenGraph,
  compactNodes,
  freezeGraph,
  nodeDegrees,
  wallRuns,
  type FrozenGraph,
} from "./frozenGraph";

/** Two rooms sharing a wall, plus a stub hanging off the bottom. */
const TWO_ROOMS = [
  "....................",
  "....................",
  "..###############...",
  "..#......#......#...",
  "..#......#......#...",
  "..#......#......#...",
  "..###############...",
  ".........#..........",
  ".........#..........",
  "....................",
  "....................",
];

/** Build a frozen graph the way the pipeline will: derive, clean, fit, freeze. */
function frozen(rows: readonly string[], tolerance = 1): FrozenGraph {
  const graph = buildWallGraph(maskFromRows(rows));
  const resolved = resolveFaces(graph);
  // Per edge, which is the whole of fitting now that faces are not assembled here.
  const fitted = resolved.graph.edges.map((edge) => ({
    points: simplifyPolyline(edge.points, tolerance),
  }));
  return freezeGraph(resolved.graph, fitted).graph;
}

describe("compactNodes", () => {
  const graph = (points: readonly [number, number][], edges: readonly [number, number][]) => ({
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  });

  it("drops the vertices no wall uses and renumbers what is left", () => {
    // Node 1 is used by nothing — the state erasing and merging leave behind.
    const withJunk = graph(
      [
        [0.1, 0.1],
        [0.5, 0.5],
        [0.9, 0.1],
      ],
      [[0, 2]],
    );
    const tidy = compactNodes(withJunk);

    expect(tidy.nodes).toEqual([documentPoint(0.1, 0.1), documentPoint(0.9, 0.1)]);
    // The surviving wall still joins the same two places, under the ids they now have.
    expect(tidy.edges).toEqual([{ a: 0, b: 1 }]);
  });

  it("keeps every wall pointing at the same coordinates it did", () => {
    const withJunk = graph(
      [
        [0.2, 0.2],
        [0.3, 0.3],
        [0.4, 0.4],
        [0.5, 0.5],
        [0.6, 0.6],
      ],
      [
        [1, 3],
        [3, 4],
      ],
    );
    const tidy = compactNodes(withJunk);

    for (const [before, after] of withJunk.edges.map((edge, i) => [edge, tidy.edges[i]!] as const)) {
      expect(tidy.nodes[after.a]).toEqual(withJunk.nodes[before.a]);
      expect(tidy.nodes[after.b]).toEqual(withJunk.nodes[before.b]);
    }
  });

  it("returns the very same graph when there is nothing to drop", () => {
    const tight = graph(
      [
        [0.1, 0.1],
        [0.9, 0.9],
      ],
      [[0, 1]],
    );

    // Identity, not equality: the caller can skip a rebuild and a write on it.
    expect(compactNodes(tight)).toBe(tight);
  });

  it("survives a graph with no walls at all", () => {
    const bare = graph([[0.1, 0.1]], []);

    expect(compactNodes(bare).nodes).toEqual([]);
    expect(compactNodes(bare).edges).toEqual([]);
  });
});

describe("freezeGraph", () => {
  it("drops a wall that simplification laid on top of another, and counts it", () => {
    /*
      The defect a room found on 2026-09-05, in the shape it actually took.

      Two walls bound a room thinner than the smoothing tolerance, so both fit to the *same* straight
      line between the same two corners. Kept, they are coincident segments enclosing nothing: the
      face traversal reports Euler's identity failing, and the trace's room count and the document's
      differ by one. Dropped, the thin room is gone — which is the cost, and why the count is
      returned rather than swallowed (user, 2026-09-05).
    */
    const wall = (a: number, b: number, points: readonly { x: number; y: number }[]) => ({
      a,
      b,
      points,
    });
    const derived = {
      width: 100,
      height: 100,
      nodes: [
        { x: 10, y: 50 },
        { x: 90, y: 50 },
      ],
      edges: [
        wall(0, 1, [
          { x: 10, y: 50 },
          { x: 50, y: 49 },
          { x: 90, y: 50 },
        ]),
        wall(0, 1, [
          { x: 10, y: 50 },
          { x: 50, y: 51 },
          { x: 90, y: 50 },
        ]),
      ],
    } as unknown as Parameters<typeof freezeGraph>[0];

    // Both chains fitted down to their two shared endpoints, which is what collapses the room.
    const fitted = [
      { points: [{ x: 10, y: 50 }, { x: 90, y: 50 }] },
      { points: [{ x: 10, y: 50 }, { x: 90, y: 50 }] },
    ];

    const frozen = freezeGraph(derived, fitted);

    expect(frozen.graph.edges).toHaveLength(1);
    expect(frozen.duplicates).toBe(1);
    expect(frozen.zeroLength).toBe(0);
  });

  it("drops a wall whose ends quantised onto one point", () => {
    const derived = {
      width: 100,
      height: 100,
      nodes: [
        { x: 10, y: 50 },
        { x: 10, y: 50 },
      ],
      edges: [{ a: 0, b: 1, points: [{ x: 10, y: 50 }, { x: 10, y: 50 }] }],
    } as unknown as Parameters<typeof freezeGraph>[0];

    // No direction, so nothing can sort it into a rotation and the traversal cannot use it.
    const frozen = freezeGraph(derived, [{ points: [{ x: 10, y: 50 }, { x: 10, y: 50 }] }]);

    expect(frozen.graph.edges).toEqual([]);
    expect(frozen.zeroLength).toBe(1);
  });

  it("stores fractions of the map, never raster pixels", () => {
    // The whole point of the change: the raster is an artefact of the megapixel cap, so a document
    // denominated in it is a document that goes stale when a budget constant moves.
    const graph = frozen(TWO_ROOMS);
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
    // And they are genuinely fractional rather than integers that happen to be small.
    expect(graph.nodes.some((n) => !Number.isInteger(n.x) || !Number.isInteger(n.y))).toBe(true);
  });

  it("gives every edge exactly two nodes", () => {
    // Segments, not polylines. This is what makes a junction at a non-node impossible rather than
    // something a normalisation pass has to repair.
    const graph = frozen(TWO_ROOMS);
    for (const edge of graph.edges) {
      expect(edge.a).toBeGreaterThanOrEqual(0);
      expect(edge.a).toBeLessThan(graph.nodes.length);
      expect(edge.b).toBeGreaterThanOrEqual(0);
      expect(edge.b).toBeLessThan(graph.nodes.length);
    }
  });

  it("makes junctions shared by reference, not merely coincident", () => {
    // A junction is one id that three or more segments meet at — not three points that happen to
    // hold equal coordinates, which is what the emitted fog degrades to and why editing cannot be
    // done there.
    const graph = frozen(TWO_ROOMS);
    const degrees = nodeDegrees(graph);
    expect(degrees.filter((d) => d >= 3).length).toBeGreaterThan(0);

    for (let id = 0; id < graph.nodes.length; id++) {
      if (degrees[id]! < 3) continue;
      const here = graph.nodes[id]!;
      expect(graph.nodes.filter((n) => n.x === here.x && n.y === here.y).length).toBe(1);
    }
  });

  it("carries the fitted geometry, not the pixel chain", () => {
    // A coarse tolerance must actually reduce the point count, or the freeze is storing the wrong
    // artefact — which is the mistake the first version of this made.
    expect(frozen(TWO_ROOMS, 3).nodes.length).toBeLessThan(frozen(TWO_ROOMS, 0).nodes.length);
  });

  it("quantises to float32 so storage cannot change a coordinate", () => {
    const graph = frozen(TWO_ROOMS);
    for (const node of graph.nodes) {
      expect(node.x).toBe(Math.fround(node.x));
      expect(node.y).toBe(Math.fround(node.y));
    }
  });
});

describe("wallRuns", () => {
  it("chains segments back into walls through their bends", () => {
    // The polyline, recovered rather than stored. A run ends where the degree does.
    const graph = frozen(TWO_ROOMS);
    const runs = wallRuns(graph);
    const degrees = nodeDegrees(graph);
    expect(runs.length).toBeGreaterThan(0);

    for (const run of runs) {
      expect(run.length).toBeGreaterThanOrEqual(2);
      // Everything strictly inside a run is a bend; the ends are not.
      for (let i = 1; i < run.length - 1; i++) expect(degrees[run[i]!]).toBe(2);
    }
    // Every segment belongs to exactly one run.
    const counted = runs.reduce((total, run) => total + run.length - 1, 0);
    expect(counted).toBe(graph.edges.length);
  });

  it("walks a closed loop that has no junction to start from", () => {
    // Every node degree 2, so there is no end to begin at and the fallback has to find it.
    const ring: FrozenGraph = {
      nodes: [
        documentPoint(0.1, 0.1),
        documentPoint(0.9, 0.1),
        documentPoint(0.9, 0.9),
        documentPoint(0.1, 0.9),
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 3, b: 0 },
      ],
    };
    const runs = wallRuns(ring);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(5);
    expect(runs[0]![0]).toBe(runs[0]![4]);
  });

  it("splits a run at a junction rather than running through it", () => {
    // A T. The crossbar is one run and the stem is another; nothing chains through degree 3.
    const tee: FrozenGraph = {
      nodes: [
        documentPoint(0.1, 0.5),
        documentPoint(0.5, 0.5),
        documentPoint(0.9, 0.5),
        documentPoint(0.5, 0.9),
      ],
      edges: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 1, b: 3 },
      ],
    };
    const runs = wallRuns(tee);
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run).toHaveLength(2);
  });
});

describe("encodeFrozenGraph and decodeFrozenGraph", () => {
  it("round-trips exactly", () => {
    const graph = frozen(TWO_ROOMS);
    expect(decodeFrozenGraph(encodeFrozenGraph(graph))).toEqual({
      nodes: [...graph.nodes],
      edges: graph.edges.map((e) => ({ a: e.a, b: e.b })),
    });
  });

  it("round-trips an empty graph rather than refusing one", () => {
    // A map with no linework the reading found is a legitimate state, not a failure to interpret.
    const empty: FrozenGraph = { nodes: [], edges: [] };
    expect(decodeFrozenGraph(encodeFrozenGraph(empty))).toEqual(empty);
  });

  it("keeps sharing across the round trip, which is the point of storing it at all", () => {
    const before = frozen(TWO_ROOMS);
    expect(nodeDegrees(decodeFrozenGraph(encodeFrozenGraph(before))!)).toEqual(nodeDegrees(before));
  });

  it("stays well inside the metadata limit", () => {
    // 512KB per key is the measured ceiling. Eight bytes a node plus a couple per edge reference,
    // and base64's third on top — so this checks the shape of the cost, not an absolute figure.
    const graph = frozen(TWO_ROOMS);
    expect(encodeFrozenGraph(graph).length / graph.nodes.length).toBeLessThan(24);
  });
});

describe("decodeFrozenGraph, refusing", () => {
  const bytesOf = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const textOf = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("refuses text that is not base64", () => {
    expect(decodeFrozenGraph("not a graph at all")).toBeNull();
    expect(decodeFrozenGraph("")).toBeNull();
  });

  it("refuses a different format version", () => {
    const bytes = bytesOf(encodeFrozenGraph(frozen(TWO_ROOMS)));
    bytes[0] = 99;
    expect(decodeFrozenGraph(textOf(bytes))).toBeNull();
  });

  it("refuses a corrupted coordinate, which ONLY the checksum can see", () => {
    // The reason the checksum exists. A corrupted coordinate is a different and entirely plausible
    // coordinate — a wall silently somewhere it does not belong — and no structural check can tell.
    // Byte 10 is inside the first node's x: version, four checksum bytes, one node-count varint,
    // then four bytes of float. Changing it leaves every offset and every id intact.
    const bytes = bytesOf(encodeFrozenGraph(frozen(TWO_ROOMS)));
    bytes[10] = bytes[10]! ^ 0x40;
    expect(decodeFrozenGraph(textOf(bytes))).toBeNull();
  });

  it("refuses a truncated payload rather than returning the part it read", () => {
    const binary = atob(encodeFrozenGraph(frozen(TWO_ROOMS)));
    expect(decodeFrozenGraph(btoa(binary.slice(0, Math.floor(binary.length / 2))))).toBeNull();
  });

  it("refuses appended bytes", () => {
    // The checksum covers the body, so appended bytes fail it before the trailing-byte check is
    // reached. That check stays as defence in depth against a payload whose declared counts stop the
    // reader early while the checksum still matches — reachable only by deliberate construction, so
    // it is not isolated by a test here. Recorded rather than left to look like coverage.
    const binary = atob(encodeFrozenGraph(frozen(TWO_ROOMS)));
    expect(decodeFrozenGraph(btoa(binary + " "))).toBeNull();
  });

  it("refuses an edge naming a node that does not exist", () => {
    // No sensible fallback exists — there is no "default edge" the way a bad blur has a default —
    // and a graph with an edge quietly dropped is a corrupt document presented as a valid one.
    const nodes = [documentPoint(0.1, 0.1), documentPoint(0.4, 0.4)];
    expect(decodeFrozenGraph(encodeFrozenGraph({ nodes, edges: [{ a: 0, b: 1 }] }))).not.toBeNull();
    expect(decodeFrozenGraph(encodeFrozenGraph({ nodes, edges: [{ a: 0, b: 2 }] }))).toBeNull();
  });
});
