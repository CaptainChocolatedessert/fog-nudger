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
 * ## Nothing here discards it
 *
 * `startOver` was deleted with the door. Replacing the graph is what the ink mode's save does, with
 * a confirmation naming what goes; removing it altogether belongs to the panel, beside the button
 * that takes our fog out of the scene (user, 2026-09-05: *"the panel has a way to clear objects that
 * we own. the workspace doesn't need to provide that."*).
 *
 * No DOM.
 */

import { devLog } from "../devlog";
import { readWallGraph, writeWallGraph } from "../wallGraphStore";
import type { WallGraph } from "../trace/wallGraph";
import { EditHistory } from "./editHistory";

let saved: WallGraph | null = null;
const listeners: (() => void)[] = [];

/**
 * How many hand edits the graph in hand carries since it was last derived.
 *
 * **The irreversibility of this project, as a number rather than as a place.** Re-deriving destroys
 * hand edits — that is real and not fixable — but it only *costs* anything when there are some. The
 * old surface priced it as a boundary between two modes and charged the ceremony whether or not
 * anything was at stake; this is the same fact stated so it can be checked.
 *
 * The two save paths already distinguish the cases exactly: a derive replaces the graph wholesale
 * and resets this, an edit adds to it. Nothing else needs to know.
 *
 * **In memory only, and the cost is stated.** A graph loaded from the scene starts at zero, because
 * nothing stored says whether it was edited — so within a session the count is exact, and across one
 * the guard is the save confirmation, which names what it would replace. Storing it would be a
 * second fact beside the graph that can disagree with it, and the format has no room for one without
 * a version bump.
 */
let edits = 0;

/** How many hand edits the graph carries. Zero means re-deriving costs nothing. */
export function handEdits(): number {
  return edits;
}

/**
 * What the graph looked like before each of the last few edits, newest last.
 *
 * **Undo exists because the boundary that used to make this unnecessary is gone.** While the reading
 * controls and the editing tools were separate pages, wall edits could not be destroyed by accident;
 * on one surface they can, and the count plus its warning only help a GM *predict*. Nothing helped
 * with a judgement that looked right and was not — pruning at a limit that seemed fine and taking a
 * wall you wanted had no route back but regenerating and losing everything.
 *
 * Snapshots rather than inverse operations. The graph is tens of kilobytes and every edit already
 * replaces it wholesale, so keeping the old one costs almost nothing and cannot disagree with what
 * an inverse would have reconstructed. Twenty is far more than a GM will reach for and still well
 * under a megabyte.
 *
 * Each carries what it would undo, so the button can name it: "Undo erasing a wall" tells you what
 * you are about to get back, where a bare "Undo" asks you to remember.
 */
const HISTORY_DEPTH = 20;

const history = new EditHistory<WallGraph>(HISTORY_DEPTH);

/** What undoing would take back, or `null` when there is nothing. */
export function undoLabel(): string | null {
  return history.peek()?.label ?? null;
}

/**
 * Take back the last edit.
 *
 * Writes to the scene like any other edit, because the graph is stored there — undo is a change to
 * the document rather than a view of it. Refuses while another write is in flight, so two overlapping
 * writes cannot land in the wrong order.
 *
 * **The count comes back down with it.** Undoing every edit returns it to zero, at which point
 * re-deriving is free again and stops asking — which is true, and is the whole point of counting
 * rather than latching a flag.
 */
let writing = false;

export async function undoEdit(): Promise<string | null> {
  const last = history.peek();
  if (!last || writing || !mapId) return null;

  writing = true;
  try {
    // Written before it is popped, so a failed write leaves the entry there to try again rather than
    // silently consuming the one state that could have been restored.
    await writeWallGraph(mapId, last.document);
    history.pop();
    saved = last.document;
    edits = Math.max(0, edits - 1);
    announce();
    devLog("info", `stage: undid ${last.label} — ${edits} hand edits left`);
    return last.label;
  } finally {
    writing = false;
  }
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
 * Held so an edit writes it back under the same map. A graph's coordinates are fractions of *a* map
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
  const { graph, corrupt } = await readWallGraph(forMap);
  saved = graph;
  edits = 0;
  // A different map's history describes a different document. Fractions of *a* map say nothing about
  // which, so restoring one here would put one map's walls onto another.
  history.clear();
  announce();
  return { corrupt };
}

/**
 * Cross into stage two: store this graph and close the reading.
 *
 * Written before the local state changes, so a failed write leaves the GM in stage one with their
 * controls live rather than in a stage two the scene does not agree with.
 */
export async function saveDerivedWalls(graph: WallGraph): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to derive a graph against");
  await writeWallGraph(mapId, graph);
  saved = graph;
  // A derive replaces the graph wholesale, so whatever was edited into the last one is gone and the
  // new one is a pure function of the ink again. The history goes with it: those snapshots describe
  // a graph that is no longer on screen, and restoring one would put back walls derived from ink the
  // GM has since changed.
  edits = 0;
  history.clear();
  announce();
  devLog("info", `stage: saved — ${graph.nodes.length} nodes, ${graph.edges.length} segments`);
}

/**
 * Save a graph the GM has changed by hand.
 *
 * The one place `edits` grows, which is why every editing tool and every one-shot operation goes
 * through here rather than writing the store directly. One call is one act the GM performed, which
 * is what makes the count something to show them.
 */
export async function saveEditedWalls(graph: WallGraph, label: string): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to save the graph against");
  const before = saved;
  await writeWallGraph(mapId, graph);
  /*
    Pushed after the write, so a failed one leaves nothing to undo back to.

    The store throws where the settings reader swallows, and the reason applies here too: a history
    entry for an edit the scene never took would offer to restore a state that was already current.
  */
  if (before) history.push(before, label);
  saved = graph;
  edits += 1;
  announce();
}


