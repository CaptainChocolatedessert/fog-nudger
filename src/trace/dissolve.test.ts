/**
 * Dissolve region's decision: which region a point is in, and which walls go.
 *
 * **Fourteen mutations, fourteen caught** (2026-09-16), across the loop rule, the loop splitter, the
 * region lookup, the edge-index translation and `removeEdges`.
 *
 * Three survived along the way, and each was answered rather than explained away. Translating edge ids
 * in the slit branch had no fixture with both a stub and a segment of no length. Forgetting the
 * vertices of a closed loop cannot matter on a face's walk, whose repeats nest, so the splitter's own
 * contract is tested directly on a walk that interleaves. And keeping zero-area loops survived because
 * the only reachable one is a stub drawn twice — which, once looked at, the rule was getting wrong. The
 * fix to that made the separate both-sides check undecidable by any test, so it was deleted.
 */

import { describe, expect, it } from "vitest";

import { deriveWalls } from "./deriveWalls";
import { dissolutionAt, dissolvedEdges, regionAt, simpleLoops } from "./dissolve";
import { graphExtent } from "./graphUnits";
import { findCrossings } from "./planarGraph";
import { removeEdges } from "./planarOps";
import { buildWallFaces, containsPoint, type WallFaces } from "./wallFaces";
import { documentPoint, type WallGraph } from "./wallGraph";
import { randomInk, randomWallGraph, seededRandom } from "./fixtures";

/** A graph from plain coordinates, quantised the way the document holds them. */
function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** A closed run of nodes, as the edges between consecutive ones. */
function loop(ids: readonly number[]): [number, number][] {
  return ids.map((id, index) => [id, ids[(index + 1) % ids.length]!] as [number, number]);
}

const square = (x: number, y: number, size: number): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

/** What dissolving the region at a point removes, or `null` when the point is in none. */
function dissolveAt(graph: WallGraph, x: number, y: number): readonly number[] | null {
  return dissolutionAt(graph, buildWallFaces(graph), { x, y })?.edges ?? null;
}

/** One room. Edges 0–3. */
const ROOM = graphOf(square(0.2, 0.2, 0.4), loop([0, 1, 2, 3]));

/**
 * Three rooms in a row: the outline (edges 0–7) and two dividers (8 between left and middle, 9
 * between middle and right).
 */
const ROW = graphOf(
  [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.7, 0.1],
    [1.0, 0.1],
    [1.0, 0.4],
    [0.7, 0.4],
    [0.4, 0.4],
    [0.1, 0.4],
  ],
  [...loop([0, 1, 2, 3, 4, 5, 6, 7]), [1, 6], [2, 5]],
);

/** A room (edges 0–3) with a pillar standing free inside it (edges 4–7). */
const PILLAR = graphOf(
  [...square(0.1, 0.1, 0.8), ...square(0.4, 0.4, 0.2)],
  [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7])],
);

/**
 * A lollipop inside a room: the outline (edges 0–4), a stem from the middle of the top wall (edge 5),
 * and a diamond on the end of it (edges 6–9).
 *
 * The head is joined to the outer wall, so the room's boundary is **one** cycle running around both —
 * which is the case a rule of "the outer cycle goes" gets wrong.
 */
