/**
 * The pieces *Prune the dead ends* rings: fixtures a GM would recognise, then an oracle over random
 * graphs that checks the claim the whole design rests on — every piece is a tree hanging off at most
 * one vertex that stays, so taking any one of them strands nothing.
 *
 * The oracle counts connected pieces of linework with a union-find of its own and reads survival off
 * the doomed set directly, so it shares nothing with how the pieces were grouped.
 *
 * **Six mutations, six caught** (2026-09-22) — the last only after the stub fixture was made to assert
 * that a piece's points include the vertex it hangs off, which the ring is built from.
 */

import { describe, expect, it } from "vitest";

import { deriveWalls } from "./deriveWalls";
import { randomInk, seededRandom } from "./fixtures";
import { graphExtent } from "./graphUnits";
import { insertEdge } from "./planarOps";
import { applyPrunePieces, findPrunePieces } from "./prunePieces";
import { pruneWallGraph, spurEdgesToPrune, type WallGraph } from "./wallGraph";

const S = 1 / 64;

function build(...polylines: (readonly [number, number])[][]): WallGraph {
  let graph: WallGraph = { nodes: [], edges: [] };
  for (const line of polylines) graph = insertEdge(graph, line.map(([x, y]) => ({ x: x * S, y: y * S }))).graph;
  return graph;
}

const ROOM: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

const nodeAt = (graph: WallGraph, x: number, y: number): number =>
  graph.nodes.findIndex((node) => node.x === x * S && node.y === y * S);

describe("the pieces a GM would recognise", () => {
  it("makes a single stub one piece, hanging off the junction it meets the wall at", () => {
    const graph = build(ROOM, [
      [5, 0],
      [5, 2],
    ]);
    const pieces = findPrunePieces(graph, 3 * S);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.anchor).toBe(nodeAt(graph, 5, 0));
    expect(pieces[0]!.length).toBeCloseTo(2 * S, 12);
    // The ring is built from these, and it has to reach the junction or a short stub is half outside it.
    expect(pieces[0]!.points).toContainEqual({ x: 5 * S, y: 0 });
    expect(pieces[0]!.points).toContainEqual({ x: 5 * S, y: 2 * S });
  });

  /*
    A stem off the wall with two short arms at its end. The arms go first and the stem after them, and
    all three are one piece — which is the whole point of running the cascade before ringing.
  */
  it("makes a star of short strokes one piece, the cascade included", () => {
    const graph = build(
      ROOM,
      [
        [5, 0],
        [5, 2],
      ],
      [
        [4, 3],
        [5, 2],
        [6, 3],
      ],
    );
    const pieces = findPrunePieces(graph, 2 * S);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.edges).toHaveLength(3);
    expect(pieces[0]!.anchor).toBe(nodeAt(graph, 5, 0));
  });

  it("makes two stubs off the same vertex two pieces", () => {
    const graph = build(
      ROOM,
      [
        [5, 0],
        [4, 2],
      ],
      [
        [5, 0],
        [6, 2],
      ],
    );
    const pieces = findPrunePieces(graph, 3 * S);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((piece) => piece.anchor === nodeAt(graph, 5, 0))).toBe(true);
  });

  it("gives a stroke touching nothing no anchor, since the whole of it goes", () => {
    const graph = build(ROOM, [
      [4, 5],
      [6, 5],
    ]);
    const pieces = findPrunePieces(graph, 3 * S);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.anchor).toBeNull();
  });

  it("takes exactly the piece it is given, and nothing at a limit of zero", () => {
    const graph = build(
      ROOM,
      [
        [5, 0],
        [5, 2],
      ],
      [
        [0, 5],
        [2, 5],
      ],
    );
    const pieces = findPrunePieces(graph, 3 * S);
    expect(pieces).toHaveLength(2);
    expect(applyPrunePieces(graph, [pieces[0]!]).graph.edges).toHaveLength(graph.edges.length - 1);
    expect(findPrunePieces(graph, 0)).toHaveLength(0);
  });
});

