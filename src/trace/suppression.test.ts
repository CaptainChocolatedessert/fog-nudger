/**
 * Suppress region's decision: which regions the marks suppress, and what is emitted without them.
 *
 * **Fifteen mutations, fifteen caught** (2026-09-16), across the suppression, the recount of the
 * walls, the mark hit test, the stored codec and the traversal's per-region coverage.
 *
 * Three survived the first run and were answered. Quantising in the encoder could not be seen,
 * because decoding quantises again — so marks are quantised once, where they are placed, and the
 * encoder no longer pretends to. Refusing a list of odd length was redundant with the pair check,
 * which fails on the missing coordinate, and went. And translating ids in the coverage had no fixture
 * with a segment of no length beside a region that stays emitted; it has one now.
 */

import { describe, expect, it } from "vitest";

import { randomWallGraph, seededRandom } from "./fixtures";
import { findCrossings } from "./planarGraph";
import {
  decodeMarks,
  encodeMarks,
  markAt,
  suppressedRegions,
  withoutSuppressed,
} from "./suppression";
import { buildWallFaces, type WallFaces } from "./wallFaces";
import { documentPoint, type WallGraph } from "./wallGraph";

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

/** What a push would emit with marks at these points: how many regions, and which walls as lines. */
function emitted(graph: WallGraph, marks: readonly [number, number][]) {
  const faces = buildWallFaces(graph);
  const points = marks.map(([x, y]) => ({ x, y }));
  const result = withoutSuppressed(graph, faces, suppressedRegions(faces, points));
  return { regions: result.faces.length, walls: result.walls };
}

/** One room. Edges 0–3. */
const ROOM = graphOf(square(0.2, 0.2, 0.4), loop([0, 1, 2, 3]));

/**
 * Three rooms in a row: the outline (edges 0–7) and two dividers (8 between left and middle, 9
 * between middle and right). The middle room's own outer walls are 1 on top and 5 underneath.
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

describe("suppressing a region", () => {
  it("emits nothing for a lone room and every one of its walls as a line", () => {
    expect(emitted(ROOM, [])).toEqual({ regions: 1, walls: [] });
    expect(emitted(ROOM, [[0.4, 0.4]])).toEqual({ regions: 0, walls: [0, 1, 2, 3] });
  });

  it("leaves the walls a suppressed room shares with emitted neighbours inside their shapes", () => {
    // The dividers are still covered by the rooms either side; only the middle room's own outer
    // walls, which no emitted room borders, come out as lines.
    expect(emitted(ROW, [[0.55, 0.25]])).toEqual({ regions: 2, walls: [1, 5] });
  });

  it("turns a wall into a line only once nothing emitted borders it", () => {
    // The left and middle rooms both suppressed: the divider between them now borders nothing
    // emitted, while the one between middle and right is still the right room's.
    expect(emitted(ROW, [[0.25, 0.25], [0.55, 0.25]])).toEqual({
      regions: 1,
      walls: [0, 1, 5, 6, 7, 8],
    });
  });

  it("covers a suppressed pillar's walls with the room around it, and keeps the pillar a hole", () => {
    const faces = buildWallFaces(PILLAR);
    const result = withoutSuppressed(PILLAR, faces, suppressedRegions(faces, [{ x: 0.5, y: 0.5 }]));
    expect(result.walls).toEqual([]);
    expect(result.faces).toHaveLength(1);
    // The room's outline and the pillar's, cut out: the pillar stays fogged for good.
    expect(result.faces[0]!.rings).toHaveLength(2);
  });

  it("keeps a pillar a shape when the room around it is suppressed", () => {
    expect(emitted(PILLAR, [[0.2, 0.2]])).toEqual({ regions: 1, walls: [0, 1, 2, 3] });
  });

  it("keeps a stub in a suppressed room a line, as it always was", () => {
    const stub = graphOf([...square(0.2, 0.2, 0.4), [0.4, 0.4]], [...loop([0, 1, 2, 3]), [0, 4]]);
    expect(emitted(stub, [])).toEqual({ regions: 1, walls: [4] });
    expect(emitted(stub, [[0.5, 0.3]])).toEqual({ regions: 0, walls: [0, 1, 2, 3, 4] });
  });

  it("suppresses a region once however many marks it holds, and nothing for a mark outside", () => {
    const faces = buildWallFaces(ROW);
    const middle = suppressedRegions(faces, [{ x: 0.55, y: 0.25 }]);
    expect(middle).toHaveLength(1);
    expect(suppressedRegions(faces, [{ x: 0.5, y: 0.2 }, { x: 0.6, y: 0.3 }])).toEqual(middle);
    expect(suppressedRegions(faces, [{ x: 0.05, y: 0.05 }])).toEqual([]);
    // Nothing suppressed is the traversal exactly, not a copy of it.
    expect(withoutSuppressed(ROW, faces, [])).toBe(faces);
  });

  it("names graph edges when a segment of no length shifts the traversal's numbering", () => {
    // A zero-length segment first, which the traversal leaves out, so every id it hands back is one
    // behind the graph's. Once where nothing stays emitted, and once where the neighbours' coverage
    // is what decides.
    const room = graphOf(square(0.2, 0.2, 0.4), [[0, 0], ...loop([0, 1, 2, 3])]);
    expect(emitted(room, [[0.4, 0.4]])).toEqual({ regions: 0, walls: [0, 1, 2, 3, 4] });

    const row = { nodes: ROW.nodes, edges: [{ a: 0, b: 0 }, ...ROW.edges] };
    expect(emitted(row, [[0.55, 0.25]])).toEqual({ regions: 2, walls: [0, 2, 6] });
  });
});

describe("marks", () => {
  it("finds the nearest mark in reach, the lower index on a tie, and nothing out of reach", () => {
    const marks = [
      { x: 0.5, y: 0.5 },
      { x: 0.52, y: 0.5 },
      { x: 0.48, y: 0.5 },
    ];
    expect(markAt(marks, { x: 0.515, y: 0.5 }, 0.01)).toBe(1);
    expect(markAt(marks, { x: 0.49, y: 0.5 }, 0.05)).toBe(0);
    expect(markAt(marks, { x: 0.5, y: 0.6 }, 0.05)).toBeNull();
    // Exactly at the radius is in reach.
    expect(markAt([{ x: 0.25, y: 0.5 }], { x: 0.5, y: 0.5 }, 0.25)).toBe(0);
    expect(markAt([], { x: 0.5, y: 0.5 }, 1)).toBeNull();
  });

  it("round-trips exactly, and refuses anything that is not whole pairs of finite numbers", () => {
    const marks = [
      { x: 0.1, y: 0.7 },
      { x: 1 / 3, y: 0 },
    ];
    // Quantised on the way in, so a double written by anything else reads back as the float32 a
    // placed mark already is — and a placed mark survives the trip unchanged.
    const decoded = decodeMarks(JSON.parse(JSON.stringify(encodeMarks(marks))));
    expect(decoded).toEqual(marks.map((mark) => ({ x: Math.fround(mark.x), y: Math.fround(mark.y) })));
    expect(decodeMarks(JSON.parse(JSON.stringify(encodeMarks(decoded!))))).toEqual(decoded);
    expect(decodeMarks([])).toEqual([]);

    expect(decodeMarks([0.1])).toBeNull();
    expect(decodeMarks([0.1, "0.2"])).toBeNull();
    expect(decodeMarks([0.1, Number.NaN])).toBeNull();
    expect(decodeMarks([0.1, Infinity])).toBeNull();
    expect(decodeMarks({ 0: 0.1, 1: 0.2 })).toBeNull();
    expect(decodeMarks(null)).toBeNull();
  });
});

/**
 * Which region lies on each side of each graph edge, from the walk rather than from the rings.
 *
 * `-1` is the outside. A segment of no length is not walked and has no sides, so it reads as outside
 * on both, which is what it is for emitting: no ring ever covers one.
 */
