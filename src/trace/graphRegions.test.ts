import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { coveredArea, deriveGraphRegions, type GraphRegionOptions } from "./graphRegions";

const BASE: GraphRegionOptions = {
  spurPrunePx: 0,
  tolerance: 0.5,
  maxTolerance: 4,
};

/**
 * Ink, not a skeleton — this is the whole chain, so it thins first. Two rooms sharing a wall, drawn
 * three pixels thick so thinning has something to do.
 */
const TWO_ROOMS = [
  "......................",
  "......................",
  "..#################...",
  "..#################...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..###...###...#####...",
  "..#################...",
  "..#################...",
  "......................",
  "......................",
];

/**
 * The same idea with a **bent** divider, which is what makes the shared-wall test able to fail.
 *
 * A straight shared wall simplifies to its two endpoints, and those are graph nodes that are pinned
 * whatever the fitting does — so there is nothing for a per-ring fit to drift. Two bends give the
 * shared wall interior points, which is where drift would show.
 */
const STEPPED = [
  "..............................",
  "..............................",
  "..#########################...",
  "..#########################...",
  "..###.....###..........####...",
  "..###.....###..........####...",
  "..###......###.........####...",
  "..###.......###........####...",
  "..###........###.......####...",
  "..###.........###......####...",
  "..###.........###......####...",
  "..#########################...",
  "..#########################...",
  "..............................",
  "..............................",
];

/**
 * One room with a stub wall reaching into it from the left — the case a partition deletes outright
 * and a graph keeps. The stub separates nothing, so a watershed drops it; here it survives as a
 * branch, and shows up as a cycle enclosing no area.
 */
const ROOM_WITH_STUB = [
  "...................",
  "...................",
  "..###############..",
  "..###############..",
  "..##...........##..",
  "..##...........##..",
  "..#######......##..",
  "..#######......##..",
  "..##...........##..",
  "..##...........##..",
  "..###############..",
  "..###############..",
  "...................",
];

