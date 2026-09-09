/**
 * Pruning in the wall editor: the same operation the ink mode applies, run once when asked.
 *
 * ## Why a button here and a slider there
 *
 * `pruneWallGraph` deletes dead-end walls, and the two modes want it on opposite terms.
 *
 * In the ink mode the graph is a **derivation**: it is rebuilt from the reading every time anything
 * moves, so a budget is a setting that gets re-applied on every derive and turning it back down puts
 * the walls straight back. Nothing is lost by sweeping it.
 *
 * Here the graph is the **document**. There is nothing to re-derive it from, so applying a budget
 * deletes walls that do not come back — including, if the budget is high enough, walls the GM drew by
 * hand a minute ago. A slider that did that on release would destroy work on a gesture as small as
 * brushing the track, so what the editor gets is the same number and a deliberate act to apply it.
 *
 * The number lives in the same setting either way, which is the point: a GM who found a budget that
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
import { confirmAction } from "./confirmDialog";
import { currentSettings } from "./settingsState";
import { controlsLive } from "./settingRows";
import { say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";

export function renderPruneAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Prune the dead ends";
  button.disabled = !controlsLive();

  const note = document.createElement("p");
  note.className = "sub";
  note.innerHTML =
    "Deletes every dead-end wall shorter than <b>Prune spurs</b> above, once, and keeps going while " +
    "each deletion frees the next. <b>It cannot be undone</b> and it does not touch a wall that is " +
    "part of a room, however short &mdash; a loop has no free end to start from. Set the slider to " +
    "off and nothing happens.";

  button.addEventListener("click", () => {
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

  const budget = readParameter(currentSettings(), "spurPruneFraction");
  if (!(budget > 0)) {
    say("the prune budget is off — raise it above the left-hand end first", "bad");
    return;
  }

  /*
    Decided before it is confirmed, so the GM is told what it would actually cost.

    A budget is not a number anybody can picture on their own map: the same setting takes four hairs
    off one map and a third of the walls off another, because it depends entirely on how the linework
    was drawn. Running it first and asking second is what makes the confirmation say something —
    and it costs nothing, because the result is thrown away if the answer is no.
  */
  const pruned = pruneWallGraph(graph, budget);
  if (pruned.removed === 0) {
    say("nothing to prune — no dead end is that short");
    return;
  }

  const before = wallRuns(graph).length;
  const ok = await confirmAction({
    title: `Delete ${pruned.removed} dead-end wall${pruned.removed === 1 ? "" : "s"}?`,
    body: [
      `${pruned.removed} of this map's ${before} walls have a free end and are short enough to go, ` +
        `taking ${pruned.segments} segment${pruned.segments === 1 ? "" : "s"} with them. It cannot ` +
        "be undone.",
      "A wall that is part of a room is safe whatever the budget, because a loop presents no free " +
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
        `${pruned.rounds} rounds at a budget of ${budget.toExponential(2)} of the map`,
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
    button.disabled = !controlsLive();
  }
}
