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
export async function readFrozenGraph(): Promise<{
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
  if (typeof stored !== "string") {
    console.error("Fog Nudger: the stored graph is not a string", typeof stored);
    return { graph: null, corrupt: true };
  }

  const graph = decodeFrozenGraph(stored);
  if (!graph) {
    // `console.error`, not the dev log: the dev log compiles away in a production build, and this is
    // a message a GM may be told to go and look for.
    console.error(
      "Fog Nudger: the stored graph could not be decoded and has been ignored. " +
        "Wall editing for this scene is lost; the reading settings and map choice are not.",
    );
    return { graph: null, corrupt: true };
  }

  devLog(
    "info",
    `graph: loaded ${graph.nodes.length} nodes and ${graph.edges.length} edges ` +
      `for a ${graph.width}x${graph.height} raster`,
  );
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
export async function writeFrozenGraph(graph: FrozenGraph): Promise<void> {
  const encoded = encodeFrozenGraph(graph);
  await OBR.scene.setMetadata({ [GRAPH_KEY]: encoded });
  devLog(
    "info",
    `graph: stored ${graph.nodes.length} nodes and ${graph.edges.length} edges ` +
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
