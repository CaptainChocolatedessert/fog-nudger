/**
 * The document's construction and its encoding.
 *
 * Three separate claims. **`buildWallGraph` preserves shared identity** — two rooms either side of a
 * wall reference the same ids, which is the entire reason editing lives in metadata rather than in
 * the scene. **The round trip is exact**, because stage two never re-derives, so a graph that comes
 * back slightly different is a graph the GM's edits were made against and no longer have. And
 * **coordinates are fractions of the map**, so the document does not depend on a raster that exists
 * only because of our memory budget.
 */

import { describe, expect, it } from "vitest";

import { buildSkeletonGraph } from "./skeletonGraph";
import { maskFromRows } from "./fixtures";
import { resolveFaces } from "./faces";
import { simplifyPolyline } from "./simplify";
import {
  decodeWallGraph,
  documentPoint,
  encodeWallGraph,
  compactNodes,
  buildWallGraph,
  nodeDegrees,
  wallRuns,
  type WallGraph,
} from "./wallGraph";
import { graphExtent } from "./graphUnits";

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

/** Build a wall graph the way the pipeline will: derive, clean, fit, derive. */
function wallGraphFrom(rows: readonly string[], tolerance = 1): WallGraph {
  const graph = buildSkeletonGraph(maskFromRows(rows));
  const resolved = resolveFaces(graph);
  // Per edge, which is the whole of fitting now that faces are not assembled here.
  const fitted = resolved.graph.edges.map((edge) => ({
    points: simplifyPolyline(edge.points, tolerance),
  }));
  return buildWallGraph(resolved.graph, fitted, graphExtent(resolved.graph.width, resolved.graph.height)).graph;
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

describe("buildWallGraph", () => {
  /*
    Raster pixels into graph units — the map's longer side is 1 — per axis against the raster.

    Added with the unit on 2026-09-16. The fixtures below are all square rasters, where every unit
    this document has ever used gives the same numbers, so nothing else in this file can tell graph
    units from fractions of each side. Two mutations — fractions of each side, and dividing by the
    raster's longer side — two caught, one by each of these tests.
  */
  it("puts a non-square raster into graph units, the longer side 1 and the other its share", () => {
    const derived = {
      width: 200,
      height: 100,
      nodes: [
        { x: 0, y: 0 },
        { x: 200, y: 100 },
      ],
      edges: [{ a: 0, b: 1, points: [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 100 }] }],
    } as unknown as Parameters<typeof buildWallGraph>[0];
    // A bend at the middle, so the interior point is stored rather than dropped as collinear.
    const fitted = [{ points: [{ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 200, y: 100 }] }];

    const built = buildWallGraph(derived, fitted, graphExtent(200, 100));

    expect(built.graph.nodes).toContainEqual({ x: 0, y: 0 });
    expect(built.graph.nodes).toContainEqual({ x: 1, y: 0.5 });
    // 100 of 200 across and 40 of 100 down: half the long side, and 0.4 of the short one's 0.5.
    expect(built.graph.nodes).toContainEqual({ x: 0.5, y: Math.fround(0.2) });
  });

  it("puts a capped raster's far edge exactly on the image's extent, not a pixel short", () => {
    /*
      A capped raster is the image divided by an integer factor and floored, so its aspect can be a
      pixel off the image's: 3301 by 2551 at factor 2 is 1650 by 1275. Dividing by the raster's own
      longer side would leave the far corner at 1275/1650, short of the image's 2551/3301. Converting
      per axis against the raster and scaling to the image's extent puts it on the edge.
    */
    const extent = graphExtent(3301, 2551);
    const derived = {
      width: 1650,
      height: 1275,
      nodes: [
        { x: 0, y: 0 },
        { x: 1650, y: 1275 },
      ],
      edges: [{ a: 0, b: 1, points: [{ x: 0, y: 0 }, { x: 1650, y: 1275 }] }],
    } as unknown as Parameters<typeof buildWallGraph>[0];

    const built = buildWallGraph(derived, [{ points: derived.edges[0]!.points }], extent);

    expect(built.graph.nodes[1]).toEqual({ x: extent.x, y: extent.y });
    expect(extent.y).not.toBe(Math.fround(1275 / 1650));
  });

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
    } as unknown as Parameters<typeof buildWallGraph>[0];

    // Both chains fitted down to their two shared endpoints, which is what collapses the room.
    const fitted = [
      { points: [{ x: 10, y: 50 }, { x: 90, y: 50 }] },
      { points: [{ x: 10, y: 50 }, { x: 90, y: 50 }] },
    ];

    const built = buildWallGraph(derived, fitted, graphExtent(derived.width, derived.height));

    expect(built.graph.edges).toHaveLength(1);
    expect(built.duplicates).toBe(1);
    expect(built.zeroLength).toBe(0);
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
    } as unknown as Parameters<typeof buildWallGraph>[0];

    // No direction, so nothing can sort it into a rotation and the traversal cannot use it.
    const built = buildWallGraph(
      derived,
      [{ points: [{ x: 10, y: 50 }, { x: 10, y: 50 }] }],
      graphExtent(derived.width, derived.height),
    );

    expect(built.graph.edges).toEqual([]);
    expect(built.zeroLength).toBe(1);
  });

  it("stores fractions of the map, never raster pixels", () => {
    // The whole point of the change: the raster is an artefact of the megapixel cap, so a document
    // denominated in it is a document that goes stale when a budget constant moves.
    const graph = wallGraphFrom(TWO_ROOMS);
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
    const graph = wallGraphFrom(TWO_ROOMS);
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
    const graph = wallGraphFrom(TWO_ROOMS);
    const degrees = nodeDegrees(graph);
    expect(degrees.filter((d) => d >= 3).length).toBeGreaterThan(0);

    for (let id = 0; id < graph.nodes.length; id++) {
      if (degrees[id]! < 3) continue;
      const here = graph.nodes[id]!;
      expect(graph.nodes.filter((n) => n.x === here.x && n.y === here.y).length).toBe(1);
    }
  });

  it("carries the fitted geometry, not the pixel chain", () => {
    /*
      A coarse tolerance must actually reduce the point count, or the derivation is storing the wrong
      artefact — which is the mistake the first version of this made.

      **On a jagged shape**, and that qualifier became necessary on 2026-09-08. `TWO_ROOMS` is all
      straight lines, and since the derivation gained a lossless collinear pass a rectangle is already
      down to its corners at a tolerance of zero: no fitting can take it further, so comparing two
      tolerances there compares seven against seven. A staircase is where a tolerance has something
      to remove.
    */
    const JAGGED = [
      "..............",
      "..............",
      "..#########...",
      "..#.......#...",
      "..#.......##..",
      "..#........#..",
      "..#.......##..",
      "..#.......#...",
      "..#########...",
      "..............",
    ];
    expect(wallGraphFrom(JAGGED, 3).nodes.length).toBeLessThan(wallGraphFrom(JAGGED, 0).nodes.length);
  });

  it("quantises to float32 so storage cannot change a coordinate", () => {
    const graph = wallGraphFrom(TWO_ROOMS);
    for (const node of graph.nodes) {
      expect(node.x).toBe(Math.fround(node.x));
      expect(node.y).toBe(Math.fround(node.y));
    }
  });
});

