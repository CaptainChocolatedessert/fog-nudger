/**
 * Framing the map, which is how a GM gets the exterior back as a room.
 *
 * The derivation stopped painting a border on 2026-09-08, so the outside is the arrangement's
 * unbounded face — no polygon, nothing emitted, and therefore fogged and unrevealable. These are the
 * shapes where that is not what a GM wants.
 *
 * **Every fixture is on a map that is not square**, since 2026-09-16. The frame goes at the map's
 * extent in graph units, where the longer side is 1 and the other is less; on a square map that is
 * the unit square, so a frame placed at (1, 1) regardless would pass every test written on one.
 *
 * Two mutations on 2026-09-16 — the frame and the already-framed test each at the unit square — two
 * caught.
 */

import { describe, expect, it } from "vitest";

import { addFrameWalls, alreadyFramed } from "./frameWalls";
import { graphExtent } from "./graphUnits";
import { buildWallFaces } from "./wallFaces";
import { documentCoordinate, documentPoint, type WallGraph } from "./wallGraph";

function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** The test map's proportions: landscape, so x runs to 1 and y stops short of it. */
const WIDE = graphExtent(3300, 2550);
/** The same map stood on its end, so it is x that stops short. */
const TALL = graphExtent(2550, 3300);

/** A closed room well inside the wide map, touching nothing. */
const ROOM = graphOf(
  [
    [0.3, 0.2],
    [0.7, 0.2],
    [0.7, 0.5],
    [0.3, 0.5],
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
    expect(buildWallFaces(ROOM).faces).toHaveLength(1);

    const framed = addFrameWalls(ROOM, WIDE);
    const faces = buildWallFaces(framed.graph);
    expect(faces.faces).toHaveLength(2);

    // The new one is the band: it carries a hole, which the room's own face does not.
    expect(faces.faces.filter((face) => face.cycles.length > 1)).toHaveLength(1);
    expect(faces.eulerHolds).toBe(true);
  });

  it("lands exactly on the map's edge, not near it and not on the unit square", () => {
    const framed = addFrameWalls(ROOM, WIDE);
    const xs = framed.graph.nodes.map((node) => node.x);
    const ys = framed.graph.nodes.map((node) => node.y);
    expect(xs).toContain(0);
    expect(xs).toContain(1);
    expect(ys).toContain(0);
    // The short side, exactly as the document holds it — and not 1, which is where a frame went when
    // the graph was in fractions of each side.
    expect(ys).toContain(documentCoordinate(2550 / 3300));
    expect(ys).not.toContain(1);
  });

  it("puts the short side where the map ends whichever way round the map is", () => {
    const framed = addFrameWalls({ nodes: [], edges: [] }, TALL);
    const xs = framed.graph.nodes.map((node) => node.x);
    const ys = framed.graph.nodes.map((node) => node.y);
    expect(Math.max(...xs)).toBe(documentCoordinate(2550 / 3300));
    expect(Math.max(...ys)).toBe(1);
  });

  /*
    The corners are shared vertices, because the frame goes in as one closed run.

    Four separate insertions would leave four pairs of coincident points that agree until one moves —
    the same distinction the drawing tool's snapping exists for. A corner that is two vertices is a
    corner where the exterior's boundary can come apart.
  */
  it("shares its corners rather than leaving coincident points", () => {
    const framed = addFrameWalls(ROOM, WIDE);
    const corners = framed.graph.nodes.filter(
      (node) => (node.x === 0 || node.x === WIDE.x) && (node.y === 0 || node.y === WIDE.y),
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
        [0.5, 0.4],
        [0.5, 1.4],
      ],
      [[0, 1]],
    );
    const framed = addFrameWalls(reaching, WIDE);
    expect(framed.splits).toBeGreaterThan(0);
    expect(buildWallFaces(framed.graph).eulerHolds).toBe(true);
  });

  /*
    Pressing it twice must not lay a second frame on the first.

    Four segments exactly on four existing ones are **collinear overlaps**, which splitting cannot
    separate and which make Euler's identity fail — a document corrupted by a second press, invisible
    until the next traversal. So the second press is refused rather than absorbed.
  */
  it("refuses to frame a graph that is already framed", () => {
    const once = addFrameWalls(ROOM, WIDE);
    expect(once.alreadyFramed).toBe(false);
    expect(alreadyFramed(once.graph, WIDE)).toBe(true);

    const twice = addFrameWalls(once.graph, WIDE);
    expect(twice.alreadyFramed).toBe(true);
    expect(twice.graph).toBe(once.graph);
    expect(twice.graph.edges).toHaveLength(once.graph.edges.length);
  });

  it("does not take a frame at the wrong extent for this map's", () => {
    // Framed as though the map were stood on end: its right edge is short of this map's, and its
    // bottom is past it. That is linework, not this map's frame.
    const elsewhere = addFrameWalls({ nodes: [], edges: [] }, TALL).graph;
    expect(alreadyFramed(elsewhere, WIDE)).toBe(false);
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
    expect(alreadyFramed(touching, WIDE)).toBe(false);
    expect(addFrameWalls(touching, WIDE).alreadyFramed).toBe(false);
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
        [WIDE.x, WIDE.y],
      ],
      [[0, 1]],
    );
    expect(alreadyFramed(diagonal, WIDE)).toBe(false);
    expect(addFrameWalls(diagonal, WIDE).alreadyFramed).toBe(false);
  });

  it("frames an empty document", () => {
    const framed = addFrameWalls({ nodes: [], edges: [] }, WIDE);
    expect(framed.graph.edges).toHaveLength(4);
    // One face: the whole map, with nothing in it.
    expect(buildWallFaces(framed.graph).faces).toHaveLength(1);
  });
});
