/**
 * The GM's suppression marks for the map in hand: loaded with the map, saved on every change, undone
 * like any other act.
 *
 * **The third document the GM edits by hand**, beside the walls and the painted ink, and it follows
 * their rules rather than inventing its own. A change is written before the local state moves, so a
 * failed write leaves the GM with the marks the scene agrees with; one act is one entry on the one
 * undo stack; and loading another map starts from that map's marks with the history gone.
 *
 * **Not part of the walls**, which is the one thing that makes it a document of its own: marks
 * survive a rebuild of the walls (user, 2026-09-16), so nothing that discards the walls touches them
 * or their history, and placing one locks nothing. `trace/suppression.ts` says what a mark means.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { readRegionMarks, writeRegionMarks } from "../regionMarksStore";
import { pushUndo, type Restore } from "./undoHistory";

let marks: readonly Vector2[] = [];
let mapId: string | null = null;
const listeners: (() => void)[] = [];

/** The marks for the map in hand. Empty before the scene has been asked, which every caller treats alike. */
export function currentMarks(): readonly Vector2[] {
  return marks;
}

/** Told whenever the marks change — a load, a placement, a removal, an undo. */
export function onMarksChange(listener: () => void): void {
  listeners.push(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Read the scene's marks for a map. Reports whether something stored could not be read.
 *
 * Called after `loadStage`, which clears the undo stack for the new map, so there is no history here
 * to clear.
 */
export async function loadMarks(forMap: string | null): Promise<{ readonly corrupt: boolean }> {
  mapId = forMap;
  const read = await readRegionMarks(forMap);
  marks = read.marks;
  announce();
  return { corrupt: read.corrupt };
}

/**
 * Replace the marks with `next`, as one act the GM can undo.
 *
 * `label` finishes "Undo …" — *placing a mark*, *removing a mark*.
 */
export async function saveMarks(next: readonly Vector2[], label: string): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to mark");
  const before = marks;
  await writeRegionMarks(mapId, next);
  // After the write, so a failed one leaves nothing to undo back to.
  pushUndo(label, restoreTo(before), "marks");
  marks = next;
  announce();
}

/** The way back to a set of marks, which returns the way forward again for redo. */
function restoreTo(target: readonly Vector2[]): Restore {
  return async () => {
    if (!mapId) return;
    const leaving = marks;
    await writeRegionMarks(mapId, target);
    marks = target;
    announce();
    devLog("info", `marks: put back ${target.length}`);
    return restoreTo(leaving);
  };
}
