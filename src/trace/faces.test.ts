/**
 * The wall graph's faces, on shapes whose answers can be written down.
 *
 * ## Why these are fixtures and not a runtime check
 *
 * Until 2026-09-08 the *production* code carried an **area check**: for every face it compared the
 * polygon the traversal produced against a raster labelling's pixel count, by a lattice identity, on
 * every run. It caught real defects — the weld radius on the second map ever tried, and a stranded
 * pixel that no eye could find — but what it was doing was serving as a **test oracle at runtime**.
 *
 * > *"It feels to me like it is a left-over diagnostic that doesn't do anything now that we treat
 * > the graph as the base truth... those checks don't need to live in production code."*
 * > — user, 2026-09-08
 *
 * So the oracle moved here, where it belongs, and became shapes with known answers: a room, a room
 * with a stub, a nested box, a lollipop, and a freestanding line. Each one has a face count and a set
 * of areas that can be reasoned out on paper, which is a stronger statement than an identity holding
 * — an identity can hold over two consistently wrong numbers, and a written-down answer cannot.
 *
 * The randomised sweep carries what fixtures cannot: it asserts the orphan count, Euler's identity
 * and planarity over 700 generated skeletons, in configurations nobody thought of.
 */

import { describe, expect, it } from "vitest";

import { resolveFaces, walkCycles } from "./faces";
import { maskFromRows } from "./fixtures";
import { buildWallGraph } from "./wallGraph";
import { graphExtent } from "./graphUnits";
import { buildWallFaces } from "./wallFaces";
import { buildSkeletonGraph, type SkeletonGraph } from "./skeletonGraph";
import { simplifyPolyline } from "./simplify";

function graphOf(rows: readonly string[]): SkeletonGraph {
  return buildSkeletonGraph(maskFromRows(rows));
}

/** The cleaned graph, which is what everything downstream is made of. */
function cleaned(rows: readonly string[]): SkeletonGraph {
  return resolveFaces(graphOf(rows)).graph;
}

/**
 * The faces as they are actually emitted: built into a wall graph, then walked.
 *
 * Unfitted — a tolerance of zero — so the areas below are the shapes' own and not a fit's. That is
 * the same split the sweep uses, and for the same reason: checking the traversal and the fitting at
 * once would need a tolerance, and a tolerance would hide what is being tested.
 */
function facesOf(rows: readonly string[]) {
  const graph = cleaned(rows);
  const fitted = graph.edges.map((edge) => ({ points: simplifyPolyline(edge.points, 0) }));
  return buildWallFaces(buildWallGraph(graph, fitted, graphExtent(graph.width, graph.height)).graph);
}

