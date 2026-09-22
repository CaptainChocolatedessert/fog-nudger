/**
 * Ink to a wall graph: what deriving still owns after the faces left it.
 *
 * **This file used to test region assembly**, and that is gone (2026-09-08). The module no longer
 * builds faces from a raster labelling — the document is a planar graph, and the faces come from
 * walking the wall graph, which is the same walk the push uses. What is asserted here is what this
 * stage still decides: the graph, the fit, and how hard to fit.
 *
 * The shape-level guarantees moved to `faces.test.ts`, on fixtures with known answers.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows, randomInk, seededRandom } from "./fixtures";
import {
  AUTO_PRUNE_INK_WIDTHS,
  autoPruneLimitPx,
  deriveWalls,
  type DeriveWallsOptions,
} from "./deriveWalls";
import { graphExtent } from "./graphUnits";
import { pruneWallGraph } from "./wallGraph";
import { commandCount } from "../geometry/ring";

/** No automatic prune: most of this file tests what the derivation does before one. */
const BASE = {
  tolerance: 0.5,
  maxTolerance: 4,
  pruneLimit: 0,
};

/** Derive from a text fixture, into the fixture's own extent — the raster *is* the image here. */
function derive(rows: readonly string[], options: Omit<DeriveWallsOptions, "extent">) {
  const mask = maskFromRows(rows);
  return deriveWalls(mask, { ...options, extent: graphExtent(mask.width, mask.height) });
}

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

/** The same room with a stub that runs in and then bends down — a bend a coarse fit drops. */
const ROOM_WITH_CROOKED_STUB = [
  "......................",
  "......................",
  "..##################..",
  "..##################..",
  "..##..............##..",
  "..##..............##..",
  "..#######.........##..",
  "..#######.........##..",
  "..##.....##.......##..",
  "..##......##......##..",
  "..##.......##.....##..",
  "..##........##....##..",
  "..##..............##..",
  "..##..............##..",
  "..##################..",
  "..##################..",
  "......................",
];

