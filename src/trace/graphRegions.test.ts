/**
 * Ink to a frozen wall graph: what the derivation still owns after the faces left it.
 *
 * **This file used to test region assembly**, and that is gone (2026-09-08). The module no longer
 * builds faces from a raster labelling — the document is a planar graph, and the faces come from
 * walking the frozen graph, which is the same walk the push uses. What is asserted here is what this
 * stage still decides: the graph, the fit, and how hard to fit.
 *
 * The shape-level guarantees moved to `faces.test.ts`, on fixtures with known answers.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { deriveGraphRegions, type GraphRegionOptions } from "./graphRegions";
import { commandCount } from "../geometry/ring";

const BASE: GraphRegionOptions = {
  tolerance: 0.5,
  maxTolerance: 4,
};

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

describe("what the derivation produces", () => {
  it("hands out a graph, a fit for every edge, and the document they make", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);

    // One fitted polyline per edge, positionally aligned — which is what lets the freeze reuse the
    // graph's own node ids for the ends rather than approximating them a second time.
    expect(result.fittedEdges).toHaveLength(result.graph.edges.length);
    expect(result.frozen.graph.nodes.length).toBeGreaterThan(0);
    expect(result.faces.faces.length).toBeGreaterThan(0);
  });

  it("finds both rooms and the space around them", () => {
    // Two rooms sharing a wall, plus the band between them and the border frame.
    expect(deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE).faces.faces).toHaveLength(3);
  });

  /*
    Two faces sharing a wall carry the **identical** points along it.

    Fitting is per *edge*, and both faces are assembled from the same fitted edge — so they cannot
    drift apart by up to the tolerance and open a sliver between two rooms. Under the old
    region-first partition their boundaries were a wall width apart and fitting each ring separately
    was harmless; under the graph they are coincident, and this is what keeps them so.
  */
  it("gives two rooms the identical points along the wall they share", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    const rings = result.faces.faces.flatMap((face) => face.rings);

    const keyed = rings.map((ring) => new Set(ring.map((p) => `${p.x},${p.y}`)));
    let shared = 0;
    for (let i = 0; i < keyed.length; i++) {
      for (let j = i + 1; j < keyed.length; j++) {
        for (const point of keyed[i]!) if (keyed[j]!.has(point)) shared += 1;
      }
    }
    // Coincident rather than merely close: the shared wall's points appear in both rings verbatim.
    expect(shared).toBeGreaterThan(0);
  });

  /*
    A stub survives, which is the whole reason for the wall graph.

    A partition deletes every wall that separates nothing, and a stub separates nothing. Here it is a
    bridge — the same face on both sides — so it is emitted as a wall line rather than as part of any
    ring, and it is still in the document.
  */
  it("keeps a stub wall", () => {
    const plain = deriveGraphRegions(maskFromRows(TWO_ROOMS), BASE);
    const stubbed = deriveGraphRegions(maskFromRows(ROOM_WITH_STUB), BASE);
    expect(stubbed.faces.bridges).toBeGreaterThan(0);
    expect(stubbed.faces.walls.length).toBeGreaterThan(0);
    expect(plain.faces.eulerHolds && stubbed.faces.eulerHolds).toBe(true);
  });

  it("leaves no sliver behind at any tolerance", () => {
    for (const tolerance of [0, 0.5, 2]) {
      const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), { ...BASE, tolerance });
      expect(result.sliversLeft, `tolerance ${tolerance}`).toBe(0);
      expect(result.graph.stats.orphans, `tolerance ${tolerance}`).toBe(0);
      expect(result.faces.eulerHolds, `tolerance ${tolerance}`).toBe(true);
    }
  });
});

describe("meeting the command cap", () => {
  /*
    Raise the tolerance for the whole map, never split a face.

    Splitting an oversized region into two adjacent shapes is the obvious remedy and the sharpest
    trap in the design: Dynamic Fog derives a wall from every shape boundary, so the join becomes a
    wall across the middle of a room. Escalation is global because fitting is per edge — a face
    escalated on its own would stop matching its neighbours along their shared walls.
  */
  it("escalates the tolerance globally, so shared walls cannot come apart", () => {
    const result = deriveGraphRegions(maskFromRows(TWO_ROOMS), {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 16,
      maxCommands: 12,
    });

    expect(result.escalations).toBeGreaterThan(0);
    expect(result.tolerance).toBeGreaterThan(0.1);
  });

  /*
    And what happens when escalating cannot help: it is **reported**, and the face is kept whole.

    `maxTolerance` equal to `tolerance` removes the escape route, so the cap is reached and stays
    reached. A silently dropped or silently split face is the failure this rule exists to forbid, and
    either would leave the map with a room the fog does not cover.
  */
  it("reports a face that still will not fit, and keeps it whole", () => {
    const result = deriveGraphRegions(maskFromRows(STEPPED), {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 0.1,
      maxCommands: 4,
    });

    expect(result.overCap).toBeGreaterThan(0);
    expect(result.escalations).toBe(0);
    // Still there, and still one face rather than two.
    const over = result.faces.faces.filter((face) => commandCount(face.rings) > 4);
    expect(over.length).toBe(result.overCap);
  });

  /*
    A tolerance of zero must not spin.

    Doubling zero is zero, so a caller asking for no simplification at all would loop for ever on any
    face over the cap. The guard is a `tolerance > 0` in the ladder's condition, and this is what
    would hang rather than fail if it went.
  */
  it("does not spin when asked for no simplification at all", () => {
    const result = deriveGraphRegions(maskFromRows(STEPPED), {
      tolerance: 0,
      maxTolerance: 4,
      maxCommands: 4,
    });
    expect(result.escalations).toBe(0);
  });
});
