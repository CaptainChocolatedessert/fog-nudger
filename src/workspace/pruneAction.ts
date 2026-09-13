/**
 * Pruning in the wall editor: the same operation the ink mode applies, run once when asked.
 *
 * ## Why a button here and a slider there
 *
 * `pruneWallGraph` deletes dead-end walls, and the two modes want it on opposite terms.
 *
 * In the ink mode the graph is a **derivation**: it is rebuilt from the reading every time anything
 * moves, so a limit is a setting that gets re-applied on every derive and turning it back down puts
 * the walls straight back. Nothing is lost by sweeping it.
 *
 * Here the graph is the **document**. There is nothing to re-derive it from, so applying a limit
 * deletes walls the map cannot give back — including, if the limit is high enough, walls the GM drew
 * by hand a minute ago. A slider that did that on release would destroy work on a gesture as small as
 * brushing the track, so what the editor gets is the same number and a deliberate act to apply it.
 *
 * **Undo does give them back**, and this used to say they "do not come back" (corrected 2026-09-10).
 * A prune is saved through `saveEditedWalls` like every hand edit, so it is on the undo history —
 * the Undo button's own doc names "Undo pruning the dead ends" as its example. What is still true is
 * that a slider would prune on every brush of the track, twenty undos deep; what is no longer true is
 * that the button's deliberate act is the only thing between the GM and a permanent loss. That
 * weakens the case for a button here at all, and it belongs to the save-then-buttons conversation.
 *
 * The number lives in the same setting either way, which is the point: a GM who found a limit that
 * suits their map in the ink mode does not have to find it again here.
 *
 * ## Renumbering, and why this is allowed to
 *
 * Pruning compacts the node table, and compacting renumbers every id — which is forbidden inside a
 * gesture, because ids are the only stable identity this document has. A button press is not inside
 * one: the pointer is on a control rather than the canvas, so no drag can be in flight, and the
 * editing tools re-ask what is under the pointer after every write rather than holding ids across
 * one. Same rule the compaction in `commit` follows.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { readParameter } from "../settings";
import { pruneWallGraph, wallRuns } from "../trace/wallGraph";
import { actionBlocked, applyActionGate, setActionGate } from "./actionGate";
import { confirmAction } from "../confirmDialog";
import { currentSettings } from "./settingsState";
import { controlsLive } from "./settingRows";
import { say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";

const BUTTON_ID = "prune-action";
const NOTE_ID = "prune-action-note";

/*
  Nothing, when it can run. This said "It cannot be undone", which was the one sentence the prose
  cull kept here and it was false: a prune is on the undo history like any hand edit. With the
  warning gone there is nothing the label and its slider do not already say — and the confirmation
  that follows the press is where the reassurance belongs, at the moment of deciding.
*/
const READY_NOTE = "";

export function renderPruneAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = "chip";
  button.textContent = "Prune the dead ends";

  const note = document.createElement("p");
  note.id = NOTE_ID;
  note.className = "sub";

  /*
    The one action whose limit lives in a different step, and the reason it names where.

    `spurPruneFraction` is declared to **Walls**, because it also shapes the graph the reading
    derives; this button re-applies the same number to the stored document. Declaring it to both
    steps was the obvious fix and is forbidden — the rail no longer forces a section shut, so two
    handles on one setting would be reachable at once and would disagree the moment either moved.
    `steps.test.ts` pins that. So the button names its slider and says which step holds it, which is
    what the second handle would have been for.
  */
  setActionGate(button, () =>
    actionBlocked(wallGraph() !== null, {
      value: readParameter(currentSettings(), "spurPruneFraction"),
      reason:
        "Off &mdash; set <b>Longest dead end to remove</b> under <b>Walls</b> to say what would go.",
    }),
  );
  applyActionGate(button, note, READY_NOTE, controlsLive());

  button.addEventListener("click", () => {
    void run(button);
  });

  actions.append(button);
  body.append(actions, note);
}

/** Re-ask the gate, for when the slider that lifts it moves in another step. */
export function refreshPruneAction(): void {
  const button = document.getElementById(BUTTON_ID);
  const note = document.getElementById(NOTE_ID);
  if (button instanceof HTMLButtonElement && note) {
    applyActionGate(button, note, READY_NOTE, controlsLive());
  }
}

async function run(button: HTMLButtonElement): Promise<void> {
  const graph = wallGraph();
  if (!graph) {
    say("no walls saved for this map yet", "bad");
    return;
  }

  const limit = readParameter(currentSettings(), "spurPruneFraction");
  if (!(limit > 0)) {
    say("the prune limit is off — raise it above the left-hand end first", "bad");
    return;
  }

  /*
    Decided before it is confirmed, so the GM is told what it would actually cost.

    A limit is not a number anybody can picture on their own map: the same setting takes four hairs
    off one map and a third of the walls off another, because it depends entirely on how the linework
    was drawn. Running it first and asking second is what makes the confirmation say something —
    and it costs nothing, because the result is thrown away if the answer is no.
  */
  const pruned = pruneWallGraph(graph, limit);
  if (pruned.removed === 0) {
    say("nothing to prune — no dead end is that short");
    return;
  }

  const before = wallRuns(graph).length;
  const ok = await confirmAction({
    title: `Delete ${pruned.removed} dead-end wall${pruned.removed === 1 ? "" : "s"}?`,
    body: [
      `${pruned.removed} of this map's ${before} walls have a free end and are short enough to go, ` +
        `taking ${pruned.segments} segment${pruned.segments === 1 ? "" : "s"} with them. Undo ` +
        "takes it back.",
      "A wall that is part of a room is safe whatever the limit, because a loop presents no free " +
        "end. What goes is the hairs a ragged ink edge leaves behind — and any stub short enough " +
        "to look like one.",
    ],
    confirmLabel: "Delete them",
    destructive: true,
  });
  if (!ok) return;

  button.disabled = true;
  say("pruning…", "working");
  try {
    await saveEditedWalls(pruned.graph, "pruning the dead ends");
    devLog(
      "info",
      `workspace: pruned ${pruned.removed} walls (${pruned.segments} segments) in ` +
        `${pruned.rounds} rounds at a limit of ${limit.toExponential(2)} of the map`,
    );
    say(`${pruned.removed} dead-end wall${pruned.removed === 1 ? "" : "s"} deleted`);
  } catch (error) {
    // The write is what makes it real, so a failure leaves the GM with the graph they had. Said
    // loudly, because the picture is about to be redrawn from the graph that did *not* change.
    const detail = describeError(error);
    say(`could not save the pruned walls: ${detail}`, "bad");
    devLog("error", "workspace: pruning failed to save", detail);
    console.error("Fog Nudger — pruning failed to save", error);
  } finally {
    // Through the gate rather than straight to `disabled`, or a run that finished would re-enable
    // the button whatever the limit and the graph now say.
    refreshPruneAction();
  }
}
