/**
 * Span's decision: the wall through or near a click, and placing it.
 *
 * **Eighteen mutations, eighteen caught** (2026-09-16), across the through search, the near search and
 * its two lookup windows, the rule between them, the floor, ties, the grid, and placing.
 *
 * Three survived the first run and were answered. A pair window allowing for one jamb's lean and not
 * both had no fixture clicked nearly the whole reach off a doorway's line; it has one. A drop allowed
 * past the end of a wall had no fixture where that mattered; it has one. And a ray started in the
 * wrong grid cell from a click outside every wall changed nothing, because no wall runs through such a
 * click — so that path became an explicit early return, whose effect is on time alone.
 *
 * **Not mutated, because no test can see them and none should**: the early return above, and the
 * grid walk remembering a hit across an empty cell. Both decide how soon a search stops, never what
 * it finds.
 */

import { describe, expect, it } from "vitest";

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { randomWallGraph, seededRandom } from "./fixtures";
import { findCrossings } from "./planarGraph";
import { applySpan, findSpan, NEAR_SHORTER, type Span } from "./span";
import { buildWallFaces } from "./wallFaces";
import { documentPoint, nodeDegrees, type WallGraph } from "./wallGraph";

/** A graph from plain coordinates, quantised the way the document holds them. */
function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

const loop = (ids: readonly number[]): [number, number][] =>
  ids.map((id, index) => [id, ids[(index + 1) % ids.length]!] as [number, number]);

const OPTIONS = { near: 0.01, minLength: 0.002 };
const THROUGH_ONLY = { near: 0, minLength: 0.002 };

const at = (x: number, y: number): Vector2 => ({ x, y });

function distanceToSegment(point: Vector2, p: Vector2, q: Vector2): number {
  const ex = q.x - p.x;
  const ey = q.y - p.y;
  const lengthSquared = ex * ex + ey * ey;
  const along = Math.max(0, Math.min(1, ((point.x - p.x) * ex + (point.y - p.y) * ey) / lengthSquared));
  return Math.hypot(point.x - (p.x + along * ex), point.y - (p.y + along * ey));
}

/** The vertices a span ends on, sorted, with `-1` for an end partway along a wall. */
const endNodes = (span: Span): number[] =>
  [span.from, span.to].map((end) => (end.kind === "vertex" ? end.node : -1)).sort((a, b) => a - b);

/** Two corridor walls, 0.2 apart, with free ends. Edges 0 (top) and 1 (bottom). */
const CORRIDOR = graphOf(
  [
    [0.1, 0.3],
    [0.9, 0.3],
    [0.1, 0.5],
    [0.9, 0.5],
  ],
  [
    [0, 1],
    [2, 3],
  ],
);

/**
 * A box split into two rooms by a wall with a doorway in it: the outline (edges 0–5), the wall's left
 * part ending at the jamb vertex 6 (edge 6), and its right part from the jamb vertex 7 (edge 7). The
 * doorway runs from x 0.4 to 0.6 along y 0.5.
 */
const DOORWAY = graphOf(
  [
    [0.05, 0.05],
    [0.95, 0.05],
    [0.95, 0.5],
    [0.95, 0.95],
    [0.05, 0.95],
    [0.05, 0.5],
    [0.4, 0.5],
    [0.6, 0.5],
  ],
  [...loop([0, 1, 2, 3, 4, 5]), [5, 6], [7, 2]],
);

/**
 * A closet only a little wider than its door and no deeper than a door: jambs at vertices 1 and 2,
 * the door 0.2 wide, and nothing outside it. The crooked wall through a click just inside is only
 * about half as long again as the door — the case the factor was chosen for.
 */
const CLOSET = graphOf(
  [
    [0.28, 0.5],
    [0.4, 0.5],
    [0.6, 0.5],
    [0.72, 0.5],
    [0.72, 0.3],
    [0.28, 0.3],
  ],
  [
    [0, 1],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 0],
  ],
);

