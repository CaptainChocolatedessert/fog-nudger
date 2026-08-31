import { describe, expect, it } from "vitest";

import { buildFaces, describeAreaCheck, fitFaces, resolveFaces, type GraphFace } from "./faces";
import { maskFromRows } from "./fixtures";
import { labelSpace, type LabelledSpace } from "./label";
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

/**
 * A lollipop: two boxes joined by a stalk, which is the shape that broke taking bridges out.
 *
 * The stalk has the exterior on both sides, so it is a bridge. The exterior's boundary walks around
 * the left box, along the stalk, around the right box, and back along the stalk — one hole. Remove
 * the stalk and that hole genuinely becomes **two**, one round each box. Skipping the stalk's two
 * half-edges without splitting leaves a ring that jumps from one box to the other.
 */
const LOLLIPOP = [
  ".................",
  ".................",
  "..#####...#####..",
  "..#...#...#...#..",
  "..#...#####...#..",
  "..#...#...#...#..",
  "..#####...#####..",
  ".................",
  ".................",
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
});

/**
 * Making the area check FAIL, which nothing had ever done.
 *
 * `CLAUDE.md`'s standing rules say to treat a clean diagnostic as evidence about the *diagnostic*
 * until it has failed at least once, and name this one as owing exactly this test. A version of it
 * existed and did not do the job: it copied a face's points, moved a vertex, recomputed the shoelace
 * sum **in the test**, and asserted the answer had changed. No production code saw the corruption,
 * so it asserted that moving a corner of a square changes its area — true with `buildFaces` deleted.
 *
 * ## Corrupting the labelling, not the ring
 *
 * The check compares two numbers reached by unrelated routes: the polygon area the traversal walked,
 * and the pixel count the labelling holds for the same face. Feeding `buildFaces` a doctored ring is
 * awkward — the rings are what it produces, not what it takes — but the labelling *is* an input, and
 * moving one region's pixel count by one breaks the identity for exactly that face and nothing else.
 * The topology is untouched: same `labels` array, so the same cycles are walked and assigned to the
 * same faces. Only the arithmetic stops balancing.
 *
 * That is the right corruption to inject, because it is the shape of the real thing. The two defects
 * this check caught on a real map were both a face coming up a pixel or two short — a stranded
 * skeleton pixel, and a sliver enclosing half a lattice square. Neither was visible in the picture,
 * which is the whole reason the check exists rather than somebody looking.
 */
