/**
 * Simplifying the whole document, which is the editor's version and destroys what it removes.
 *
 * The ink mode's simplification is a *fitting* parameter — turn it down and the detail comes back
 * from the reading. This has nothing to re-derive from, so the tests are about what it must refuse to
 * lose: junctions, and rooms.
 */

import { describe, expect, it } from "vitest";

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, nodeDegrees, wallRuns, type WallGraph } from "./wallGraph";
import { simplifyWalls } from "./planarOps";

function graphOf(
  points: readonly (readonly [number, number])[],
  edges: readonly (readonly [number, number])[],
): WallGraph {
  return {
    nodes: points.map(([x, y]) => documentPoint(x, y)),
    edges: edges.map(([a, b]) => ({ a, b })),
  };
}

const near = (a: Vector2, x: number, y: number): boolean =>
  Math.abs(a.x - x) < 1e-5 && Math.abs(a.y - y) < 1e-5;

describe("simplifyWalls", () => {
  it("returns the graph untouched when the tolerance is off", () => {
    const graph = graphOf(
      [
        [0, 0],
        [0.5, 0.01],
        [1, 0],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const result = simplifyWalls(graph, 0);
    expect(result.graph).toBe(graph);
    expect(result.removed).toBe(0);
  });

  it("drops a bend inside a run and keeps the run's ends", () => {
    const graph = graphOf(
      [
        [0, 0],
        [0.5, 0.01],
        [1, 0],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const result = simplifyWalls(graph, 0.1);
    expect(result.removed).toBe(1);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.nodes).toHaveLength(2);
  });

  /*
    The property that makes this safe without special-casing anything.

    A wall run is a chain through degree-2 vertices, so its ends are junctions or free ends by
    construction, and Douglas–Peucker keeps both ends of what it is handed. So a junction cannot be
    moved or removed however hard the fitting is pushed — which is what the faces are read from.
  */
  it("never removes a junction, however hard it is pushed", () => {
    const graph = graphOf(
      [
        [0, 0.5],
        [0.25, 0.51],
        [0.5, 0.5], // the junction
        [1, 0.5],
        [0.5, 1],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [2, 4],
      ],
    );
    const result = simplifyWalls(graph, 0.4);

    const degrees = nodeDegrees(result.graph);
    const junctions = result.graph.nodes.filter((_, id) => (degrees[id] ?? 0) >= 3);
    expect(junctions).toHaveLength(1);
    expect(near(junctions[0]!, 0.5, 0.5)).toBe(true);
  });

  /*
    A closed loop is the one run that CAN be fitted out of existence, because it starts and ends at
    the same vertex — so a tolerance larger than the loop collapses it to that point and the room it
    bounded disappears. Stage one has the same guard at the ring and gives the same answer: keep the
    unfitted version, because a room vanishing is worse than a coarse one.
  */
  it("keeps a room rather than fitting it away, and says it did", () => {
    const room = graphOf(
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );
    const result = simplifyWalls(room, 0.9);
    expect(result.preserved).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.graph.edges).toHaveLength(4);
    expect(wallRuns(result.graph)).toHaveLength(1);
  });

  /*
    The collapse threshold is **four, not three**, and the room above cannot show it — at 0.9 that
    square fits to two indices, which both thresholds preserve. This fits to *exactly three*: a
    closed run reduced to the repeat of its first vertex plus one other, which is a doubled line
    rather than a shape.

    **Not a rare case.** Over 174,156 wall runs of random graphs at six tolerances, 4,391 of the
    23,436 closed runs fitted to exactly three — 18.7% (2026-09-18). A threshold of three would turn
    every one of those rooms into a pair of coincident walls.
  */
  it("keeps a closed run that fits to exactly three points", () => {
    const spike = graphOf(
      [
        [0, 0],
        [1, 0],
        [0.5, 0.002],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    );
    const result = simplifyWalls(spike, 0.1);
    expect(result.preserved).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.graph.edges).toHaveLength(3);
    expect(wallRuns(result.graph)).toHaveLength(1);
  });

  /*
    Simplification can pull a wall across one that was clear of it — which pruning cannot, since
    deleting never breaks planarity. The rule is to let it split, so the result stays an embedding a
    face traversal can mean anything over.

    The dip in the first wall passes well above the second; flattening it puts it straight through.
  */
  it("splits a crossing that simplification created", () => {
    const graph = graphOf(
      [
        [0, 0.5],
        [0.5, 0.3],
        [1, 0.5],
        [0.5, 0.4],
        [0.5, 0.6],
      ],
      [
        [0, 1],
        [1, 2],
        [3, 4],
      ],
    );
    // Nothing crosses before: the dip reaches y=0.3 and the upright spans 0.4 to 0.6.
    expect(simplifyWalls(graph, 0).splits).toBe(0);

    // Flattened, the first wall runs along y=0.5, which is inside the upright.
    const result = simplifyWalls(graph, 0.3);
    expect(result.removed).toBe(1);
    expect(result.splits).toBeGreaterThan(0);
    // The cut lands on both, so the crossing point is a vertex of each.
    expect(nodeDegrees(result.graph).filter((degree) => degree === 4)).toHaveLength(1);
  });
});
