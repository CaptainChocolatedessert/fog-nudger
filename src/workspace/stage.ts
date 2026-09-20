/**
 * The wall graph: reading it for a map, and writing it.
 *
 * ## It stopped being a "stage" when the surface became two modes — 2026-09-05
 *
 * This file used to own a one-way door. Stage one was the map and stage two was the graph, one
 * accordion carried both, and crossing back **discarded** the graph — which is what removed the
 * identity problem in storing a move, since nothing was ever re-derived behind an edit.
 *
 * The modes keep the property and drop the door. The wall editor never re-derives, so nothing is
 * renumbered behind an edit; and the ink mode never *reads* the stored graph, so being in it costs
 * nothing. What is left here is a stored document with a map beside it: read it, write it, and tell
 * whoever draws it when it changed.
 *
 * ## The stored graph's presence is still what says whether there is anything to edit
 *
 * There is no flag, deliberately. A flag is a second statement of the same fact and can disagree
 * with the first; a graph either is in the scene or is not. `wallGraphStore.ts` says the same
 * thing from the other end.
 *
 * ## Two ways to discard it, and the difference is the undo history
 *
 * This header used to say nothing here discards the graph at all — that removing it belongs to the
 * panel, beside the button that takes our fog out of the scene (user, 2026-09-05). Both halves have
 * since stopped being true, and the note outlived them.
 *
 * - **`discardWalls`** is consent to *regenerate*: the GM has agreed that a reading change may
 *   rebuild the walls. The history goes with the graph, because its snapshots describe a document
 *   derived from ink that has just moved.
 * - **`clearWallEdits`** is *Clear wall edits*, a press aimed at the graph and nothing else. Nothing
 *   upstream has moved, so the document is put on the stack and one undo brings it back.
 *
 * Neither is *Clear everything*, which is still the panel's and still reaches the whole scene.
 *
 * No DOM.
 */

import { devLog } from "../devlog";
import {
  clearWallGraph,
  readWallGraph,
  writeCommittedWalls,
  writeDerivedWalls,
  writeWallGraph,
} from "../wallGraphStore";
import type { WallGraph } from "../trace/wallGraph";
import { graphsDiffer } from "../trace/wallGraphDiff";
import { clearUndo, pushUndo, type Restore } from "./undoHistory";

let saved: WallGraph | null = null;
let base: WallGraph | null = null;
const listeners: (() => void)[] = [];

/*
  `handEdits` and `derivedBase` were here, and both went in the review of 2026-09-14.

  The **count** was how this file priced a re-derive: a number the surface showed, and the thing the
  discard prompt asked. `wallsEdited` replaced every read of it — comparing the document against the
  trace that made it answers the same question from two things that are both in the scene, where the
  count lived in memory and so could not survive a session. Once the last reader went the count was a
  second statement of a fact the graphs already carry, which is the arrangement this file's own
  header warns about.

  `derivedBase` was the accessor the delta drawing will want. It came back on 2026-09-15 when the
  delta drawing did — one line, written again, exactly as that note expected.
*/

/**
 * The trace's own version of these walls, which the document was made from.
 *
 * **One caller, and it wants it to draw the difference**: what a regenerate would take away and
 * what it would bring back. Everything else asks `wallsEdited`, which is this same comparison
 * reduced to a yes or no — so the base is exposed rather than the delta, and the module that
 * draws it owns how the two graphs are compared.
 */
export function derivedBase(): WallGraph | null {
  return base;
}

/**
 * Whether the graph in hand still is what the trace derived.
 *
 * **The one question this surface asks about hand editing**, and three things read it: the mark on
 * the groups whose controls would rebuild the walls, the prompt that prices a rebuild, and the
 * predicate deciding which graph is on screen. One answer for all three is the point — they
 * disagreeing is a defect this project has already paid for.
 *
 * It is a comparison rather than a count, and both sides are in the scene, so it is still true when
 * the GM comes back tomorrow. A count could not be: it lived in memory, so a map edited last week
 * opened at zero and wore no mark at exactly the moment one was most needed.
 */
