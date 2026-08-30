import { describe, expect, it } from "vitest";

import { fitFaces, resolveFaces, type GraphFace } from "./faces";
import { maskFromRows } from "./fixtures";
import { labelSpace } from "./label";
import { buildWallGraph, type WallGraph } from "./wallGraph";

/**
 * Fixtures are skeletons, not ink — everything here is already one pixel wide, because the graph is
 * built from a thinned and pruned skeleton rather than from the linework.
 *
 * The border of every fixture is *empty*, because `buildWallGraph` paints the raster frame in
 * itself. A fixture that drew its own border would end up with the frame twice.
 */
function graphOf(rows: readonly string[]): WallGraph {
  return buildWallGraph(maskFromRows(rows));
}

function facesOf(rows: readonly string[]) {
  // `resolveFaces`, not `buildFaces`: a raw traversal is not a usable partition until the sub-pixel
  // slivers a junction cluster leaves have been taken out, and every fixture here has them — the
  // border frame alone produces one at each of its own corners.
  const built = graphOf(rows);
  const resolved = resolveFaces(built, labelSpace(built.framed, { minArea: 0 }));
  return { graph: resolved.graph, result: resolved.faces };
}

const ROOM = [
  ".........",
  ".........",
  "..#####..",
  "..#...#..",
  "..#...#..",
  "..#...#..",
  "..#####..",
  ".........",
  ".........",
];

/** The same room with a two-pixel stub hanging off its left wall into the room. */
const ROOM_WITH_STUB = [
  ".........",
  ".........",
  "..#####..",
  "..#...#..",
  "..###.#..",
  "..#...#..",
  "..#####..",
  ".........",
  ".........",
];

/**
 * A small closed box floating inside a bigger one, sharing no pixel with it.
 *
 * Kept **two** pixels clear of the fixture's edge, not one. The frame is painted along the border,
 * and a box drawn one pixel in would be 8-adjacent to it the whole way round — fusing into a
 * two-pixel-thick band in which every pixel is a junction.
 */
const NESTED = [
  ".............",
  ".............",
  "..#########..",
  "..#.......#..",
  "..#..###..#..",
  "..#..#.#..#..",
  "..#..###..#..",
  "..#.......#..",
  "..#########..",
  ".............",
  ".............",
];

function faceOfArea(faces: readonly GraphFace[], doubleArea: number): GraphFace {
  const found = faces.find((face) => face.doubleArea === doubleArea);
  expect(found, `no face with doubled area ${doubleArea}`).toBeDefined();
  return found!;
}

