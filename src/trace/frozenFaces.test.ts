import { describe, expect, it } from "vitest";

import { buildFrozenFaces, describeFrozenFaces } from "./frozenFaces";
import { documentPoint, type FrozenGraph } from "./frozenGraph";

/** A graph from plain coordinates, quantised the way the document holds them. */
function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): FrozenGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** A closed run of nodes, as the edges between consecutive ones. */
function loop(ids: readonly number[]): [number, number][] {
  return ids.map((id, index) => [id, ids[(index + 1) % ids.length]!] as [number, number]);
}

const square = (x: number, y: number, size: number): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

/** One room. */
const ROOM = graphOf(square(0.2, 0.2, 0.4), loop([0, 1, 2, 3]));

/**
 * Two rooms sharing a wall — the outline, plus one divider.
 *
 * Written as one loop and a divider rather than two loops, because two loops would put the wall
 * between them in twice: two segments on the same pair of vertices are *coincident*, which is a
 * doubled wall rather than a shared one.
 */
const DOMINO = graphOf(
  [
    [0.1, 0.1],
    [0.5, 0.1],
    [0.9, 0.1],
    [0.9, 0.5],
    [0.5, 0.5],
    [0.1, 0.5],
  ],
  [...loop([0, 1, 2, 3, 4, 5]), [1, 4]],
);

/** Coordinates are float32, so an area is right to about seven digits and no further. */
const PLACES = 6;

/** A room with a stub hanging into it from a corner. */
const STUB = graphOf(
  [...square(0.2, 0.2, 0.4), [0.4, 0.4]],
  [...loop([0, 1, 2, 3]), [0, 4]],
);

/** A room inside a room. */
const NESTED = graphOf(
  [...square(0.1, 0.1, 0.8), ...square(0.4, 0.4, 0.2)],
  [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7])],
);

/**
 * Three rooms nested one inside the next, none joined to any other.
 *
 * The innermost piece of linework is contained by *two* rings, so this is what says a hole attaches
 * to the smallest ring around it rather than to any ring around it.
 */
const ONION = graphOf(
  [...square(0.05, 0.05, 0.9), ...square(0.2, 0.2, 0.6), ...square(0.35, 0.35, 0.3)],
  [...loop([0, 1, 2, 3]), ...loop([4, 5, 6, 7]), ...loop([8, 9, 10, 11])],
);

/** A piece of linework floating free inside a room, joined to nothing. */
const FLOATING = graphOf(
  [...square(0.1, 0.1, 0.8), [0.4, 0.5], [0.6, 0.5]],
  [...loop([0, 1, 2, 3]), [4, 5]],
);

/**
 * A loose chain inside a frame whose area does not cancel if it is summed point by point.
 *
 * The coordinates are not decoration. A tree is walked out and back, so its area is exactly nothing
 * — but the terms that ought to annihilate are separated by the rest of the walk, and adding them in
 * that order rounds. **These four points sum to +5.55e-17**, and positive is the direction that
 * matters: a rounding residue the wrong way turns a loose stub into a room.
 *
 * Found by searching random float32 chains rather than reasoned out: about one in a thousand fails
 * to cancel, and a three-point chain never does, because its two middle terms are adjacent.
 */
const LOOSE_CHAIN = graphOf(
  [
    ...square(0, 0, 1),
    [0.05097900703549385, 0.11645196378231049],
    [0.48409080505371094, 0.06363479793071747],
    [0.5403146147727966, 0.5743140578269958],
    [0.12005297094583511, 0.8019104599952698],
  ],
  [
    ...loop([0, 1, 2, 3]),
    [4, 5],
    [5, 6],
    [6, 7],
  ],
);

/**
 * A room on the end of a stalk, both inside a frame.
 *
 * The frame's face has one hole cycle that walks round the first room, out along the stalk, round
 * the second and back. Taking the stalk out **disconnects** that boundary, so it must come apart
 * into two rings rather than carrying on across the gap.
 */
const LOLLIPOP = graphOf(
  [
    ...square(0.0, 0.0, 1.0),
    [0.1, 0.1],
    [0.3, 0.1],
    [0.3, 0.3],
    [0.1, 0.3],
    [0.6, 0.1],
    [0.8, 0.1],
    [0.8, 0.3],
    [0.6, 0.3],
  ],
  [
    ...loop([0, 1, 2, 3]),
    ...loop([4, 5, 6, 7]),
    ...loop([8, 9, 10, 11]),
    [5, 8],
  ],
);

