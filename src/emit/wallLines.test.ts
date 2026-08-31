import { describe, expect, it } from "vitest";

import { stageWallLines, wallStrokeWidth, type PlacedWall } from "./wallLines";

const OPTIONS = {
  run: "2026-08-30T00:00:00.000Z",
  mapId: "map-1",
  colour: "#111111",
  strokeWidth: 4,
};

/** A stub: three points, so two segments, running away from a junction at (10, 10). */
const STUB: PlacedWall = {
  edge: 7,
  points: [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 20, y: 25 },
  ],
  ids: [3, 41, 42],
};

describe("wall lines", () => {
  it("cuts a polyline into one item per segment", () => {
    const { lines } = stageWallLines([STUB], OPTIONS);
    expect(lines).toHaveLength(2);
  });

  it("stores the end relative to the position, as Dynamic Fog's wall mode does", () => {
    const { lines } = stageWallLines([STUB], OPTIONS);

    expect(lines[0]!.position).toEqual({ x: 10, y: 10 });
    expect(lines[0]!.end).toEqual({ x: 10, y: 0 });
    expect(lines[1]!.position).toEqual({ x: 20, y: 10 });
    expect(lines[1]!.end).toEqual({ x: 0, y: 15 });
  });

  it("carries the vertex ids of each segment's ends", () => {
    const { lines } = stageWallLines([STUB], OPTIONS);

    // The junction id is on the first segment, so the wall is joined to whatever ring also carries
    // it. The last id belongs to nothing else, which is what makes this a stub and not a doorway.
    expect(lines[0]!.provenance.vertices).toEqual([3, 41]);
    expect(lines[1]!.provenance.vertices).toEqual([41, 42]);
  });

  it("keeps consecutive segments sharing the id at the point they meet", () => {
    // What lets a wall be reassembled from its segments after it has been cut into items.
    const { lines } = stageWallLines([STUB], OPTIONS);
    expect(lines[0]!.provenance.vertices[1]).toBe(lines[1]!.provenance.vertices[0]);
  });

  it("names each segment for the wall it came from, and in order", () => {
    const { lines } = stageWallLines([STUB], OPTIONS);
    expect(lines.map((line) => line.name)).toEqual([
      "Fog Nudger — wall 7.1",
      "Fog Nudger — wall 7.2",
    ]);
    expect(lines.map((line) => line.provenance.segment)).toEqual([1, 2]);
  });

  it("drops a zero-length segment rather than emitting an item nobody can select", () => {
    const degenerate: PlacedWall = {
      edge: 1,
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
        { x: 9, y: 5 },
      ],
      ids: [1, 2, 3],
    };
    const { lines, dropped } = stageWallLines([degenerate], OPTIONS);
    expect(dropped).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it("emits nothing for a wall with a single point", () => {
    const { lines } = stageWallLines([{ edge: 0, points: [{ x: 1, y: 1 }], ids: [0] }], OPTIONS);
    expect(lines).toHaveLength(0);
  });
});

describe("the emitted stroke width", () => {
  it("is a quarter of the scene's fog stroke, because the width is the sliver", () => {
    // Dynamic Fog strokes the item at this width and takes the outline, so a line W wide yields two
    // walls W apart with an unreachable band between them.
    expect(wallStrokeWidth(8)).toBe(2);
  });

  it("never reaches zero, which is the one place zero is unsafe", () => {
    // A closed shape has its own boundary to stroke at any width. An open LINE does not: its stroke
    // is the only thing giving it extent, so stroking it at zero leaves nothing to become a wall,
    // and the failure would be silent until sight passed through a wall at the table.
    expect(wallStrokeWidth(0)).toBeGreaterThan(0);
    expect(wallStrokeWidth(0.1)).toBeGreaterThan(0);
  });
});