describe("the area check", () => {
  /** The labelling `buildFaces` expects, with one region's pixel count moved by `delta`. */
  function withRegionArea(
    labelled: LabelledSpace,
    id: number,
    delta: number,
  ): LabelledSpace {
    return {
      ...labelled,
      regions: labelled.regions.map((region) =>
        region.id === id ? { ...region, area: region.area + delta } : region,
      ),
    };
  }

  const parts = () => {
    const graph = graphOf(ROOM);
    return { graph, labelled: labelSpace(graph.framed, { minArea: 0 }) };
  };

  it("passes on the untouched fixture, so the failures below mean something", () => {
    const { graph, labelled } = parts();
    const result = buildFaces(graph, labelled);

    expect(result.checked).toBeGreaterThan(0);
    expect(result.exact).toBe(result.checked);
    expect(describeAreaCheck(result)).toContain("area check exact");
  });

  it("REPORTS A FAILURE when a face's pixel count is off by one", () => {
    const { graph, labelled } = parts();
    const target = labelled.regions[0]!.id;
    const result = buildFaces(graph, withRegionArea(labelled, target, 1));

    // The count the log reads, and the flag on the face itself.
    expect(result.exact).toBe(result.checked - 1);
    const broken = result.faces.find((face) => face.label === target);
    expect(broken, `no face carries label ${target}`).toBeDefined();
    expect(broken!.exact).toBe(false);
    expect(broken!.doubleArea).not.toBe(broken!.expectedDoubleArea);
  });

  it("blames only the face that was corrupted", () => {
    // A check that went red across the board on a single bad pixel count would still be reporting a
    // failure, and would be useless for finding which face to look at.
    const { graph, labelled } = parts();
    const target = labelled.regions[0]!.id;
    const result = buildFaces(graph, withRegionArea(labelled, target, 1));

    for (const face of result.faces) {
      expect(face.exact, `face ${face.label}`).toBe(face.label !== target);
    }
  });

  it("fails in both directions, since an undercount is as wrong as an overcount", () => {
    const { graph, labelled } = parts();
    const target = labelled.regions[0]!.id;
    for (const delta of [1, -1, 7]) {
      const result = buildFaces(graph, withRegionArea(labelled, target, delta));
      expect(result.exact, `delta ${delta}`).toBe(result.checked - 1);
    }
  });

  it("says FAILED in the line that goes to the log", () => {
    /*
      The string is the finding. `CLAUDE.md`'s rule is "if it ever says FAILED, stop; nothing
      downstream is real" — so the wording is what that rule is written against, and a check that
      detected the fault while reporting it as exact would be worse than no check at all.
    */
    const { graph, labelled } = parts();
    const target = labelled.regions[0]!.id;
    const line = describeAreaCheck(buildFaces(graph, withRegionArea(labelled, target, 1)));

    expect(line).toContain("area check FAILED");
    expect(line).toContain(`1 of ${buildFaces(graph, labelled).checked} faces`);
    expect(line).not.toContain("exact");
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
    const roomRing = rings[room]![0]![0]!;
    const bandHole = rings[band]![1]![0]!;
    expect(roomRing.points).toHaveLength(bandHole.points.length);
    expect(new Set(roomRing.points.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(bandHole.points.map((p) => `${p.x},${p.y}`)),
    );
    // The vertex ids that used to be asserted here went on 2026-08-31 -- the scene is never read
    // back, so nothing consumed them. What made the join reconstructible is still true and still
    // checked: both faces are assembled from the SAME fitted edge, so the points are identical
    // rather than merely close, which is what the set comparison above says.
  });

  it("splits a ring in two when a bridge between them is dropped", () => {
    const { graph, result } = facesOf(LOLLIPOP);
    const bridges = new Set<number>();
    // The stalk: the same face on both sides of it.
    const sideOf = new Map<number, number>();
    for (const face of result.faces) {
      for (const cycle of face.cycles) {
        for (const half of cycle.halfEdges) sideOf.set(half, face.label);
      }
    }
    for (let edge = 0; edge < graph.edges.length; edge += 1) {
      const left = sideOf.get(edge * 2);
      if (left !== undefined && left === sideOf.get(edge * 2 + 1)) bridges.add(edge);
    }
    expect(bridges.size, "the stalk is a bridge").toBeGreaterThan(0);

    const exterior = result.faces.reduce((best, face) =>
      face.doubleArea > best.doubleArea ? face : best,
    );
    const index = result.faces.indexOf(exterior);

    const whole = fitFaces(graph, result.faces, 0).rings[index]!;
    const split = fitFaces(graph, result.faces, 0, bridges).rings[index]!;

    // The hole around both boxes becomes a hole around each.
    const wholeCount = whole.reduce((total, list) => total + list.length, 0);
    const splitCount = split.reduce((total, list) => total + list.length, 0);
    expect(splitCount).toBe(wholeCount + 1);

    // And no ring teleports: every step is still to an 8-neighbour, which is what a linear skip
    // broke — the outline jumped from the stalk's base to the far box and back.
    for (const list of split) {
      for (const ring of list) {
        for (let i = 0; i < ring.points.length; i++) {
          const a = ring.points[i]!;
          const b = ring.points[(i + 1) % ring.points.length]!;
          expect(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps a square square, corners and all", () => {
    const { graph, result } = facesOf(ROOM);
    const { rings } = fitFaces(graph, result.faces, 0.5);
    const room = result.faces.findIndex((face) => face.cycles.length === 1);
    const ring = rings[room]![0]![0]!.points;

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
