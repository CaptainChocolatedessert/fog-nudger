/**
 * The small-region search as a tool: run it while *Collapse small regions* is in hand, and hold what
 * it found.
 *
 * ## It follows the graph on its own, and the size as it moves
 *
 * **The graph** is asked for every time the regions are: `editableGraph` hands back a new object
 * whenever the walls on screen change, so a search keyed on that object re-runs exactly when it has
 * to — which is also what makes a collapse re-run it.
 *
 * **The size** is the drawer's handle, and unlike Mend's settings it applies **while the handle
 * moves**, not on release. Measured before it was allowed (2026-09-21): on a mesh of 2,500 regions and
 * 7,000 walls a full drag across the track cost a median of a quarter of a millisecond a step and a
 * worst of 7ms, because the regions' areas are worked out once per graph and a new size is a filter
 * over them. Mend's search is the whole graph again on every change, which is why it waits.
 *
 * **Nothing is stored.** The size is back at its starting point every time the drawer opens (user,
 * 2026-09-21), and it is held here only while the tool is in hand.
 *
 * No SDK of its own; the starting size reads the last reading's ink width from the pipeline.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { lastInkWidth, lastRasterPerGraphUnit } from "../pipeline";
import { collapseAt, findCollapses, type Collapse } from "../trace/collapse";
import { buildWallFaces, type WallFaces } from "../trace/wallFaces";
import type { WallGraph } from "../trace/wallGraph";
import { startingSize } from "./collapseScale";
import { editableGraph } from "./regions";

/** The size in graph units squared, `0` for off, or `null` while the tool is not in hand. */
let limit: number | null = null;
/** The traversal of the graph on screen, walked once per graph. */
let walked: { readonly graph: WallGraph; readonly faces: WallFaces } | null = null;
let searched: { readonly graph: WallGraph; readonly limit: number; readonly found: readonly Collapse[] } | null = null;

/**
 * The regions on offer for the walls on screen, searching again only if the walls or the size have
 * changed.
 *
 * Empty while the tool is not in hand, the size is off, or there are no walls — which is what the layer
 * draws and what a click is tested against, so the two cannot see different lists.
 */
export function currentCollapses(): readonly Collapse[] {
  const graph = editableGraph();
  if (limit === null || !(limit > 0) || !graph) return [];
  if (searched && searched.graph === graph && searched.limit === limit) return searched.found;

  const started = performance.now();
  if (walked?.graph !== graph) walked = { graph, faces: buildWallFaces(graph) };
  const found = findCollapses(graph, walked.faces, limit);
  searched = { graph, limit, found };
  const ms = performance.now() - started;
  // Only when it cost something: the handle moving asks this on every frame.
  if (ms > 50) {
    devLog(
      "info",
      `workspace: small-region search — ${found.length} of ${walked.faces.faces.length} regions under ` +
        `${limit.toExponential(2)} square graph units, over ${graph.edges.length} segments in ${Math.round(ms)}ms`,
    );
  }
  return found;
}

/**
 * Pick the tool up, at the starting size — eight square ink widths of the last reading, or a fixed
 * guess without one (`collapseScale.ts`). Returns how many regions qualify, or `null` with no walls.
 */
export function startCollapseSearch(): number | null {
  limit = startingSize(lastInkWidth(), lastRasterPerGraphUnit());
  searched = null;
  return editableGraph() ? currentCollapses().length : null;
}

/** The handle moved. Returns the count, or `null` when the tool is not in hand. */
export function setCollapseSize(size: number): number | null {
  if (limit === null) return null;
  limit = size;
  return editableGraph() ? currentCollapses().length : null;
}

/** The size the search is running at, or `null` while the tool is not in hand. */
export function collapseSize(): number | null {
  return limit;
}

/** Put the tool down. The rings go with it, since nothing else can act on them. */
export function stopCollapseSearch(): void {
  limit = null;
  searched = null;
  walked = null;
  hoveredFree = null;
}

/** Whether the search is running, which is whether the tool is in hand. */
export function collapseSearchActive(): boolean {
  return limit !== null;
}

/**
 * The region at a point, its own size ignored entirely — for a direct click on a region bigger than
 * the drawer's current setting, and for the hover that previews it.
 *
 * Shares `walked` with `currentCollapses`, so a free click never rebuilds a traversal the ringed
 * search has already paid for this graph.
 */
export function collapseAtPoint(point: Vector2): Collapse | null {
  const graph = editableGraph();
  if (!graph) return null;
  if (walked?.graph !== graph) walked = { graph, faces: buildWallFaces(graph) };
  return collapseAt(graph, walked.faces, point);
}

/**
 * The free-click target the pointer is currently over, for the layer to preview — `null` when it is
 * over a ringed one instead, or nothing at all.
 *
 * A cursor's own decision, kept here rather than computed by the layer, for the reason `currentCollapses`
 * already is: the layer must draw exactly what a click would take, and there is one place that decides it.
 */
let hoveredFree: Collapse | null = null;

export function setHoveredFreeCollapse(collapse: Collapse | null): void {
  hoveredFree = collapse;
}

export function hoveredFreeCollapse(): Collapse | null {
  return hoveredFree;
}
