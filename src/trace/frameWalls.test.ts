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
 *
 * **Eight mutations on 2026-09-22, eight caught**, over the toggle: the along-test loosened to either
 * end and stripped of the right edge, any vertical wall called an edge wall, the clearing step skipped
 * before laying a frame, the cleared count zeroed, the graph rebuilt when nothing was removed, the
 * removal filter inverted, and the removed count zeroed.
 */

import { describe, expect, it } from "vitest";

import { addFrameWalls, alreadyFramed, edgeWallIndices, removeFrameWalls } from "./frameWalls";
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

/**
 * Every edge as its two endpoints' coordinates, sorted, so two graphs can be compared by what they
 * draw rather than by how they are numbered. Removal leaves unused vertices behind on purpose, so the
 * node tables differ even when the walls are identical.
 */
function edgesAsPoints(graph: WallGraph): [number, number][][] {
  return graph.edges
    .map((edge): [number, number][] => {
      const a: [number, number] = [graph.nodes[edge.a]!.x, graph.nodes[edge.a]!.y];
      const b: [number, number] = [graph.nodes[edge.b]!.x, graph.nodes[edge.b]!.y];
      return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    })
    .sort((x, y) => x[0]![0] - y[0]![0] || x[0]![1] - y[0]![1] || x[1]![0] - y[1]![0] || x[1]![1] - y[1]![1]);
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

  /*
    The case the all-or-nothing refusal does not reach.

    A frame with one side erased reads as unframed, so the press goes ahead — and before the clearing
    step it laid three new segments exactly on three existing ones. `insertEdge` reports those as
    collinear overlaps and leaves them, so the corruption is silent until something next walks the
    graph. The oracle here is the traversal, which shares none of the framing's reasoning.
  */
  it("lays a clean frame over a partial one rather than doubling three of its sides", () => {
    const once = addFrameWalls(ROOM, WIDE);
    const top = edgeWallIndices(once.graph, WIDE).find((index) => {
      const edge = once.graph.edges[index]!;
      return once.graph.nodes[edge.a]!.y === 0 && once.graph.nodes[edge.b]!.y === 0;
    })!;
    const partial: WallGraph = {
      nodes: once.graph.nodes,
      edges: once.graph.edges.filter((_, index) => index !== top),
    };
    expect(alreadyFramed(partial, WIDE)).toBe(false);

    const again = addFrameWalls(partial, WIDE);
    expect(again.overlaps).toBe(0);
    expect(again.cleared).toBe(3);
    expect(alreadyFramed(again.graph, WIDE)).toBe(true);
    const faces = buildWallFaces(again.graph);
    expect(faces.eulerHolds).toBe(true);
    // The same two faces a whole frame gives: the room, and the band around it.
    expect(faces.faces).toHaveLength(2);
  });
});

describe("removeFrameWalls", () => {
  /*
    Off then on is the identity, on a map where nothing reaches the edge.

    Compared as coordinate pairs rather than ids: taking walls out leaves their vertices behind by
    `removeEdge`'s rule, so the node table is deliberately not the same afterwards and comparing ids
    would assert the wrong thing.
  */
  it("takes back exactly what framing added", () => {
    const framed = addFrameWalls(ROOM, WIDE);
    const back = removeFrameWalls(framed.graph, WIDE);
    expect(back.removed).toBe(4);
    expect(edgesAsPoints(back.graph)).toEqual(edgesAsPoints(ROOM));
    expect(alreadyFramed(back.graph, WIDE)).toBe(false);
  });

  /*
    A wall that ran out to the edge keeps the piece the frame cut.

    The document never recorded which splits the framing made, so the two pieces stay as two, meeting
    at a vertex where there was none. The **line** is unchanged, which is what a GM sees; the cost is
    one extra vertex, and it is stated rather than silently repaired.
  */
  it("leaves a wall the frame split as two pieces on the same line", () => {
    const reaching = graphOf(
      [
        [0.5, 0.4],
        [0.5, 1.4],
      ],
      [[0, 1]],
    );
    const framed = addFrameWalls(reaching, WIDE);
    const back = removeFrameWalls(framed.graph, WIDE);
    // Outside the map and inside it, meeting where the frame was.
    expect(back.graph.edges).toHaveLength(2);
    const ys = new Set(edgesAsPoints(back.graph).flat().map(([, y]) => y));
    expect(ys).toContain(documentCoordinate(WIDE.y));
  });

  it("takes a wall the GM drew along the edge, having no way to tell it apart", () => {
    const drawn = graphOf(
      [
        [0.2, 0],
        [0.6, 0],
      ],
      [[0, 1]],
    );
    expect(removeFrameWalls(drawn, WIDE).removed).toBe(1);
  });

  /*
    The strict reading, from the other side: a wall is only a frame wall if it lies **along** an edge.
    The diagonal touches all four and none of them lies along one, so nothing goes.
  */
  it("keeps a corner-to-corner wall, which touches every edge and lies along none", () => {
    const diagonal = graphOf(
      [
        [0, 0],
        [WIDE.x, WIDE.y],
      ],
      [[0, 1]],
    );
    expect(removeFrameWalls(diagonal, WIDE).removed).toBe(0);
    expect(removeFrameWalls(diagonal, WIDE).graph).toBe(diagonal);
  });

  it("does not take a frame belonging to a different extent", () => {
    const elsewhere = addFrameWalls({ nodes: [], edges: [] }, TALL).graph;
    // Two of the four sides are shared by any extent — x = 0 and y = 0 — so the other two stay.
    expect(removeFrameWalls(elsewhere, WIDE).removed).toBe(2);
    expect(alreadyFramed(removeFrameWalls(elsewhere, WIDE).graph, TALL)).toBe(false);
  });
});
