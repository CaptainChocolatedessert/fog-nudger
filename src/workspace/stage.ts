/**
 * The saved wall graph: reading it for a map, and writing it.
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
 * with the first; a graph either is in the scene or is not. `frozenGraphStore.ts` says the same
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
import { readFrozenGraph, writeFrozenGraph } from "../frozenGraphStore";
import type { FrozenGraph } from "../trace/frozenGraph";

let frozen: FrozenGraph | null = null;
const listeners: (() => void)[] = [];

/**
 * The frozen graph, or `null` in stage one.
 *
 * Also `null` before the scene has been asked, which is indistinguishable here and deliberately so:
 * every caller's response to "no graph" is the same, and the start-up sequence loads it before any
 * of them run.
 */
export function frozenGraph(): FrozenGraph | null {
  return frozen;
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
 * Called again when the GM nominates a different image, because a graph frozen against one map does
 * not describe another — the store treats a mismatch as "no graph here", which puts them back in
 * stage one for the new map without touching the old map's work.
 */
export async function loadStage(forMap: string | null): Promise<{ readonly corrupt: boolean }> {
  mapId = forMap;
  const { graph, corrupt } = await readFrozenGraph(forMap);
  frozen = graph;
  announce();
  return { corrupt };
}

/**
 * Cross into stage two: store this graph and close the reading.
 *
 * Written before the local state changes, so a failed write leaves the GM in stage one with their
 * controls live rather than in a stage two the scene does not agree with.
 */
export async function freezeTo(graph: FrozenGraph): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to freeze a graph against");
  await writeFrozenGraph(mapId, graph);
  frozen = graph;
  announce();
  devLog("info", `stage: frozen — ${graph.nodes.length} nodes, ${graph.edges.length} segments`);
}

/** Save an edited graph over the stored one. Stage two stays stage two. */
export async function updateFrozen(graph: FrozenGraph): Promise<void> {
  if (!mapId) throw new Error("no map is nominated, so there is nothing to save the graph against");
  await writeFrozenGraph(mapId, graph);
  frozen = graph;
  announce();
}


