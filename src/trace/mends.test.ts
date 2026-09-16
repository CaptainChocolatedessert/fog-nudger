/**
 * Mends: what the graph gap search proposes, and what accepting one does to the graph.
 *
 * Every fixture is written in graph units — the map's longer side is 1 — and drawn out as the walls
 * it holds. The search is exercised on the shapes the decisions were argued from: a wall that thinned
 * out and broke, a kink that is not a break, and the three kinds of thing a mend can land on.
 *
 * **Mutation-tested on 2026-09-16: twelve mutations, twelve caught** — ranking by score before kind
 * for one end and across ends, the along-walls test, rejecting targets behind an end, the reach, the
 * direction onto a segment taken from the heading or the perpendicular alone, crossings, an end used
 * twice, and in accepting: no split, a split made twice at one point, and splits out of order. Two of
 * those survived the first version of these tests, and each needed a test the obvious fixture could
 * not provide — see the sweep and the pairing fixture.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import { applyMends, findMends, type Mend } from "./mends";
import { buildWallFaces } from "./wallFaces";
import { documentPoint, nodeDegrees, type WallGraph } from "./wallGraph";

function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** The node at a position, so an assertion can say which end it means by where it is. */
function nodeAt(graph: WallGraph, x: number, y: number): number {
  const at = documentPoint(x, y);
  const id = graph.nodes.findIndex((node) => node.x === at.x && node.y === at.y);
  if (id < 0) throw new Error(`no node at ${x}, ${y}`);
  return id;
}

/** The mend with this free end on either side of it, if there is one. */
function mendTouching(mends: readonly Mend[], node: number): Mend | undefined {
  return mends.find(
    (mend) => mend.from === node || (mend.to.kind === "end" && mend.to.node === node),
  );
}

const close = (point: Vector2, x: number, y: number): void => {
  expect(point.x).toBeCloseTo(x, 5);
  expect(point.y).toBeCloseTo(y, 5);
};

/*
  A room whose bottom wall thinned out and broke in the middle.

      (0.2,0.2) ────────────── (0.8,0.2)
          │                        │
          │                        │
      (0.2,0.8) ──── ·  · ──── (0.8,0.8)
                (0.48)  (0.52)

  The two broken ends are 0.04 apart in space and the whole rest of the room apart along the walls,
  which is the break this tool exists for.
*/
const BROKEN_ROOM = graphOf(
  [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.52, 0.8],
    [0.48, 0.8],
    [0.2, 0.8],
  ],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [4, 5],
    [5, 0],
  ],
);