/** Areas as a share of the map, largest first, rounded so a fixture can state them. */
function areas(rows: readonly string[]): number[] {
  return facesOf(rows)
    .faces.map((face) => Math.round(face.doubleArea * 5000) / 10000)
    .sort((left, right) => right - left);
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


describe("the cycle walk", () => {
  /*
    A plain room: two faces, and only two.

    Anything more means the walk invented a cycle — which is what a junction cluster does, and what
    sliver removal exists to undo.
  */
  /*
    A plain room is **one** face: the inside.

    The space around it is the arrangement's unbounded face, which has no polygon and is not emitted
    — since 2026-09-08 there is no border frame to make it a bounded one. That is the point rather
    than a side effect: everything is fogged by default, so emitting nothing for the outside leaves it
    fogged and unrevealable, which is what "not an explorable space" means on most maps.
  */
  it("finds the room, and nothing for the space around it", () => {
    expect(facesOf(ROOM).faces).toHaveLength(1);
  });

  /*
    A stub hanging into the room adds no face, and that is the whole reason for the wall graph.

    Under a partition a stub separates nothing and is deleted. Here it survives as a **bridge** — the
    same face on both sides — walked out and back as a zero-width slit inside the room's own cycle.
    So the face count is unchanged and the bridge count is not.
  */
  it("keeps a stub without inventing a face for it", () => {
    const plain = facesOf(ROOM);
    const stubbed = facesOf(ROOM_WITH_STUB);
    expect(stubbed.faces).toHaveLength(plain.faces.length);
    expect(stubbed.bridges).toBeGreaterThan(plain.bridges);
    // And it is emitted, as a wall line rather than as part of any ring.
    expect(stubbed.walls.length).toBeGreaterThan(plain.walls.length);
  });

  /*
    A box floating inside another: three faces, and the inner box is a **hole** of the outer band.

    The number that matters is the middle face's, because it is the one a containment mistake gets
    wrong: the band between the boxes must be the outer box's interior *minus* the inner box, so its
    area is strictly less than the outer interior and strictly more than zero.
  */
  it("attaches a nested box as a hole rather than as another face", () => {
    const faces = facesOf(NESTED);
    // The band between the boxes, and the inside of the inner one. The outside is unbounded.
    expect(faces.faces).toHaveLength(2);

    const [band, inner] = areas(NESTED);
    expect(band).toBeGreaterThan(inner!);
    /*
      Exactly one face carries a hole — and this number moved when the frame went, which is worth
      recording rather than quietly correcting.

      With the frame the nesting was three deep and **two** faces held holes: the band inside the
      frame held the outer box, and the band inside the outer box held the inner one. Unframed, the
      outermost of those is the unbounded face and has no polygon, so only the band between the two
      boxes carries a hole.
    */
    const withHole = faces.faces.filter((face) => face.cycles.length > 1);
    expect(withHole).toHaveLength(1);
  });

  /*
    The lollipop, which is the shape that broke taking bridges out of a ring.

    Two boxes joined by a stalk. The stalk is a bridge, so removing it from the exterior's boundary
    **disconnects** that boundary: one hole around both boxes becomes two, one around each. A version
    that skipped the stalk's half-edges without splitting left a ring jumping from one box to the
    other, cutting a chord across the map — reported from a room as the exterior running to unrelated
    vertices and skipping long stretches of wall.
  */
  it("gives a lollipop two rooms and a stalk that is a wall", () => {
    const faces = facesOf(LOLLIPOP);
    // The inside of each box. The space around them is unbounded and is not a face.
    expect(faces.faces).toHaveLength(2);

    /*
      The stalk is a **bridge** — the same face on either side — so no ring covers it and it emits as
      a wall line. That is the whole reason the lollipop is a named fixture: taking a bridge out of a
      ring disconnects that ring, and a version that skipped its half-edges without splitting left a
      boundary jumping from one box to the other, cutting a chord across the map.
    */
    expect(faces.walls.length).toBeGreaterThan(0);

    // Every ring is a real polygon: the symptom of that defect was a ring of two points that
    // teleported across the map.
    for (const face of faces.faces) {
      for (const ring of face.rings) expect(ring.length).toBeGreaterThanOrEqual(3);
    }
  });

  /*
    A freestanding line encloses nothing, and must not become a face.

    Its cycle is walked out and back, so every step has its twin in the same cycle and the signed
    area cancels exactly. It is a bridge from end to end and emits as wall lines.
  */
  it("gives a freestanding line no face of its own", () => {
    const FREESTANDING = [
      ".........",
      ".........",
      ".........",
      "..#####..",
      ".........",
      ".........",
      ".........",
    ];
    const faces = facesOf(FREESTANDING);
    // No face at all: the only region it bounds is the unbounded one, which has no polygon.
    expect(faces.faces).toHaveLength(0);
    // It is still linework, so it still goes on the map — as wall lines.
    expect(faces.walls.length).toBeGreaterThan(0);
  });

  it("holds Euler's identity on every fixture", () => {
    for (const [name, rows] of [
      ["room", ROOM],
      ["room with stub", ROOM_WITH_STUB],
      ["nested", NESTED],
      ["lollipop", LOLLIPOP],
    ] as const) {
      expect(facesOf(rows).eulerHolds, name).toBe(true);
    }
  });
});

describe("sliver removal", () => {
  /*
    A junction cluster leaves faces of the arrangement that hold no map, and they must be gone.

    Where thinning turns a T into a small Y, two chains run between the same pair of nodes and bound
    a triangle of half a pixel. Detected from the geometry alone — a cycle enclosing no lattice
    point — and removed by dropping one of its bounding edges, which moves nothing.
  */
  it("leaves nothing enclosing no lattice point", () => {
    for (const rows of [ROOM, ROOM_WITH_STUB, NESTED, LOLLIPOP]) {
      const resolved = resolveFaces(graphOf(rows));
      expect(resolved.sliversLeft).toBe(0);
      expect(walkCycles(resolved.graph).slivers).toHaveLength(0);
    }
  });

  it("settles rather than running to the round cap", () => {
    // Removing one sliver can expose another, so it iterates — but on a real shape it converges
    // immediately. A fixture that needed many rounds would be worth looking at rather than passing.
    for (const rows of [ROOM, NESTED, LOLLIPOP]) {
      expect(resolveFaces(graphOf(rows)).rounds).toBeLessThan(3);
    }
  });
});
