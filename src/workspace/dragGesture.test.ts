import { describe, expect, it } from "vitest";

import { documentPoint, nodeDegrees, type WallGraph } from "../trace/wallGraph";
import {
  applyDraw,
  applyDrag,
  describeDraw,
  describeEdit,
  dragTo,
  drawPoint,
  drawRelease,
  grabAt,
} from "./dragGesture";
import { nearestEdge, nearestNode, removeEdge } from "../trace/planarOps";

function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/**
 * Two walls meeting at a corner, and a separate wall whose loose end faces them across a small gap.
 *
 * The loose end used to be a bare vertex with no wall on it, which is not a thing that can exist on
 * screen — nothing draws one and, since 2026-09-05, nothing snaps to one either. A fixture holding a
 * vertex the tools would refuse to offer is a fixture testing a graph that cannot happen.
 */
const CORNER = graphOf(
  [
    [0.2, 0.2],
    [0.5, 0.2],
    [0.5, 0.5],
    [0.55, 0.2],
    [0.7, 0.2],
  ],
  [
    [0, 1],
    [1, 2],
    [3, 4],
  ],
);

/** A radius that reaches the corner from just off it, and not as far as its neighbours. */
const NEAR = 0.02;

describe("taking hold of a vertex", () => {
  it("takes the one under the press", () => {
    const grab = grabAt(CORNER, 0.505, 0.205, NEAR);

    expect(grab?.id).toBe(1);
  });

  it("lets the press mean something else when there is nothing near it", () => {
    // The middle of a room. A drag here has to stay a pan, and `null` is how that is said.
    expect(grabAt(CORNER, 0.35, 0.4, NEAR)).toBeNull();
  });

  it("remembers where the vertex sits relative to the cursor, so it does not jump", () => {
    const grab = grabAt(CORNER, 0.505, 0.205, NEAR)!;
    const held = dragTo(CORNER, grab, 0.505, 0.205, 0, true);

    // Grabbed off-centre and not moved: the vertex is exactly where it was, not under the cursor.
    expect(held.at).toEqual(CORNER.nodes[1]);
  });
});

describe("dragging", () => {
  it("carries the vertex with the cursor", () => {
    const grab = grabAt(CORNER, 0.5, 0.2, NEAR)!;
    const held = dragTo(CORNER, grab, 0.4, 0.3, 0, true);

    expect(held.at).toEqual(documentPoint(0.4, 0.3));
    expect(held.snapTo).toBeNull();
  });

  it("offers a merge when it lands near another vertex, and shows it in the target's place", () => {
    const grab = grabAt(CORNER, 0.5, 0.2, NEAR)!;
    // Dragged to within the snap radius of the loose vertex at 0.55.
    const held = dragTo(CORNER, grab, 0.545, 0.2, NEAR, false);

    expect(held.snapTo).toBe(3);
    // Drawn where the merge would put it, which is what makes the offer legible.
    expect(held.at).toEqual(CORNER.nodes[3]);
  });

  it("does not offer to merge a vertex with itself", () => {
    const grab = grabAt(CORNER, 0.5, 0.2, NEAR)!;
    // Barely moved, so the nearest vertex of all is the one being dragged.
    const held = dragTo(CORNER, grab, 0.501, 0.2, NEAR, false);

    expect(held.snapTo).toBeNull();
  });

  it("suppresses the merge while the modifier is held", () => {
    const grab = grabAt(CORNER, 0.5, 0.2, NEAR)!;
    const suppressed = dragTo(CORNER, grab, 0.545, 0.2, NEAR, true);

    expect(suppressed.snapTo).toBeNull();
    // And the vertex stays under the cursor rather than being pulled onto the target.
    expect(suppressed.at).toEqual(documentPoint(0.545, 0.2));
  });

  it("measures the merge from the vertex, not from the cursor", () => {
    /*
      Grabbed well off-centre, then dragged so the *cursor* is next to the loose vertex while the
      vertex itself is nowhere near it. Measuring from the cursor would offer a merge for two walls
      that never come close, which is the version a GM would see as the mark appearing at random.
    */
    const grab = grabAt(CORNER, 0.515, 0.21, NEAR)!;
    const held = dragTo(CORNER, grab, 0.55, 0.2, 0.01, false);

    expect(held.snapTo).toBeNull();
  });
});