describe("faces of the frozen graph", () => {
  it("finds one room in a square, and covers every wall with its ring", () => {
    const result = buildFrozenFaces(ROOM);

    expect(result.faces).toHaveLength(1);
    expect(result.faces[0]!.rings).toHaveLength(1);
    expect(result.faces[0]!.rings[0]).toHaveLength(4);
    expect(result.faces[0]!.doubleArea).toBeGreaterThan(0);
    expect(result.walls).toEqual([]);
    expect(result.bridges).toBe(0);
    expect(result.unbounded).toBe(1);
  });

  it("puts the face on the right of every wall, so a room encloses and the outside does not", () => {
    const result = buildFrozenFaces(ROOM);

    // Doubled area of a 0.4 square, and positive because the walk keeps the room on its right.
    expect(result.faces[0]!.doubleArea).toBeCloseTo(2 * 0.4 * 0.4, PLACES);
    expect(result.enclosing).toBe(1);
    expect(result.outward).toBe(1);
  });

  it("finds both rooms of a domino, and gives them the shared wall's own two points", () => {
    const result = buildFrozenFaces(DOMINO);

    expect(result.faces).toHaveLength(2);
    for (const face of result.faces) {
      expect(face.rings).toHaveLength(1);
      expect(face.rings[0]).toHaveLength(4);
      expect(face.doubleArea).toBeCloseTo(2 * 0.4 * 0.4, PLACES);
    }

    // The wall between them, by identity rather than by coordinates being close.
    const shared = [DOMINO.nodes[1]!, DOMINO.nodes[4]!];
    for (const face of result.faces) {
      const ring = face.rings[0]!;
      for (const point of shared) expect(ring).toContain(point);
    }
  });

  it("walks a stub as a slit, emits it as a wall, and leaves it out of the room's ring", () => {
    const result = buildFrozenFaces(STUB);

    expect(result.faces).toHaveLength(1);
    expect(result.bridges).toBe(1);
    // The stub is the fifth edge, and it is the only one no ring covers.
    expect(result.walls).toEqual([4]);

    const ring = result.faces[0]!.rings[0]!;
    expect(ring).toHaveLength(4);
    expect(ring).not.toContain(STUB.nodes[4]);
    // The slit encloses nothing, so it costs the room no area either.
    expect(result.faces[0]!.doubleArea).toBeCloseTo(2 * 0.4 * 0.4, PLACES);
  });

  it("makes a nested room a hole of the one around it, and a face in its own right", () => {
    const result = buildFrozenFaces(NESTED);

    expect(result.faces).toHaveLength(2);
    const [outer, inner] = result.faces;

    expect(outer!.rings).toHaveLength(2);
    expect(inner!.rings).toHaveLength(1);
    // The outer face is the big square less the small one, which is what the hole subtracts.
    expect(outer!.doubleArea).toBeCloseTo(2 * (0.8 * 0.8 - 0.2 * 0.2), PLACES);
    expect(inner!.doubleArea).toBeCloseTo(2 * 0.2 * 0.2, PLACES);
    expect(result.walls).toEqual([]);
  });

  it("attaches a hole to the smallest ring containing it, not to any ring containing it", () => {
    const result = buildFrozenFaces(ONION);

    expect(result.faces).toHaveLength(3);
    const [outer, middle, inner] = result.faces;

    // Each band is its own square less the next one in; the innermost is solid.
    expect(outer!.doubleArea).toBeCloseTo(2 * (0.9 * 0.9 - 0.6 * 0.6), PLACES);
    expect(middle!.doubleArea).toBeCloseTo(2 * (0.6 * 0.6 - 0.3 * 0.3), PLACES);
    expect(inner!.doubleArea).toBeCloseTo(2 * 0.3 * 0.3, PLACES);
    expect(outer!.rings).toHaveLength(2);
    expect(middle!.rings).toHaveLength(2);
    expect(inner!.rings).toHaveLength(1);

    // The innermost square is a hole of the middle band, and appears in no other face's holes.
    expect(middle!.cycles[1]!.points).toContain(ONION.nodes[8]);
    expect(outer!.cycles[1]!.points).not.toContain(ONION.nodes[8]);
  });

  it("hangs free-floating linework off the face that contains it, without giving it area", () => {
    const result = buildFrozenFaces(FLOATING);

    expect(result.faces).toHaveLength(1);
    expect(result.components).toBe(2);
    expect(result.bridges).toBe(1);
    // The room's ring only; the loose segment produced no ring and is emitted as a wall.
    expect(result.faces[0]!.rings).toHaveLength(1);
    expect(result.walls).toEqual([4]);
    expect(result.faces[0]!.doubleArea).toBeCloseTo(2 * 0.8 * 0.8, PLACES);
  });

  it("gives free-floating linework an area of exactly nothing, not nearly nothing", () => {
    const result = buildFrozenFaces(LOOSE_CHAIN);

    // Exactly, with no tolerance: a positive residue would make this loose chain a room.
    expect(result.faces).toHaveLength(1);
    expect(result.enclosing).toBe(1);
    expect(result.faces[0]!.cycles).toHaveLength(2);
    expect(result.faces[0]!.cycles[1]!.doubleArea).toBe(0);
    expect(result.walls).toEqual([4, 5, 6]);
  });

  it("splits a boundary that a stalk disconnects, rather than cutting across the gap", () => {
    const result = buildFrozenFaces(LOLLIPOP);

    expect(result.faces).toHaveLength(3);
    expect(result.bridges).toBe(1);
    expect(result.walls).toEqual([12]);

    // The frame's face: its own ring, plus one round each room the stalk joined.
    const frame = result.faces[0]!;
    expect(frame.cycles).toHaveLength(2);
    expect(frame.rings).toHaveLength(3);
    for (const ring of frame.rings) expect(ring).toHaveLength(4);

    // Cutting across the gap would have put the stalk's far end in the near room's ring.
    const near = frame.rings.find((ring) => ring.includes(LOLLIPOP.nodes[5]!))!;
    expect(near).not.toContain(LOLLIPOP.nodes[8]);
  });
});