const LOLLIPOP = graphOf(
  [
    [0.1, 0.1],
    [0.5, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
    [0.5, 0.3],
    [0.6, 0.4],
    [0.5, 0.5],
    [0.4, 0.4],
  ],
  [...loop([0, 1, 2, 3, 4]), [1, 5], ...loop([5, 6, 7, 8])],
);

/**
 * A room (edges 0–3) with a triangle inside it touching its corner at a single vertex (edges 4–6).
 *
 * No stem: the two share node 0 and nothing else. The room's boundary passes through that corner
 * twice, and again runs around the triangle as part of one cycle.
 */
const PINCHED = graphOf(
  [...square(0.1, 0.1, 0.8), [0.4, 0.2], [0.2, 0.4]],
  [...loop([0, 1, 2, 3]), ...loop([0, 4, 5])],
);

describe("dissolving a region", () => {
  it("removes every wall of a lone room, and nothing outside it answers", () => {
    expect(dissolveAt(ROOM, 0.4, 0.4)).toEqual([0, 1, 2, 3]);
    expect(dissolveAt(ROOM, 0.1, 0.1)).toBeNull();
    expect(dissolveAt(ROOM, 0.7, 0.4)).toBeNull();
  });

  it("removes the walls a room shares with its neighbours, and leaves theirs", () => {
    expect(dissolveAt(ROW, 0.55, 0.25)).toEqual([1, 5, 8, 9]);
    expect(dissolveAt(ROW, 0.25, 0.25)).toEqual([0, 6, 7, 8]);
    expect(dissolveAt(ROW, 0.85, 0.25)).toEqual([2, 3, 4, 9]);
  });

  it("keeps a pillar standing free inside the room, and dissolves the pillar when it is clicked", () => {
    expect(dissolveAt(PILLAR, 0.2, 0.2)).toEqual([0, 1, 2, 3]);
    expect(dissolveAt(PILLAR, 0.5, 0.5)).toEqual([4, 5, 6, 7]);
  });

  it("removes a stub hanging in, which has the room on both sides", () => {
    const stub = graphOf([...square(0.2, 0.2, 0.4), [0.4, 0.4]], [...loop([0, 1, 2, 3]), [0, 4]]);
    expect(dissolveAt(stub, 0.5, 0.3)).toEqual([0, 1, 2, 3, 4]);
  });

  it("leaves a stub sticking out into a neighbour, and takes it when the neighbour dissolves", () => {
    /*
      A pillar with a stub off its corner, out into the room around it. One graph, both readings: the
      stub has the room on both sides, so dissolving the pillar leaves it and dissolving the room takes
      it — while the pillar, a closed region inside the room, keeps its walls.
    */
    const graph = graphOf(
      [...square(0.1, 0.1, 0.8), ...square(0.4, 0.4, 0.2), [0.25, 0.25]],
      [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7]), [4, 8]],
    );
    expect(dissolveAt(graph, 0.5, 0.5)).toEqual([4, 5, 6, 7]);
    expect(dissolveAt(graph, 0.8, 0.2)).toEqual([0, 1, 2, 3, 8]);
  });

  it("removes a freestanding wall, and a branching one, from inside the room", () => {
    const line = graphOf(
      [...square(0.1, 0.1, 0.8), [0.4, 0.5], [0.6, 0.5]],
      [...loop([0, 1, 2, 3]), [4, 5]],
    );
    expect(dissolveAt(line, 0.2, 0.2)).toEqual([0, 1, 2, 3, 4]);

    // A T with its three arms walked as slits from the tips inward.
    const tee = graphOf(
      [...square(0.1, 0.1, 0.8), [0.3, 0.5], [0.7, 0.5], [0.5, 0.5], [0.5, 0.7]],
      [...loop([0, 1, 2, 3]), [4, 6], [6, 5], [6, 7]],
    );
    expect(dissolveAt(tee, 0.2, 0.2)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("removes a lollipop's stem and keeps its head", () => {
    const faces = buildWallFaces(LOLLIPOP);
    const room = regionAt(faces, { x: 0.2, y: 0.8 })!;
    // The fixture has to be the hard case, or this test proves nothing about it.
    expect(faces.faces[room]!.cycles).toHaveLength(1);

    expect(dissolvedEdges(LOLLIPOP, faces, room)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(dissolveAt(LOLLIPOP, 0.5, 0.4)).toEqual([6, 7, 8, 9]);
  });

  it("keeps a room that touches the outer wall at a single point", () => {
    const faces = buildWallFaces(PINCHED);
    const room = regionAt(faces, { x: 0.7, y: 0.7 })!;
    // One cycle, carrying the triangle's walls — again the case this exists for.
    expect(faces.faces[room]!.cycles).toHaveLength(1);
    const triangleHalves = faces.faces[room]!.cycles[0]!.halfEdges.filter(
      (half) => faces.sourceEdges[half >> 1]! >= 4,
    );
    expect(triangleHalves).toHaveLength(3);

    expect(dissolvedEdges(PINCHED, faces, room)).toEqual([0, 1, 2, 3]);
    expect(dissolveAt(PINCHED, 0.23, 0.23)).toEqual([4, 5, 6]);
  });

  it("does not depend on where in the walk a cycle starts", () => {
    /*
      A walk can begin partway round an inner room or partway along a slit, and the loops then close
      in a different order. Every rotation of every cycle has to give the same walls.
    */
    for (const [name, graph, x, y] of [
      ["lollipop", LOLLIPOP, 0.2, 0.8],
      ["pinched", PINCHED, 0.7, 0.7],
      ["pillar", PILLAR, 0.2, 0.2],
    ] as const) {
      const faces = buildWallFaces(graph);
      const room = regionAt(faces, { x, y })!;
      const expected = dissolvedEdges(graph, faces, room);
      const walkLength = faces.faces[room]!.cycles[0]!.halfEdges.length;
      const rotate = (walk: readonly number[], shift: number) => {
        const at = shift % walk.length;
        return [...walk.slice(at), ...walk.slice(0, at)];
      };
      for (let shift = 1; shift < walkLength; shift++) {
        const rotated: WallFaces = {
          ...faces,
          faces: faces.faces.map((face) => ({
            ...face,
            cycles: face.cycles.map((cycle) => ({ ...cycle, halfEdges: rotate(cycle.halfEdges, shift) })),
          })),
        };
        expect(dissolvedEdges(graph, rotated, room), `${name}, rotated by ${shift}`).toEqual(expected);
      }
    }
  });

  it("names graph edges, not traversal edges, when a segment of no length shifts the numbering", () => {
    // A zero-length segment first, which the traversal leaves out — so its half-edge ids are one
    // behind the graph's indices for every wall after it. A room, and a room with a stub, because
    // walls on the loops and walls with the region on both sides are collected in two places.
    const room = graphOf(square(0.2, 0.2, 0.4), [[0, 0], ...loop([0, 1, 2, 3])]);
    expect(dissolveAt(room, 0.4, 0.4)).toEqual([1, 2, 3, 4]);

    const stub = graphOf([...square(0.2, 0.2, 0.4), [0.4, 0.4]], [[0, 0], [0, 4], ...loop([0, 1, 2, 3])]);
    expect(dissolveAt(stub, 0.5, 0.3)).toEqual([1, 2, 3, 4, 5]);
  });

  it("removes both copies of a stub drawn twice", () => {
    /*
      Two walls on the same pair of vertices — a legal state to pass through, doubling a line to drag
      the copy away. The sliver between them is filed under the outside rather than as a region, so
      the copies do not look like walls with the room on both sides, and the loop they make encloses
      nothing. Measured before this was decided: keeping zero-area loops left both copies standing.
    */
    const graph = graphOf([...square(0.1, 0.1, 0.8), [0.4, 0.4]], [...loop([0, 1, 2, 3]), [0, 4], [0, 4]]);
    expect(dissolveAt(graph, 0.6, 0.3)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("simpleLoops", () => {
  it("puts every half-edge in exactly one loop, and no loop visits a vertex twice", () => {
    for (const graph of [LOLLIPOP, PINCHED, ROW, PILLAR]) {
      const faces = buildWallFaces(graph);
      const origin = (half: number) => {
        const edge = graph.edges[faces.sourceEdges[half >> 1]!]!;
        return (half & 1) === 0 ? edge.a : edge.b;
      };
      const target = (half: number) => origin(half ^ 1);
      for (const face of faces.faces) {
        for (const cycle of face.cycles) {
          const loops = simpleLoops(cycle.halfEdges, origin, target);
          expect(loops.flat().sort((a, b) => a - b)).toEqual([...cycle.halfEdges].sort((a, b) => a - b));
          for (const piece of loops) {
            const visited = piece.map(origin);
            expect(new Set(visited).size).toBe(visited.length);
            expect(target(piece[piece.length - 1]!)).toBe(origin(piece[0]!));
          }
        }
      }
    }
  });
});

describe("simpleLoops on a walk that revisits vertices out of order", () => {
  it("forgets the vertices of a loop once it closes", () => {
    /*
      Not a face boundary — a face's repeats nest, and this one interleaves — but the splitter's
      contract is any closed walk. The walk 0 1 2 3 1 4 2 5 0 closes the loop 1 2 3 1, and then comes
      back to 2: a vertex that was on the stack and is not any more. Remembering where 2 used to be
      would cut the second loop in the wrong place.
    */
    const vertices = [0, 1, 2, 3, 1, 4, 2, 5, 0];
    const walk = vertices.slice(0, -1).map((_, index) => index);
    const origin = (half: number) => vertices[half]!;
    const target = (half: number) => vertices[half + 1]!;
    expect(simpleLoops(walk, origin, target)).toEqual([
      [1, 2, 3],
      [0, 4, 5, 6, 7],
    ]);
  });
});

describe("removeEdges", () => {
  it("removes exactly the walls named, in any order, and leaves the vertices", () => {
    const result = removeEdges(ROW, [9, 1, 5, 8, 42, -1]);
    expect(result.graph.nodes).toBe(ROW.nodes);
    expect(result.graph.edges).toEqual([0, 2, 3, 4, 6, 7].map((index) => ROW.edges[index]));
    expect(removeEdges(ROW, []).graph.edges).toBe(ROW.edges);
  });
});

/*
  The same question asked a different way, over linework nobody drew.

  The fixtures above are shapes somebody thought of. This checks the loop rule against an oracle that
  shares none of its reasoning: **a region is inside the clicked one exactly when it cannot reach the
  outside without passing through it**, found by walking from region to region across walls with the
  clicked region taken out. A wall goes when the clicked region is on one side and the other side is
  the clicked region again or can reach the outside.

  Two generators feed it, for the reason given on `randomWallGraph` in `fixtures.ts`.
*/

function expectedByReachability(faces: WallFaces, clicked: number): number[] {
  // Which region is on each side of each traversal edge; -1 is the outside.
  const faceOfHalf = new Int32Array(faces.edges * 2).fill(-1);
  faces.faces.forEach((face, index) => {
    for (const cycle of face.cycles) for (const half of cycle.halfEdges) faceOfHalf[half] = index;
  });

  // Regions reachable from the outside across walls, without entering the clicked one.
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (let edge = 0; edge < faces.edges; edge++) {
    const left = faceOfHalf[edge * 2]!;
    const right = faceOfHalf[edge * 2 + 1]!;
    if (left === right || left === clicked || right === clicked) continue;
    link(left, right);
    link(right, left);
  }
  const reaches = new Set<number>([-1]);
  const queue = [-1];
  while (queue.length > 0) {
    for (const next of neighbours.get(queue.pop()!) ?? []) {
      if (reaches.has(next)) continue;
      reaches.add(next);
      queue.push(next);
    }
  }

  const going: number[] = [];
  for (let edge = 0; edge < faces.edges; edge++) {
    const left = faceOfHalf[edge * 2]!;
    const right = faceOfHalf[edge * 2 + 1]!;
    if (left !== clicked && right !== clicked) continue;
    const other = left === clicked ? right : left;
    if (other === clicked || reaches.has(other)) going.push(faces.sourceEdges[edge]!);
  }
  return going.sort((a, b) => a - b);
}

describe("dissolving over generated graphs", () => {
  it("agrees with reachability for every region, including inner rooms joined to the outer wall", () => {
    let regions = 0;
    let kept = 0;
    let keptOnOuterCycle = 0;
    let usable = 0;
    const seeds = 1500;
    for (let seed = 1; seed <= seeds; seed++) {
      const graph = randomWallGraph(seededRandom(seed), 3 + (seed % 9));
      const faces = buildWallFaces(graph);
      // A doubled wall or a crossing is not an embedding the traversal means anything over.
      if (!faces.eulerHolds || findCrossings(graph).length > 0) continue;
      usable += 1;
      for (let face = 0; face < faces.faces.length; face++) {
        const actual = dissolvedEdges(graph, faces, face);
        expect(actual, `seed ${seed} region ${face}`).toEqual(expectedByReachability(faces, face));
        regions += 1;

        const going = new Set(actual);
        const [outer, ...holes] = faces.faces[face]!.cycles;
        const edgesOf = (halfEdges: readonly number[]) =>
          new Set(halfEdges.map((half) => faces.sourceEdges[half >> 1]!));
        const outerEdges = edgesOf(outer!.halfEdges);
        const holeEdges = edgesOf(holes.flatMap((hole) => hole.halfEdges));
        for (const edge of new Set([...outerEdges, ...holeEdges])) if (!going.has(edge)) kept += 1;
        for (const edge of outerEdges) if (!going.has(edge)) keptOnOuterCycle += 1;
      }
    }
    // A sweep that never kept a wall, or never kept one off the outer cycle, would not have reached
    // the rule — the finding that retired the ink-run generator for this test.
    expect(usable, "usable seeds").toBeGreaterThan(seeds / 2);
    expect(regions).toBeGreaterThan(0);
    expect(kept, "walls kept as an inner room's").toBeGreaterThan(0);
    expect(keptOnOuterCycle, "walls kept from the outer cycle").toBeGreaterThan(0);
  });
});

describe("dissolving over generated linework", () => {
  /*
    The derivation's own output, as a second source of topology: junction clusters, staircases and
    slits the lattice generator above never makes. It exercises the outer walls and the slits, and —
    as measured — essentially never an inner room, which the sweep above is for.
  */
  const SHAPES = [
    { width: 18, height: 14, runs: 5, seeds: 200 },
    { width: 40, height: 30, runs: 22, seeds: 80 },
  ] as const;

  for (const { width, height, runs, seeds } of SHAPES) {
    it(`agrees with reachability for every region of ${seeds} random ${width}x${height} maps`, () => {
      let regions = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const { walls, faces } = deriveWalls(randomInk(width, height, seededRandom(seed), runs), {
          tolerance: 0,
          maxTolerance: 0,
          pruneLimit: 0,
          extent: graphExtent(width, height),
        });
        for (let face = 0; face < faces.faces.length; face++) {
          const expected = expectedByReachability(faces, face);
          const actual = dissolvedEdges(walls.graph, faces, face);
          expect(actual, `${width}x${height} seed ${seed} region ${face}`).toEqual(expected);
          regions += 1;
        }
      }
      expect(regions).toBeGreaterThan(0);
    });
  }

  it("finds the region a point is in, agreeing with the emitted rings' even-odd fill", () => {
    const next = seededRandom(7);
    let inside = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const width = 40;
      const height = 30;
      const { faces } = deriveWalls(randomInk(width, height, seededRandom(seed), 22), {
        tolerance: 0,
        maxTolerance: 0,
        pruneLimit: 0,
        extent: graphExtent(width, height),
      });
      const extent = graphExtent(width, height);
      for (let sample = 0; sample < 200; sample++) {
        const point = { x: next() * extent.x, y: next() * extent.y };
        const filled = faces.faces
          .map((face, index) => ({ face, index }))
          .filter(({ face }) => face.rings.filter((ring) => containsPoint(ring, point)).length % 2 === 1)
          .map(({ index }) => index);
        expect(filled.length, `seed ${seed}: regions filling one point`).toBeLessThanOrEqual(1);
        expect(regionAt(faces, point), `seed ${seed} at ${point.x},${point.y}`).toBe(filled[0] ?? null);
        if (filled.length === 1) inside += 1;
      }
    }
    expect(inside).toBeGreaterThan(0);
  });
});
