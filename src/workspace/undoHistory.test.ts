/**
 * The shared undo stack: what it would take back, and what happens when taking it back fails.
 *
 * `editHistory` is tested on its own for the stack mechanics — ordering, the depth bound, a peek
 * that does not consume. What is tested here is the half that was added when the ink joined the
 * graph on one stack: that an entry is a **way back** rather than a document, that a failed restore
 * leaves the entry in place, and that anything changing what undo would do says so.
 *
 * Mutation-tested, sixteen mutations and sixteen caught, in two rounds. The backward half: popping
 * before the restore runs, not awaiting it at all, the announcements dropped one at a time, an empty
 * stack claiming an undo. The forward half: a new act failing to abandon the forward history, undo
 * not offering the act to redo, redo pushed back through the front door so it cleared the entries
 * behind it, redo popped before its restore, a clear leaving one stack behind, and an act with no way
 * forward offered anyway.
 *
 * **Two of those survived their first pass**, and both because a test was weaker than its name: one
 * never awaited the undo it was clearing after, so it passed against a clear that emptied one stack.
 *
 * Module state is a singleton, so every case clears first — the surface has exactly one stack and
 * pretending otherwise here would test something that does not exist.
 *
 * Pure: no DOM, no SDK.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearUndo,
  onUndoChange,
  pushUndo,
  redoDepth,
  redoLabel,
  redoLast,
  undoDepth,
  undoLabel,
  undoLast,
  type Restore,
} from "./undoHistory";

beforeEach(() => {
  clearUndo();
});

describe("the shared undo stack", () => {
  it("has nothing to take back when it is empty", async () => {
    expect(undoLabel()).toBeNull();
    expect(await undoLast()).toBeNull();
  });

  it("names the most recent act, whichever document it belongs to", () => {
    pushUndo("drawing added ink", () => {}, "ink");
    pushUndo("pruning the dead ends", () => {}, "walls");
    // The button finishes the sentence "Undo …", so the newest act is what it must name.
    expect(undoLabel()).toBe("pruning the dead ends");
  });

  it("runs the way back and takes the entry off", async () => {
    const order: string[] = [];
    pushUndo("drawing added ink", () => void order.push("ink"), "ink");
    pushUndo("erasing a wall", () => void order.push("wall"), "walls");

    expect(await undoLast()).toBe("erasing a wall");
    expect(order).toEqual(["wall"]);
    expect(undoLabel()).toBe("drawing added ink");

    expect(await undoLast()).toBe("drawing added ink");
    expect(order).toEqual(["wall", "ink"]);
    expect(undoLabel()).toBeNull();
  });

  it("waits for a restore that takes time before considering it done", async () => {
    /*
      A graph restore writes to the scene, which is a round trip. Popping before it resolved would
      let a second undo start against a document the first has not finished putting back.

      **Held open by a gate the test releases**, rather than by a promise that settles on the next
      microtask: awaiting `undoLast()` yields one anyway, so a version that never awaited the restore
      at all still looked correct. The mutation that dropped the `await` survived until this asked
      what the stack looked like *while* the restore was in flight.
    */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    pushUndo("pruning the dead ends", async () => {
      await gate;
      finished = true;
    }, "walls");

    const undoing = undoLast();
    expect(finished).toBe(false);
    expect(undoDepth()).toBe(1);

    release();
    expect(await undoing).toBe("pruning the dead ends");
    expect(finished).toBe(true);
    expect(undoDepth()).toBe(0);
  });

  it("keeps the entry when the way back fails", async () => {
    /*
      **The rule the graph half already followed**, and the reason it is worth having: a scene write
      can fail, and consuming the entry would throw away the one state that could have been restored.
      Leaving it means the GM can press Undo again.
    */
    pushUndo("erasing a wall", () => {
      throw new Error("the scene refused the write");
    }, "walls");

    await expect(undoLast()).rejects.toThrow("the scene refused the write");
    expect(undoLabel()).toBe("erasing a wall");
    expect(undoDepth()).toBe(1);
  });

  it("tells listeners whenever what undo would do changes", async () => {
    // The button used to repaint on a *graph* event, which a brush stroke is not. Pushing, undoing
    // and clearing all move what the button should say, so all three announce.
    const heard = vi.fn();
    onUndoChange(heard);

    pushUndo("drawing added ink", () => {}, "ink");
    expect(heard).toHaveBeenCalledTimes(1);

    await undoLast();
    expect(heard).toHaveBeenCalledTimes(2);

    pushUndo("erasing a wall", () => {}, "walls");
    clearUndo();
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it("forgets everything when the documents it describes are replaced", () => {
    // Saving the derived walls, loading another map, or the raster changing under an open paint
    // mode. Each leaves every entry describing something that is no longer on screen.
    pushUndo("drawing added ink", () => {}, "ink");
    pushUndo("erasing a wall", () => {}, "walls");
    clearUndo();
    expect(undoLabel()).toBeNull();
    expect(undoDepth()).toBe(0);
  });

  it("keeps the newest twenty and drops the oldest", () => {
    for (let i = 0; i < 25; i += 1) pushUndo(`edit ${i}`, () => {}, "walls");
    expect(undoDepth()).toBe(20);
    expect(undoLabel()).toBe("edit 24");
  });
});