function sidesOf(graph: WallGraph, faces: WallFaces): [number, number][] {
  const faceOfHalf = new Int32Array(faces.edges * 2).fill(-1);
  faces.faces.forEach((face, index) => {
    for (const cycle of face.cycles) for (const half of cycle.halfEdges) faceOfHalf[half] = index;
  });
  const sides: [number, number][] = graph.edges.map(() => [-1, -1]);
  faces.sourceEdges.forEach((edge, walked) => {
    sides[edge] = [faceOfHalf[walked * 2]!, faceOfHalf[walked * 2 + 1]!];
  });
  return sides;
}

describe("suppressing over generated graphs", () => {
  /*
    Checked against the rule as §3 states it rather than against the rings: **a wall is a line
    exactly when no emitted region lies on either side of it — or the same region lies on both**,
    which is a bridge, and which no ring covers however much is emitted. The sides come from the
    walk; the implementation counts coverage from the rings. The two share nothing but the traversal.

    Measured on 2026-09-16: 514 of the 600 graphs usable, 4,103 suppressions checked, and 10,765 walls
    turned into lines by them.
  */
  it("emits a wall as a line exactly when no emitted region borders it, for every subset tried", () => {
    let usable = 0;
    let suppressions = 0;
    let linesFromSuppression = 0;
    const seeds = 600;
    for (let seed = 1; seed <= seeds; seed++) {
      const graph = randomWallGraph(seededRandom(seed), 3 + (seed % 9));
      const faces = buildWallFaces(graph);
      if (!faces.eulerHolds || findCrossings(graph).length > 0) continue;
      usable += 1;

      // With nothing suppressed, coverage recounted from every region's rings must be the
      // traversal's own list — which is what says `ringEdges` records what the rings cover.
      const coveredByAll = new Set(faces.faces.flatMap((face) => face.ringEdges));
      const uncovered = graph.edges.map((_, edge) => edge).filter((edge) => !coveredByAll.has(edge));
      expect(uncovered, `seed ${seed}, nothing suppressed`).toEqual(faces.walls);

      const sides = sidesOf(graph, faces);
      const next = seededRandom(seed * 7919);
      const subsets: number[][] = faces.faces.map((_, index) => [index]);
      subsets.push(faces.faces.map((_, index) => index).filter(() => next() < 0.5));
      for (const suppressed of subsets) {
        const result = withoutSuppressed(graph, faces, suppressed);
        const gone = new Set(suppressed);
        const expected = sides
          .map(([left, right], edge) => ({ left, right, edge }))
          .filter(({ left, right }) => {
            if (left === right) return true;
            const emits = (side: number) => side >= 0 && !gone.has(side);
            return !emits(left) && !emits(right);
          })
          .map(({ edge }) => edge);
        expect(result.walls, `seed ${seed}, suppressing ${suppressed.join(",")}`).toEqual(expected);
        expect(result.faces).toHaveLength(faces.faces.length - gone.size);
        suppressions += 1;
        linesFromSuppression += result.walls.length - faces.walls.length;
      }
    }
    // A sweep in which suppressing never turned a wall into a line would not have reached the rule.
    expect(usable, "usable seeds").toBeGreaterThan(seeds / 2);
    expect(suppressions).toBeGreaterThan(0);
    expect(linesFromSuppression, "walls that became lines").toBeGreaterThan(0);
  });
});
