/**
 * The one-way door, as a pair of buttons at the end of the Edit walls step.
 *
 * In stage one it offers **Generate the graph**; in stage two it offers **Start over**. One slot,
 * two states, because they are the same door from the two sides and putting them in different places
 * would suggest they are different subjects.
 *
 * ## Why the Edit walls step
 *
 * **It was the Regions step until 2026-09-04**, on the argument that the thing being committed to is
 * the partition and Regions is where a GM judges it. That argument was sound and it was answered by
 * a step existing: this doc predicted stage two would want one, and the door belongs at the boundary
 * that step creates rather than one step short of it.
 *
 * It also reads better from inside. In stage one the Edit walls step is empty and this button is
 * what puts something in it; in stage two it is the way back out of the thing the GM is looking at.
 * The button that acts on the partition — the push — sits at the foot of **Walls**, which is the
 * step that shows what it would write.
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
import { freezeGraph, wallRuns, type Frozen } from "../trace/frozenGraph";
import { confirmAction } from "./confirmDialog";
import { controlsLive } from "./settingRows";
import { currentPaint } from "./paintState";
import { partitionCheck } from "./regions";
import { currentSettings } from "./settingsState";
import { say } from "./shell";
import { freezeTo, frozenGraph, inStageTwo, startOver } from "./stage";

/**
 * What freezing says afterwards, and why it is assembled rather than fixed.
 *
 * **The freeze message used to overwrite the traversal's, and that hid a failing check for a day**
 * (found in a room, 2026-09-05). Crossing the door triggers the stage change, which re-derives the
 * partition, which says its own line — and this one, written a moment later, replaced it. So the
 * numbers a GM needs and the one warning stage two has were both written into a channel and
 * immediately painted over.
 *
 * It carries them now. The traversal has already run by the time this is composed, synchronously,
 * inside the stage change; `partitionCheck` is where it left its answer.
 */
function freezeReport(stored: Frozen): { readonly text: string; readonly ok: boolean } {
  const check = partitionCheck();
  const parts: string[] = [];
  if (check) parts.push(`${check.rooms} room${check.rooms === 1 ? "" : "s"}`);
  // Walls rather than segments, because that is the unit a GM counts. A wall is a run of segments
  // chained through its bends, which is what the polyline used to be before it stopped being stored.
  parts.push(`${wallRuns(stored.graph).length} walls`);
  parts.push(`${stored.graph.nodes.length} points`);

  const notes: string[] = [];
  // Each of these is a room the map has and the document does not, so it is named rather than
  // buried in the log. Expected to be zero; the first map tried had one.
  if (stored.duplicates > 0) {
    notes.push(
      `${stored.duplicates} wall${stored.duplicates === 1 ? "" : "s"} dropped for lying on another ` +
        "— rooms thinner than the smoothing are gone",
    );
  }
  if (stored.zeroLength > 0) {
    notes.push(`${stored.zeroLength} wall${stored.zeroLength === 1 ? "" : "s"} of no length dropped`);
  }
  if (check && !check.ok) notes.push("CHECK FAILED, see the log");

  const head = `Graph frozen — ${parts.join(", ")}.`;
  const tail = notes.length === 0 ? " The reading is closed; Start over reopens it." : ` ${notes.join(" · ")}.`;
  // Any note at all is bad news: a dropped wall is a room the map has and the document does not,
  // and a failed check means the traversal is not to be trusted. Neither is a neutral figure.
  return { text: head + tail, ok: notes.length === 0 };
}

/**
 * Freeze what the current settings derive.
 *
 * It re-runs the trace rather than freezing whatever the preview happens to hold, for the same
 * reason "Put on the map" does: one implementation of the chain, and the thing stored is provably
 * the thing the emit path would write rather than a possibly-stale copy beside it.
 */
async function generate(): Promise<{ readonly text: string; readonly ok: boolean }> {
  const outcome = await runTrace({ settings: currentSettings(), paint: currentPaint() });
  if (!outcome.ok) return { text: outcome.message, ok: false };

  const stored = freezeGraph(outcome.run.graph, outcome.run.fittedEdges);
  if (stored.duplicates > 0 || stored.zeroLength > 0) {
    devLog(
      "warn",
      `freeze: dropped ${stored.duplicates} duplicate and ${stored.zeroLength} zero-length ` +
        "segments — simplification collapsed a room to a doubled wall",
    );
  }
  await freezeTo(stored.graph);
  return freezeReport(stored);
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
              `This discards your wall editing — ${graph ? wallRuns(graph).length : 0} walls and ` +
                `${graph?.nodes.length ?? 0} points. It cannot be undone.`,
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
          const report = await generate();
          say(report.text, report.ok ? "" : "bad");
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
