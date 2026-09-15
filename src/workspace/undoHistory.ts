/**
 * One undo stack for both documents the GM edits by hand: the wall graph, and the painted ink.
 *
 * ## Why one stack — user, 2026-09-13
 *
 * It held the graph alone, and the record's stated reason was that "the paint layers are a raster
 * document with their own Discard and Clear. A stroke-level undo for those is a different mechanism
 * against a different document." A room asked the obvious question — *"Why wouldn't undo cover ink
 * edits, too?"* — and the answer is that a GM expects one Undo that takes back the last thing they
 * did, whatever it was. Two histories with different names is the tool's structure showing through.
 *
 * ## An entry is a label and a way back, not a document
 *
 * The stack holds **closures**, so it does not need to know what kind of thing it is restoring. Each
 * owner knows how to put its own document back — `stage.ts` writes a graph to the scene, `paintTool`
 * puts a raster back and asks for a re-read — and neither has to be reachable from here. That is what
 * keeps this module free of both of them, and so free of the import cycle a union type would have
 * forced: the graph's owner would have had to import the paint's, or a third module would have had to
 * import both and be imported by both.
 *
 * The snapshot itself is captured by the caller *before* the edit, which is the same contract the
 * graph half always had.
 *
 * ## Why nothing here needs a confirmation
 *
 * Mixing the two raised the question of an undo that loses downstream work — undoing a stroke changes
 * what counts as ink, and walls are derived from ink. It cannot arise, and the reason is structural
 * rather than careful:
 *
 * - The stack is **cleared** when walls are saved from the Walls step, and when the map changes. So
 *   everything on it happened since the last save.
 * - Undo is **last in, first out**, so it always returns to a state that actually existed.
 * - Undoing a stroke changes the *preview* partition. The **saved** graph is replaced only by a save,
 *   which is the thing that cleared the stack in the first place.
 *
 * If that clearing rule is ever relaxed, this paragraph stops being true and a confirmation becomes
 * the thing that replaces it.
 */

import { EditHistory } from "./editHistory";

/**
 * How many acts can be taken back.
 *
 * The same twenty the graph alone had. A paint snapshot is run-length encoded rather than a raw
 * raster — an untouched layer is a single run and ordinary brushwork is a couple of runs a row — so
 * covering a second document does not cost what the raw size of a raster would suggest.
 */
const DEPTH = 20;

/**
 * Puts one document back as it was, and hands back the way to the state it just left.
 *
 * **That return value is the whole of redo.** An owner is the only thing that knows how to snapshot
 * its own document, so rather than the stack learning two tricks per kind of edit, a restore takes
 * its own snapshot on the way past and returns a restore for it. Undo pushes what comes back onto the
 * redo stack; redo does the same in reverse, which is what makes the two symmetrical rather than two
 * implementations that have to agree.
 *
 * Returning nothing means this act cannot be gone forward into again — the paint half says so when
 * there is no layer to snapshot — and the entry is simply not offered.
 */
export type Restore = () => Promise<Restore | void> | Restore | void;

const history = new EditHistory<Restore>(DEPTH);
/**
 * The acts undone, newest last, waiting to be done again.
 *
 * The same depth, because the two can only trade entries: every redo entry came off the undo stack
 * and goes back onto it when taken.
 */
const redo = new EditHistory<Restore>(DEPTH);
const listeners: (() => void)[] = [];

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Told whenever what undo would take back has changed.
 *
 * The button needs it: pushes now come from two places, and it used to repaint on a stage change
 * alone — which a stroke is not.
 */
export function onUndoChange(listener: () => void): void {
  listeners.push(listener);
}

/**
 * Remember how to take one act back.
 *
 * `label` finishes the sentence "Undo …", so it names the act rather than the document: *pruning the
 * dead ends*, *drawing added ink*. A bare "Undo" asks a GM to remember what they just did, which is
 * exactly what someone who has misjudged an effect cannot do.
 */
export function pushUndo(label: string, restore: Restore, tag: string): void {
  history.push(restore, label, tag);
  /*
    A new act abandons the forward history, which is the ordinary rule everywhere and is worth stating
    because the alternative is worse than it sounds: keeping it would offer to redo an act on top of a
    document that has moved since, and the snapshot it holds describes a state that no longer follows
    from anything on screen.
  */
  redo.clear();
  announce();
}

/** What undoing would take back, or `null` when there is nothing. */
export function undoLabel(): string | null {
  return history.peek()?.label ?? null;
}

/**
 * Take the last act back.
 *
 * **Popped only after the restore succeeds**, which is the rule the graph half already followed: a
 * failed scene write must leave the entry in place to try again rather than silently consuming the
 * one state that could have been restored.
 */
export async function undoLast(): Promise<string | null> {
  const entry = history.peek();
  if (!entry) return null;

  const forward = await entry.document();
  history.pop();
  if (forward) redo.push(forward, entry.label, entry.tag);
  announce();
  return entry.label;
}

/** What redoing would do again, or `null` when there is nothing. */
export function redoLabel(): string | null {
  return redo.peek()?.label ?? null;
}

/**
 * Do the last undone act again.
 *
 * The mirror of `undoLast`, down to the failure rule: the entry stays put unless the restore returns,
 * so a refused scene write leaves something to try again rather than losing the way forward. What
 * comes back goes onto the **undo** stack directly rather than through `pushUndo`, because this is
 * not a new act and must not abandon the rest of the forward history.
 */
export async function redoLast(): Promise<string | null> {
  const entry = redo.peek();
  if (!entry) return null;

  const back = await entry.document();
  redo.pop();
  if (back) history.push(back, entry.label, entry.tag);
  announce();
  return entry.label;
}

/**
 * Forget everything, because the documents these describe are no longer the ones on screen.
 *
 * Three events, and they are the same event in different clothes: **saving the derived walls**
 * replaces the graph with a fresh function of the ink, **loading another map** replaces both
 * documents, and **the raster changing** abandons the open paint mode, which leaves every snapshot
 * describing a layer at a size that no longer exists.
 */
/**
 * Forget what can no longer be restored — all of it, or only one document's.
 *
 * **Discarding the wall graph used to clear the lot**, which took the GM's brush strokes off the
 * history because they agreed to a wall setting rebuilding the walls (room, 2026-09-15). The
 * paint entries were still perfectly good: they describe a raster nothing in that path touched.
 *
 * The rule this relaxes is a real one — *the stack is cleared when the graph is replaced, and
 * that is what makes undoing a stroke safe without a confirmation* — so it is worth saying why
 * the narrower version is still safe. Undo is last-in-first-out, so it always returns to a state
 * that existed; and undoing a stroke moves the **preview**, where the stored graph is replaced
 * only by a derive or a push. After a discard there is no stored graph at all, so there is
 * nothing for a restored stroke to disagree with.
 */
export function clearUndo(tag?: string): void {
  history.clear(tag);
  redo.clear(tag);
  announce();
}

/** How many acts could be taken back. */
export function undoDepth(): number {
  return history.size;
}

/** How many acts could be done again. */
export function redoDepth(): number {
  return redo.size;
}
