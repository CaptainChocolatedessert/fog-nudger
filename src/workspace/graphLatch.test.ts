/**
 * The latch behind the Walls drawer's two actions.
 *
 * The tests that matter are about **what must not commit**: a latch whose base has been replaced, a
 * handle that was never moved, and an amount carried over from a previous opening. Each of those would
 * destroy work silently, which is the whole reason this is a pure module rather than state inside a
 * drawer's event handler.
 *
 * Twelve mutations, twelve caught.
 */

import { describe, expect, it } from "vitest";

import { documentPoint, type WallGraph } from "../trace/wallGraph";
import {
  NO_LATCH,
  aimLatch,
  commitOf,
  labelFor,
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
  it("pins the graph and starts both amounts at zero", () => {
    const graph = squareGraph();
    const latch = openLatch(graph, false);
    expect(latch.base).toBe(graph);
    expect(latch.prune).toBe(0);
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
    The ratchet's side door. Reopening must not inherit either amount, or a handle would sit describing
    work already applied and one nudge would apply it again to the new base.
  */
  it("does not inherit an amount from a previous opening", () => {
    const graph = squareGraph();
    const aimed = aimLatch(aimLatch(openLatch(graph, false), "prune", 0.05), "straighten", 0.02);
    expect(aimed.prune).toBe(0.05);
    expect(aimed.straighten).toBe(0.02);
    const reopened = openLatch(graph, false);
    expect(reopened.prune).toBe(0);
    expect(reopened.straighten).toBe(0);
  });
});

describe("aimLatch", () => {
  it("aims each handle without disturbing the other", () => {
    const open = openLatch(squareGraph(), false);
    const pruned = aimLatch(open, "prune", 0.04);
    expect(pruned.prune).toBe(0.04);
    expect(pruned.straighten).toBe(0);
    const both = aimLatch(pruned, "straighten", 0.01);
    expect(both.prune).toBe(0.04);
    expect(both.straighten).toBe(0.01);
  });

  it("reads nonsense as off rather than refusing it", () => {
    const open = aimLatch(openLatch(squareGraph(), false), "prune", 0.04);
    expect(aimLatch(open, "prune", -1).prune).toBe(0);
    expect(aimLatch(open, "prune", Number.NaN).prune).toBe(0);
    expect(aimLatch(open, "prune", Number.POSITIVE_INFINITY).prune).toBe(0);
  });

  it("cannot arm a latch that holds no base", () => {
    expect(aimLatch(NO_LATCH, "straighten", 0.3)).toEqual(NO_LATCH);
  });
});

describe("revalidate", () => {
  it("keeps a latch whose base is still the current graph", () => {
    const graph = squareGraph();
    const latch = aimLatch(openLatch(graph, false), "prune", 0.02);
    expect(revalidate(latch, graph)).toBe(latch);
  });

  /*
    The rule the module exists for. An undo or a derive replaces the graph, and an operation computed
    against the old base would throw the replacement away without a word.
  */
  it("voids a latch when the graph has been replaced by an equal one", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), "prune", 0.02);
    const replacement = squareGraph();
    expect(latch.base).toEqual(replacement);
    expect(revalidate(latch, replacement)).toEqual(NO_LATCH);
  });

  it("voids a latch when the graph has gone entirely", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), "straighten", 0.02);
    expect(revalidate(latch, null)).toEqual(NO_LATCH);
  });

  it("leaves an empty latch alone", () => {
    expect(revalidate(NO_LATCH, squareGraph())).toBe(NO_LATCH);
  });
});

describe("previewOf and commitOf", () => {
  it("commit and preview agree, so the drawing cannot promise more than the commit does", () => {
    const graph = squareGraph();
    const latch = aimLatch(aimLatch(openLatch(graph, true), "prune", 0.04), "straighten", 0.01);
    expect(previewOf(latch)).toEqual({ base: graph, prune: 0.04, straighten: 0.01 });
    expect(commitOf(latch)).toEqual({
      base: graph,
      prune: 0.04,
      straighten: 0.01,
      fromDerivation: true,
    });
  });

  it("offers something when only one handle has moved", () => {
    const graph = squareGraph();
    expect(previewOf(aimLatch(openLatch(graph, false), "prune", 0.04))).not.toBeNull();
    expect(previewOf(aimLatch(openLatch(graph, false), "straighten", 0.04))).not.toBeNull();
  });

  it("offers nothing when neither handle was moved", () => {
    const latch = openLatch(squareGraph(), false);
    expect(previewOf(latch)).toBeNull();
    expect(commitOf(latch)).toBeNull();
  });

  it("offers nothing once the latch is void", () => {
    const latch = aimLatch(openLatch(squareGraph(), false), "prune", 0.04);
    expect(commitOf(revalidate(latch, squareGraph()))).toBeNull();
  });
});

describe("labelFor", () => {
  /*
    The undo button prints this, and the whole reason it does is that a GM has just done something whose
    effect they misjudged — so a label naming an operation that did not run is worse than none.
  */
  it("names only the operations that will run", () => {
    const open = openLatch(squareGraph(), false);
    expect(labelFor(aimLatch(open, "prune", 0.04))).toBe("pruning the dead ends");
    expect(labelFor(aimLatch(open, "straighten", 0.04))).toBe("straightening the walls");
    expect(labelFor(aimLatch(aimLatch(open, "prune", 0.04), "straighten", 0.01))).toBe(
      "tidying the walls",
    );
  });
});
