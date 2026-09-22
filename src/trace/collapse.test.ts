/**
 * Collapsing small regions: the fixtures a GM would recognise, then an oracle over random graphs.
 *
 * The oracle shares none of the implementation's reasoning about *which* walls go or where the star
 * lands. It asks what a GM would ask of the result: did anything outside the region move, did any two
 * other regions merge or any one split, do walls cross, does Euler's identity still hold — and it asks
 * the last three of `collapseAll` too. The partition check is by sample points and `regionAt`, which is
 * Dissolve's lookup, not anything this module decides.
 *
 * **Twenty-one mutations** (2026-09-21): eighteen caught; one answered by deleting the check it
 * disabled, which the wall check already covered; one surviving because it decides nothing on a valid
 * graph, measured over 9,521 regions; and one kept as defence in depth and said so beside it. Two of
 * the eighteen first **hung** rather than failing, which is what put the shrink guard into
 * `collapseAll`.
 *
 * **Two real faults, both found by the oracle and neither by a fixture.** On its first run: two
 * vertices a float32 step apart either side of a region's boundary, which the containment test passed
 * and the edit's sweep then split. And at four times the usual size, after the wall grid went in: a
 * region refused at the press qualifying once a neighbour had gone, and `collapseAll` taking it
 * without its ever having been ringed. The grid itself passed the heavier run unchanged.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import { applyCollapses, collapseAll, findCollapses, type Collapse } from "./collapse";
import { deriveWalls } from "./deriveWalls";
import { regionAt } from "./dissolve";
import { randomInk, randomWallGraph, seededRandom } from "./fixtures";
import { graphExtent } from "./graphUnits";
import { findCrossings } from "./planarGraph";
import { insertEdge } from "./planarOps";
import { buildWallFaces, containsPoint, type WallFaces } from "./wallFaces";
import type { WallGraph } from "./wallGraph";

/** Fixture coordinates are integers times this, which float32 holds exactly. */
const S = 1 / 64;

/** A graph from polylines of integer points, each added the way Draw adds a wall. */
function build(...polylines: (readonly [number, number])[][]): WallGraph {
  let graph: WallGraph = { nodes: [], edges: [] };
  for (const line of polylines) {
    graph = insertEdge(graph, line.map(([x, y]) => ({ x: x * S, y: y * S }))).graph;
  }
  return graph;
}

const at = (x: number, y: number): Vector2 => ({ x: x * S, y: y * S });

function hasNode(graph: WallGraph, point: Vector2): boolean {
  return graph.edges.some((edge) =>
    [edge.a, edge.b].some((id) => graph.nodes[id]!.x === point.x && graph.nodes[id]!.y === point.y),
  );
}

/** The one candidate whose outline contains a point. */
function candidateAt(graph: WallGraph, point: Vector2, limit = Infinity): Collapse | undefined {
  const faces = buildWallFaces(graph);
  return findCollapses(graph, faces, limit).find((c) => containsPoint(c.outline, point));
}

const ROOM: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 6],
  [0, 6],
  [0, 0],
];

