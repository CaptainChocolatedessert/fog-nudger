/**
 * The dead-end search as a tool: run it while *Prune the dead ends* is in hand, and hold what it found.
 *
 * The same shape as `collapseSearch.ts`, deliberately. **The graph** is asked for every time: a new
 * object whenever the walls on screen change, so a search keyed on it re-runs exactly when it must —
 * which is also what re-rings after a click. **The length** is the drawer's handle and applies as it
 * moves: this search is a run walk and a cascade, which is what the red preview already recomputed on
 * every movement of the old slider, and rooms have driven that since 2026-09-07.
 *
 * **Nothing is stored.** The length is back at its start every time the tool is picked up.
 *
 * No SDK of its own; the starting length reads the last reading's ink width from the pipeline.
 */

import { devLog } from "../devlog";
import { lastInkWidth, lastRasterPerGraphUnit } from "../pipeline";
import { findPrunePieces, type PrunePiece } from "../trace/prunePieces";
import type { WallGraph } from "../trace/wallGraph";
import { startingLength } from "./pruneScale";
import { editableGraph } from "./regions";

/** The length in graph units, `0` for off, or `null` while the tool is not in hand. */
let limit: number | null = null;
let searched: { readonly graph: WallGraph; readonly limit: number; readonly found: readonly PrunePiece[] } | null =
  null;

/**
 * The pieces on offer for the walls on screen, searching again only if the walls or the length changed.
 *
 * Empty while the tool is not in hand, the length is off, or there are no walls — which is what the
 * layers draw and what a click is tested against, so they cannot see different lists.
 */
export function currentPrunePieces(): readonly PrunePiece[] {
  const graph = editableGraph();
  if (limit === null || !(limit > 0) || !graph) return [];
  if (searched && searched.graph === graph && searched.limit === limit) return searched.found;
  const started = performance.now();
  const found = findPrunePieces(graph, limit);
  searched = { graph, limit, found };
  const ms = performance.now() - started;
  if (ms > 50) {
    devLog(
      "info",
      `workspace: dead-end search — ${found.length} pieces at ${limit.toExponential(2)} graph units, over ` +
        `${graph.edges.length} segments in ${Math.round(ms)}ms`,
    );
  }
  return found;
}

/** Pick the tool up at the starting length. Returns how many pieces qualify, or `null` with no walls. */
export function startPruneSearch(): number | null {
  limit = startingLength(lastInkWidth(), lastRasterPerGraphUnit());
  searched = null;
  return editableGraph() ? currentPrunePieces().length : null;
}

/** The handle moved. Returns the count, or `null` when the tool is not in hand. */
export function setPruneLength(length: number): number | null {
  if (limit === null) return null;
  limit = length;
  return editableGraph() ? currentPrunePieces().length : null;
}

/** The length the search is running at, or `null` while the tool is not in hand. */
export function pruneLength(): number | null {
  return limit;
}

/** Put the tool down. The rings and the red go with it. */
export function stopPruneSearch(): void {
  limit = null;
  searched = null;
}