describe("a span through the click", () => {
  it("walls a corridor straight across wherever it is clicked", () => {
    for (const x of [0.2, 0.37, 0.8]) {
      const span = findSpan(CORRIDOR, at(x, 0.42), OPTIONS)!;
      expect(span.through).toBe(true);
      expect(span.length).toBeCloseTo(0.2, 6);
      expect(span.from.kind).toBe("segment");
      expect(span.to.kind).toBe("segment");
      expect(span.from.at.x).toBeCloseTo(x, 6);
      expect(span.to.at.x).toBeCloseTo(x, 6);
    }
  });

  it("reaches a doorway's jambs from a click exactly on the line between them", () => {
    // Along the wall's own line, which the search has to meet at the jamb rather than slide along.
    const span = findSpan(DOORWAY, at(0.5, 0.5), OPTIONS)!;
    expect(span.through).toBe(true);
    expect(span.length).toBeCloseTo(0.2, 6);
    expect(endNodes(span)).toEqual([6, 7]);
  });

  it("keeps a corridor's wall through the click when a kink nearby is only a little narrower", () => {
    // A small bump into the corridor from the top wall, at vertex 2, beside the click.
    const kinked = graphOf(
      [
        [0.1, 0.3],
        [0.45, 0.3],
        [0.46, 0.31],
        [0.47, 0.3],
        [0.9, 0.3],
        [0.1, 0.5],
        [0.9, 0.5],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [5, 6],
      ],
    );
    const click = at(0.455, 0.42);
    const span = findSpan(kinked, click, { near: 0.02, minLength: 0.002 })!;
    expect(span.through).toBe(true);
    expect(distanceToSegment(click, span.from.at, span.to.at)).toBeLessThan(1e-9);
  });

  it("takes the lower angle when two walls through the click are the same length", () => {
    // The centre of a square room: straight across either way is the same length.
    const room = graphOf(
      [
        [0.2, 0.2],
        [0.6, 0.2],
        [0.6, 0.6],
        [0.2, 0.6],
      ],
      loop([0, 1, 2, 3]),
    );
    const span = findSpan(room, at(0.4, 0.4), OPTIONS)!;
    expect(span.length).toBeCloseTo(0.4, 6);
    expect(span.from.at.y).toBeCloseTo(0.4, 6);
    expect(span.to.at.y).toBeCloseTo(0.4, 6);
  });

  it("finds nothing outside, and nothing when the shortest wall is under the floor", () => {
    const room = graphOf(
      [
        [0.2, 0.2],
        [0.6, 0.2],
        [0.6, 0.6],
        [0.2, 0.6],
      ],
      loop([0, 1, 2, 3]),
    );
    expect(findSpan(room, at(0.9, 0.9), OPTIONS)).toBeNull();
    // The corridor is 0.2 across; a longer diagonal is not offered in its place.
    expect(findSpan(CORRIDOR, at(0.5, 0.4), { near: 0.01, minLength: 0.3 })).toBeNull();
  });
});