describe("the cases a GM would recognise", () => {
  /*
    The case the tool is for: detail drawn just inside a room's top wall, touching it at two points.
    The average of those two lies on the wall, so the wall stays exactly where it was drawn and the
    room gets the sliver's area back.
  */
  it("collapses a sliver against a straight wall onto the wall itself", () => {
    const graph = build(ROOM, [
      [3, 0],
      [4, 1],
      [6, 1],
      [7, 0],
    ]);
    const sliver = candidateAt(graph, at(5, 0.5));
    expect(sliver).toBeDefined();
    expect(sliver!.connections).toHaveLength(2);
    expect(sliver!.centre).toEqual(at(5, 0));
    expect(sliver!.area).toBeCloseTo(3 * S * S, 12);

    const after = applyCollapses(graph, [sliver!]).graph;
    const faces = buildWallFaces(after);
    expect(faces.faces).toHaveLength(1);
    expect(faces.faces[0]!.doubleArea / 2).toBeCloseTo(60 * S * S, 12);
    expect(findCrossings(after)).toHaveLength(0);
    // Nothing moved: the two connections are where they were.
    expect(hasNode(after, at(3, 0)) && hasNode(after, at(7, 0))).toBe(true);
  });

  it("deletes a loop touching nothing, and gives its area to the room around it", () => {
    const graph = build(ROOM, [
      [4, 2],
      [5, 2],
      [5, 3],
      [4, 3],
      [4, 2],
    ]);
    const pebble = candidateAt(graph, at(4.5, 2.5));
    expect(pebble!.connections).toHaveLength(0);
    expect(pebble!.centre).toBeNull();
    const after = applyCollapses(graph, [pebble!]).graph;
    const faces = buildWallFaces(after);
    expect(faces.faces).toHaveLength(1);
    expect(faces.faces[0]!.doubleArea / 2).toBeCloseTo(60 * S * S, 12);
  });

  it("deletes a loop hanging off one vertex and leaves the stalk it hung from", () => {
    const graph = build(
      ROOM,
      [
        [5, 0],
        [5, 2],
      ],
      [
        [5, 2],
        [6, 3],
        [4, 3],
        [5, 2],
      ],
    );
    const head = candidateAt(graph, at(5, 2.6));
    expect(head!.connections).toHaveLength(1);
    expect(head!.centre).toBeNull();
    const after = applyCollapses(graph, [head!]).graph;
    expect(buildWallFaces(after).faces).toHaveLength(1);
    // The stalk is still there, now a dead end.
    expect(hasNode(after, at(5, 2))).toBe(true);
    expect(buildWallFaces(after).freeEnds).toBe(1);
  });

  /*
    Three walls running into a small triangle from three sides of a room: the triangle becomes the
    junction the three walls meet at, and the three rooms they divide stay three.
  */
  it("turns a small loop with three connections into a three-way junction", () => {
    const graph = build(
      ROOM,
      [
        [5, 0],
        [5, 2],
        [6, 3],
        [4, 3],
        [5, 2],
      ],
      [
        [6, 3],
        [10, 3],
      ],
      [
        [4, 3],
        [0, 3],
      ],
    );
    const before = buildWallFaces(graph).faces.length;
    const triangle = candidateAt(graph, at(5, 2.6));
    expect(triangle!.connections).toHaveLength(3);
    const after = applyCollapses(graph, [triangle!]).graph;
    const faces = buildWallFaces(after);
    expect(faces.faces).toHaveLength(before - 1);
    expect(faces.eulerHolds).toBe(true);
    expect(findCrossings(after)).toHaveLength(0);
  });

  /*
    A U whose two tips are the connections: their average sits in the notch, outside the region, so a
    spoke would cut across whatever is in the notch without crossing a wall. Not offered.
  */
  it("does not offer a region whose spokes would leave it", () => {
    const graph = build(
      [
        [0, 0],
        [6, 0],
        [6, 6],
        [4, 6],
        [4, 2],
        [2, 2],
        [2, 6],
        [0, 6],
        [0, 0],
      ],
      [
        [0, 6],
        [0, 9],
      ],
      [
        [6, 6],
        [6, 9],
      ],
    );
    expect(candidateAt(graph, at(1, 1))).toBeUndefined();
  });

  /*
    A wall drawn as two lines makes a thin ring of region round a whole room. Its own area is small;
    the area inside its outer boundary is the room's and more, so it is not offered until the limit
    reaches that — and when it does, the room inside goes with it.
  */
  it("measures a ring round a room by the area inside it, holes included", () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const inner: [number, number][] = [
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
      [1, 1],
    ];
    const graph = build(outer, inner);
    const faces = buildWallFaces(graph);
    // The ring's own area is 36; inside its outer boundary is 100.
    expect(findCollapses(graph, faces, 50 * S * S).some((c) => c.area > 64 * S * S)).toBe(false);
    const ring = findCollapses(graph, faces, 100 * S * S).find((c) => c.area > 64 * S * S);
    expect(ring!.area).toBeCloseTo(100 * S * S, 12);
    expect(ring!.edges).toHaveLength(graph.edges.length);
  });

  it("measures a ring pinched to its room at a vertex the same way", () => {
    const graph = build(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [0, 0],
        [8, 1],
        [9, 9],
        [1, 8],
        [0, 0],
      ],
    );
    const faces = buildWallFaces(graph);
    const found = findCollapses(graph, faces, 100 * S * S);
    // The inner room and the ring both qualify at 100; the ring measures the whole square.
    expect(found.map((c) => c.area).sort((a, b) => b - a)[0]).toBeCloseTo(100 * S * S, 12);
  });

  it("takes a region exactly at the limit and not one just over it", () => {
    const graph = build(ROOM, [
      [3, 0],
      [4, 1],
      [6, 1],
      [7, 0],
    ]);
    const faces = buildWallFaces(graph);
    const area = 3 * S * S;
    expect(findCollapses(graph, faces, area).some((c) => c.area === area)).toBe(true);
    expect(findCollapses(graph, faces, area * 0.999)).toHaveLength(0);
    expect(findCollapses(graph, faces, 0)).toHaveLength(0);
  });

  /*
    Three cells in a row against a wall share their dividing walls, so neighbours cannot go in one
    round: the first round takes the two ends, and the middle one then has a wedge of each. With room
    under the limit for that growth, a second round takes it too.

    At a limit exactly the cells' own area it does not — the middle one was ringed, grew past the limit
    when its neighbours went, and is left. That is the stated cost of rounds, pinned rather than
    described.
  */
  it("collapses a row of touching cells in rounds, and leaves one that grew past the limit", () => {
    const graph = build(
      ROOM,
      [
        [2, 0],
        [2, 1],
        [8, 1],
        [8, 0],
      ],
      [
        [4, 0],
        [4, 1],
      ],
      [
        [6, 0],
        [6, 1],
      ],
    );
    expect(findCollapses(graph, buildWallFaces(graph), 2 * S * S)).toHaveLength(3);

    const roomy = collapseAll(graph, 3 * S * S);
    expect(roomy.rounds).toBe(2);
    expect(roomy.collapsed).toBe(3);
    expect(findCollapses(roomy.graph, buildWallFaces(roomy.graph), 3 * S * S)).toHaveLength(0);
    expect(buildWallFaces(roomy.graph).faces).toHaveLength(1);
    expect(findCrossings(roomy.graph)).toHaveLength(0);

    const tight = collapseAll(graph, 2 * S * S);
    expect(tight.rounds).toBe(1);
    expect(tight.collapsed).toBe(2);
    expect(tight.stopped).toBe(false);
    expect(buildWallFaces(tight.graph).faces).toHaveLength(2);
  });

  /*
    Squares inside squares: each one's walls include the one inside it, so no two can go in a round,
    and every region goes in a round of its own — as many rounds as there were regions, the most there
    can ever be. The last round leaves nothing, and that is an ordinary finish, not the guard firing.
  */
  it("finishes a graph whose regions go one a round without stopping early", () => {
    const box = (low: number, high: number): [number, number][] => [
      [low, low],
      [high, low],
      [high, high],
      [low, high],
      [low, low],
    ];
    const graph = build(box(0, 12), box(2, 10), box(4, 8));
    expect(buildWallFaces(graph).faces).toHaveLength(3);
    const all = collapseAll(graph, Infinity);
    expect(all.rounds).toBe(3);
    expect(all.stopped).toBe(false);
    expect(all.graph.edges).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------------ */

/** Which region each point is in, `-1` for none. */
function regionsOf(faces: WallFaces, points: readonly Vector2[]): number[] {
  return points.map((point) => regionAt(faces, point) ?? -1);
}

/**
 * Two classings of the same points agree up to renaming: same before means same after, and different
 * before means different after. Returns the first disagreement, or `null`.
 */
function sameClasses(before: readonly number[], after: readonly number[]): string | null {
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (forward.has(b) && forward.get(b) !== a) return `point ${i}: region ${b} split`;
    if (backward.has(a) && backward.get(a) !== b) return `point ${i}: regions ${backward.get(a)} and ${b} merged`;
    forward.set(b, a);
    backward.set(a, b);
  }
  return null;
}

function nearOutline(point: Vector2, outline: readonly Vector2[], margin: number): boolean {
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const p = outline[j]!;
    const q = outline[i]!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.min(1, Math.max(0, ((point.x - p.x) * dx + (point.y - p.y) * dy) / length)) : 0;
    if (Math.hypot(point.x - p.x - t * dx, point.y - p.y - t * dy) <= margin) return true;
  }
  return false;
}

