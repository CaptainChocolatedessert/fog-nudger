import { describe, expect, it } from "vitest";

import { documentPoint, nodeDegrees, type FrozenGraph } from "../trace/frozenGraph";
import { applyDrag, describeEdit, dragTo, grabAt } from "./dragGesture";

function graphOf(points: readonly [number, number][], edges: readonly [number, number][]): FrozenGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

/** Two walls meeting at a corner, plus a third vertex a little way off. */
const CORNER = graphOf(
  [
    [0.2, 0.2],
    [0.5, 0.2],
    [0.5, 0.5],
    [0.55, 0.2],
  ],
  [
    [0, 1],
    [1, 2],
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
    // A move keeps both walls and both their ends; only the coordinate changed.
    expect(result.graph.edges).toHaveLength(2);
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
