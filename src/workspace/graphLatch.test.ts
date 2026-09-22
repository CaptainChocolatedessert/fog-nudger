/**
 * The latch behind *Straighten*.
 *
 * The tests that matter are about **what must not commit**: a latch whose base has been replaced, a
 * handle that was never moved, and an amount carried over from a previous opening. Each of those would
 * destroy work silently, which is the whole reason this is a pure module rather than state inside a
 * drawer's event handler.
 *
 * Twelve mutations, twelve caught, while it carried Prune's amount too. Reduced to Straighten's alone
 * on 2026-09-22 and re-run: nine mutations, nine caught.
 */

import { describe, expect, it } from "vitest";

import { documentPoint, type WallGraph } from "../trace/wallGraph";
import { NO_LATCH, aimLatch, commitOf, openLatch, previewOf, revalidate } from "./graphLatch";

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
  it("pins the graph and starts the amount at zero", () => {
    const graph = squareGraph();
    const latch = openLatch(graph, false);
    expect(latch.base).toBe(graph);
    expect(latch.straighten).toBe(0);
    expect(latch.fromDerivation).toBe(false);
  });

  it("carries where the base came from, because the save needs it", () => {
    expect(openLatch(squareGraph(), true).fromDerivation).toBe(true);
  });

  it("pins nothing on a map with no walls", () => {
    expect(openLatch(null, false)).toEqual(NO_LATCH);
  });

  /*
    The ratchet's side door. Reopening must not inherit the amount, or the handle would sit describing
    work already applied and one nudge would apply it again to the new base.
  */
  it("does not inherit the amount from a previous opening", () => {
    const graph = squareGraph();
    expect(aimLatch(openLatch(graph, false), 0.02).straighten).toBe(0.02);
    expect(openLatch(graph, false).straighten).toBe(0);
  });
});

describe("aimLatch", () => {
  it("aims the handle", () => {
    expect(aimLatch(openLatch(squareGraph(), false), 0.04).straighten).toBe(0.04);
  });

  it("reads nonsense as off rather than refusing it", () => {
    const open = aimLatch(openLatch(squareGraph(), false), 0.04);
    expect(aimLatch(open, -1).straighten).toBe(0);
    expect(aimLatch(open, Number.NaN).straighten).toBe(0);
    expect(aimLatch(open, Number.POSITIVE_INFINITY).straighten).toBe(0);
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
    const latch = aimLatch(openLatch(graph, true), 0.01);
    expect(previewOf(latch)).toEqual({ base: graph, straighten: 0.01 });
    expect(commitOf(latch)).toEqual({ base: graph, straighten: 0.01, fromDerivation: true });
  });

  it("offers nothing when the handle was not moved", () => {
    const latch = openLatch(squareGraph(), false);
    expect(previewOf(latch)).toBeNull();
    expect(commitOf(latch)).toBeNull();
  });

  it("offers nothing once the latch is void", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), 0.04);
    expect(commitOf(revalidate(latch, squareGraph()))).toBeNull();
  });
});