describe("a span near the click", () => {
  it("takes a doorway's jambs from a click a few pixels off their line", () => {
    const click = at(0.5, 0.503);
    const through = findSpan(DOORWAY, click, THROUGH_ONLY)!;
    // The fixture has to be the hard case: through the click, the wall reaches across a room.
    expect(through.length).toBeGreaterThan(0.2 / NEAR_SHORTER);

    const span = findSpan(DOORWAY, click, OPTIONS)!;
    expect(span.through).toBe(false);
    expect(span.length).toBeCloseTo(0.2, 6);
    expect(endNodes(span)).toEqual([6, 7]);
  });

  it("takes the jambs from a click almost the whole near distance off their line", () => {
    /*
      0.009 off, with a reach of 0.01. Seen from the click the jambs are no longer straight across from
      each other — each is 0.09 radians off — and the narrowest window that still finds a wall passing
      within reach has to allow for both of them leaning. A window allowing for one found nothing here.
    */
    const click = at(0.5, 0.509);
    expect(findSpan(DOORWAY, click, THROUGH_ONLY)!.length).toBeGreaterThan(0.2 / NEAR_SHORTER);
    const span = findSpan(DOORWAY, click, OPTIONS)!;
    expect(span.through).toBe(false);
    expect(endNodes(span)).toEqual([6, 7]);
  });

  it("does not drop square past the end of a wall, and takes the wall's end instead", () => {
    // The drop fixture below, with the flat wall cut short so the square drop would land off its end.
    const graph = graphOf(
      [
        [0.1, 0.3],
        [0.5, 0.3],
        [0.6, 0.6],
        [0.9, 0.6],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const span = findSpan(graph, at(0.51, 0.308), { near: 0.012, minLength: 0.002 })!;
    expect(span.through).toBe(false);
    expect(endNodes(span)).toEqual([1, 2]);
  });

  it("does not reach for the jambs from farther off than the near distance", () => {
    expect(findSpan(DOORWAY, at(0.5, 0.53), OPTIONS)!.through).toBe(true);
  });

  it("gets a shallow closet its door, which half as short would not", () => {
    const click = at(0.5, 0.49);
    const through = findSpan(CLOSET, click, THROUGH_ONLY)!;
    const ratio = 0.2 / through.length;
    // Between a half and two-thirds: the band this factor exists for.
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(NEAR_SHORTER);

    const span = findSpan(CLOSET, click, { near: 0.02, minLength: 0.002 })!;
    expect(span.through).toBe(false);
    expect(endNodes(span)).toEqual([1, 2]);
  });

  it("drops square from a vertex onto a wall across from it", () => {
    /*
      A wall ending at vertex 1, across from a flat wall 0.3 away; the door is the square drop.

      Clicked just past the wall's end and to the side, where the wall through the click has to aim
      at the end steeply and runs half as long again. Anywhere nearer the drop itself, the wall
      through the click aims at the end almost square and is as good — so this is the one place
      the drop decides anything, and the fixture says so rather than assuming it.
    */
    const graph = graphOf(
      [
        [0.1, 0.3],
        [0.5, 0.3],
        [0.1, 0.6],
        [0.9, 0.6],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const click = at(0.51, 0.308);
    expect(findSpan(graph, click, THROUGH_ONLY)!.length).toBeGreaterThan(0.3 / NEAR_SHORTER);
    const span = findSpan(graph, click, { near: 0.012, minLength: 0.002 })!;
    expect(span.through).toBe(false);
    expect(span.length).toBeCloseTo(0.3, 6);
    expect(endNodes(span)).toEqual([-1, 1]);
  });
});

describe("placing a span", () => {
  it("splits the walls it lands partway along and shares their new vertices", () => {
    const span = findSpan(CORRIDOR, at(0.37, 0.42), OPTIONS)!;
    const { graph, splits, overlaps } = applySpan(CORRIDOR, span);
    expect(splits).toBe(2);
    expect(overlaps).toBe(0);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges).toHaveLength(5);
    expect(findCrossings(graph)).toEqual([]);
    const degrees = nodeDegrees(graph);
    expect(degrees.filter((degree) => degree === 3)).toHaveLength(2);
  });

  it("adds one wall between two vertices without splitting anything", () => {
    const span = findSpan(DOORWAY, at(0.5, 0.503), OPTIONS)!;
    const { graph, splits } = applySpan(DOORWAY, span);
    expect(splits).toBe(0);
    expect(graph.edges).toHaveLength(DOORWAY.edges.length + 1);
    expect(graph.nodes).toHaveLength(DOORWAY.nodes.length);
  });
});

/**
 * The shortest chord through a point by brute force: a ray cast of its own at many angles.
 *
 * Shares nothing with the search but the question. It can only ever find a chord *at least* as long
 * as the true shortest, since it samples, so the search must never lose to it.
 */
function sampledShortest(graph: WallGraph, point: Vector2, samples: number): number {
  const cast = (dx: number, dy: number): number => {
    let best = Infinity;
    for (const edge of graph.edges) {
      const p = graph.nodes[edge.a]!;
      const q = graph.nodes[edge.b]!;
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const denominator = dx * ey - dy * ex;
      if (denominator === 0) continue;
      const t = ((p.x - point.x) * ey - (p.y - point.y) * ex) / denominator;
      const s = ((p.x - point.x) * dy - (p.y - point.y) * dx) / denominator;
      if (t > 0 && s >= 0 && s <= 1 && t < best) best = t;
    }
    return best;
  };
  let shortest = Infinity;
  for (let step = 0; step < samples; step++) {
    const angle = (Math.PI * step) / samples;
    const length = cast(Math.cos(angle), Math.sin(angle)) + cast(-Math.cos(angle), -Math.sin(angle));
    if (length < shortest) shortest = length;
  }
  return shortest;
}

describe("spans over generated graphs", () => {
  it("is never beaten through the click, and always lands without crossing a wall", () => {
    let through = 0;
    let near = 0;
    let checked = 0;
    let extraSplits = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const graph = randomWallGraph(seededRandom(seed), 3 + (seed % 9));
      // A doubled or overlapping wall is not an embedding a traversal — or a span — means anything
      // over; the other region sweeps skip the same graphs by the same check.
      if (graph.edges.length === 0 || findCrossings(graph).length > 0) continue;
      if (!buildWallFaces(graph).eulerHolds) continue;
      const next = seededRandom(seed * 104729);
      for (let click = 0; click < 12; click++) {
        /*
          Half anywhere, half a click's width from some vertex — where the near rule can decide
          anything. Clicks anywhere alone reached it 19 times in 1,536.
        */
        const vertex = graph.nodes[graph.edges[Math.floor(next() * graph.edges.length)]!.a]!;
        const point =
          click % 2 === 0
            ? at(next() * 1.1 - 0.05, next() * 1.1 - 0.05)
            : at(vertex.x + (next() - 0.5) * 4 * OPTIONS.near, vertex.y + (next() - 0.5) * 4 * OPTIONS.near);
        const where = `seed ${seed}, click ${point.x},${point.y}`;
        checked += 1;

        const unfloored = findSpan(graph, point, { near: 0, minLength: 0 });
        const sampled = sampledShortest(graph, point, 720);
        if (unfloored) {
          // Within a millionth: an end within tolerance of a wall's end is placed on that vertex,
          // which moves the wall off the exact chord by up to that much.
          expect(unfloored.length, `${where}: beaten by sampling`).toBeLessThanOrEqual(sampled + 1e-6);
          expect(distanceToSegment(point, unfloored.from.at, unfloored.to.at), where).toBeLessThan(1e-6);
        } else {
          expect(sampled, `${where}: sampling found a wall the search did not`).toBe(Infinity);
        }

        const onlyThrough = findSpan(graph, point, THROUGH_ONLY);
        expect(onlyThrough?.length ?? null, where).toBe(
          unfloored && unfloored.length >= THROUGH_ONLY.minLength ? unfloored.length : null,
        );

        const span = findSpan(graph, point, OPTIONS);
        if (!span) continue;
        expect(span.length, where).toBeGreaterThanOrEqual(OPTIONS.minLength);
        if (span.through) {
          through += 1;
          expect(span.length, where).toBe(onlyThrough!.length);
        } else {
          near += 1;
          expect(distanceToSegment(point, span.from.at, span.to.at), where).toBeLessThanOrEqual(
            OPTIONS.near + 1e-12,
          );
          expect(span.from.kind === "vertex" || span.to.kind === "vertex", where).toBe(true);
          if (onlyThrough) {
            expect(span.length, where).toBeLessThanOrEqual(onlyThrough.length * NEAR_SHORTER * (1 + 1e-9));
          }
        }

        const placed = applySpan(graph, span);
        /*
          The span's own wall meets nothing — not "the graph has no crossings afterwards".

          Measured on seed 233: the generator can leave two vertices one float32 step apart, from
          crossing splits that rounded to neighbouring values. The crossing predicate's tolerance is a
          fraction of each segment, so while the wall beside them is long their near-touch is inside
          it; a span landing on that wall splits it short, and the same 1.5e-8 becomes a reported
          touch between two walls the span never went near. A property of the predicate on a
          near-degenerate graph, and any split can expose it — Mend's included.
        */
        const spanEdge = placed.graph.edges.findIndex((edge) => {
          const ends = [placed.graph.nodes[edge.a]!, placed.graph.nodes[edge.b]!];
          const wanted = [span.from.at, span.to.at].map((point) => documentPoint(point.x, point.y));
          const same = (a: Vector2, b: Vector2) => a.x === b.x && a.y === b.y;
          return (
            (same(ends[0]!, wanted[0]!) && same(ends[1]!, wanted[1]!)) ||
            (same(ends[0]!, wanted[1]!) && same(ends[1]!, wanted[0]!))
          );
        });
        expect(spanEdge, `${where}: the span's wall is not in the graph as one segment`).toBeGreaterThanOrEqual(0);
        const crossed = findCrossings(placed.graph).filter(
          (crossing) => crossing.edgeA === spanEdge || crossing.edgeB === spanEdge,
        );
        expect(crossed, `${where}: placing crossed a wall`).toEqual([]);
        expect(placed.overlaps, where).toBe(0);
        const landings = [span.from, span.to].filter((end) => end.kind === "segment").length;
        expect(placed.splits, `${where}: split fewer than its landings`).toBeGreaterThanOrEqual(landings);
        /*
          More splits than landings means the span's end also lies on a second wall. Measured on
          2026-09-16, twice in 3,072 clicks over 300 graphs: two walls leaving one vertex whose far ends are
          1.9e-8 apart, and one wall lying exactly along another from a shared vertex. Walls closer
          than the crossing test's tolerance are one wall to it, and no span can land on one of them
          alone; the span itself still stays a single uncrossed wall, which is checked above.
        */
        if (placed.splits > landings) extraSplits += 1;
      }
    }
    /*
      1,560 clicks, 832 spans through the click and 118 near it, in about 0.75s (2026-09-16). Twice the
      graphs and 2,000 angles found the two ends-on-two-walls cases recorded above, at four times the
      time — a size for a probe, not for a suite run on every change.
    */
    expect(checked).toBeGreaterThan(1500);
    expect(extraSplits, "spans ending on two walls at once").toBeLessThanOrEqual(2);
    expect(through, "spans through the click").toBeGreaterThan(0);
    expect(near, "spans near the click").toBeGreaterThan(0);
  });
});
