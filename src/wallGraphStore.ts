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
 * The graph's coordinates are graph units of *a* map, and nothing in them says which. A GM who derives
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
 * The graph as the trace last derived it, kept beside the document it became.
 *
 * **This is what lets the surface answer "is there work of mine in these walls?" tomorrow.** The
 * hand-edit count answers it today and only within one session, because nothing stored says a graph
 * was edited — so a GM who comes back to a map they worked on last week opens with no mark and no
 * warning. Two graphs in the scene make the question a comparison between two durable things, and
 * `graphsDiffer` is the whole of the answer.
 *
 * **Its own key rather than a field in the record above**, and for the same reason the graph is not a
 * field in the settings: `setMetadata` merges, so a hand edit rewrites only the document. Sharing a
 * record would put the base's tens of kilobytes back on the wire on every wall drag, which is the
 * slow half of an edit.
 *
 * A derive writes both keys in one call, since at that moment they are the same graph — see
 * `writeDerivedWalls`. Nothing else ever writes this one.
 */
const BASE_KEY = key("graphBase");

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
  /**
   * The graph as the trace last derived it, for comparing against the one above.
   *
   * `null` covers three cases that the caller treats alike and should: nothing stored, stored
   * against another map, and stored but unreadable. All three mean *we cannot say this graph is
   * still what was derived*, and `graphsDiffer` answers that with its loud direction.
   */
  readonly base: WallGraph | null;
  /** True when there was a *document* stored and it could not be read. */
  readonly corrupt: boolean;
}> {
  let stored: unknown;
  let storedBase: unknown;
  try {
    const metadata = await OBR.scene.getMetadata();
    stored = metadata[GRAPH_KEY];
    storedBase = metadata[BASE_KEY];
  } catch (error) {
    // Could not ask. Distinct from "asked and it was bad", so it does not claim the graph is lost.
    devLog("warn", `graph: could not read scene metadata — ${describeError(error)}`);
    return { graph: null, base: null, corrupt: false };
  }

  const document = readRecord(stored, mapId, "graph");
  if (!document.graph) return { graph: null, base: null, corrupt: document.corrupt };

  /*
    The base is read but its failures are not reported the same way, because they cost a different
    thing. A document that will not decode loses the GM their editing; a base that will not decode
    loses only our ability to say whether they edited — and the answer to that is already "assume
    they did". So it degrades into the safe direction rather than into a message.
  */
  const base = readRecord(storedBase, mapId, "base graph").graph;

  devLog(
    "info",
    `graph: loaded ${document.graph.nodes.length} nodes and ${document.graph.edges.length} walls` +
      (base ? `, with a derived base of ${base.edges.length} walls` : ", with no derived base"),
  );
  return { graph: document.graph, base, corrupt: false };
}

/**
 * One stored record — the map it belongs to, and the encoded graph — validated and decoded.
 *
 * Shared by the document and the base so the two cannot drift into disagreeing about what a valid
 * record is. `what` only ever reaches a log line; nothing branches on it.
 */
function readRecord(
  stored: unknown,
  mapId: string | null,
  what: string,
): { readonly graph: WallGraph | null; readonly corrupt: boolean } {
  if (stored === undefined || stored === null) return { graph: null, corrupt: false };
  if (typeof stored !== "object") {
    console.error(`Fog Nudger: the stored ${what} is not an object`, typeof stored);
    return { graph: null, corrupt: true };
  }

  const record = stored as { map?: unknown; graph?: unknown };
  if (typeof record.graph !== "string") {
    console.error(`Fog Nudger: the stored ${what} has no encoded body`);
    return { graph: null, corrupt: true };
  }

  // A graph for another map is not corruption — it is a document that simply does not apply here.
  // Silent, because it is the ordinary consequence of nominating a different image.
  if (typeof record.map !== "string" || record.map !== mapId) {
    devLog("info", `graph: the stored ${what} belongs to another map, ignoring it`);
    return { graph: null, corrupt: false };
  }

  const graph = decodeWallGraph(record.graph);
  if (!graph) {
    // `console.error`, not the dev log: the dev log compiles away in a production build, and this is
    // a message a GM may be told to go and look for.
    console.error(
      `Fog Nudger: the stored ${what} could not be decoded and has been ignored. ` +
        "Wall editing for this scene is lost; the reading settings and map choice are not.",
    );
    return { graph: null, corrupt: true };
  }

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
 * Write a graph the trace just derived, as both the document and the base to compare against.
 *
 * **One `setMetadata`, not two.** At a derive the two are the same graph, so the encoding happens
 * once and both keys carry the same string — which matters because a scene write is the slow part of
 * everything this surface does, and doing it twice at the moment a slider is released would be felt.
 *
 * Writing the base is also what *resets* the question the mark asks: from here the graph is a pure
 * function of the ink again, the comparison finds nothing, and the rail goes unmarked without
 * anything having to remember that it should.
 */
export async function writeDerivedWalls(mapId: string, graph: WallGraph): Promise<void> {
  const encoded = encodeWallGraph(graph);
  const record = { map: mapId, graph: encoded };
  await OBR.scene.setMetadata({ [GRAPH_KEY]: record, [BASE_KEY]: record });
  devLog(
    "info",
    `graph: stored a derived ${graph.nodes.length} nodes and ${graph.edges.length} walls ` +
      `in ${encoded.length} characters, as both the document and its base`,
  );
}

/**
 * Write a graph the GM has just edited **and** the derivation it was edited from, in one call.
 *
 * This is the first hand edit on a graph that was only ever a derivation — the moment the surface
 * adopts what the trace produced as the document, because a document is now needed. It is under the
 * hood by design: a GM never presses anything to enter an editing stage, they move a wall and the
 * commit happens because the edit needed one.
 *
 * **Two keys, two different values, one write.** The base is what they started from and the document
 * is what they made of it, so unlike `writeDerivedWalls` the encodings differ — but it is still a
 * single `setMetadata`, because a scene write is the expensive part of an edit and the first one
 * must not cost twice what the rest do.
 */
export async function writeCommittedWalls(
  mapId: string,
  graph: WallGraph,
  base: WallGraph,
): Promise<void> {
  const encoded = encodeWallGraph(graph);
  await OBR.scene.setMetadata({
    [GRAPH_KEY]: { map: mapId, graph: encoded },
    [BASE_KEY]: { map: mapId, graph: encodeWallGraph(base) },
  });
  devLog(
    "info",
    `graph: adopted the derivation as the document on a first edit — ` +
      `${graph.nodes.length} nodes and ${graph.edges.length} walls, ` +
      `over a base of ${base.edges.length}`,
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
  // The base goes with it. Left behind it would be a record of what a document that no longer exists
  // was derived from — and the next graph saved here would be compared against another map's trace.
  await OBR.scene.setMetadata({ [GRAPH_KEY]: undefined, [BASE_KEY]: undefined });
  devLog("info", "graph: the saved walls were discarded");
}
