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
import { actionBlocked, applyActionGate, setActionGate } from "./actionGate";
import { controlsLive } from "./settingsState";
import { mapExtent, say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";
import { workOn } from "./subject";

const BUTTON_ID = "frame-action";
const NOTE_ID = "frame-action-note";

/*
  Empty, and that is the whole of its ready state.

  The name says the consequence, which is what the four-sentence note it replaced was for. What is
  left for this element to carry is the blocked case, where there is something to say that no label
  can: that there is no graph to add walls to yet.
*/
const READY_NOTE = "";

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
  button.id = BUTTON_ID;
  button.textContent = "Add walls around the map edge";

  const note = document.createElement("p");
  note.id = NOTE_ID;
  note.className = "sub";

  /*
    No limit of its own, which is why `actionBlocked` takes none here.

    It is the only one of the three that **adds** rather than removes, so there is no ceiling on what
    it would take and nothing to set before pressing it. A graph is the whole of what it needs.
  */
  setActionGate(button, () => actionBlocked(wallGraph() !== null));
  applyActionGate(button, note, READY_NOTE, controlsLive());

  button.addEventListener("click", () => {
    // Adding four walls at the map's edge is wall work, and it is the one wall action that is a
    // button rather than a tool, so nothing else here would say so.
    workOn("walls");
    void run(button);
  });

  actions.append(button);
  body.append(actions, note);
}

async function run(button: HTMLButtonElement): Promise<void> {
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
    // Through the gate, not straight to `disabled`. Framing a graph that was already framed
    // leaves it unchanged, and re-enabling blind would also re-enable it with no graph at all.
    refreshFrameAction();
  }
}

/** Re-ask the gate, for when a graph arrives. */
export function refreshFrameAction(): void {
  const button = document.getElementById(BUTTON_ID);
  const note = document.getElementById(NOTE_ID);
  if (button instanceof HTMLButtonElement && note) {
    applyActionGate(button, note, READY_NOTE, controlsLive());
  }
}