describe("releasing", () => {
  it("moves the vertex when nothing was offered", () => {
    const grab = grabAt(CORNER, 0.5, 0.2, NEAR)!;
    const held = dragTo(CORNER, grab, 0.4, 0.3, 0, true);
    const result = applyDrag(CORNER, grab, held)!;

    expect(result.graph.nodes[1]).toEqual(documentPoint(0.4, 0.3));
    // A move keeps every wall and every end; only the coordinate changed.
    expect(result.graph.edges).toHaveLength(3);
    expect(CORNER.nodes[1]).toEqual(documentPoint(0.5, 0.2));
  });

  it("merges rather than moving when a vertex was offered, so the walls share a point", () => {
    const graph = graphOf(
      [
        [0.2, 0.2],
        [0.5, 0.2],
        [0.55, 0.2],
        [0.8, 0.5],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const grab = grabAt(graph, 0.5, 0.2, NEAR)!;
    const held = dragTo(graph, grab, 0.545, 0.2, NEAR, false);
    const result = applyDrag(graph, grab, held)!;

    // The two walls were separate pieces of linework and are now one, joined at a shared id — not
    // at two vertices that happen to hold equal coordinates.
    expect(held.snapTo).toBe(2);
    expect(nodeDegrees(result.graph)[2]).toBe(2);
    expect(result.graph.edges.some((edge) => edge.a === 1 || edge.b === 1)).toBe(false);
  });

  it("does nothing at all when the vertex did not move", () => {
    const grab = grabAt(CORNER, 0.505, 0.205, NEAR)!;
    const held = dragTo(CORNER, grab, 0.505, 0.205, 0, true);

    // A press and release on a vertex. Writing the graph back would be a scene write for nothing.
    expect(applyDrag(CORNER, grab, held)).toBeNull();
  });

  it("splits a wall the drag carried a vertex across, and says how many", () => {
    // A stub whose free end is dragged over the wall beside it.
    const graph = graphOf(
      [
        [0.2, 0.5],
        [0.4, 0.5],
        [0.6, 0.2],
        [0.6, 0.8],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const grab = grabAt(graph, 0.4, 0.5, NEAR)!;
    const held = dragTo(graph, grab, 0.8, 0.5, 0, true);
    const result = applyDrag(graph, grab, held)!;

    /*
      Two, for one crossing, and that is the operation being honest rather than a miscount: both
      segments are cut where they meet — the stub being dragged and the wall it ran into. The
      wording has to survive that, so it says "at the crossing" rather than "it crossed".
    */
    expect(result.splits).toBe(2);
    expect(describeEdit(false, result.splits, result.overlaps)).toBe(
      "moved a point · split 2 walls at the crossing",
    );
  });
});

describe("saying what happened", () => {
  it("names the operation, and stays quiet when there is nothing to add", () => {
    expect(describeEdit(false, 0, 0)).toBe("moved a point");
    expect(describeEdit(true, 0, 0)).toBe("joined two points");
  });

  it("counts walls in the plural it deserves", () => {
    // One is reachable: a vertex landing *on* a wall rather than across it splits only that wall.
    expect(describeEdit(false, 1, 0)).toBe("moved a point · split 1 wall at the crossing");
    expect(describeEdit(false, 2, 0)).toBe("moved a point · split 2 walls at the crossing");
    expect(describeEdit(true, 0, 1)).toBe("joined two points · 1 wall lies along another");
    expect(describeEdit(true, 0, 3)).toBe("joined two points · 3 walls lie along another");
  });
});

describe("drawing a wall", () => {
  it("attaches an end to a vertex it lands near, by that vertex's own coordinate", () => {
    const end = drawPoint(CORNER, 0.505, 0.205, NEAR, false);

    // The exact coordinate matters and is not a nicety: `insertEdge` reuses a vertex only on an
    // exact match, so a point merely *near* the corner would make a second one on top of it.
    expect(end.onNode).toBe(1);
    expect(end.at).toEqual(CORNER.nodes[1]);
  });

  it("leaves an end loose where there is nothing near it, and where the modifier is held", () => {
    expect(drawPoint(CORNER, 0.35, 0.4, NEAR, false).onNode).toBeNull();

    const suppressed = drawPoint(CORNER, 0.505, 0.205, NEAR, true);
    expect(suppressed.onNode).toBeNull();
    expect(suppressed.at).toEqual(documentPoint(0.505, 0.205));
  });

  it("joins two existing vertices into one piece of linework, which is how a gap closes", () => {
    // Two separate walls whose loose ends face each other across a gap.
    const broken = graphOf(
      [
        [0.1, 0.5],
        [0.4, 0.5],
        [0.6, 0.5],
        [0.9, 0.5],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    );
    const from = drawPoint(broken, 0.401, 0.5, NEAR, false);
    const to = drawPoint(broken, 0.599, 0.5, NEAR, false);
    const result = applyDraw(broken, from, to)!;

    expect(from.onNode).toBe(1);
    expect(to.onNode).toBe(2);
    // No new vertices: the new wall runs between the two that were already there.
    expect(result.graph.nodes).toHaveLength(4);
    expect(result.graph.edges).toHaveLength(3);
    expect(nodeDegrees(result.graph)).toEqual([1, 2, 2, 1]);
  });

  it("splits whatever the new wall crosses, so the graph stays one a traversal can read", () => {
    const crossed = graphOf(
      [
        [0.5, 0.1],
        [0.5, 0.9],
      ],
      [[0, 1]],
    );
    const from = drawPoint(crossed, 0.1, 0.5, NEAR, false);
    const to = drawPoint(crossed, 0.9, 0.5, NEAR, false);
    const result = applyDraw(crossed, from, to)!;

    expect(result.splits).toBe(1);
    expect(describeDraw(result.splits, result.overlaps)).toBe(
      "drew a wall · split 1 wall at the crossing",
    );
    // The crossing is a real vertex now, met by four walls rather than passed through by two.
    const meeting = result.graph.nodes.findIndex((n) => n.x === documentPoint(0.5, 0.5).x && n.y === documentPoint(0.5, 0.5).y);
    expect(nodeDegrees(result.graph)[meeting]).toBe(4);
  });

  it("refuses a wall too short to see or to aim at", () => {
    /*
      From a room: two clicks in nearly the same place made a wall a few thousandths across, which is
      invisible and which the erase tool could barely be aimed at — a longer neighbour wins the
      nearest-wall query from almost anywhere near it.
    */
    const from = drawPoint(CORNER, 0.3, 0.4, 0, true);
    const to = drawPoint(CORNER, 0.3005, 0.4, 0, true);

    expect(applyDraw(CORNER, from, to, 0.01)).toBeNull();
    // The same two points with no floor asked for are a wall, so the floor is what refused it and
    // not some other degeneracy.
    expect(applyDraw(CORNER, from, to)).not.toBeNull();
  });

  it("allows a short wall when the view is zoomed in far enough to aim at one", () => {
    // The floor is a screen distance the caller converts, so zooming in to draw fine detail works.
    const from = drawPoint(CORNER, 0.3, 0.4, 0, true);
    const to = drawPoint(CORNER, 0.3005, 0.4, 0, true);

    expect(applyDraw(CORNER, from, to, 0.0001)).not.toBeNull();
  });

  it("adds nothing when both ends are the same place", () => {
    const loose = drawPoint(CORNER, 0.35, 0.4, NEAR, false);
    expect(applyDraw(CORNER, loose, loose)).toBeNull();

    // And when both ends snapped to the same existing vertex, which looks different and is not.
    const onNode = drawPoint(CORNER, 0.5, 0.2, NEAR, false);
    expect(applyDraw(CORNER, onNode, { ...onNode })).toBeNull();
  });

  it("says what it drew, and stays quiet when there is nothing to add", () => {
    expect(describeDraw(0, 0)).toBe("drew a wall");
    expect(describeDraw(2, 0)).toBe("drew a wall · split 2 walls at the crossing");
    expect(describeDraw(0, 1)).toBe("drew a wall · 1 wall lies along another");
  });
});

describe("finishing a drawn wall", () => {
  it("puts the wall down on the second click, which is the case that was broken", () => {
    // A room found this: two clicks armed the anchor and then silently re-placed it, for ever.
    expect(drawRelease(true, false)).toBe("finish");
  });

  it("puts it down on a drag that went somewhere, from either starting state", () => {
    expect(drawRelease(false, true)).toBe("finish");
    expect(drawRelease(true, true)).toBe("finish");
  });

  it("arms the first end when a press neither travelled nor followed one", () => {
    expect(drawRelease(false, false)).toBe("arm");
  });
});

describe("snapping to what is actually there", () => {
  it("ignores a vertex no wall uses, because nothing draws one", () => {
    /*
      From a room: erasing a few walls left their vertices behind — deliberately, since ids are the
      only stable identity here — and drawing nearby then caught on points that were not on screen.
      The layer skips them and this has to agree, because between them they are what "there is
      something here" means.
    */
    const orphaned = removeEdge(CORNER, 0).graph;

    expect(nodeDegrees(orphaned)[0]).toBe(0);
    expect(nearestNode(orphaned, { x: 0.2, y: 0.2 }, NEAR)).toBeNull();
    // Its other end is still in use by the second wall, so that one is still offered.
    expect(nearestNode(orphaned, { x: 0.5, y: 0.2 }, NEAR)).toBe(1);
  });

  it("keeps a drawn end from attaching to one either", () => {
    const orphaned = removeEdge(CORNER, 0).graph;

    expect(drawPoint(orphaned, 0.2, 0.2, NEAR, false).onNode).toBeNull();
  });
});

describe("erasing a wall", () => {
  it("finds the wall under the pointer by distance to the segment, not to its ends", () => {
    // The middle of the first wall, which is the part furthest from either of its vertices.
    expect(nearestEdge(CORNER, { x: 0.35, y: 0.2 }, NEAR)).toBe(0);
    expect(nearestEdge(CORNER, { x: 0.5, y: 0.35 }, NEAR)).toBe(1);
  });

  it("finds nothing out in the open, so a press there can still pan", () => {
    expect(nearestEdge(CORNER, { x: 0.3, y: 0.4 }, NEAR)).toBeNull();
  });

  it("removes one wall and leaves its vertices, since ids are the only stable identity", () => {
    const result = removeEdge(CORNER, 0);

    expect(result.graph.edges).toHaveLength(2);
    expect(result.graph.edges[0]).toEqual({ a: 1, b: 2 });
    // Node 0 now has no walls. It stays, because renumbering would invalidate every id held
    // elsewhere — and a vertex with no walls draws no handle and offers no snap.
    expect(result.graph.nodes).toHaveLength(5);
    expect(nodeDegrees(result.graph)[0]).toBe(0);
  });

  it("cannot break planarity, so it reports no splits and sweeps nothing", () => {
    const result = removeEdge(CORNER, 0);

    expect(result.splits).toBe(0);
    expect(result.overlaps).toBe(0);
  });

  it("leaves the graph alone when asked for a wall that is not there", () => {
    expect(removeEdge(CORNER, 9).graph).toBe(CORNER);
  });
});
