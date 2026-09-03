/**
 * Which of the two stages the GM is in, and the one-way door between them.
 *
 * Stage one is the map: tune the reading, edit pixels, generate the graph. Stage two is the graph:
 * nudge vertices, add and delete edges. **Going back to stage one discards the graph**, and that is
 * the whole rule — it does not solve the identity problem in storing a move, it removes it, because
 * stage two never re-derives and so nothing is ever renumbered behind an edit.
 *
 * ## The stored graph's presence IS the stage
 *
 * There is no flag, deliberately. A flag is a second statement of the same fact and can disagree
 * with the first; a graph either is in the scene or is not. `frozenGraphStore.ts` says the same
 * thing from the other end.
 *
 * ## What crossing back actually costs, and what it does not
 *
 * Only the stage-two editing. The reading settings, the map nomination and (when they exist) the
 * GM's pixel strokes are stage one's *inputs* — never consumed, never discarded — so starting over
 * lands them back at their tuned ink rather than at a bare map. Saying that in the confirmation
 * matters as much as naming what goes: the fear otherwise is that "start over" means the whole map.
 *
 * **Closing the workspace costs nothing at all**, which is why nothing warns about it. Everything
 * durable is in scene metadata and everything else is derived from it on demand. A warning there
 * would train a GM to dismiss the one warning that matters.
 *
 * No DOM. The confirmation is drawn by `confirmDialog.ts`; this owns the state and the rule.
 */

import { devLog } from "../devlog";
import { clearFrozenGraph, readFrozenGraph, writeFrozenGraph } from "../frozenGraphStore";
import type { FrozenGraph } from "../trace/frozenGraph";

let frozen: FrozenGraph | null = null;
let loaded = false;
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

/** Whether the GM is editing a frozen graph rather than tuning a reading. */
export function inStageTwo(): boolean {
  return frozen !== null;
}

/**
 * Whether the stage has been established yet.
 *
 * Separate from `inStageTwo` because "not yet asked" and "asked, and there is none" want the same
 * behaviour but not the same *message* — a control disabled because the SDK has not answered is not
 * a control disabled because the graph is frozen.
 */
export function stageKnown(): boolean {
  return loaded;
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
  loaded = true;
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

/**
 * Cross back: discard the graph and reopen the reading.
 *
 * The scene is cleared first for the same reason the freeze writes first — if the write fails, the
 * GM should still be in the stage the scene says they are in.
 */
export async function startOver(): Promise<void> {
  await clearFrozenGraph();
  frozen = null;
  announce();
  devLog("info", "stage: back to stage one, graph discarded");
}