describe("going forward again", () => {
  /**
   * A step that moves a value and hands back the step that moves it back.
   *
   * The shape every real owner has: a graph restore writes the old graph and returns one that writes
   * what it replaced; a paint restore does the same with a snapshot. Modelled here with a box, so the
   * test can say *where the document ended up* rather than only which closure ran.
   */
  function step(box: { value: string }, to: string): Restore {
    return function move(): Restore {
      const leaving = box.value;
      box.value = to;
      return step(box, leaving);
    };
  }

  it("offers nothing to redo until something has been undone", () => {
    expect(redoLabel()).toBeNull();
    pushUndo("drawing added ink", () => {}, "ink");
    expect(redoLabel()).toBeNull();
  });

  it("takes an undone act forward again, and leaves it undoable", async () => {
    const box = { value: "after" };
    pushUndo("drawing added ink", step(box, "before"), "ink");

    await undoLast();
    expect(box.value).toBe("before");
    expect(redoLabel()).toBe("drawing added ink");

    expect(await redoLast()).toBe("drawing added ink");
    expect(box.value).toBe("after");
    // Back on the undo stack rather than consumed, so the pair can be walked in both directions.
    expect(undoLabel()).toBe("drawing added ink");
    expect(redoLabel()).toBeNull();
  });

  it("walks a run of acts back and forward in order", async () => {
    const box = { value: "third" };
    pushUndo("first", step(box, "start"), "walls");
    pushUndo("second", step(box, "first"), "walls");
    pushUndo("third", step(box, "second"), "walls");

    await undoLast();
    await undoLast();
    expect(box.value).toBe("first");
    expect(redoDepth()).toBe(2);

    await redoLast();
    expect(box.value).toBe("second");
    await redoLast();
    expect(box.value).toBe("third");
    expect(redoDepth()).toBe(0);
    expect(undoDepth()).toBe(3);
  });

  it("abandons the forward history when a new act happens", async () => {
    /*
      The ordinary rule, and worth pinning because the alternative is worse than it sounds: keeping it
      would offer to redo an act on top of a document that has moved since, from a snapshot that no
      longer follows from anything on screen.
    */
    const box = { value: "after" };
    pushUndo("drawing added ink", step(box, "before"), "ink");
    await undoLast();
    expect(redoDepth()).toBe(1);

    pushUndo("erasing a wall", () => {}, "walls");
    expect(redoDepth()).toBe(0);
    expect(redoLabel()).toBeNull();
  });

  it("does not abandon the rest of the forward history when redoing", async () => {
    // A redo is not a new act. Putting it back through the front door would clear the entries behind
    // it, so redoing one of three would silently lose the other two.
    const box = { value: "third" };
    pushUndo("first", step(box, "start"), "walls");
    pushUndo("second", step(box, "first"), "walls");
    pushUndo("third", step(box, "second"), "walls");
    await undoLast();
    await undoLast();
    await undoLast();
    expect(redoDepth()).toBe(3);

    await redoLast();
    expect(redoDepth()).toBe(2);
  });

  it("keeps the entry when going forward fails", async () => {
    const box = { value: "after" };
    pushUndo("drawing added ink", step(box, "before"), "ink");
    await undoLast();

    // Replace the forward step with one that refuses, the way a scene write can.
    clearUndo();
    pushUndo("erasing a wall", () => () => {
      throw new Error("the scene refused the write");
    }, "walls");
    await undoLast();

    await expect(redoLast()).rejects.toThrow("the scene refused the write");
    expect(redoLabel()).toBe("erasing a wall");
    expect(redoDepth()).toBe(1);
  });

  it("waits for a forward step that takes time", async () => {
    // The mirror of undo's gate: popped only once the restore has finished, so a second press cannot
    // start against a document the first has not put back.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pushUndo("pruning the dead ends", () => async () => {
      await gate;
    }, "walls");
    await undoLast();

    const redoing = redoLast();
    expect(redoDepth()).toBe(1);
    release();
    expect(await redoing).toBe("pruning the dead ends");
    expect(redoDepth()).toBe(0);
  });

  it("forgets the forward history when the documents are replaced", async () => {
    // Saving the derived walls clears both stacks: a forward step describes a graph the save has just
    // replaced, which is the same reason the backward ones go.
    //
    // The undo is **awaited**: unawaited, the forward step had not been pushed yet when the clear
    // ran, so this passed against a clear that only emptied one stack.
    pushUndo("drawing added ink", () => () => {}, "ink");
    await undoLast();
    expect(redoDepth()).toBe(1);

    clearUndo();
    expect(redoLabel()).toBeNull();
    expect(redoDepth()).toBe(0);
  });

  it("does not offer an act that cannot be gone forward into", async () => {
    // A restore returning nothing means its owner could not snapshot what it was replacing — the
    // paint half says so when there is no layer in hand. Offering it would be a button that declines.
    pushUndo("drawing added ink", () => {}, "ink");
    await undoLast();
    expect(redoLabel()).toBeNull();
    expect(redoDepth()).toBe(0);
  });
});
