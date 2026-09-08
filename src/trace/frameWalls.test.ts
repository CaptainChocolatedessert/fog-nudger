/**
 * Framing the map, which is how a GM gets the exterior back as a room.
 *
 * The derivation stopped painting a border on 2026-09-08, so the outside is the arrangement's
 * unbounded face — no polygon, nothing emitted, and therefore fogged and unrevealable. These are the
 * shapes where that is not what a GM wants.
 */

import { describe, expect, it } from "vitest";

import { addFrameWalls, alreadyFramed } from "./frameWalls";
import { buildFrozenFaces } from "./frozenFaces";
import { documentPoint, type FrozenGraph } from "./frozenGraph";

function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): FrozenGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** A closed room well inside the map, touching nothing. */
const ROOM = graphOf(
  [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
  ],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ],
);

describe("addFrameWalls", () => {
  /*
    The point of the whole thing: one more face, and it is the outside.

    Unframed, a lone room gives one face — its inside. Framed, the band between the room and the map's
    edge becomes an ordinary bounded face with the room as its hole, so it can be emitted and
    therefore revealed.
  */
  it("turns the exterior into a face that can be emitted", () => {
    expect(buildFrozenFaces(ROOM).faces).toHaveLength(1);

    const framed = addFrameWalls(ROOM);
    const faces = buildFrozenFaces(framed.graph);
    expect(faces.faces).toHaveLength(2);

    // The new one is the band: it carries a hole, which the room's own face does not.
    expect(faces.faces.filter((face) => face.cycles.length > 1)).toHaveLength(1);
    expect(faces.eulerHolds).toBe(true);
  });

  it("lands exactly on the map's edge, not near it", () => {
    const framed = addFrameWalls(ROOM);
    const xs = framed.graph.nodes.map((node) => node.x);
    const ys = framed.graph.nodes.map((node) => node.y);
    expect(xs).toContain(0);
    expect(xs).toContain(1);
    expect(ys).toContain(0);
    expect(ys).toContain(1);
  });

  /*
    The corners are shared vertices, because the frame goes in as one closed run.

    Four separate insertions would leave four pairs of coincident points that agree until one moves —
    the same distinction the drawing tool's snapping exists for. A corner that is two vertices is a
    corner where the exterior's boundary can come apart.
  */
  it("shares its corners rather than leaving coincident points", () => {
    const framed = addFrameWalls(ROOM);
    const corners = framed.graph.nodes.filter(
      (node) => (node.x === 0 || node.x === 1) && (node.y === 0 || node.y === 1),
    );
    expect(corners).toHaveLength(4);
  });

  /*
    A wall running off the edge of the map is cut where it meets the frame.

    Without that the frame would overlap existing linework rather than joining it, and the exterior
    would not be one face. Splitting is the standing rule for crossings, and this is the case that
    makes it matter here.
  */
  it("splits linework that runs out to the edge", () => {
    const reaching = graphOf(
      [
        [0.5, 0.5],
        [0.5, 1.4],
      ],
      [[0, 1]],
    );
    const framed = addFrameWalls(reaching);
    expect(framed.splits).toBeGreaterThan(0);
    expect(buildFrozenFaces(framed.graph).eulerHolds).toBe(true);
  });

  /*
    Pressing it twice must not lay a second frame on the first.

    Four segments exactly on four existing ones are **collinear overlaps**, which splitting cannot
    separate and which make Euler's identity fail — a document corrupted by a second press, invisible
    until the next traversal. So the second press is refused rather than absorbed.
  */
  it("refuses to frame a graph that is already framed", () => {
    const once = addFrameWalls(ROOM);
    expect(once.alreadyFramed).toBe(false);
    expect(alreadyFramed(once.graph)).toBe(true);

    const twice = addFrameWalls(once.graph);
    expect(twice.alreadyFramed).toBe(true);
    expect(twice.graph).toBe(once.graph);
    expect(twice.graph.edges).toHaveLength(once.graph.edges.length);
  });

  it("does not mistake linework that merely touches the border for a frame", () => {
    // One wall along the top edge is not a frame, and a GM pressing the button should get one.
    const touching = graphOf(
      [
        [0, 0],
        [1, 0],
      ],
      [[0, 1]],
    );
    expect(alreadyFramed(touching)).toBe(false);
    expect(addFrameWalls(touching).alreadyFramed).toBe(false);
  });

  /*
    A single wall from corner to corner reaches all four edges, and is not a frame.

    This is the case that separates "an endpoint sits on this edge" from "a segment lies along it",
    and it is the whole reason the test is written the strict way: the diagonal's two endpoints touch
    the left, right, top and bottom between them, so a looser test calls the map framed and the button
    silently refuses to do anything.
  */
  it("does not mistake a corner-to-corner wall for a frame", () => {
    const diagonal = graphOf(
      [
        [0, 0],
        [1, 1],
      ],
      [[0, 1]],
    );
    expect(alreadyFramed(diagonal)).toBe(false);
    expect(addFrameWalls(diagonal).alreadyFramed).toBe(false);
  });

  it("frames an empty document", () => {
    const framed = addFrameWalls({ nodes: [], edges: [] });
    expect(framed.graph.edges).toHaveLength(4);
    // One face: the whole map, with nothing in it.
    expect(buildFrozenFaces(framed.graph).faces).toHaveLength(1);
  });
});