describe("findMends", () => {
  it("closes a room whose wall broke, end to end", () => {
    const mends = findMends(BROKEN_ROOM, { reach: 0.06, travel: 0.1 });

    expect(mends).toHaveLength(1);
    const [mend] = mends;
    expect(mend!.to.kind).toBe("end");
    const ends = [mend!.from, (mend!.to as { node: number }).node].sort();
    expect(ends).toEqual([nodeAt(BROKEN_ROOM, 0.52, 0.8), nodeAt(BROKEN_ROOM, 0.48, 0.8)].sort());
    expect(mend!.length).toBeCloseTo(0.04, 5);
  });

  it("proposes nothing beyond its reach, and nothing at all at zero", () => {
    expect(findMends(BROKEN_ROOM, { reach: 0.03, travel: 0.1 })).toEqual([]);
    expect(findMends(BROKEN_ROOM, { reach: 0, travel: 0.1 })).toEqual([]);
  });

  /*
    A kink, not a break. Two free ends 0.03 apart, joined the short way round by 0.07 of wall.

        (0.5,0.5) ·           · (0.53,0.5)
                  │           │
        (0.5,0.52)└───────────┘(0.53,0.52)

    Within the same-wall distance they are one piece of wall; set it shorter than the path and they
    are two sides of a gap. The second slider is what decides, which is why it exists.
  */
  it("leaves a kink alone when the walls already join its ends within the same-wall distance", () => {
    const hook = graphOf(
      [
        [0.5, 0.5],
        [0.5, 0.52],
        [0.53, 0.52],
        [0.53, 0.5],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );

    expect(findMends(hook, { reach: 0.05, travel: 0.1 })).toEqual([]);
    expect(findMends(hook, { reach: 0.05, travel: 0.05 })).toHaveLength(1);
    // Zero switches the test off.
    expect(findMends(hook, { reach: 0.05, travel: 0 })).toHaveLength(1);
  });

  /*
    A free end is preferred to a wall even when the wall is nearer.

        (0.4,0.5) ───── A ·       · B ───── (0.66,0.5)
                      (0.5)      (0.56)
        (0.3,0.52) ─────────────────────────── (0.7,0.52)

    A's mend onto the wall below would be about 0.028 long; B is 0.06 away. B wins.
  */
  it("prefers a free end to a nearer wall", () => {
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.56, 0.5],
        [0.66, 0.5],
        [0.3, 0.52],
        [0.7, 0.52],
      ],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    const a = nodeAt(graph, 0.5, 0.5);
    const b = nodeAt(graph, 0.56, 0.5);

    const mend = mendTouching(findMends(graph, { reach: 0.1, travel: 0 }), a);

    expect(mend).toBeDefined();
    expect(mend!.to.kind).toBe("end");
    expect([mend!.from, (mend!.to as { node: number }).node].sort()).toEqual([a, b].sort());
  });

  /*
    With no free end in reach, a vertex is preferred to a nearer wall.

        (0.4,0.5) ───── A ·        (0.56,0.40)
                      (0.5)            │
                                  V ───┘── (0.62,0.47)
                              (0.56,0.47)
        (0.3,0.52) ─────────────────────────── (0.7,0.52)
  */
  it("prefers an existing vertex to a nearer wall when no free end is in reach", () => {
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.56, 0.4],
        [0.56, 0.47],
        [0.62, 0.47],
        [0.3, 0.52],
        [0.7, 0.52],
      ],
      [
        [0, 1],
        [2, 3],
        [3, 4],
        [5, 6],
      ],
    );
    const a = nodeAt(graph, 0.5, 0.5);
    const v = nodeAt(graph, 0.56, 0.47);

    const mend = findMends(graph, { reach: 0.1, travel: 0 }).find((candidate) => candidate.from === a);

    expect(mend).toBeDefined();
    expect(mend!.to).toEqual({ kind: "vertex", node: v });
  });

  it("lands square on a wall the broken end points straight at", () => {
    // A heads straight down at a wall 0.05 below it: the heading and the perpendicular agree.
    const graph = graphOf(
      [
        [0.5, 0.3],
        [0.5, 0.4],
        [0.3, 0.45],
        [0.7, 0.45],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );

    const mend = findMends(graph, { reach: 0.1, travel: 0 }).find(
      (candidate) => candidate.from === nodeAt(graph, 0.5, 0.4),
    );

    expect(mend?.to.kind).toBe("segment");
    close(mend!.end, 0.5, 0.45);
  });

  /*
    Onto a wall met at an angle, the mend splits the difference.

    A heads down and to the right at 45 degrees; the wall's perpendicular is straight down. Halfway is
    22.5 degrees off vertical, so crossing the 0.05 to the wall moves it 0.05 × tan(22.5°) ≈ 0.0207 to
    the right. The heading alone would land at 0.55, and the perpendicular alone at 0.5.
  */
  it("splits the difference between the end's heading and the wall's perpendicular", () => {
    const graph = graphOf(
      [
        [0.46, 0.36],
        [0.5, 0.4],
        [0.3, 0.45],
        [0.7, 0.45],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );

    const mend = findMends(graph, { reach: 0.1, travel: 0 }).find(
      (candidate) => candidate.from === nodeAt(graph, 0.5, 0.4),
    );

    expect(mend?.to.kind).toBe("segment");
    close(mend!.end, 0.5 + 0.05 * Math.tan(Math.PI / 8), 0.45);
  });

  /*
    Alignment ranks and never rejects.

                 B · ─────────── (0.65,0.54)
              (0.45,0.54)
        (0.3,0.5) ─────────── A ·
                            (0.5)

    Each end lies behind the other's heading. They are still each other's best — a free end outranks
    any wall — and a search that threw away targets behind an end would join each to a wall instead.
    The walls are long so their far ends are out of reach: a free end straight ahead would rightly
    outrank one behind, and that is not the case being pinned.
  */
  it("still joins two ends that each lie behind the other's heading", () => {
    const graph = graphOf(
      [
        [0.3, 0.5],
        [0.5, 0.5],
        [0.65, 0.54],
        [0.45, 0.54],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const a = nodeAt(graph, 0.5, 0.5);
    const b = nodeAt(graph, 0.45, 0.54);

    const mend = mendTouching(findMends(graph, { reach: 0.08, travel: 0 }), a);

    expect(mend?.to.kind).toBe("end");
    expect([mend!.from, (mend!.to as { node: number }).node].sort()).toEqual([a, b].sort());
  });

  /*
    A mend never crosses a wall. Two ends face each other across a wall that runs between them, so
    joining them would cut straight through it — each lands on the wall instead, from its own side.

        (0.4,0.5) ── A ·  │  · B ── (0.66,0.5)
                          │ (0.53, 0.3 to 0.7)
  */
  it("does not cross a wall to reach an end, and lands on the wall instead", () => {
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.56, 0.5],
        [0.66, 0.5],
        [0.53, 0.3],
        [0.53, 0.7],
      ],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    const a = nodeAt(graph, 0.5, 0.5);
    const b = nodeAt(graph, 0.56, 0.5);

    const mends = findMends(graph, { reach: 0.1, travel: 0 });
    const fromA = mends.find((mend) => mend.from === a);
    const fromB = mends.find((mend) => mend.from === b);

    expect(fromA?.to.kind).toBe("segment");
    expect(fromB?.to.kind).toBe("segment");
    close(fromA!.end, 0.53, 0.5);
    close(fromB!.end, 0.53, 0.5);
  });

  /*
    One mend per end, and no fan of them at one gap.

        (0.4,0.5) ── A ·        · B ── (0.65,0.5)
                          · C
                          │
                     (0.525,0.64)

    Three free ends within reach of one another. A and B choose each other first; C's choices are then
    taken, and nothing else of C's is in reach — so there is one mend, not three.
  */
  it("takes each free end once, so three ends at one gap give one mend", () => {
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.55, 0.5],
        [0.65, 0.5],
        [0.525, 0.54],
        [0.525, 0.64],
      ],
      [
        [0, 1],
        [2, 3],
        [5, 4],
      ],
    );
    const a = nodeAt(graph, 0.5, 0.5);
    const b = nodeAt(graph, 0.55, 0.5);
    const c = nodeAt(graph, 0.525, 0.54);

    const mends = findMends(graph, { reach: 0.06, travel: 0 });
    const atTheGap = mends.filter(
      (mend) =>
        [a, b, c].includes(mend.from) || (mend.to.kind === "end" && [a, b, c].includes(mend.to.node)),
    );

    expect(atTheGap).toHaveLength(1);
    expect(atTheGap[0]!.to.kind).toBe("end");
    expect([atTheGap[0]!.from, (atTheGap[0]!.to as { node: number }).node].sort()).toEqual(
      [a, b].sort(),
    );
  });
});

