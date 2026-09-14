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

/** Puts one document back as it was. May write to the scene, so it may be slow. */
export type Restore = () => Promise<void> | void;

const history = new EditHistory<Restore>(DEPTH);
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
export function pushUndo(label: string, restore: Restore): void {
  history.push(restore, label);
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

  await entry.document();
  history.pop();
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
export function clearUndo(): void {
  history.clear();
  announce();
}

/** How many acts could be taken back. */
export function undoDepth(): number {
  return history.size;
}
