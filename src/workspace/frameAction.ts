/**
 * The button that walls the map's edge, so the exterior becomes a room the party can enter.
 *
 * ## Why the exterior is not one by default
 *
 * The trace stopped painting a border into the skeleton on 2026-09-08 (user): *"on most maps the
 * exterior isn't a 'room'. It's not an explorable space."* With nothing at the edge, the outside is
 * the arrangement's **unbounded face** — it has no polygon, so nothing is emitted for it, and since
 * everything is fogged by default that leaves it fogged and unrevealable.
 *
 * That is right for a dungeon on blank paper and wrong for a map whose outside is somewhere the party
 * can walk. This is the remedy, and it is a button rather than a setting because it changes the
 * document rather than the reading.
 *
 * ## It adds and does not delete, which is why it asks nothing first
 *
 * The two buttons beside it confirm, because pruning and straightening remove work that does not come
 * back. This only inserts four walls, and the result is drawn on the canvas the instant it lands —
 * the exterior appears as another coloured region. A GM who did not want it erases them, or presses
 * *Remove ours* and starts again.
 *
 * **A second press is refused rather than absorbed**, and that is the one thing here that could go
 * quietly wrong: four segments laid exactly on four existing ones are collinear overlaps, which
 * splitting cannot separate and which make Euler's identity fail. The document would be corrupt with
 * nothing to see until the next traversal.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { addFrameWalls } from "../trace/frameWalls";
import { mapExtent, say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";
import { workOn } from "./subject";
import type { BandAct } from "./bandActs";


/**
 * **An act in the strip, since 2026-09-21**, at the foot of the Walls band above the clear bin.
 *
 * It was a chip in the Walls group's drawer — and that drawer is gone, because the two amounts that
 * shared it became tools and this was the only other thing in it. An **act** is the strip's third
 * kind of button: it opens nothing and arms nothing, so it never draws pressed.
 *
 * **The second act in the column, and the first that adds rather than destroys.** The bin was the
 * only one, so "an act is a destructive press" was a coincidence of there being one example. This
 * one asks nothing before it runs, which it never needed to: it adds walls, so there is nothing to
 * lose, and undo takes it back like any other hand edit.
 *
 * **The gate is a graph and nothing else** — it is the one wall action with no limit of its own,
 * since there is no ceiling on what adding takes and nothing to set before pressing it.
 */
export const FRAME_ACT: BandAct = {
  step: "walls",
  /*
    The name says the consequence, which is what the four-sentence note it replaced was for.

    It was *Wall the map's edge*, which describes the mechanism — four walls at the extent — and left
    the point to a paragraph. It was then *Make the outside a room*, which named one reason a GM
    might press it and was doubted in two rooms, because the exterior is not something they
    necessarily think of as a room. The lesson is narrower than "name the point": a point that is
    only one of several is a guess at intent.
  */
  label: "Add walls around the map edge",
  glyph: "frame",
  gate: () => wallGraph() !== null,
  run: frameTheMapEdge,
};

/**
 * One press at a time.
 *
 * The chip disabled itself while the write was in flight and re-enabled through the gate. A strip
 * button cannot: the column is rebuilt on every tool change, so the element that disabled itself is
 * gone by the time the write returns. A module flag is what the clear acts already use for this.
 */
let busy = false;

async function frameTheMapEdge(): Promise<void> {
  if (busy) return;
  // Adding four walls at the map's edge is wall work, and it is the one wall action that is not a
  // tool, so nothing else here would say which side the GM is on.
  workOn("walls");
  await run();
}

async function run(): Promise<void> {
  const graph = wallGraph();
  if (!graph) {
    say("no walls saved for this map yet", "bad");
    return;
  }

  // The map's own size in graph units, which the document does not record — the frame goes where
  // the image's edge is.
  const extent = mapExtent();
  if (!extent) {
    say("no map is drawn, so there is no edge to wall", "bad");
    return;
  }

  const framed = addFrameWalls(graph, extent);
  if (framed.alreadyFramed) {
    // Said plainly rather than done silently: pressing a button and seeing nothing happen reads as a
    // broken button, where "it is already there" is an answer.
    say("the map's edge is already walled");
    return;
  }

  busy = true;
  say("walling the edge…", "working");
  try {
    await saveEditedWalls(framed.graph, "walling the map's edge");
    devLog(
      "info",
      `workspace: walled the map's edge — ${framed.splits} existing segments split where they met ` +
        `it, ${framed.overlaps} collinear overlaps left alone`,
    );
    say(
      "the map's edge is walled — the outside is a room now" +
        (framed.splits === 0 ? "" : ` · ${framed.splits} walls joined to it`),
    );
  } catch (error) {
    // The write is what makes it real, so a failure leaves the GM the graph they had.
    const detail = describeError(error);
    say(`could not save the edge walls: ${detail}`, "bad");
    devLog("error", "workspace: framing failed to save", detail);
    console.error("Fog Nudger — framing failed to save", error);
  } finally {
    busy = false;
  }
}

/*
  `refreshFrameAction` was here and went with the chip. It re-asked the action gate when a graph
  arrived, by looking the button up by id. The strip redraws on `onStageChange` and asks `gate()` on
  the way past, so the answer is recomputed at the moment it is drawn rather than pushed at it.
*/
