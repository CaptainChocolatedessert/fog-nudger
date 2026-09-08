/**
 * Where the wall graph lives: scene metadata, beside the settings and the map nomination.
 *
 * Same reasoning as those two. The extension runs in a third-party iframe, so Firefox partitions
 * `localStorage` per top-level site and a local copy can simply vanish; and a graph derived from
 * *this* map belongs to the scene rather than to a browser.
 *
 * ## Its presence is what says whether there is anything to edit
 *
 * No stored graph means the wall editor has nothing to show, and says so. A stored graph is the
 * document that editor works on and the source the push emits from. **There is no separate flag**,
 * deliberately — a flag can disagree with the thing it describes, and this cannot.
 *
 * It used to mean more than that: it *was* the stage, and the reading closed itself while one
 * existed. The two-mode split (2026-09-05) ended that. Reading the map and editing the walls are two
 * surfaces now, so the ink mode never consults this and being in it costs nothing — which is what
 * makes reopening it over an edited graph harmless.
 *
 * ## Its own key, not a field inside the settings
 *
 * The settings are rewritten on every slider release. The graph is written once at the derivation and
 * then on each edit, and it is two orders of magnitude larger. Sharing a key would mean rewriting
 * tens of kilobytes every time a slider moved, and — worse — a settings write racing a graph write
 * could drop one of them. Separate keys make that impossible rather than unlikely.
 *
 * ## It records which map it is for
 *
 * The graph's coordinates are fractions of *a* map, and nothing in them says which. A GM who derives
 * a graph and then nominates a different image would otherwise have the first map's walls silently
 * reinterpreted over the second. So the stored value is a small wrapper — the map's id beside the
 * encoded graph — and a mismatch reads as "no graph for this map" rather than as a graph.
 *
 * The wrapper lives here rather than inside the encoding on purpose: which map a document belongs to
 * is a fact about the *scene*, and `trace/wallGraph.ts` stays purely geometric and purely testable.
 *
 * The SDK is imported here, so nothing in this file is reachable from a node test. Everything with
 * a decision in it lives in `trace/wallGraph.ts`, which is pure and tested; this is the round trip
 * to the scene and the error handling around it, and it is deliberately thin.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { key } from "./namespace";
import {
  decodeWallGraph,
  encodeWallGraph,
  type WallGraph,
} from "./trace/wallGraph";

const GRAPH_KEY = key("graph");

/**
 * Read the scene's wall graph, or `null` if there is not one this build can vouch for.
 *
 * **`null` is a legitimate answer, not an error**: it is what every scene looks like before anything
 * has been saved, and the caller says where walls come from rather than reporting a failure.
 *
 * It is also the answer for a graph that will not decode, and that case is *not* silent. Unlike the
 * settings, there is no per-field degrading available here: an edge naming a node that does not
 * exist has no sensible fallback, and a graph with an edge quietly dropped would be a corrupt
 * document presented as a valid one. So a bad payload costs the GM their stage-two editing, which is
 * a real loss and has to be said out loud rather than looking like "you have not started yet".
 * `readWallGraph` reports the distinction; deciding what the GM is told is the caller's.
 */
export async function readWallGraph(mapId: string | null): Promise<{
  readonly graph: WallGraph | null;
  /** True when there was something stored and it could not be read. */
  readonly corrupt: boolean;
}> {
  let stored: unknown;
  try {
    const metadata = await OBR.scene.getMetadata();
    stored = metadata[GRAPH_KEY];
  } catch (error) {
    // Could not ask. Distinct from "asked and it was bad", so it does not claim the graph is lost.
    devLog("warn", `graph: could not read scene metadata — ${describeError(error)}`);
    return { graph: null, corrupt: false };
  }

  if (stored === undefined || stored === null) return { graph: null, corrupt: false };
  if (typeof stored !== "object" || stored === null) {
    console.error("Fog Nudger: the stored graph is not an object", typeof stored);
    return { graph: null, corrupt: true };
  }

  const record = stored as { map?: unknown; graph?: unknown };
  if (typeof record.graph !== "string") {
    console.error("Fog Nudger: the stored graph has no encoded body");
    return { graph: null, corrupt: true };
  }

  // A graph for another map is not corruption — it is a document that simply does not apply here.
  // Silent, because it is the ordinary consequence of nominating a different image.
  if (typeof record.map !== "string" || record.map !== mapId) {
    devLog("info", `graph: the stored graph belongs to another map, ignoring it`);
    return { graph: null, corrupt: false };
  }

  const graph = decodeWallGraph(record.graph);
  if (!graph) {
    // `console.error`, not the dev log: the dev log compiles away in a production build, and this is
    // a message a GM may be told to go and look for.
    console.error(
      "Fog Nudger: the stored graph could not be decoded and has been ignored. " +
        "Wall editing for this scene is lost; the reading settings and map choice are not.",
    );
    return { graph: null, corrupt: true };
  }

  devLog("info", `graph: loaded ${graph.nodes.length} nodes and ${graph.edges.length} walls`);
  return { graph, corrupt: false };
}

/**
 * Write the wall graph, replacing whatever was there.
 *
 * Throws on failure rather than swallowing, which is the opposite of `readSettings` and is the right
 * way round: a *read* that fails can fall back to defaults and carry on, but a **write** that fails
 * silently means the GM keeps editing a graph that is not being saved. The caller has a state line
 * and must use it.
 */
export async function writeWallGraph(mapId: string, graph: WallGraph): Promise<void> {
  const encoded = encodeWallGraph(graph);
  await OBR.scene.setMetadata({ [GRAPH_KEY]: { map: mapId, graph: encoded } });
  devLog(
    "info",
    `graph: stored ${graph.nodes.length} nodes and ${graph.edges.length} walls ` +
      `in ${encoded.length} characters`,
  );
}

/**
 * Discard the stored graph.
 *
 * **One caller, and it is the panel's "Remove ours"** (user, 2026-09-05: *"the panel has a way to
 * clear objects that we own. the workspace doesn't need to provide that."*). Neither workspace
 * offers it: the ink mode's save *replaces* the graph, with a confirmation naming what goes, and the
 * editor has no reason to throw away the only thing it holds.
 *
 * It goes with the fog rather than alone, because on its own it would be half a removal — the next
 * save from either surface would put the same walls straight back.
 *
 * The reading settings, the map nomination and the paint layers are under their own keys and are
 * deliberately left alone.
 */
export async function clearWallGraph(): Promise<void> {
  await OBR.scene.setMetadata({ [GRAPH_KEY]: undefined });
  devLog("info", "graph: the saved walls were discarded");
}
