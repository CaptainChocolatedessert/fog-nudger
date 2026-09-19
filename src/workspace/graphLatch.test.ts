/**
 * The latch behind an action with an amount.
 *
 * The tests that matter are about **what must not commit**: a latch whose base has been replaced, a
 * handle that was never moved, and an amount carried over from a previous opening. Each of those
 * would destroy work silently, which is the whole reason this is a pure module rather than state
 * inside a drawer's event handler.
 *
 * Nine mutations, nine caught.
 */

import { describe, expect, it } from "vitest";

import { documentPoint, type WallGraph } from "../trace/wallGraph";
import {
  NO_LATCH,
  aimLatch,
  commitOf,
  openLatch,
  previewOf,
  revalidate,
} from "./graphLatch";

/*
  Two graphs that are **equal and distinct**, which is the pair the staleness rule turns on: an edit
  replaces the graph wholesale, so a replacement that happens to hold the same walls is still a
  replacement, and a latch pinned to the old object must not commit over it.
*/
function squareGraph(): WallGraph {
  return {
    nodes: [documentPoint(0, 0), documentPoint(1, 0), documentPoint(1, 1)],
    edges: [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ],
  };
}

describe("openLatch", () => {
  it("latches the graph and starts the amount at zero", () => {
    const graph = squareGraph();
    const latch = openLatch(graph, false);
    expect(latch.base).toBe(graph);
    expect(latch.amount).toBe(0);
    expect(latch.fromDerivation).toBe(false);
  });

  it("carries where the base came from, because the save needs it", () => {
    expect(openLatch(squareGraph(), true).fromDerivation).toBe(true);
  });

  it("latches nothing on a map with no walls", () => {
    expect(openLatch(null, false)).toEqual(NO_LATCH);
  });

  /*
    The ratchet's side door. Reopening must not inherit the last amount, or the handle would sit
    describing work already applied and one nudge would apply it again to the new base.
  */
  it("does not inherit an amount from a previous opening", () => {
    const graph = squareGraph();
    const aimed = aimLatch(openLatch(graph, false), 0.05);
    expect(aimed.amount).toBe(0.05);
    expect(openLatch(graph, false).amount).toBe(0);
  });
});

describe("aimLatch", () => {
  it("takes a positive amount", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), 0.02);
    expect(latch.amount).toBe(0.02);
  });

  it("reads nonsense as off rather than refusing it", () => {
    const open = openLatch(squareGraph(), false);
    expect(aimLatch(open, -1).amount).toBe(0);
    expect(aimLatch(open, Number.NaN).amount).toBe(0);
    expect(aimLatch(open, Number.POSITIVE_INFINITY).amount).toBe(0);
  });

  it("cannot arm a latch that holds no base", () => {
    expect(aimLatch(NO_LATCH, 0.3)).toEqual(NO_LATCH);
  });
});

describe("revalidate", () => {
  it("keeps a latch whose base is still the current graph", () => {
    const graph = squareGraph();
    const latch = aimLatch(openLatch(graph, false), 0.02);
    expect(revalidate(latch, graph)).toBe(latch);
  });

  /*
    The rule the module exists for. An undo or a derive replaces the graph, and an operation computed
    against the old base would throw the replacement away without a word.
  */
  it("voids a latch when the graph has been replaced by an equal one", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), 0.02);
    const replacement = squareGraph();
    expect(latch.base).toEqual(replacement);
    expect(revalidate(latch, replacement)).toEqual(NO_LATCH);
  });

  it("voids a latch when the graph has gone entirely", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), 0.02);
    expect(revalidate(latch, null)).toEqual(NO_LATCH);
  });

  it("leaves an empty latch alone", () => {
    expect(revalidate(NO_LATCH, squareGraph())).toBe(NO_LATCH);
  });
});

describe("previewOf and commitOf", () => {
  it("commit and preview agree, so the drawing cannot promise more than the commit does", () => {
    const graph = squareGraph();
    const latch = aimLatch(openLatch(graph, true), 0.04);
    expect(previewOf(latch)).toEqual({ base: graph, amount: 0.04 });
    expect(commitOf(latch)).toEqual({ base: graph, amount: 0.04, fromDerivation: true });
  });

  it("offers nothing when the handle was never moved", () => {
    const latch = openLatch(squareGraph(), false);
    expect(previewOf(latch)).toBeNull();
    expect(commitOf(latch)).toBeNull();
  });

  it("offers nothing once the latch is void", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), 0.04);
    const stale = revalidate(latch, squareGraph());
    expect(commitOf(stale)).toBeNull();
  });
});