describe("wallRuns", () => {
  it("chains segments back into walls through their bends", () => {
    // The polyline, recovered rather than stored. A run ends where the degree does.
    const graph = wallGraphFrom(TWO_ROOMS);
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
    const ring: WallGraph = {
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
    const tee: WallGraph = {
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

describe("encodeWallGraph and decodeWallGraph", () => {
  it("round-trips exactly", () => {
    const graph = wallGraphFrom(TWO_ROOMS);
    expect(decodeWallGraph(encodeWallGraph(graph))).toEqual({
      nodes: [...graph.nodes],
      edges: graph.edges.map((e) => ({ a: e.a, b: e.b })),
    });
  });

  it("round-trips an empty graph rather than refusing one", () => {
    // A map with no linework the reading found is a legitimate state, not a failure to interpret.
    const empty: WallGraph = { nodes: [], edges: [] };
    expect(decodeWallGraph(encodeWallGraph(empty))).toEqual(empty);
  });

  it("keeps sharing across the round trip, which is the point of storing it at all", () => {
    const before = wallGraphFrom(TWO_ROOMS);
    expect(nodeDegrees(decodeWallGraph(encodeWallGraph(before))!)).toEqual(nodeDegrees(before));
  });

  it("stays well inside the metadata limit", () => {
    // 512KB per key is the measured ceiling. Eight bytes a node plus a couple per edge reference,
    // and base64's third on top — so this checks the shape of the cost, not an absolute figure.
    const graph = wallGraphFrom(TWO_ROOMS);
    expect(encodeWallGraph(graph).length / graph.nodes.length).toBeLessThan(24);
  });
});

describe("decodeWallGraph, refusing", () => {
  const bytesOf = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const textOf = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("refuses text that is not base64", () => {
    expect(decodeWallGraph("not a graph at all")).toBeNull();
    expect(decodeWallGraph("")).toBeNull();
  });

  it("refuses a different format version", () => {
    const bytes = bytesOf(encodeWallGraph(wallGraphFrom(TWO_ROOMS)));
    bytes[0] = 99;
    expect(decodeWallGraph(textOf(bytes))).toBeNull();
  });

  it("refuses a corrupted coordinate, which ONLY the checksum can see", () => {
    // The reason the checksum exists. A corrupted coordinate is a different and entirely plausible
    // coordinate — a wall silently somewhere it does not belong — and no structural check can tell.
    // Byte 10 is inside the first node's x: version, four checksum bytes, one node-count varint,
    // then four bytes of float. Changing it leaves every offset and every id intact.
    const bytes = bytesOf(encodeWallGraph(wallGraphFrom(TWO_ROOMS)));
    bytes[10] = bytes[10]! ^ 0x40;
    expect(decodeWallGraph(textOf(bytes))).toBeNull();
  });

  it("refuses a truncated payload rather than returning the part it read", () => {
    const binary = atob(encodeWallGraph(wallGraphFrom(TWO_ROOMS)));
    expect(decodeWallGraph(btoa(binary.slice(0, Math.floor(binary.length / 2))))).toBeNull();
  });

  it("refuses appended bytes", () => {
    // The checksum covers the body, so appended bytes fail it before the trailing-byte check is
    // reached. That check stays as defence in depth against a payload whose declared counts stop the
    // reader early while the checksum still matches — reachable only by deliberate construction, so
    // it is not isolated by a test here. Recorded rather than left to look like coverage.
    const binary = atob(encodeWallGraph(wallGraphFrom(TWO_ROOMS)));
    expect(decodeWallGraph(btoa(binary + " "))).toBeNull();
  });

  it("refuses an edge naming a node that does not exist", () => {
    // No sensible fallback exists — there is no "default edge" the way a bad blur has a default —
    // and a graph with an edge quietly dropped is a corrupt document presented as a valid one.
    const nodes = [documentPoint(0.1, 0.1), documentPoint(0.4, 0.4)];
    expect(decodeWallGraph(encodeWallGraph({ nodes, edges: [{ a: 0, b: 1 }] }))).not.toBeNull();
    expect(decodeWallGraph(encodeWallGraph({ nodes, edges: [{ a: 0, b: 2 }] }))).toBeNull();
  });
});
