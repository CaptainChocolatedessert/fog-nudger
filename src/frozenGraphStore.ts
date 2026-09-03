/**
 * Where the frozen graph lives: scene metadata, beside the settings and the map nomination.
 *
 * Same reasoning as those two. The extension runs in a third-party iframe, so Firefox partitions
 * `localStorage` per top-level site and a local copy can simply vanish; and a graph derived from
 * *this* map belongs to the scene rather than to a browser.
 *
 * ## Its presence is what says which stage the GM is in
 *
 * No frozen graph means stage one: the reading is live, every control does what it says, and
 * generating the graph is available. A frozen graph means stage two: the reading is closed, the
 * graph is the document, and going back discards it. **There is no separate flag**, deliberately —
 * a flag can disagree with the thing it describes, and this cannot.
 *
 * ## Its own key, not a field inside the settings
 *
 * The settings are rewritten on every slider release. The graph is written once at the freeze and
 * then on each edit, and it is two orders of magnitude larger. Sharing a key would mean rewriting
 * tens of kilobytes every time a slider moved, and — worse — a settings write racing a graph write
 * could drop one of them. Separate keys make that impossible rather than unlikely.
 *
 * ## It records which map it is for
 *
 * The graph's coordinates are fractions of *a* map, and nothing in them says which. A GM who freezes
 * a graph and then nominates a different image would otherwise have the first map's walls silently
 * reinterpreted over the second. So the stored value is a small wrapper — the map's id beside the
 * encoded graph — and a mismatch reads as "no graph for this map" rather than as a graph.
 *
 * The wrapper lives here rather than inside the encoding on purpose: which map a document belongs to
 * is a fact about the *scene*, and `trace/frozenGraph.ts` stays purely geometric and purely testable.
 *
 * The SDK is imported here, so nothing in this file is reachable from a node test. Everything with
 * a decision in it lives in `trace/frozenGraph.ts`, which is pure and tested; this is the round trip
 * to the scene and the error handling around it, and it is deliberately thin.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { key } from "./namespace";
import {
  decodeFrozenGraph,
  encodeFrozenGraph,
  type FrozenGraph,
} from "./trace/frozenGraph";

const GRAPH_KEY = key("graph");

/**
 * Read the scene's frozen graph, or `null` if there is not one this build can vouch for.
 *
 * **`null` is a legitimate answer, not an error**: it is what every scene looks like before anything
 * was ever frozen, and the caller's response is the same either way — offer stage one.
 *
 * It is also the answer for a graph that will not decode, and that case is *not* silent. Unlike the
 * settings, there is no per-field degrading available here: an edge naming a node that does not
 * exist has no sensible fallback, and a graph with an edge quietly dropped would be a corrupt
 * document presented as a valid one. So a bad payload costs the GM their stage-two editing, which is
 * a real loss and has to be said out loud rather than looking like "you have not started yet".
 * `readFrozenGraph` reports the distinction; deciding what the GM is told is the caller's.
 */
export async function readFrozenGraph(mapId: string | null): Promise<{
  readonly graph: FrozenGraph | null;
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

  const graph = decodeFrozenGraph(record.graph);
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
 * Write the frozen graph, replacing whatever was there.
 *
 * Throws on failure rather than swallowing, which is the opposite of `readSettings` and is the right
 * way round: a *read* that fails can fall back to defaults and carry on, but a **write** that fails
 * silently means the GM keeps editing a graph that is not being saved. The caller has a state line
 * and must use it.
 */
export async function writeFrozenGraph(mapId: string, graph: FrozenGraph): Promise<void> {
  const encoded = encodeFrozenGraph(graph);
  await OBR.scene.setMetadata({ [GRAPH_KEY]: { map: mapId, graph: encoded } });
  devLog(
    "info",
    `graph: stored ${graph.nodes.length} nodes and ${graph.edges.length} walls ` +
      `in ${encoded.length} characters`,
  );
}

/**
 * Discard the frozen graph, which is what going back to stage one means.
 *
 * The one-way door, and the only thing that opens it. Everything else stage one needs — the reading
 * settings and the map nomination — is under its own key and is deliberately left alone, so "start
 * over" lands the GM back at their tuned ink rather than at a bare map.
 */
export async function clearFrozenGraph(): Promise<void> {
  await OBR.scene.setMetadata({ [GRAPH_KEY]: undefined });
  devLog("info", "graph: discarded, back to stage one");
}