/*
  Across different ends, a better *kind* of target is taken before a better score.

      (0.4,0.5) ── X ·   ┆   · X' ── (0.69,0.5)
                  (0.5)  ┆ Y  (0.59)
                         ┆ (0.545,0.581), its wall running up
      (0.3,0.4995) ─────────────────────────── (0.8,0.4995)

  X and X' are a gap 0.09 wide, exactly the reach. Y sits over the middle of it, just out of reach of
  both, so its only option is the wall below — a mend 0.0815 long, which crosses the gap. Ranked by
  score alone, Y's shorter mend is taken first and the gap between X and X' can no longer be closed.
  Taken by kind first, X and X' are joined and Y is left with nothing, which is the right way round:
  an end joined to an end is the stronger evidence of a break.
*/
describe("pairing across ends", () => {
  it("joins two ends before a nearer mend onto a wall that would cross them", () => {
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.59, 0.5],
        [0.69, 0.5],
        [0.545, 0.68],
        [0.545, 0.581],
        [0.3, 0.4995],
        [0.8, 0.4995],
      ],
      [
        [0, 1],
        [3, 2],
        [4, 5],
        [6, 7],
      ],
    );
    const x = nodeAt(graph, 0.5, 0.5);
    const xPrime = nodeAt(graph, 0.59, 0.5);
    const y = nodeAt(graph, 0.545, 0.581);

    const mends = findMends(graph, { reach: 0.09, travel: 0 });
    const gap = mendTouching(mends, x);

    expect(gap?.to.kind).toBe("end");
    expect([gap!.from, (gap!.to as { node: number }).node].sort()).toEqual([x, xPrime].sort());
    expect(mends.find((mend) => mend.from === y)).toBeUndefined();
  });
});

