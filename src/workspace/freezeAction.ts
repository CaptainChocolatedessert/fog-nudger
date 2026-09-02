/**
 * The one-way door, as a pair of buttons at the end of the Regions step.
 *
 * In stage one it offers **Generate the graph**; in stage two it offers **Start over**. One slot,
 * two states, because they are the same door from the two sides and putting them in different places
 * would suggest they are different subjects.
 *
 * ## Why the Regions step
 *
 * The thing being committed to is the partition, and this is the step that draws it. A GM freezes
 * when the rooms look right, which is a judgement they can only make while looking at them.
 *
 * *Placement is a first answer rather than a settled one.* Once stage two has real editing tools it
 * may want a step of its own, and the door would move to whatever boundary that creates.
 *
 * ## Why a dialog here and disabled controls elsewhere
 *
 * §8 wants the boundary visible **before** it is crossed. A dialog cannot do that on its own — it
 * appears after the GM has already committed to the gesture. So the reading controls disable
 * themselves in stage two and say why, which is the continuous statement; this is the deliberate
 * action they went looking for, and it is the one place a confirmation is not a trap.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { runTrace } from "../pipeline";
import { freezeGraph } from "../trace/frozenGraph";
import { confirmAction } from "./confirmDialog";
import { controlsLive } from "./settingRows";
import { currentSettings } from "./settingsState";
import { say } from "./shell";
import { freezeTo, frozenGraph, inStageTwo, startOver } from "./stage";

/**
 * Freeze what the current settings derive.
 *
 * It re-runs the trace rather than freezing whatever the preview happens to hold, for the same
 * reason "Put on the map" does: one implementation of the chain, and the thing stored is provably
 * the thing the emit path would write rather than a possibly-stale copy beside it.
 */
async function generate(): Promise<string> {
  const outcome = await runTrace(currentSettings());
  if (!outcome.ok) return outcome.message;

  const stored = freezeGraph(outcome.run.graph, outcome.run.fittedEdges);
  await freezeTo(stored);
  return (
    `Graph frozen — ${stored.nodes.length} points, ${stored.edges.length} walls. ` +
    "The reading is closed; Start over reopens it."
  );
}

export function renderFreezeAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";

  const note = document.createElement("p");
  note.className = "sub";

  const paint = (): void => {
    const stageTwo = inStageTwo();
    button.textContent = stageTwo ? "Start over" : "Generate the graph";
    button.className = stageTwo ? "chip urgent" : "chip";
    button.disabled = !controlsLive();
    note.textContent = stageTwo
      ? "The walls are yours to edit and the reading is closed. Start over discards the edits and " +
        "reopens it — your settings and ink are kept, so you come back to this same ink."
      : "Hands the walls over to be edited by hand. It closes the reading and the smoothing for " +
        "this map, and going back afterwards discards whatever you edited.";
  };

  button.addEventListener("click", () => {
    void (async () => {
      const stageTwo = inStageTwo();
      const graph = frozenGraph();

      const ok = stageTwo
        ? await confirmAction({
            title: "Start over?",
            body: [
              `This discards your wall editing — ${graph?.nodes.length ?? 0} points and ` +
                `${graph?.edges.length ?? 0} walls. It cannot be undone.`,
              "Your reading settings, your map choice and your ink edits are kept, so you come " +
                "back to the same ink you tuned rather than to a bare map.",
            ],
            confirmLabel: "Discard and start over",
            destructive: true,
          })
        : await confirmAction({
            title: "Generate the graph?",
            body: [
              "The walls become yours to edit by hand, and stop being recalculated from the map.",
              "That closes the reading for this map: the threshold, the linework filters, the " +
                "break repair and the edge smoothing all stop applying. Smoothing is the one " +
                "people are surprised by — re-tuning it means starting over.",
              "Nothing is lost by doing it. Starting over later brings the reading back exactly " +
                "as you left it; what it discards is the wall editing you did in between.",
            ],
            confirmLabel: "Generate",
          });
      if (!ok) return;

      button.disabled = true;
      say(stageTwo ? "starting over…" : "generating the graph…", "working");
      try {
        if (stageTwo) {
          await startOver();
          say("back to stage one — the reading is live again");
        } else {
          say(await generate());
        }
      } catch (error) {
        const detail = describeError(error);
        say(`could not write to the scene: ${detail}`, "bad");
        devLog("error", "workspace: the freeze failed", detail);
        console.error("Fog Nudger — freezing or discarding the graph failed", error);
      } finally {
        paint();
      }
    })();
  });

  /*
    No `onStageChange` subscription here, deliberately.

    This function runs on every `renderPanel`, and the accordion rebuilds every step's body on every
    header click — so subscribing would add a listener per rebuild, each holding a detached button,
    for the life of the session. The composition root subscribes `renderPanel` itself once, which
    rebuilds this along with everything else and re-runs the paint below.
  */
  paint();
  actions.append(button);
  body.append(actions, note);
}
