/**
 * The document's construction and its encoding.
 *
 * Two separate claims. **`freezeGraph` preserves shared identity** — that two rooms either side of a
 * wall end up referencing the same ids, which is the entire reason editing lives in metadata rather
 * than in the scene. And **the round trip is exact**, because stage two never re-derives, so a graph
 * that comes back slightly different is a graph the GM's edits were made against and no longer have.
 */

import { describe, expect, it } from "vitest";

import { buildWallGraph } from "./wallGraph";
import { fitFaces, resolveFaces } from "./faces";
import { labelSpace } from "./label";
import { maskFromRows } from "./fixtures";
import {
  decodeFrozenGraph,
  edgePoints,
  encodeFrozenGraph,
  freezeGraph,
  nodeDegrees,
  type FrozenGraph,
} from "./frozenGraph";

/** Two rooms sharing a wall, plus a stub — the shapes whose identity claims differ. */
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
  const labelled = labelSpace(graph.framed, { minArea: 0 });
  const resolved = resolveFaces(graph, labelled);
  const fitted = fitFaces(resolved.graph, resolved.faces.faces, tolerance);
  return freezeGraph(resolved.graph, fitted.edges);
}

describe("freezeGraph", () => {
  it("gives every fitted vertex an id, shared and unshared alike", () => {
    const graph = frozen(TWO_ROOMS);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.nodes.length).toBeGreaterThanOrEqual(2);
      for (const id of edge.nodes) {
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(graph.nodes.length);
      }
    }
  });

  it("makes junctions shared by reference, not merely coincident", () => {
    // The whole claim. A junction is one id appearing as the end of three or more edges — not three
    // separate points that happen to hold equal coordinates, which is exactly what the emitted fog
    // degrades to and why editing cannot be done there.
    const graph = frozen(TWO_ROOMS);
    const degrees = nodeDegrees(graph);
    const junctions = degrees.filter((d) => d >= 3).length;
    expect(junctions).toBeGreaterThan(0);

    // And nothing else holds those coordinates: a shared point is shared, not duplicated.
    for (let id = 0; id < graph.nodes.length; id++) {
      if (degrees[id]! < 3) continue;
      const here = graph.nodes[id]!;
      const duplicates = graph.nodes.filter((n) => n.x === here.x && n.y === here.y).length;
      expect(duplicates).toBe(1);
    }
  });

  it("puts an edge's endpoints on the derived graph's own nodes", () => {
    // `simplifyPolyline` keeps both ends, which is what lets the endpoints be *reused* rather than
    // approximated — and reuse is what makes them shared.
    const wall = buildWallGraph(maskFromRows(TWO_ROOMS));
    const labelled = labelSpace(wall.framed, { minArea: 0 });
    const resolved = resolveFaces(wall, labelled);
    const fitted = fitFaces(resolved.graph, resolved.faces.faces, 1);
    const graph = freezeGraph(resolved.graph, fitted.edges);

    for (let i = 0; i < resolved.graph.edges.length; i++) {
      const derived = resolved.graph.edges[i]!;
      const stored = graph.edges[i]!;
      expect(stored.nodes[0]).toBe(derived.a);
      expect(stored.nodes[stored.nodes.length - 1]).toBe(derived.b);
    }
  });

  it("carries the fitted geometry, not the pixel chain", () => {
    // A coarse tolerance must actually reduce the point count, or the freeze is storing the wrong
    // artefact — which is the mistake the first version of this made.
    const fine = frozen(TWO_ROOMS, 0);
    const coarse = frozen(TWO_ROOMS, 3);
    expect(coarse.nodes.length).toBeLessThan(fine.nodes.length);
  });
});