describe("the arithmetic check", () => {
  const fixtures: [string, FrozenGraph][] = [
    ["one room", ROOM],
    ["a domino", DOMINO],
    ["a stub", STUB],
    ["a nested room", NESTED],
    ["three nested rooms", ONION],
    ["floating linework", FLOATING],
    ["a lollipop", LOLLIPOP],
    ["a loose chain", LOOSE_CHAIN],
  ];

  it.each(fixtures)("holds on %s", (_name, graph) => {
    const result = buildFrozenFaces(graph);

    expect(result.eulerHolds).toBe(true);
    expect(result.vertices - result.edges + result.enclosing).toBe(result.components);
    // Exactly one outward-facing cycle per piece of linework, which is what makes grouping total.
    expect(result.outward).toBe(result.components);
    expect(describeFrozenFaces(result)).toContain("Euler holds");
  });

  it.each(fixtures)("accounts for every wall exactly once on %s", (_name, graph) => {
    const result = buildFrozenFaces(graph);

    const covered = new Set<number>();
    for (const face of result.faces) {
      for (const cycle of face.cycles) {
        for (const half of cycle.halfEdges) covered.add(half >> 1);
      }
    }
    // A ring covers a wall or a line does; a wall in neither has vanished from both outputs.
    for (let edge = 0; edge < graph.edges.length; edge++) {
      const drawn = covered.has(edge) || result.walls.includes(edge);
      expect(drawn, `edge ${edge}`).toBe(true);
    }
    expect(new Set(result.walls).size).toBe(result.walls.length);
  });

  it("reports the failure rather than throwing when the identity does not hold", () => {
    // Two walls between the same pair of vertices are coincident, so they enclose nothing and the
    // embedding is not one Euler describes. A legal state to pass through — doubling a line in
    // order to drag the copy away — so it is reported and the derivation still produces something.
    const doubled = graphOf(
      [
        [0.2, 0.2],
        [0.8, 0.2],
      ],
      [
        [0, 1],
        [0, 1],
      ],
    );
    const result = buildFrozenFaces(doubled);

    expect(result.faces).toEqual([]);
    expect(result.eulerHolds).toBe(false);
    // Both walls are still drawn, as lines, which is the honest rendering of a pair enclosing
    // nothing. Two outward cycles on one piece of linework is the other half of the tell.
    expect(result.walls).toEqual([0, 1]);
    expect(result.outward).toBe(2);
    expect(result.components).toBe(1);
    expect(describeFrozenFaces(result)).toContain("EULER FAILED");
    expect(describeFrozenFaces(result)).toContain("outward cycles 2 against 1");
  });
});

describe("slivers and other degenerate shapes", () => {
  it("keeps a sliver rather than refusing it", () => {
    // A triangle a thousandth of the map thick. Small in area and not small in effect: Dynamic Fog
    // strokes a boundary to derive walls, so a few pixels of shape still block line of sight.
    const sliver = graphOf(
      [
        [0.2, 0.5],
        [0.8, 0.5],
        [0.5, 0.501],
      ],
      loop([0, 1, 2]),
    );
    const result = buildFrozenFaces(sliver);

    expect(result.faces).toHaveLength(1);
    expect(result.faces[0]!.rings[0]).toHaveLength(3);
    expect(result.degenerateFaces).toBe(0);
    expect(result.walls).toEqual([]);
  });

  it("leaves an unreferenced vertex out of the count, since merging makes them", () => {
    const merged: FrozenGraph = {
      ...ROOM,
      nodes: [...ROOM.nodes, documentPoint(0.9, 0.9)],
    };
    const result = buildFrozenFaces(merged);

    expect(result.vertices).toBe(4);
    expect(result.eulerHolds).toBe(true);
  });

  it("leaves a wall of no length out of the traversal and emits it as a line", () => {
    const collapsed = graphOf(
      [...square(0.2, 0.2, 0.4), [0.5, 0.5]],
      [...loop([0, 1, 2, 3]), [4, 4]],
    );
    const result = buildFrozenFaces(collapsed);

    expect(result.zeroLength).toBe(1);
    expect(result.faces).toHaveLength(1);
    expect(result.walls).toEqual([4]);
    expect(result.eulerHolds).toBe(true);
  });
});