describe("faces from the wall graph", () => {
  it("finds the room and the space around it, and nothing else", () => {
    const { result } = facesOf(ROOM);

    // The room's interior, and the band between the room and the border frame.
    expect(result.faces).toHaveLength(2);
    // One cycle carries no label: the unbounded face outside the frame.
    expect(result.unlabelled).toBe(1);
  });

  it("puts the face on the right of every half-edge, consistently", () => {
    const { result } = facesOf(ROOM);
    expect(result.disagreements).toBe(0);
    expect(result.ambiguous).toBe(0);
  });

  it("gives every face exactly one enclosing ring", () => {
    const { result } = facesOf(ROOM);
    for (const face of result.faces) {
      expect(face.cycles.filter((cycle) => cycle.doubleArea > 0)).toHaveLength(1);
    }
  });

  it("holds the area identity on a plain room", () => {
    const { result } = facesOf(ROOM);
    expect(result.exact).toBe(result.checked);

    const room = faceOfArea(result.faces, 32);
    expect(room.interior).toBe(9);
    expect(room.cycles).toHaveLength(1);
    expect(room.cycles[0]!.steps).toBe(16);
    // 2A = 2I + S + 2h - 2 = 18 + 16 - 2
    expect(room.expectedDoubleArea).toBe(32);
  });

  it("holds it on the band outside the room, which is a face with a hole", () => {
    const { result } = facesOf(ROOM);
    const band = faceOfArea(result.faces, 96);

    expect(band.interior).toBe(24);
    expect(band.cycles).toHaveLength(2);
    expect(band.cycles[1]!.doubleArea).toBeLessThan(0);
    // 2A = 48 + (32 + 16) + 2 - 2
    expect(band.expectedDoubleArea).toBe(96);
    expect(band.exact).toBe(true);
  });

  it("holds it on a face containing a bridge, which is where plain Pick would fail", () => {
    const { result } = facesOf(ROOM_WITH_STUB);
    const room = faceOfArea(result.faces, 32);

    expect(room.interior).toBe(7);
    // The stub is walked out and back, so it adds four steps and no area at all.
    expect(room.cycles[0]!.steps).toBe(20);
    expect(room.exact).toBe(true);
    expect(result.exact).toBe(result.checked);

    // Plain Pick counts *distinct* boundary points instead of steps, so it counts a slit pixel once
    // where it must be counted twice — and under-counts by exactly the length of the slit. Asserted
    // so nobody re-derives the wrong version and finds it "nearly right".
    const distinct = new Set(
      room.cycles[0]!.points.map((point) => `${point.x},${point.y}`),
    ).size;
    expect(distinct).toBe(18);
    expect(2 * room.interior + distinct - 2).toBe(30);
    expect(room.doubleArea).toBe(32);
  });

  it("attaches a nested component as a hole of the face it floats in", () => {
    const { result } = facesOf(NESTED);

    // Outside the frame; the band between frame and outer box; the outer box's interior; the inner
    // box's interior.
    expect(result.disagreements).toBe(0);
    expect(result.exact).toBe(result.checked);

    // The big box's interior: 5 x 7 of floor, less the 3 x 3 the inner box stands on.
    const outerRoom = result.faces.find((face) => face.interior === 26);
    expect(outerRoom).toBeDefined();
    // Its hole is the inner box, a separate connected component it never touches. Nothing tested
    // containment; the hole found its parent from the label one step to the right of its own wall.
    expect(outerRoom!.cycles).toHaveLength(2);
    expect(outerRoom!.cycles[1]!.doubleArea).toBeLessThan(0);

    // And the inner box's own interior is a face in its own right.
    expect(result.faces.some((face) => face.interior === 1)).toBe(true);
  });

  it("reports a corrupted ring as a failure", () => {
    const { result } = facesOf(ROOM);
    const room = faceOfArea(result.faces, 32);

    // Push the rightmost vertex one pixel further right. The shape still renders perfectly
    // plausibly, which is the whole reason this check exists — and it must no longer balance.
    const corrupted = [...room.cycles[0]!.points];
    let rightmost = 0;
    corrupted.forEach((point, index) => {
      if (point.x > corrupted[rightmost]!.x) rightmost = index;
    });
    corrupted[rightmost] = { x: corrupted[rightmost]!.x + 1, y: corrupted[rightmost]!.y };
    let doubled = 0;
    for (let i = 0; i < corrupted.length; i++) {
      const a = corrupted[i]!;
      const b = corrupted[(i + 1) % corrupted.length]!;
      doubled += a.x * b.y - b.x * a.y;
    }
    expect(doubled).not.toBe(room.expectedDoubleArea);
  });
});

describe("fitting the faces", () => {
  it("simplifies each edge once, so two faces sharing a wall get identical points", () => {
    const { graph, result } = facesOf(ROOM);
    const { rings } = fitFaces(graph, result.faces, 0.5);

    const band = result.faces.findIndex((face) => face.cycles.length === 2);
    const room = result.faces.findIndex((face) => face.cycles.length === 1);
    expect(band).toBeGreaterThanOrEqual(0);
    expect(room).toBeGreaterThanOrEqual(0);

    // The room's outer ring and the band's hole are the same wall, walked opposite ways.
    const roomRing = rings[room]![0]!;
    const bandHole = rings[band]![1]!;
    expect(roomRing.points).toHaveLength(bandHole.points.length);
    expect(new Set(roomRing.points.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(bandHole.points.map((p) => `${p.x},${p.y}`)),
    );
    // And the same vertex ids, which is what makes a join reconstructible rather than inferred.
    expect(new Set(roomRing.ids)).toEqual(new Set(bandHole.ids));
  });

  it("keeps a square square, corners and all", () => {
    const { graph, result } = facesOf(ROOM);
    const { rings } = fitFaces(graph, result.faces, 0.5);
    const room = result.faces.findIndex((face) => face.cycles.length === 1);
    const ring = rings[room]![0]!.points;

    const corners = new Set(ring.map((point) => `${point.x},${point.y}`));
    for (const corner of ["2,2", "6,2", "6,6", "2,6"]) {
      expect(corners.has(corner), `corner ${corner} was fitted away`).toBe(true);
    }
    // Four corners, and at most a couple of extra vertices: fitting pins every node, and removing a
    // sliver at a corner can leave one behind. Vertices are the cheap thing here.
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring.length).toBeLessThanOrEqual(6);
  });
});