/** Connected pieces of linework, counting only vertices with a wall, by a union-find of our own. */
function components(graph: WallGraph): number {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  for (const edge of graph.edges) {
    for (const id of [edge.a, edge.b]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(edge.a), find(edge.b));
  }
  return new Set([...parent.keys()].map(find)).size;
}

const key = (graph: WallGraph, edge: { a: number; b: number }): string =>
  [graph.nodes[edge.a]!, graph.nodes[edge.b]!].map((p) => `${p.x},${p.y}`).sort().join("|");

describe("over random graphs, against an oracle that shares none of the grouping", () => {
  it("partitions the doomed walls into trees that each hang off at most one vertex that stays", () => {
    const reach = { freestanding: 0, anchored: 0, stars: 0, sharedAnchor: 0, pieces: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const graph = deriveWalls(randomInk(40, 30, seededRandom(seed), 22), {
        tolerance: 0.5,
        maxTolerance: 4,
        pruneLimit: 0,
        extent: graphExtent(40, 30),
      }).walls.graph;
      for (const limit of [2 / 40, 5 / 40, 12 / 40]) {
        const doomed = spurEdgesToPrune(graph, limit).edges;
        const pieces = findPrunePieces(graph, limit);
        reach.pieces += pieces.length;
        const label = `seed ${seed} limit ${limit}`;

        // Disjoint, and together exactly what the limit prunes.
        const seen = new Set<number>();
        for (const piece of pieces) {
          for (const edge of piece.edges) {
            expect(seen.has(edge), label).toBe(false);
            seen.add(edge);
          }
        }
        expect([...seen].sort((a, b) => a - b), label).toEqual([...doomed].sort((a, b) => a - b));

        // Taking all of them is pruning.
        const all = applyPrunePieces(graph, pieces).graph;
        const pruned = pruneWallGraph(graph, limit).graph;
        expect(all.edges.map((e) => key(all, e)).sort(), label).toEqual(pruned.edges.map((e) => key(pruned, e)).sort());

        const survivingDegree = new Map<number, number>();
        graph.edges.forEach((edge, index) => {
          if (doomed.has(index)) return;
          for (const id of [edge.a, edge.b]) survivingDegree.set(id, (survivingDegree.get(id) ?? 0) + 1);
        });
        const anchorsSeen = new Map<number, number>();
        const before = components(graph);
        for (const piece of pieces) {
          const ids = new Set<number>();
          const degreeInPiece = new Map<number, number>();
          for (const index of piece.edges) {
            const edge = graph.edges[index]!;
            for (const id of [edge.a, edge.b]) {
              ids.add(id);
              degreeInPiece.set(id, (degreeInPiece.get(id) ?? 0) + 1);
            }
          }
          // A tree: one fewer wall than vertices, counting the one it hangs off.
          expect(piece.edges.length, label).toBe(ids.size - 1);
          // Touching at most one vertex that stays, read straight off the walls that stay.
          const touching = [...ids].filter((id) => (survivingDegree.get(id) ?? 0) > 0);
          expect(touching.length, label).toBeLessThanOrEqual(1);
          expect(piece.anchor, label).toBe(touching[0] ?? null);
          // Taking it alone strands nothing: only a piece touching nothing takes a piece of linework with it.
          const after = components(applyPrunePieces(graph, [piece]).graph);
          expect(after, label).toBe(before - (piece.anchor === null ? 1 : 0));

          if (piece.anchor === null) reach.freestanding += 1;
          else {
            reach.anchored += 1;
            anchorsSeen.set(piece.anchor, (anchorsSeen.get(piece.anchor) ?? 0) + 1);
          }
          if ([...degreeInPiece].some(([id, degree]) => degree >= 3 && id !== piece.anchor)) reach.stars += 1;
        }
        reach.sharedAnchor += [...anchorsSeen.values()].filter((count) => count >= 2).length;
      }
    }
    expect(reach.freestanding, "a piece touching nothing").toBeGreaterThan(0);
    expect(reach.anchored, "a piece hanging off a wall").toBeGreaterThan(0);
    expect(reach.stars, "a star of strokes as one piece").toBeGreaterThan(0);
    expect(reach.sharedAnchor, "two pieces off one vertex").toBeGreaterThan(0);
  });
});
