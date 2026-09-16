/**
 * The mend search as a tool: run it while the mend tool is in hand, and hold what it found.
 *
 * ## It follows the graph on its own, and the settings only when told
 *
 * **The graph** is asked for every time the mends are: `editableGraph` hands back a new object
 * whenever the walls on screen change — an edit, a derive, a mend accepted — so a search keyed on
 * that object re-runs exactly when it has to, with nothing to subscribe to and nothing to forget.
 * That is also what makes accepting re-run the search, which the ink tool does on purpose: a gap
 * mended changes what the rest of the walls look like.
 *
 * **The settings** are read when the tool is picked up and when one of its sliders is released, and
 * not while one is being dragged. A tool setting applies live as the handle moves, and a search over
 * a large map on every pixel of a drag is work nobody is looking at — the ink tool re-runs on release
 * for the same reason.
 *
 * No SDK. What accepting writes goes through the wall tools' own save, so it is an edit like any other.
 */

import { devLog } from "../devlog";
import { findMends, type Mend, type MendOptions } from "../trace/mends";
import type { WallGraph } from "../trace/wallGraph";
import { editableGraph } from "./regions";
import { currentSettings } from "./settingsState";

/** The settings the search runs with, or `null` while the tool is not in hand. */
let options: MendOptions | null = null;
/** The last search, and what it was run against. */
let searched: { readonly graph: WallGraph; readonly options: MendOptions; readonly mends: readonly Mend[] } | null =
  null;

function readOptions(): MendOptions {
  const { mendReachGraphUnits, mendTravelGraphUnits } = currentSettings().trace;
  return { reach: mendReachGraphUnits, travel: mendTravelGraphUnits };
}

/**
 * The mends on offer for the walls on screen, searching again only if those walls have changed.
 *
 * Empty while the tool is not in hand or there are no walls, which is what the layer draws and what a
 * click is tested against — the two cannot see different lists.
 */
export function currentMends(): readonly Mend[] {
  const graph = editableGraph();
  if (!options || !graph) return [];
  if (searched && searched.graph === graph && searched.options === options) return searched.mends;

  const started = performance.now();
  const mends = findMends(graph, options);
  searched = { graph, options, mends };
  devLog(
    "info",
    `workspace: mend search — ${mends.length} proposed over ${graph.edges.length} segments in ` +
      `${Math.round(performance.now() - started)}ms (reach ${options.reach.toExponential(2)}, ` +
      `travel ${options.travel.toExponential(2)} graph units)`,
  );
  return mends;
}

/**
 * Pick the tool up: read the settings and search now. Returns how many were found, or `null` with no
 * walls to search.
 */
export function startMendSearch(): number | null {
  options = readOptions();
  searched = null;
  return editableGraph() ? currentMends().length : null;
}

/** Put the tool down. The rings go with it, since nothing else can act on them. */
export function stopMendSearch(): void {
  options = null;
  searched = null;
}

/** Whether the search is running, which is whether the mend tool is in hand. */
export function mendSearchActive(): boolean {
  return options !== null;
}

/**
 * A mend slider was released: search again with what it now says. Returns the count, or `null` when
 * the tool is not in hand and there is nothing to refresh.
 */
export function refreshMendSearch(): number | null {
  if (!options) return null;
  options = readOptions();
  return editableGraph() ? currentMends().length : null;
}