describe("applyMends", () => {
  it("closes the broken room, so it becomes a room", () => {
    expect(buildWallFaces(BROKEN_ROOM).faces).toHaveLength(0);

    const result = applyMends(BROKEN_ROOM, findMends(BROKEN_ROOM, { reach: 0.06, travel: 0.1 }));
    const faces = buildWallFaces(result.graph);

    expect(faces.faces).toHaveLength(1);
    expect(faces.eulerHolds).toBe(true);
    // Joined through the existing ends, not beside them: no free end is left.
    expect(nodeDegrees(result.graph).filter((degree) => degree === 1)).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(BROKEN_ROOM.nodes.length);
  });

  /*
    A wall that stops short of another. Accepting splits the other at the landing and shares that
    vertex, rather than ending a hair away from it.

        (0.3,0.45) ──────────┬────────── (0.7,0.45)
                             │
                        (0.5, 0.3 to 0.4)
  */
  it("splits the wall a mend lands on and attaches to the split", () => {
    const graph = graphOf(
      [
        [0.5, 0.3],
        [0.5, 0.4],
        [0.3, 0.45],
        [0.7, 0.45],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const mend = findMends(graph, { reach: 0.1, travel: 0 }).find(
      (candidate) => candidate.from === nodeAt(graph, 0.5, 0.4),
    )!;

    const result = applyMends(graph, [mend]);
    const landing = nodeAt(result.graph, 0.5, 0.45);

    expect(result.splits).toBe(1);
    expect(nodeDegrees(result.graph)[landing]).toBe(3);
    expect(nodeDegrees(result.graph)[nodeAt(result.graph, 0.5, 0.4)]).toBe(2);
  });

  /*
    Onto walls at every angle, where a landing is not a round number — the case the split-first order
    exists for, and a sweep because no single fixture reliably shows it.

    Adding a wall whose end lands inside another already splits the other, but at the point the
    *crossing predicate* computes along it, and it reuses the new wall's end only if the two quantise
    to the same float32. They often do not: **measured on 2026-09-16 over 19,061 random mends, adding
    each by `insertEdge` alone left 7,926 ending beside the vertex they were meant to share** — drawn
    closed, and open. The first fixture written for this was horizontal and attached either way, which
    is how a mutation removing the split survived it. Splitting at the landing first gives the mend a
    vertex to reach by its exact coordinate; `applyMends` left none detached over the same set.
  */
  it("attaches every mend to the wall it lands on, at any angle", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    let landed = 0;
    for (let i = 0; i < 3000; i++) {
      // A free end with a random heading, and a long wall at a random angle passing near it.
      const ax = 0.3 + random() * 0.4;
      const ay = 0.3 + random() * 0.4;
      const heading = random() * Math.PI * 2;
      const back = 0.02 + random() * 0.05;
      const slope = random() * Math.PI;
      const cx = ax + (random() - 0.5) * 0.06;
      const cy = ay + (random() - 0.5) * 0.06;
      const graph = graphOf(
        [
          [ax - Math.cos(heading) * back, ay - Math.sin(heading) * back],
          [ax, ay],
          [cx - Math.cos(slope) * 0.3, cy - Math.sin(slope) * 0.3],
          [cx + Math.cos(slope) * 0.3, cy + Math.sin(slope) * 0.3],
        ],
        [
          [0, 1],
          [2, 3],
        ],
      );
      const mend = findMends(graph, { reach: 0.2, travel: 0 }).find(
        (candidate) => candidate.from === 1 && candidate.to.kind === "segment",
      );
      if (!mend) continue;
      landed += 1;

      const result = applyMends(graph, [mend]).graph;
      const at = result.nodes.findIndex((node) => node.x === mend.end.x && node.y === mend.end.y);
      expect(nodeDegrees(result)[at], `case ${i}`).toBe(3);
    }
    // Most cases land on the wall; the sweep is only evidence if they do.
    expect(landed).toBeGreaterThan(2500);
  });

  it("splits a wall once for two mends landing on the same point of it", () => {
    // The wall between two facing ends: both land at (0.53, 0.5), which becomes one four-way vertex.
    const graph = graphOf(
      [
        [0.4, 0.5],
        [0.5, 0.5],
        [0.56, 0.5],
        [0.66, 0.5],
        [0.53, 0.3],
        [0.53, 0.7],
      ],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    const mends = findMends(graph, { reach: 0.1, travel: 0 }).filter(
      (mend) => mend.to.kind === "segment",
    );
    expect(mends).toHaveLength(2);

    const result = applyMends(graph, mends);
    const crossing = nodeAt(result.graph, 0.53, 0.5);

    expect(nodeDegrees(result.graph)[crossing]).toBe(4);
    // One new vertex, not two at the same place.
    expect(result.graph.nodes.length).toBe(graph.nodes.length + 1);
  });

  it("splits a wall at two points, in order along it, for two mends landing apart", () => {
    // Two walls stopping short of one long wall, at x = 0.4 and x = 0.6.
    const graph = graphOf(
      [
        [0.4, 0.3],
        [0.4, 0.4],
        [0.6, 0.3],
        [0.6, 0.4],
        [0.2, 0.45],
        [0.8, 0.45],
      ],
      [
        [0, 1],
        [2, 3],
        [5, 4],
      ],
    );
    const mends = findMends(graph, { reach: 0.1, travel: 0 });
    expect(mends.filter((mend) => mend.to.kind === "segment")).toHaveLength(2);

    const result = applyMends(graph, mends);
    const degrees = nodeDegrees(result.graph);

    expect(result.splits).toBe(2);
    expect(degrees[nodeAt(result.graph, 0.4, 0.45)]).toBe(3);
    expect(degrees[nodeAt(result.graph, 0.6, 0.45)]).toBe(3);
    // The long wall is three segments now, end to end, with nothing overlapping.
    expect(buildWallFaces(result.graph).eulerHolds).toBe(true);
  });
});