const key = (point: Vector2): string => `${point.x},${point.y}`;
const segmentKey = (graph: WallGraph, edge: { a: number; b: number }): string =>
  [key(graph.nodes[edge.a]!), key(graph.nodes[edge.b]!)].sort().join("|");

interface Reach {
  none: number;
  one: number;
  two: number;
  more: number;
  refused: number;
  contents: number;
  pinched: number;
}

/**
 * Collapse every region that can be collapsed, one at a time, and check each result.
 *
 * `graphs` yields the graphs; the sample points are spread over the map's unit square.
 */
function sweep(graphs: Iterable<WallGraph>, reach: Reach): void {
  const next = seededRandom(99);
  const samples: Vector2[] = Array.from({ length: 400 }, () => ({ x: next() * 1.1, y: next() * 1.1 }));

  for (const graph of graphs) {
    const faces = buildWallFaces(graph);
    if (!faces.eulerHolds || findCrossings(graph).length > 0) continue;
    const offered = findCollapses(graph, faces, Infinity);
    reach.refused += faces.faces.length - offered.length;
    // Smallest first, which is the order a round takes them in.
    for (let i = 1; i < offered.length; i++) expect(offered[i]!.area).toBeGreaterThanOrEqual(offered[i - 1]!.area);
    const before = regionsOf(faces, samples);

    for (const collapse of offered) {
      const n = collapse.connections.length;
      if (n === 0) reach.none += 1;
      else if (n === 1) reach.one += 1;
      else if (n === 2) reach.two += 1;
      else reach.more += 1;
      const own = new Set<number>();
      for (const cycle of faces.faces[collapse.face]!.cycles) {
        for (const half of cycle.halfEdges) own.add(faces.sourceEdges[half >> 1]!);
      }
      if (collapse.edges.some((edge) => !own.has(edge))) reach.contents += 1;

      const result = applyCollapses(graph, [collapse]).graph;
      const label = `collapse of region ${collapse.face} with ${n} connections`;

      // Planar, and the traversal is coherent.
      expect(findCrossings(result), label).toHaveLength(0);
      const after = buildWallFaces(result);
      expect(after.eulerHolds, label).toBe(true);
      // At least the region itself went, and nothing new appeared.
      expect(after.faces.length, label).toBeLessThan(faces.faces.length);

      // Nothing outside the region moved: every segment is either one the graph had or a spoke from
      // the centre to a point the graph had.
      const had = new Set(graph.edges.map((edge) => segmentKey(graph, edge)));
      const points = new Set(graph.nodes.map(key));
      for (const edge of result.edges) {
        if (had.has(segmentKey(result, edge))) continue;
        const ends = [result.nodes[edge.a]!, result.nodes[edge.b]!];
        const atCentre = collapse.centre !== null && ends.some((end) => key(end) === key(collapse.centre!));
        expect(atCentre && ends.some((end) => points.has(key(end))), label).toBe(true);
      }

      // No two regions merged and none split, judged on points clear of the collapsed region.
      const clear = samples
        .map((point, index) => ({ point, index }))
        .filter(
          ({ point }) =>
            !containsPoint(collapse.outline, point) && !nearOutline(point, collapse.outline, 1e-6),
        );
      const afterRegions = regionsOf(after, clear.map(({ point }) => point));
      const problem = sameClasses(
        clear.map(({ index }) => before[index]!),
        afterRegions,
      );
      expect(problem, label).toBeNull();

      // A neighbour that touched the region in two places now touches itself at the centre, and
      // Euler above says it is still one region rather than two.
      if (collapse.centre) {
        const centre = key(collapse.centre);
        const edgeOf = (half: number) => result.edges[after.sourceEdges[half >> 1]!]!;
        const origin = (half: number) => ((half & 1) === 0 ? edgeOf(half).a : edgeOf(half).b);
        for (const face of after.faces) {
          const visits = face.cycles
            .flatMap((cycle) => cycle.halfEdges)
            .filter((half) => key(result.nodes[origin(half)]!) === centre).length;
          if (visits >= 2) reach.pinched += 1;
        }
      }
    }
  }
}