describe("what deriving produces", () => {
  it("hands out a graph, a fit for every edge, and the document they make", () => {
    const result = derive(TWO_ROOMS, BASE);

    // One fitted polyline per edge, positionally aligned — which is what lets the build reuse the
    // graph's own node ids for the ends rather than approximating them a second time.
    expect(result.fittedEdges).toHaveLength(result.graph.edges.length);
    expect(result.walls.graph.nodes.length).toBeGreaterThan(0);
    expect(result.faces.faces.length).toBeGreaterThan(0);
  });

  it("finds both rooms, and nothing for the space around them", () => {
    // Two rooms sharing a wall. The outside is the arrangement's unbounded face: no polygon, not
    // emitted, and therefore fogged and unrevealable — which is what a map's exterior should be.
    expect(derive(TWO_ROOMS, BASE).faces.faces).toHaveLength(2);
  });

  /*
    Two faces sharing a wall carry the **identical** points along it.

    Fitting is per *edge*, and both faces are assembled from the same fitted edge — so they cannot
    drift apart by up to the tolerance and open a sliver between two rooms. Under the old
    region-first partition their boundaries were a wall width apart and fitting each ring separately
    was harmless; under the graph they are coincident, and this is what keeps them so.
  */
  it("gives two rooms the identical points along the wall they share", () => {
    const result = derive(TWO_ROOMS, BASE);
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
    const plain = derive(TWO_ROOMS, BASE);
    const stubbed = derive(ROOM_WITH_STUB, BASE);
    expect(stubbed.faces.bridges).toBeGreaterThan(0);
    expect(stubbed.faces.walls.length).toBeGreaterThan(0);
    expect(plain.faces.eulerHolds && stubbed.faces.eulerHolds).toBe(true);
  });

  it("leaves no sliver behind at any tolerance", () => {
    for (const tolerance of [0, 0.5, 2]) {
      const result = derive(TWO_ROOMS, { ...BASE, tolerance });
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
    /*
      The cap is deliberately below what two plain rooms need, so the ladder has to run.

      It is lower than it was before the border frame went: with the frame there was a third face —
      the band around everything — carrying far more commands than either room, and it was what
      tripped the cap first.
    */
    const result = derive(TWO_ROOMS, {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 16,
      maxCommands: 6,
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
    const result = derive(STEPPED, {
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
    const result = derive(STEPPED, {
      tolerance: 0,
      maxTolerance: 4,
      pruneLimit: 0,
      maxCommands: 4,
    });
    expect(result.escalations).toBe(0);
  });
});

/*
  The dead ends every derive removes on its way through — `autoPruneLimitPx` says why two ink widths.

  **Nine mutations, nine caught** (2026-09-21): the prune skipped, its graph not handed over, the faces
  walked on the unpruned build, the ladder's later rungs unpruned, one ink width, a prune when no width
  was measured, the choice of graph inverted, the width test loosened — and the count carried from the
  ladder's first rung, which survived until the crooked-stub fixture was written for it.
*/
describe("the automatic prune", () => {
  it("is two measured ink widths, and nothing at all when no width was measured", () => {
    expect(AUTO_PRUNE_INK_WIDTHS).toBe(2);
    expect(autoPruneLimitPx(5.7)).toBeCloseTo(11.4, 10);
    expect(autoPruneLimitPx(3)).toBe(6);
    // Deleting on a guess is the direction that can be wrong, so the unknown width keeps the hairs.
    expect(autoPruneLimitPx(null)).toBe(0);
    expect(autoPruneLimitPx(0)).toBe(0);
    expect(autoPruneLimitPx(Number.NaN)).toBe(0);
  });

  /** The stub's own length along the walls, in graph units, from a derivation that kept it. */
  function stubLength(): number {
    const kept = derive(ROOM_WITH_STUB, BASE);
    // A limit of the whole map takes every dead end there is, and a closed room is never one, so
    // what it removes is the stub alone.
    const all = pruneWallGraph(kept.walls.graph, 1);
    expect(all.removed).toBe(1);
    return all.length;
  }

  /*
    The limit is inclusive, and it is what decides — a stub exactly at it goes, and one a hair longer
    stays. The length is measured on the same fit in both derivations, so equality is exact.
  */
  it("takes a dead end no longer than the limit, and leaves one longer", () => {
    const length = stubLength();

    const at = derive(ROOM_WITH_STUB, { ...BASE, pruneLimit: length });
    expect(at.pruning.removed).toBe(1);
    expect(at.faces.bridges).toBe(0);
    expect(at.faces.freeEnds).toBe(0);

    const under = derive(ROOM_WITH_STUB, { ...BASE, pruneLimit: length * 0.999 });
    expect(under.pruning.removed).toBe(0);
    expect(under.faces.bridges).toBeGreaterThan(0);
  });

  /*
    What is handed over is the pruned graph, and the faces are its faces — not the build's before the
    prune. The room survives whole: a closed loop can never present a free end.
  */
  it("hands over the pruned graph and walks its faces, keeping the room", () => {
    const before = derive(ROOM_WITH_STUB, BASE);
    const after = derive(ROOM_WITH_STUB, { ...BASE, pruneLimit: 1 });

    expect(after.walls.graph.edges.length).toBe(
      before.walls.graph.edges.length - after.pruning.segments,
    );
    expect(after.pruning.segments).toBeGreaterThan(0);
    expect(after.faces.faces).toHaveLength(1);
    expect(after.faces.walls).toHaveLength(0);
    expect(after.faces.eulerHolds).toBe(true);
  });

  /*
    The prune runs on every rung of the ladder, so the graph that comes out of an escalation is pruned
    too. A prune applied only to the first build would hand the escalated graph over with its hairs.
  */
  it("prunes the graph the ladder ends on, not only the first attempt", () => {
    const result = derive(ROOM_WITH_STUB, {
      ...BASE,
      tolerance: 0.1,
      maxTolerance: 16,
      maxCommands: 3,
      pruneLimit: 1,
    });
    expect(result.escalations).toBeGreaterThan(0);
    expect(result.pruning.removed).toBe(1);
    expect(result.faces.bridges).toBe(0);
  });

  /*
    And what it reports is the prune of that last rung. A crooked stub keeps its bend at a fine fit and
    loses it at a coarse one, so the two rungs remove different numbers of segments — which the test
    asserts first, or it could not tell them apart. Found as a surviving mutation: carrying the first
    rung's count through the ladder passed everything above, since a straight stub is one segment at
    any tolerance.
  */
  it("reports the prune of the rung it hands over", () => {
    const ladder = { tolerance: 0.1, maxTolerance: 16, maxCommands: 3, pruneLimit: 1 };
    const climbed = derive(ROOM_WITH_CROOKED_STUB, ladder);
    expect(climbed.escalations).toBeGreaterThan(0);

    const at = (tolerance: number) =>
      derive(ROOM_WITH_CROOKED_STUB, { ...ladder, tolerance, maxTolerance: tolerance }).pruning;
    const first = at(0.1);
    const last = at(climbed.tolerance);
    expect(first.segments).not.toBe(last.segments);

    expect(climbed.pruning.segments).toBe(last.segments);
  });

  /*
    ## Over random ink, against an oracle that walks the dead ends itself

    Two properties, neither restating the implementation. **Nothing is invented**: every segment
    handed over is one the unpruned derivation had, compared by endpoint coordinates. **Nothing
    qualifying is left**: counting degree from the edges and walking each free end along degree-2
    vertices — not with `walkRuns` — no dead end is at or under the limit. And the sweep has to be
    shown to reach its case, so it counts the runs removed.
  */
  it("only deletes, and leaves no dead end within the limit, over random ink", () => {
    let removed = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const mask = randomInk(40, 30, seededRandom(seed), 22);
      const options = { ...BASE, extent: graphExtent(40, 30) };
      const limit = 4 / 40; // four raster pixels, in graph units
      const plain = deriveWalls(mask, options);
      const pruned = deriveWalls(mask, { ...options, pruneLimit: limit });
      removed += pruned.pruning.removed;

      const had = new Set(plain.walls.graph.edges.map((edge) => segmentKey(plain.walls.graph, edge)));
      for (const edge of pruned.walls.graph.edges) {
        expect(had.has(segmentKey(pruned.walls.graph, edge)), `seed ${seed}`).toBe(true);
      }
      const shortest = shortestDeadEnd(pruned.walls.graph);
      expect(shortest, `seed ${seed}`).toBeGreaterThan(limit);
      expect(pruned.faces.eulerHolds, `seed ${seed}`).toBe(true);
    }
    expect(removed).toBeGreaterThan(50);
  });
});

type Graph = ReturnType<typeof derive>["walls"]["graph"];

/** A segment by its two endpoints' coordinates, in either order. */
function segmentKey(graph: Graph, edge: { a: number; b: number }): string {
  const a = graph.nodes[edge.a]!;
  const b = graph.nodes[edge.b]!;
  const [p, q] = [`${a.x},${a.y}`, `${b.x},${b.y}`].sort();
  return `${p}|${q}`;
}

/** The shortest dead end in a graph, walked from each free end; `Infinity` when there is none. */
function shortestDeadEnd(graph: Graph): number {
  const around = new Map<number, number[]>();
  graph.edges.forEach((edge, index) => {
    for (const node of [edge.a, edge.b]) {
      const list = around.get(node) ?? [];
      list.push(index);
      around.set(node, list);
    }
  });
  let shortest = Infinity;
  for (const [start, edges] of around) {
    if (edges.length !== 1) continue;
    let node = start;
    let via = edges[0]!;
    let length = 0;
    for (;;) {
      const edge = graph.edges[via]!;
      const next = edge.a === node ? edge.b : edge.a;
      length += Math.hypot(graph.nodes[next]!.x - graph.nodes[node]!.x, graph.nodes[next]!.y - graph.nodes[node]!.y);
      node = next;
      const onward = around.get(node)!;
      if (onward.length !== 2 || node === start) break;
      via = onward[0] === via ? onward[1]! : onward[0]!;
    }
    shortest = Math.min(shortest, length);
  }
  return shortest;
}