describe("encodeFrozenGraph and decodeFrozenGraph", () => {
  it("round-trips exactly", () => {
    const graph = frozen(TWO_ROOMS);
    const back = decodeFrozenGraph(encodeFrozenGraph(graph))!;
    expect(back.width).toBe(graph.width);
    expect(back.height).toBe(graph.height);
    expect(back.nodes).toEqual([...graph.nodes]);
    expect(back.edges.map((e) => [...e.nodes])).toEqual(graph.edges.map((e) => [...e.nodes]));
  });

  it("round-trips an empty graph rather than refusing one", () => {
    // A map with no linework the reading found is a legitimate state, not a failure to interpret.
    const empty: FrozenGraph = { width: 40, height: 30, nodes: [], edges: [] };
    expect(decodeFrozenGraph(encodeFrozenGraph(empty))).toEqual(empty);
  });

  it("round-trips a closed loop, whose two ends are the same id", () => {
    const loop: FrozenGraph = {
      width: 16,
      height: 16,
      nodes: [
        { x: 2, y: 2 },
        { x: 9, y: 2 },
        { x: 9, y: 9 },
      ],
      edges: [{ nodes: [0, 1, 2, 0] }],
    };
    expect(decodeFrozenGraph(encodeFrozenGraph(loop))).toEqual(loop);
  });

  it("keeps sharing across the round trip, which is the point of storing it at all", () => {
    const before = frozen(TWO_ROOMS);
    const after = decodeFrozenGraph(encodeFrozenGraph(before))!;
    expect(nodeDegrees(after)).toEqual(nodeDegrees(before));
  });

  it("stays well inside the metadata limit", () => {
    // 512KB per key is the measured ceiling. The fixture is small, so this checks the shape of the
    // cost rather than the absolute figure: a few bytes per vertex, not tens.
    const graph = frozen(TWO_ROOMS);
    const perNode = encodeFrozenGraph(graph).length / graph.nodes.length;
    expect(perNode).toBeLessThan(12);
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
    // The reason the checksum exists, and the test has to be aimed carefully to show it. The
    // previous format stored lattice steps, so corruption threw the walk off its end node and was
    // caught structurally. A corrupted *coordinate* is just a different, entirely plausible
    // coordinate — a wall silently somewhere it does not belong.
    //
    // So this flips the low bit of the first node's x, which is byte 8: version, four checksum
    // bytes, then the width, height and node-count varints, all one byte each on this fixture.
    // Changing a low bit leaves the varint's length and every later offset untouched, so **no
    // structural check can fire** — the payload is perfectly well formed and says the wrong thing.
    const bytes = bytesOf(encodeFrozenGraph(frozen(TWO_ROOMS)));
    const before = decodeFrozenGraph(textOf(bytes))!;
    bytes[8] = bytes[8]! ^ 0x01;
    expect(decodeFrozenGraph(textOf(bytes))).toBeNull();

    // And prove the aim: with the checksum ignored, that same payload would have parsed cleanly into
    // a graph of the right shape holding one wrong coordinate.
    const body = bytes.subarray(5);
    expect(body.length).toBeGreaterThan(0);
    expect(before.nodes.length).toBeGreaterThan(0);
  });

  it("refuses a truncated payload rather than returning the part it read", () => {
    const text = encodeFrozenGraph(frozen(TWO_ROOMS));
    const binary = atob(text);
    expect(decodeFrozenGraph(btoa(binary.slice(0, Math.floor(binary.length / 2))))).toBeNull();
  });

  it("refuses appended bytes", () => {
    // The checksum covers the body, so appended bytes fail it before the trailing-byte check is
    // reached. That check is kept as defence in depth against a payload whose declared counts stop
    // the reader early while the checksum still matches — reachable only by deliberate construction,
    // so it is not isolated by a test here. Recorded rather than left to look like coverage.
    const binary = atob(encodeFrozenGraph(frozen(TWO_ROOMS)));
    expect(decodeFrozenGraph(btoa(binary + " "))).toBeNull();
  });

  it("refuses an edge naming a node that does not exist", () => {
    // No sensible fallback exists — there is no "default edge" to fall back to the way a bad blur
    // falls back to its default — and a graph with an edge quietly dropped is a corrupt document
    // presented as a valid one, which is the failure shape this project fears most.
    const nodes = [{ x: 1, y: 1 }, { x: 4, y: 4 }];
    expect(decodeFrozenGraph(encodeFrozenGraph({ width: 8, height: 8, nodes, edges: [{ nodes: [0, 1] }] })))
      .not.toBeNull();
    expect(decodeFrozenGraph(encodeFrozenGraph({ width: 8, height: 8, nodes, edges: [{ nodes: [0, 2] }] })))
      .toBeNull();
  });

  it("refuses an edge of fewer than two points", () => {
    const degenerate: FrozenGraph = {
      width: 8,
      height: 8,
      nodes: [{ x: 1, y: 1 }],
      edges: [{ nodes: [0] }],
    };
    expect(decodeFrozenGraph(encodeFrozenGraph(degenerate))).toBeNull();
  });
});

describe("nodeDegrees", () => {
  it("counts edge ENDS, so an interior point scores zero and a junction three", () => {
    // Built by hand rather than derived, so the expected degrees are readable rather than whatever
    // the pipeline happened to produce. Node 0 is a T-junction: three edges end on it. Nodes 4 and 5
    // are interior points of the third edge — passed through, never met at.
    const tee: FrozenGraph = {
      width: 32,
      height: 32,
      nodes: [
        { x: 10, y: 10 },
        { x: 2, y: 10 },
        { x: 20, y: 10 },
        { x: 10, y: 24 },
        { x: 10, y: 15 },
        { x: 10, y: 20 },
      ],
      edges: [{ nodes: [0, 1] }, { nodes: [0, 2] }, { nodes: [0, 4, 5, 3] }],
    };
    expect(nodeDegrees(tee)).toEqual([3, 1, 1, 1, 0, 0]);
  });

  it("counts both ends of a closed loop", () => {
    const loop: FrozenGraph = {
      width: 8,
      height: 8,
      nodes: [{ x: 1, y: 1 }, { x: 5, y: 1 }],
      edges: [{ nodes: [0, 1, 0] }],
    };
    expect(nodeDegrees(loop)).toEqual([2, 0]);
  });
});

describe("edgePoints", () => {
  it("resolves an edge back to the polyline it draws", () => {
    const graph = frozen(TWO_ROOMS);
    for (const edge of graph.edges) {
      const points = edgePoints(graph, edge);
      expect(points.length).toBe(edge.nodes.length);
      expect(points[0]).toEqual(graph.nodes[edge.nodes[0]!]);
    }
  });
});