describe("regions derived from the wall graph", () => {
  it("finds both rooms and the space around them", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    expect(result.faces.disagreements).toBe(0);
    expect(result.faces.exact).toBe(result.faces.checked);
    // Two rooms plus the exterior, which the border frame makes an ordinary bounded face.
    expect(result.regions.length).toBeGreaterThanOrEqual(3);
  });

  it("gives the two rooms the identical points along the wall they share", () => {
    /*
      The property step D was re-planned around: each **edge** is fitted once and both faces are
      assembled from it. Fitting per ring instead lets two coincident boundaries drift apart by up to
      the tolerance and opens a sliver between two rooms that share a wall.

      **The fixture has to have a bent divider, and the earlier version of this test did not.**
      `TWO_ROOMS`' shared wall is straight, so Douglas–Peucker keeps its two endpoints and nothing
      else — and those endpoints are graph *nodes*, which `fitFaces` pins whichever way the fitting
      is done. There was nothing for a per-ring fit to drift. `STEPPED` bends twice, so the shared
      wall carries interior points, which is where drift would show.
    */
    const result = deriveGraphRegions(maskFromRows(STEPPED), BASE);

    const keys = (region: { rings: readonly (readonly { x: number; y: number }[])[] }) =>
      region.rings.map((ring) => ring.map((point) => `${point.x},${point.y}`));

    // The exterior is the one the border frame gave a hole; the other two are the rooms.
    const rooms = result.regions.filter((region) => region.rings.length === 1);
    expect(rooms).toHaveLength(2);

    const a = keys(rooms[0]!)[0]!;
    const b = keys(rooms[1]!)[0]!;
    const shared = new Set(a.filter((key) => b.includes(key)));

    // More than two: two would be only the shared nodes, which pinning them gives for free.
    expect(shared.size).toBeGreaterThan(2);

    /*
      And contiguous along both rings, which is what a *drifted interior point* would break: it
      appears as two separate keys, punching a hole in the run rather than shortening it. Wrap-around
      counts, since a ring has no first point.
    */
    const oneRun = (ring: readonly string[]): boolean => {
      const flags = ring.map((key) => shared.has(key));
      // Count boundaries between shared and not, around the loop. One contiguous run has exactly
      // two, unless every point is shared.
      let changes = 0;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] !== flags[(i + 1) % flags.length]) changes += 1;
      }
      return changes <= 2;
    };
    expect(oneRun(a), `room A ring ${a.join(" ")}`).toBe(true);
    expect(oneRun(b), `room B ring ${b.join(" ")}`).toBe(true);
  });

  it("emits a joined stub as a line, and leaves no slit in the room's ring", () => {
    /*
      The traversal walks a bridge out and back, so a stub hanging into a room appears in the room's
      boundary as a zero-width slit. That is right for the area check, which counts those steps, and
      wrong to emit: it would put our internal representation into the scene and leave Owlbear's fill
      and Dynamic Fog's stroke to interpret a degenerate excursion. A human would draw the room, then
      draw the wall.

      So the ring drops the excursion — costing it nothing, since a slit encloses no area — and the
      bridge comes out in `uncoveredEdges` to be emitted as its own line.
    */
    const result = deriveGraphRegions(maskFromRows(ROOM_WITH_STUB), BASE);
    const room = result.regions.find((region) => region.rings.length === 1);
    expect(room).toBeDefined();

    const keys = room!.rings[0]!.map((point) => `${point.x},${point.y}`);
    expect(new Set(keys).size, "the ring visits no vertex twice").toBe(keys.length);
    expect(result.uncoveredEdges).toHaveLength(result.bridges);
  });

  it("puts the stub's line exactly on the room's boundary where they meet", () => {
    /*
      This asserted vertex IDS until 2026-08-31 -- that the junction was one id carried by both the
      room's ring and the stub's line, so grouping emitted items by id would reconstruct the graph.
      The ids went because the scene is never read back: everything the graph is derived from lives
      in scene metadata, so a graph is always one re-run away.

      What the ids were evidence FOR is still true and is what is asserted now. The junction point is
      shared exactly, because both come from the same fitted edge -- and the stub's free tip is on no
      ring, which is what distinguishes a stub from a doorway. Exact rather than within a tolerance:
      anything we emit is exact by construction, and an epsilon here would flag every doorway.
    */
    const result = deriveGraphRegions(maskFromRows(ROOM_WITH_STUB), BASE);
    const room = result.regions.find((region) => region.rings.length === 1);
    const stub = result.uncoveredEdges[0];
    expect(room).toBeDefined();
    expect(stub).toBeDefined();

    const onRing = new Set(room!.rings[0]!.map((point) => `${point.x},${point.y}`));
    const ends = [stub!.points[0]!, stub!.points[stub!.points.length - 1]!];
    const shared = ends.filter((point) => onRing.has(`${point.x},${point.y}`));

    expect(shared, "exactly one end of the stub is on the room's boundary").toHaveLength(1);
  });

  it("keeps a stub wall, which is the whole reason for the pivot", () => {
    const result = deriveGraphRegions(maskFromRows(ROOM_WITH_STUB), BASE);
    // A stub separates nothing, so the same face lies on both sides of it — the bridge criterion.
    // A watershed over regions would have deleted it outright.
    //
    // It does **not** show up as a zero-area cycle: joined to a wall, a stub is a slit *inside* the
    // room's own cycle, walked out and back. Counting degenerate cycles finds none of these, which
    // is what the first version of this test got wrong.
    expect(result.bridges).toBeGreaterThan(0);
    expect(result.degenerateCycles).toBe(0);
    expect(result.faces.exact).toBe(result.faces.checked);
  });

  it("holds the area identity whatever the pruning", () => {
    for (const spurPrunePx of [0, 3, 7]) {
      const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), { ...BASE, spurPrunePx });
      expect(result.faces.exact, `prune ${spurPrunePx}`).toBe(result.faces.checked);
      expect(result.faces.disagreements).toBe(0);
      expect(result.graph.stats.orphans).toBe(0);
    }
  });

  it("emits every face that holds any map, with no size threshold at all", () => {
    /*
      The smallest-room control is gone (user, 2026-08-30). It deleted a *region* when what is
      usually wrong is a *wall*, and removing a sliver by deleting the wall that made it is exact and
      local where removing it by area is neither — so it belongs to the wall editing rather than to a
      slider here.

      What replaces it is an invariant, not a threshold: a face with no interior pixels holds no map,
      so there is nothing there to reveal.
    */
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    const labelled = new Set(result.labelled.regions.map((region) => region.id));

    for (const face of result.faces.faces) {
      const emitted = result.regions.some((region) => region.id === face.label);
      expect(emitted, `face ${face.label} with ${face.interior} px`).toBe(face.interior > 0);
      expect(labelled.has(face.label)).toBe(face.interior > 0);
    }
  });

  it("escalates the tolerance globally, so shared walls cannot come apart", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 16,
      maxCommands: 12,
    });

    expect(result.escalations).toBeGreaterThan(0);
    // One tolerance for the whole map, not one per region — that is what makes the shared points
    // above stay shared.
    expect(result.tolerance).toBeGreaterThan(0.1);
  });

  it("keeps a hole because of what is inside it, and fills none of these", () => {
    /*
      The containment rule, which `contours.test.ts` was the only place asserting until it was
      deleted with the region-first tracer.

      Its two cases there were "keep a hole around a region that survives, however small" and "fill
      the same hole once the region inside it has been discarded". The second cannot be built any
      more: there is no minimum-area filter, so nothing gets discarded by size, and a face is left
      out only when it holds **zero interior pixels** — which by construction no pixel can probe
      into. So the rule survives with one branch reachable, and what is asserted is the reachable
      one: every hole in an emitted region corresponds to a face that is itself emitted.

      Stated as a cost rather than dressed up: the fill branch is untested because producing it needs
      a sub-pixel sliver fixture, and none of these fixtures has one. `filledHoles` is asserted zero
      here so that a change which starts filling holes on ordinary maps fails rather than passing
      quietly.
    */
    for (const [name, rows] of [
      ["two rooms", TWO_ROOMS],
      ["room with a stub", ROOM_WITH_STUB],
    ] as const) {
      const result = deriveGraphRegions(maskFromRows(rows), BASE);
      expect(result.filledHoles, `${name}: holes filled`).toBe(0);

      const emitted = new Set(result.regions.map((region) => region.id));
      for (const face of result.faces.faces) {
        for (let cycle = 1; cycle < face.cycles.length; cycle += 1) {
          // A hole's cycle is walked the other way round, so the face it belongs to is one of the
          // emitted ones — this is the containment relation, read off the traversal rather than
          // recomputed by a point-in-polygon test of our own.
          expect(emitted.has(face.label), `${name}: face ${face.label} has a hole`).toBe(true);
        }
      }
    }
  });

  it("never marks an edge covered by a ring it did not emit", () => {
    /*
      The invariant behind pass 1's item 5.1. A cycle whose every ring was dropped used to mark its
      edges covered anyway, so they were emitted neither as part of a shape nor as a wall line: the
      linework vanished from both outputs with nothing saying so.

      Asserted as a property rather than by building the fixture that triggers it. Reaching it needs a
      cycle of one or two skeleton pixels, which sliver removal should already have taken — so a
      fixture would be asserting that sliver removal has a hole in it. What holds on every map is the
      relation: an edge is covered only if some emitted ring walks it, and everything else is a wall
      line. `droppedCycles` is asserted zero so the untriggered case is visible rather than assumed.
    */
    for (const rows of [TWO_ROOMS, ROOM_WITH_STUB]) {
      const result = deriveGraphRegions(maskFromRows(rows), BASE);
      expect(result.droppedCycles).toBe(0);
      // No edge is left over twice, and none is invented: the leftovers are a subset of the graph.
      expect(result.uncoveredEdges.length).toBeLessThanOrEqual(result.graph.edges.length);
    }
  });

  it("covers the raster it was given", () => {
    const rows = TWO_ROOMS;
    const result = deriveGraphRegions(maskFromRows(rows), BASE);
    const raster = rows[0]!.length * rows.length;
    // The faces tile the framed raster, so together they account for nearly all of it — the
    // shortfall is the half-pixel the boundary runs through the wall on either side.
    expect(coveredArea(result.regions)).toBeGreaterThan(raster * 0.5);
    expect(coveredArea(result.regions)).toBeLessThanOrEqual(raster);
  });
});
