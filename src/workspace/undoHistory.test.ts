/**
 * The shared undo stack: what it would take back, and what happens when taking it back fails.
 *
 * `editHistory` is tested on its own for the stack mechanics — ordering, the depth bound, a peek
 * that does not consume. What is tested here is the half that was added when the ink joined the
 * graph on one stack: that an entry is a **way back** rather than a document, that a failed restore
 * leaves the entry in place, and that anything changing what undo would do says so.
 *
 * Mutation-tested: seven mutations, seven caught — popping before the restore runs, not awaiting
 * it at all, the announcements dropped one at a time, and an empty stack claiming an undo.
 *
 * Module state is a singleton, so every case clears first — the surface has exactly one stack and
 * pretending otherwise here would test something that does not exist.
 *
 * Pure: no DOM, no SDK.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearUndo, onUndoChange, pushUndo, undoDepth, undoLabel, undoLast } from "./undoHistory";

beforeEach(() => {
  clearUndo();
});

describe("the shared undo stack", () => {
  it("has nothing to take back when it is empty", async () => {
    expect(undoLabel()).toBeNull();
    expect(await undoLast()).toBeNull();
  });

  it("names the most recent act, whichever document it belongs to", () => {
    pushUndo("drawing added ink", () => {});
    pushUndo("pruning the dead ends", () => {});
    // The button finishes the sentence "Undo …", so the newest act is what it must name.
    expect(undoLabel()).toBe("pruning the dead ends");
  });

  it("runs the way back and takes the entry off", async () => {
    const order: string[] = [];
    pushUndo("drawing added ink", () => void order.push("ink"));
    pushUndo("erasing a wall", () => void order.push("wall"));

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
    });

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
    });

    await expect(undoLast()).rejects.toThrow("the scene refused the write");
    expect(undoLabel()).toBe("erasing a wall");
    expect(undoDepth()).toBe(1);
  });

  it("tells listeners whenever what undo would do changes", async () => {
    // The button used to repaint on a *graph* event, which a brush stroke is not. Pushing, undoing
    // and clearing all move what the button should say, so all three announce.
    const heard = vi.fn();
    onUndoChange(heard);

    pushUndo("drawing added ink", () => {});
    expect(heard).toHaveBeenCalledTimes(1);

    await undoLast();
    expect(heard).toHaveBeenCalledTimes(2);

    pushUndo("erasing a wall", () => {});
    clearUndo();
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it("forgets everything when the documents it describes are replaced", () => {
    // Saving the derived walls, loading another map, or the raster changing under an open paint
    // mode. Each leaves every entry describing something that is no longer on screen.
    pushUndo("drawing added ink", () => {});
    pushUndo("erasing a wall", () => {});
    clearUndo();
    expect(undoLabel()).toBeNull();
    expect(undoDepth()).toBe(0);
  });

  it("keeps the newest twenty and drops the oldest", () => {
    for (let i = 0; i < 25; i += 1) pushUndo(`edit ${i}`, () => {});
    expect(undoDepth()).toBe(20);
    expect(undoLabel()).toBe("edit 24");
  });
});
