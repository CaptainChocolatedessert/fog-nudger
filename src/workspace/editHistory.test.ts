/**
 * What undo remembers, and — the part that matters — when it must forget.
 *
 * The pushing and popping are the obvious half and the cheap half. What is worth pinning is the
 * *staleness*: a snapshot describes the document as it was, and there are two events after which it
 * describes something the GM is no longer looking at. Restoring across either would put back walls
 * belonging to a different graph, and because a graph is stored in fractions of *a* map with nothing
 * in it saying which, that would not look wrong until it reached the scene.
 */

import { describe, expect, it } from "vitest";

import { EditHistory } from "./editHistory";

/** A stand-in document. Nothing in the history reads it, so a string is enough to tell states apart. */
const history = (depth = 20) => new EditHistory<string>(depth);

describe("EditHistory", () => {
  it("takes edits back newest first", () => {
    const h = history();
    h.push("a", "first", "ink");
    h.push("b", "second", "ink");

    expect(h.pop()).toEqual({ document: "b", label: "second", tag: "ink" });
    expect(h.pop()).toEqual({ document: "a", label: "first", tag: "ink" });
    expect(h.pop()).toBeNull();
  });

  it("remembers the state before the edit, not after it", () => {
    /*
      The direction is the whole of it, and getting it backwards is not obviously wrong from the
      inside: the first undo becomes a no-op and every later one restores the state before the one
      the GM meant. That reads as undo lagging by one, which invites being chased as a timing bug.
    */
    const h = history();
    h.push("before the erase", "erasing a wall", "ink");

    expect(h.peek()?.document).toBe("before the erase");
  });

  it("says what it would take back without taking it", () => {
    const h = history();
    h.push("a", "pruning the dead ends", "ink");

    expect(h.peek()?.label).toBe("pruning the dead ends");
    // Still there: the button asks on every repaint, and a peek that consumed would empty the stack
    // by being drawn.
    expect(h.peek()?.label).toBe("pruning the dead ends");
    expect(h.size).toBe(1);
  });

  it("has nothing to take back when nothing has been done", () => {
    const h = history();

    expect(h.peek()).toBeNull();
    expect(h.pop()).toBeNull();
    expect(h.size).toBe(0);
  });

  it("drops the oldest once it is full, and keeps the bound exactly", () => {
    // Without a bound an evening of editing holds every state it passed through. Dropping the oldest
    // is what makes the bound cost the thing a GM is least likely to reach for.
    const h = history(3);
    for (const n of ["a", "b", "c", "d", "e"]) h.push(n, n, "ink");

    expect(h.size).toBe(3);
    expect(h.pop()?.label).toBe("e");
    expect(h.pop()?.label).toBe("d");
    expect(h.pop()?.label).toBe("c");
    expect(h.pop()).toBeNull();
  });

  it("forgets everything when the document is replaced", () => {
    /*
      A derive and a map change are the same event in different clothes: the graph on screen is no
      longer the one these describe. Keeping them would offer to restore walls derived from ink the
      GM has since changed, or belonging to another map entirely.
    */
    const h = history();
    h.push("a", "drawing a wall", "ink");
    h.push("b", "erasing a wall", "ink");
    h.clear();

    expect(h.size).toBe(0);
    expect(h.peek()).toBeNull();
  });

  it("goes on working after being cleared", () => {
    // Clearing is an ordinary event — every derive does it — so the history has to be reusable
    // rather than spent. A GM re-reads the map and starts editing again in the same sitting.
    const h = history();
    h.push("a", "first", "ink");
    h.clear();
    h.push("b", "after the re-read", "ink");

    expect(h.size).toBe(1);
    expect(h.pop()).toEqual({ document: "b", label: "after the re-read", tag: "ink" });
  });

  it("forgets only the entries carrying the tag it was given", () => {
    /*
      **The fix for a real defect** (room, 2026-09-15): *"changing parameters on the walls shouldn't
      delete ink edits."* Discarding the wall graph cleared the whole stack, so agreeing that a wall
      setting may rebuild the walls also took away the GM's ability to undo a brush stroke — and the
      paint entries were perfectly good, describing a raster nothing in that path had touched.
    */
    const h = history();
    h.push("ink one", "drawing added ink", "ink");
    h.push("wall one", "erasing a wall", "walls");
    h.push("ink two", "drawing added ink", "ink");

    h.clear("walls");

    expect(h.size).toBe(2);
    expect(h.pop()?.document).toBe("ink two");
    expect(h.pop()?.document).toBe("ink one");
  });

  it("still forgets everything when given no tag", () => {
    // The wide answer is the default on purpose: a caller that forgets its tag loses history, where
    // one that clears too little leaves entries describing a document that no longer exists.
    const h = history();
    h.push("a", "drawing added ink", "ink");
    h.push("b", "erasing a wall", "walls");

    h.clear();

    expect(h.size).toBe(0);
  });
});