export function wallsEdited(): boolean {
  return graphsDiffer(base, saved);
}

/*
  The stack lives in `undoHistory.ts` now, shared with the painted ink (user, 2026-09-13).

  **Undo exists because the boundary that used to make this unnecessary is gone.** While the reading
  controls and the editing tools were separate pages, wall edits could not be destroyed by accident;
  on one surface they can, and the count plus its warning only help a GM *predict*. Nothing helped
  with a judgement that looked right and was not — pruning at a limit that seemed fine and taking a
  wall you wanted had no route back but regenerating and losing everything.

  Snapshots rather than inverse operations. The graph is tens of kilobytes and every edit already
  replaces it wholesale, so keeping the old one costs almost nothing and cannot disagree with what an
  inverse would have reconstructed.

  What this file owns is the graph and the base beside it. **Whether the GM has edited is derived
  from those two rather than counted**, so there is no second number that can disagree with them.
*/

/**
 * The stored document, or `null` for "nothing is stored and the walls are a derivation".
 *
 * **`null` is a state undo has to be able to return to**, which is the whole reason this is a shape
 * rather than a bare graph. Both halves move together on a first edit — the graph appears and the
 * base appears under it — so a way back that put only the graph right would leave a base describing
 * a document that is no longer there.
 */
interface Stored {
  readonly graph: WallGraph;
  /** The derivation `graph` was made from, or `null` for a graph stored before bases existed. */
  readonly base: WallGraph | null;
}

/** The document as it stands, for an edit to hand to undo as the way back. */
function stored(): Stored | null {
  return saved ? { graph: saved, base } : null;
}

/**
 * Put the document back as it was before one edit — including back to not existing.
 *
 * Handed to `undoHistory` as the way back from a wall edit. Writes to the scene like any other edit,
 * because the graph is stored there — undo is a change to the document rather than a view of it.
 *
 * ## It took a graph, and so could not express the first edit — room, 2026-09-15
 *
 * The first hand edit on a map is the one that *creates* the document: before it the surface is
 * showing a derivation and the scene holds nothing. `saveEditedWalls` pushed an entry only when
 * there was already a graph to go back to, so **that edit went on the scene with nothing on the
 * stack describing it** — and a GM pressing undo straight afterwards watched their wall edit stay
 * exactly where it was while the press reached past it into whatever was below. Which, on a shared
 * stack, was a brush stroke: *"sometimes I thought undo wasn't working, so I probably clicked
 * multiple times"*, and four clicks took 1,795 pixels of painted ink off a map.
 *
 * Nothing was missing from the store to make this expressible — `clearWallGraph` already removes
 * both keys, which is exactly the state a first edit leaves behind it. What was missing was a way to
 * *say* it: a `WallGraph` has no value meaning "there is no graph".
 *
 * **Undoing every edit puts the mark out by itself**, with nothing here to decrement: once the graph
 * matches the base again — or both are gone — `wallsEdited` simply says no. That is what the
 * comparison buys over a counter: there is no running total to keep honest across undo and redo.
 */
function restoreTo(next: Stored | null): Restore {
  return async () => {
    if (!mapId) return;
    const leaving = stored();
    if (!next) {
      await clearWallGraph();
    } else if (next.base && next.base !== base) {
      // The base moves only across a first edit, in either direction. Writing both keys is what
      // `writeCommittedWalls` is for, and doing it here means a redo of that edit costs one write
      // rather than two, exactly as the edit itself did.
      //
      // Tested rather than asserted, and the truthiness is not defensive padding: a graph stored
      // before bases existed loads with none, and an edit on one pushes an entry whose base is null.
      // Its restore wants the plain write below, which is what this falls through to.
      await writeCommittedWalls(mapId, next.graph, next.base);
    } else {
      await writeWallGraph(mapId, next.graph);
    }
    saved = next?.graph ?? null;
    base = next?.base ?? null;
    announce();
    devLog(
      "info",
      next
        ? "stage: a wall edit was put back"
        : "stage: the first wall edit was put back, so the walls are a derivation again",
    );
    // The way back to where we just were, which is what redo takes. Always something now: "nothing
    // stored" is a state like any other, so the first edit is redoable as well as undoable.
    return restoreTo(leaving);
  };
}

