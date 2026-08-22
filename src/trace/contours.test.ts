import { describe, expect, it } from "vitest";

import { commandCount, doubleSignedArea, type Ring } from "../geometry/ring";
import { traceRegions } from "./contours";
import { maskFromRows } from "./fixtures";
import { labelSpace, type LabelOptions } from "./label";

/**
 * Every fixture here is drawn rather than computed, for a reason step 4 paid for: two of its
 * fixtures were wrong before its code was, and both were predicates. A drawn grid cannot hide a
 * comb whose teeth are secretly joined.
 */
function trace(rows: readonly string[], options?: Partial<LabelOptions> & { minHoleArea?: number }) {
  const labelled = labelSpace(maskFromRows(rows), { minArea: options?.minArea ?? 0 });
  return {
    labelled,
    contours: traceRegions(labelled, { minHoleArea: options?.minHoleArea }),
  };
}

const asPairs = (ring: Ring) => ring.map((point) => [point.x, point.y]);

describe("traceRegions", () => {
  it("puts a room's boundary on the pixel corners, not the pixel centres", () => {
    // Three-by-three of space inside a one-pixel wall. The floor pixels run x 1..3 and y 1..3, so
    // the boundary of the *area* they cover runs from corner (1,1) to corner (4,4) — one past the
    // last floor pixel in each direction. A trace through pixel centres would report (3,3) as the
    // far corner and lose a pixel's width off every room.
    const { contours } = trace([
      "#####",
      "#...#",
      "#...#",
      "#...#",
      "#####",
    ]);

    expect(contours).toHaveLength(1);
    expect(asPairs(contours[0]!.rings[0]!)).toEqual([
      [1, 1],
      [4, 1],
      [4, 4],
      [1, 4],
    ]);
  });

  it("collapses a straight wall to its two ends", () => {
    // A twenty-pixel run of wall is two vertices, not twenty. Lossless — nothing that carries any
    // shape is discarded — and it is the difference between step 6 receiving thousands of points
    // per room and receiving dozens.
    const { contours } = trace([
      "######################",
      "#....................#",
      "#....................#",
      "######################",
    ]);

    expect(contours[0]!.rings[0]).toHaveLength(4);
  });

  it("gives adjacent rooms boundaries that meet the shared wall from opposite sides", () => {
    // The point of tracing on the lattice. Each room stops at the face of the wall it touches:
    // x = 3 for the left room, x = 4 for the right. Neither claims any of the wall, and neither
    // claims a sliver of the other — which is what a half-pixel disagreement would look like.
    const { contours } = trace([
      "#######",
      "#..#..#",
      "#..#..#",
      "#######",
    ]);

    expect(contours).toHaveLength(2);
    const [left, right] = contours;
    expect(asPairs(left!.rings[0]!)).toEqual([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
    expect(asPairs(right!.rings[0]!)).toEqual([
      [4, 1],
      [6, 1],
      [6, 3],
      [4, 3],
    ]);
  });

  it("traces a room with a pillar as an outer ring and a hole", () => {
    // Step 5's second requirement. The region is eight pixels: nine of floor less the pillar. The
    // outer ring encloses nine and the hole subtracts one, and the hole comes out negative without
    // anything having tested for containment.
    const { labelled, contours } = trace([
      "#####",
      "#...#",
      "#.#.#",
      "#...#",
      "#####",
    ]);

    const [room] = contours;
    expect(room!.outerCount).toBe(1);
    expect(room!.holeCount).toBe(1);
    expect(doubleSignedArea(room!.rings[0]!) / 2).toBe(9);
    expect(doubleSignedArea(room!.rings[1]!) / 2).toBe(-1);
    expect(room!.tracedArea).toBe(labelled.regions[0]!.area);
  });

  it("traces the outside as one boundary with a hole per enclosed cluster", () => {
    // Step 5's third requirement, and the reason DESIGN.md §4 calls the exterior the most complex
    // path we emit. Two separate blocks of wall sitting in open ground: the outside runs round the
    // whole raster and cuts a hole around each block.
    const { contours } = trace([
      ".........",
      ".###.###.",
      ".#.#.#.#.",
      ".###.###.",
      ".........",
    ]);

    const outside = contours[0]!;
    expect(outside.outerCount).toBe(1);
    expect(outside.holeCount).toBe(2);
    // The whole raster, less the two three-by-three blocks of wall-and-room.
    expect(doubleSignedArea(outside.rings[0]!) / 2).toBe(45);
    expect(outside.tracedArea).toBe(45 - 9 - 9);
    // And each enclosed room is its own region, unrelated to the hole cut for it.
    expect(contours).toHaveLength(3);
    expect(contours[1]!.tracedArea).toBe(1);
    expect(contours[2]!.tracedArea).toBe(1);
  });

  it("does not let a ring cross a diagonal touch of ink", () => {
    // The connectivity pairing again, one stage further down. Ink runs from the wall at (1,1) to
    // the island at (2,2), touching only at a corner. Ink is 8-connected so that is a seal, and the
    // space either side of it is one region only by the long way round.
    //
    // A single number separates the rules. Turning *toward* the region hugs the pixel being traced,
    // so the boundary pinches at the corner and the whole space is one ring. Turning away would run
    // the boundary straight through the diagonal, cutting the island loose as a spurious hole — two
    // rings — and that is a diagonal leak written into the geometry.
    const { labelled, contours } = trace([
      "######",
      "##...#",
      "#.#..#",
      "#....#",
      "#....#",
      "######",
    ]);

    expect(labelled.regions).toHaveLength(1);
    expect(labelled.regions[0]!.area).toBe(14);
    expect(contours[0]!.rings).toHaveLength(1);
    expect(contours[0]!.holeCount).toBe(0);
    expect(contours[0]!.tracedArea).toBe(14);
  });

  it("runs the boundary along the raster edge for a region that reaches it", () => {
    // No margin, no inset. A room running to the edge of the image has its boundary at 0 and at the
    // width, and an off-by-one here would show up as a hairline of permanent fog round the map.
    const { contours } = trace(["....", "....", "...."]);

    expect(asPairs(contours[0]!.rings[0]!)).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
  });

  it("traces a single pixel as a unit square", () => {
    const { contours } = trace(["###", "#.#", "###"]);

    expect(contours[0]!.rings[0]).toHaveLength(4);
    expect(contours[0]!.tracedArea).toBe(1);
  });

  it("keeps every region's ring areas summing to its pixel count", () => {
    // The one check that ties tracing back to labelling, and it is exact rather than approximate
    // because every vertex is an integer. A hole traced the wrong way round, a boundary off by a
    // pixel, or a ring silently lost all break it, and none of them would be visible in a vertex
    // count.
    const rows = [
      "..........",
      ".########.",
      ".#..#...#.",
      ".#..#.#.#.",
      ".#..#...#.",
      ".##.#####.",
      ".#......#.",
      ".########.",
      "..........",
    ];
    const { labelled, contours } = trace(rows);

    expect(contours.length).toBeGreaterThan(2);
    for (const region of contours) {
      const area = labelled.regions.find((r) => r.id === region.id)!.area;
      expect(region.tracedArea).toBe(area);
    }
  });

  it("fills in holes below the minimum area and says what it filled", () => {
    // The filter that stops step 4's dropped specks reappearing here as rings. A one-pixel pillar
    // is below a four-pixel minimum, so the room simply covers it — reported, because a filter that
    // does not say what it ate cannot be tuned.
    const rows = ["#####", "#...#", "#.#.#", "#...#", "#####"];
    const { contours } = trace(rows, { minHoleArea: 4 });

    expect(contours[0]!.holeCount).toBe(0);
    expect(contours[0]!.droppedHoles).toBe(1);
    expect(contours[0]!.droppedHoleArea).toBe(1);
    // Reported before the filter, so the invariant above still reads true against labelling.
    expect(contours[0]!.tracedArea).toBe(8);
  });

  it("keeps a hole that clears the minimum", () => {
    const rows = ["######", "#....#", "#.##.#", "#.##.#", "#....#", "######"];
    const { contours } = trace(rows, { minHoleArea: 4 });

    expect(contours[0]!.holeCount).toBe(1);
    expect(contours[0]!.droppedHoles).toBe(0);
  });

  it("costs one command per vertex plus a move and a close per ring", () => {
    // The figure step 6 has to keep under 8192. Checked here so the cap arithmetic is anchored to a
    // shape whose vertices can be counted by hand.
    const { contours } = trace(["#####", "#...#", "#.#.#", "#...#", "#####"]);

    // Four corners outside, four around the pillar, plus MOVE and CLOSE for each ring.
    expect(commandCount(contours[0]!.rings)).toBe(10);
  });

  it("traces nothing for a raster with no space in it", () => {
    const { contours } = trace(["###", "###"]);
    expect(contours).toEqual([]);
  });

  it("does not trace regions the minimum-area filter dropped", () => {
    // A dropped region is not a region, and tracing it would put back exactly what the filter
    // removed. What it *does* become is a hole in whatever encloses it, which is the other filter's
    // problem.
    const rows = [
      "#########",
      "#.......#",
      "#.......#",
      "#.......#",
      "#########",
      "###...###",
      "#########",
    ];
    const { labelled, contours } = trace(rows, { minArea: 10 });

    expect(labelled.regions).toHaveLength(1);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.id).toBe(1);
  });
});
