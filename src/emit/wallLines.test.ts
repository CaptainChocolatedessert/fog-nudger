import { describe, expect, it } from "vitest";

import { ACCEPTED_WALL_STROKE, stageWallLines, type PlacedWall } from "./wallLines";

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

  it("keeps consecutive segments meeting at exactly the point they share", () => {
    /*
      Two tests here asserted vertex IDS until 2026-08-31 -- that each segment carried the ids of its
      two ends, so a wall cut into items could be reassembled by grouping on them. The scheme went
      because the scene is never read back: everything the graph is derived from lives in scene
      metadata, so the graph is always one re-run away.

      The geometry those ids were evidence for is still asserted. One segment's end is the next
      segment's start, exactly, which is what "cut into items" has to mean.
    */
    const { lines } = stageWallLines([STUB], OPTIONS);
    const firstEnd = {
      x: lines[0]!.position.x + lines[0]!.end.x,
      y: lines[0]!.position.y + lines[0]!.end.y,
    };
    expect(firstEnd).toEqual(lines[1]!.position);
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
    };
    const { lines, dropped } = stageWallLines([degenerate], OPTIONS);
    expect(dropped).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it("emits nothing for a wall with a single point", () => {
    const { lines } = stageWallLines([{ edge: 0, points: [{ x: 1, y: 1 }] }], OPTIONS);
    expect(lines).toHaveLength(0);
  });
});

describe("the emitted stroke width", () => {
  it("is zero once accepted, so the derived walls sit on the centreline", () => {
    // Dynamic Fog strokes the item at this width and takes the outline, so the width is the gap
    // between the two walls it derives. At zero they coincide and each side reveals up to the
    // centreline — the party seeing half the wall as drawn, rather than a band of fog down it.
    expect(ACCEPTED_WALL_STROKE).toBe(0);
  });

  // "is visible while staged, because a zero-width line cannot be selected" was here, exercising
  // `stagedWallStroke`. Staging is gone and nothing but that test called it, so both went.
});