/**
 * The wall graph, or `null` in stage one.
 *
 * Also `null` before the scene has been asked, which is indistinguishable here and deliberately so:
 * every caller's response to "no graph" is the same, and the start-up sequence loads it before any
 * of them run.
 */
export function wallGraph(): WallGraph | null {
  return saved;
}

export function onStageChange(listener: () => void): void {
  listeners.push(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * The map the loaded graph belongs to.
 *
 * Held so an edit writes it back under the same map. A graph's coordinates are in units of *a* map
 * and say nothing about which, so the association is part of what is stored.
 */
let mapId: string | null = null;

/**
 * Read the scene's graph for a map. Reports whether something stored could not be read.
 *
 * Called again when the GM nominates a different image, because a graph saved against one map does
 * not describe another — the store treats a mismatch as "no graph here", which puts them back in
 * stage one for the new map without touching the old map's work.
 */
export async function loadStage(forMap: string | null): Promise<{ readonly corrupt: boolean }> {
  mapId = forMap;
  const { graph, base: storedBase, corrupt } = await readWallGraph(forMap);
  saved = graph;
  base = storedBase;
  // A different map's history describes a different document. Units of *a* map say nothing about
  // which, so restoring one here would put one map's walls onto another.
  clearUndo();
  announce();
  return { corrupt };
}

/**
 * Throw the stored graph away, because the GM has agreed to regenerate it.
 *
 * **This is what consent looks like**, and it is deliberately the whole document rather than a flag
 * saying consent was given. A flag is a second statement of the same fact and can disagree with it;
 * an absent graph cannot. With nothing stored, the derive is free to run, what it produces takes the
 * screen, and the push adopts it — which is exactly the state a map that has never been edited is in.
 *
 * **It does not restore the base**, which was the other candidate. The base is the derivation these
 * edits were made *on*, produced by settings the GM has just changed — so putting it back would show
 * them a graph that answers neither the old question nor the new one.
 *
 * The undo stack goes too, on the rule it already followed: its snapshots describe a document that is
 * no longer on screen.
 */
export async function discardWalls(): Promise<void> {
  await clearWallGraph();
  saved = null;
  base = null;
  // The walls only. A brush stroke is still perfectly restorable, and taking that away because
  // the GM agreed to rebuild the walls is deleting one document to replace another.
  clearUndo("walls");
  announce();
  devLog("info", "stage: the stored walls were discarded so the reading can be derived again");
}

/**
 * Throw the stored graph away because the GM asked for it — *Clear wall edits*.
 *
 * ## Why this is not `discardWalls`, which does the same thing
 *
 * The two differ in exactly one line, and it is the one that matters: **this pushes a way back and
 * that one clears the history.** `discardWalls` is consent to *regenerate*, so the settings the
 * edits were made under have just moved and its snapshots describe a document derived from ink the
 * GM has since changed. Nothing upstream has moved here. The old document is a state that existed a
 * moment ago and is a perfectly good one to return to, so one press of undo returns to it (user,
 * 2026-09-20).
 *
 * That keeps the clear family on one rule: **a clear is one named act, and every named act is
 * undoable** — *Clear layer* already was, *Clear all marks* is by going through `saveMarks`, and
 * *Clear everything* is the single exception, which is why it is the one place "this cannot be
 * undone" is true.
 *
 * **The entries below it stay**, and are still honest: they describe earlier states of this same
 * document, which undoing this returns to.
 *
 * **It does not touch the marks**, and that is the decision rather than an omission (user,
 * 2026-09-18). A mark survives a *rebuild* of the walls, which is far more violent than this, so
 * taking them here would make the gentle explicit recovery more destructive than the accident it
 * exists to undo.
 */
export async function clearWallEdits(): Promise<void> {
  const before = stored();
  if (!before) return;
  await clearWallGraph();
  // After the write, so a failed one leaves nothing to undo back to — `saveEditedWalls`' own rule.
  pushUndo("clearing the wall edits", restoreTo(before), "walls");
  saved = null;
  base = null;
  announce();
  devLog("info", "stage: the stored walls were cleared, so they are a derivation again");
}

/**
 * Adopt the derivation on screen as the stored document, which is what a push does on its way out.
 *
 * Written before the local state changes, so a failed write leaves the GM with their controls live
 * rather than in a state the scene does not agree with.
 *
 * ## It cleared the undo history, and that was the old model talking — user, 2026-09-15
 *
 * The line said *restoring one would put back walls derived from ink the GM has since changed*, and
 * it rested on two things that have both stopped being true.
 *
 * **The scene is not a source of truth.** This project once assumed walls would go into the scene
 * and be read back to edit — *"now, though, we've gotten invested in keeping a lot of metadata, so
 * when you reopen the workspace it doesn't read anything back from the scene"*. Nothing reads
 * geometry back; our own items are found only to be replaced or removed. **A push is an emit, not a
 * save**, and an emit has no business invalidating the document's history.
 *
 * **And a restored graph can no longer lie about what it is.** The hazard was a document claiming
 * to be a derivation while not being a function of the current ink, which nothing could detect
 * while the derivation it came from was not stored. The base moved into the scene beside it, and
 * the way back now carries **both halves as one thing** — so restoring puts back a consistent pair
 * and the mark stays honest. The reason is spent twice over.
 *
 * So this clears nothing. Every entry still describes a state that existed and can be returned to.
 * **What it does leave is the scene holding walls the workspace no longer agrees with** if the GM
 * undoes afterwards — which is already true of every edit made after a push, since nothing here has
 * ever pushed by itself.
 */
export async function saveDerivedWalls(graph: WallGraph): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to derive a graph against");
  await writeDerivedWalls(mapId, graph);
  saved = graph;
  // The base moves with it: from here the document *is* the derivation, so the comparison the mark
  // asks finds nothing until the GM touches a wall.
  base = graph;
  announce();
  devLog("info", `stage: saved — ${graph.nodes.length} nodes, ${graph.edges.length} segments`);
}

/**
 * Save a graph the GM has changed by hand.
 *
 * **One call is one act the GM performed**, which is why every editing tool and every one-shot
 * operation goes through here rather than writing the store directly — and why exactly one entry
 * goes on the history for it, whatever the act turns out to have cost in writes.
 */
export async function saveEditedWalls(
  graph: WallGraph,
  label: string,
  /**
   * The graph this edit was applied to, when that is not the stored document.
   *
   * **This is what deletes the save button.** A GM editing a wall on a graph that has only ever been
   * a derivation is the moment a document becomes necessary — so the surface adopts the derivation
   * as the document *here*, caused by the edit rather than performed beforehand. Left undefined, the
   * edit is an ordinary one on what is already stored.
   */
  from?: WallGraph,
): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to save the graph against");
  const before = stored();
  /*
    One write either way, which is why the store has a second function rather than this making two
    calls. A first edit on a derivation has to leave *two* different graphs in the scene — what the
    trace produced and what the GM made of it — and doing that as two writes would make the first
    wall drag on every map cost twice what the rest do.
  */
  if (from && from !== saved) {
    await writeCommittedWalls(mapId, graph, from);
    base = from;
  } else {
    await writeWallGraph(mapId, graph);
  }
  /*
    Pushed after the write, so a failed one leaves nothing to undo back to.

    The store throws where the settings reader swallows, and the reason applies here too: a history
    entry for an edit the scene never took would offer to restore a state that was already current.

    **Unconditionally**, which it was not until 2026-09-15. It read `if (before)`, so the one edit
    that has no earlier document — the first, which creates it — was the one edit that could not be
    taken back. See `restoreTo` for what that cost in a room.
  */
  pushUndo(label, restoreTo(before), "walls");
  saved = graph;
  announce();
}


