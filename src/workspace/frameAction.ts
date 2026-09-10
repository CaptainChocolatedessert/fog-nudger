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
import { controlsLive } from "./settingRows";
import { say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";

export function renderFrameAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  /*
    The name says the consequence, so the four-sentence note that used to say it is gone.

    It was called "Wall the map's edge", which describes the mechanism — four walls at the extent —
    and left the point to a paragraph: those walls turn the outside into a region, so the party can
    be out there and the GM can reveal it. Without them the outside is enclosed by nothing and stays
    fogged for ever. Naming the outcome carries that in three words.
  */
  button.textContent = "Make the outside a room";
  button.disabled = !controlsLive();

  button.addEventListener("click", () => {
    void run(button);
  });

  actions.append(button);
  body.append(actions);
}

async function run(button: HTMLButtonElement): Promise<void> {
  const graph = wallGraph();
  if (!graph) {
    say("no walls saved for this map yet", "bad");
    return;
  }

  const framed = addFrameWalls(graph);
  if (framed.alreadyFramed) {
    // Said plainly rather than done silently: pressing a button and seeing nothing happen reads as a
    // broken button, where "it is already there" is an answer.
    say("the map's edge is already walled");
    return;
  }

  button.disabled = true;
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
    button.disabled = !controlsLive();
  }
}