function* wallGraphs(count: number): Iterable<WallGraph> {
  for (let seed = 1; seed <= count; seed++) yield randomWallGraph(seededRandom(seed), 3 + (seed % 9));
}

function* derivedGraphs(count: number): Iterable<WallGraph> {
  for (let seed = 1; seed <= count; seed++) {
    yield deriveWalls(randomInk(40, 30, seededRandom(seed), 22), {
      tolerance: 0,
      maxTolerance: 0,
      pruneLimit: 0,
      extent: graphExtent(40, 30),
    }).walls.graph;
  }
}

describe("over random graphs, against an oracle that shares none of the reasoning", () => {
  it("moves nothing outside the region, merges and splits nothing, and stays planar", () => {
    const reach: Reach = { none: 0, one: 0, two: 0, more: 0, refused: 0, contents: 0, pinched: 0 };
    sweep(wallGraphs(300), reach);
    sweep(derivedGraphs(150), reach);
    // Every kind of collapse has to have been met, or the sweep is a green light about nothing.
    expect(reach.none, "no connections").toBeGreaterThan(0);
    expect(reach.one, "one connection").toBeGreaterThan(0);
    expect(reach.two, "two connections").toBeGreaterThan(0);
    expect(reach.more, "three or more").toBeGreaterThan(0);
    expect(reach.refused, "regions not offered").toBeGreaterThan(0);
    expect(reach.contents, "something inside taken with it").toBeGreaterThan(0);
    expect(reach.pinched, "a neighbour left touching itself").toBeGreaterThan(0);
  });

  /*
    `collapseAll` at a limit that catches some regions and not others: nothing under the limit is left,
    the graph is planar and coherent, and regions that were never under the limit — judged on points
    clear of every region that was — keep their partition.
  */
  /*
    **Only what was ringed at the press**, which the sweep at four times this size showed is not
    automatic: a region under the limit but refused — its spokes would have left it — can start to
    qualify once a neighbour has gone, and it was being taken without ever having been ringed. Seeds
    136, 157 and 159 of the wall-graph generator are three of the nine it found, so this runs to 200
    and asserts the case is met, by a region left on offer afterwards that holds ground no ringed
    region covered at the press.
  */
  it("collapses only what was ringed at the press, and leaves the rest of the partition alone", () => {
    const next = seededRandom(7);
    const samples: Vector2[] = Array.from({ length: 300 }, () => ({ x: next() * 1.1, y: next() * 1.1 }));
    const fine = (collapse: Collapse): Vector2[] => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of collapse.outline) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const points: Vector2[] = [];
      for (let i = 1; i < 24; i++) {
        for (let j = 1; j < 24; j++) {
          const p = { x: minX + ((maxX - minX) * i) / 24, y: minY + ((maxY - minY) * j) / 24 };
          if (containsPoint(collapse.outline, p) && !nearOutline(p, collapse.outline, 1e-6)) points.push(p);
        }
      }
      return points;
    };
    let collapsed = 0;
    let leftAlone = 0;
    for (const graph of [...wallGraphs(200), ...derivedGraphs(60)]) {
      const faces = buildWallFaces(graph);
      if (!faces.eulerHolds || findCrossings(graph).length > 0 || faces.faces.length < 2) continue;
      const areas = faces.faces.map((face) => face.doubleArea / 2).sort((a, b) => a - b);
      const limit = areas[Math.floor(areas.length / 2)]!;
      const offered = findCollapses(graph, faces, limit);
      const all = collapseAll(graph, limit);
      collapsed += all.collapsed;

      expect(findCrossings(all.graph)).toHaveLength(0);
      const after = buildWallFaces(all.graph);
      expect(after.eulerHolds).toBe(true);
      expect(all.collapsed).toBeLessThanOrEqual(offered.length);
      expect(all.stopped).toBe(false);

      // Nothing outside the regions ringed at the press merged or split, so nothing unringed was taken.
      const clear = samples.filter(
        (point) =>
          !offered.some(
            (collapse) => containsPoint(collapse.outline, point) || nearOutline(point, collapse.outline, 1e-6),
          ),
      );
      expect(sameClasses(regionsOf(faces, clear), regionsOf(after, clear))).toBeNull();

      // A region still on offer that holds ground no ringed region covered was not ringed: it is the
      // case this test exists for, left alone.
      for (const remaining of findCollapses(all.graph, after, limit)) {
        const own = fine(remaining).some((p) => !offered.some((o) => containsPoint(o.outline, p)));
        if (own) leftAlone += 1;
      }
    }
    expect(collapsed).toBeGreaterThan(100);
    expect(leftAlone, "a region that qualified only after a neighbour went").toBeGreaterThan(0);
  });
});
