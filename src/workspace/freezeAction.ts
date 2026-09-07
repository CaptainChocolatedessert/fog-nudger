/**
 * How the ink mode ends: save the graph it has derived, put it on the map, and offer the editor.
 *
 * ## What this replaces, and why it is not a door any more
 *
 * It was a one-way door — *Generate the graph* in stage one, *Start over* in stage two — sitting at
 * the end of a step in an accordion that carried both. Two things dissolved it. The stages became
 * two **modes**, so crossing between them is opening the other page rather than passing a control;
 * and the ink mode's last step now draws the graph it would save, so the thing being committed to is
 * already on screen rather than one step ahead.
 *
 * > *"The last step of the ink mode displays the graph, post simplification. Saving out of ink mode
 * > pushes that graph."* — user, 2026-09-05
 *
 * So there is no generate-then-push: saving **is** both. The graph goes into scene metadata, where
 * the editor will find it, and the scene's fog is rewritten to match.
 *
 * ## Closing without saving commits nothing, and that is the point
 *
 * Everything the ink mode holds is derived from durable inputs — the settings, the map choice and
 * the two paint layers, all of which are written as they change. So leaving without saving loses
 * nothing at all, and it is what makes opening this mode over an edited graph **harmless**: looking
 * at the reading again cannot destroy walls somebody spent an evening moving.
 *
 * That is the third payoff the two-mode framing was predicted to produce, and it is the reason the
 * old all-or-nothing door has left the next list rather than being reworded.
 *
 * ## Why a dialog here, when the boundary used to be shown by disabling
 *
 * The reading controls used to dim themselves in stage two, because §8 wants a boundary visible
 * *before* it is crossed and a slider that throws a dialog when you nudge it is a trap. There is no
 * boundary to show any more: in this mode nothing is frozen and every control is live. What is left
 * is one deliberate, irreversible act — replacing a graph somebody has edited — and a confirmation
 * on a button the GM went looking for is exactly where a confirmation is not a trap.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { wallRuns } from "../trace/frozenGraph";
import { confirmAction } from "./confirmDialog";
import { controlsLive } from "./settingRows";
import { previewGraph } from "./regions";
import { pushCurrent } from "./pushAction";
import { say, closeWorkspace } from "./shell";
import { freezeTo, frozenGraph } from "./stage";
import { openWorkspace } from "./workspaceControl";

/**
 * Save the derived graph, then put it on the map.
 *
 * **In that order, and it matters.** The push reads the stored graph, so writing the metadata first
 * is what makes the scene a rendering of the document rather than of a copy beside it. A failed
 * write therefore stops before anything reaches the fog layer, which is the safe direction: the GM
 * keeps the fog they had and is told the save failed.
 */
async function saveAndPush(): Promise<boolean> {
  const graph = previewGraph();
  if (!graph) {
    say("nothing has been derived yet — open Walls and let it finish", "bad");
    return false;
  }

  await freezeTo(graph);
  const walls = wallRuns(graph).length;
  devLog("info", `workspace: saved ${walls} walls and ${graph.nodes.length} points`);
  /*
    The push's own answer decides whether the hand-off goes ahead.

    Since 2026-09-07 a GM can stop a slow write from here, and pressing that button most plainly
    means "let me out of this" rather than "carry on to the next thing". So a stopped push stays put
    and says so. **The graph is saved either way** — `freezeTo` ran first, deliberately — so nothing
    is lost by staying, and the editor is one button away whenever they want it.
  */
  return await pushCurrent();
}

/**
 * Whether replacing what is stored needs asking first.
 *
 * Only when a graph is already saved, because only then is anything lost — and what is lost is
 * whatever was done to it in the editor, which this cannot see and cannot get back.
 */
async function mayReplace(): Promise<boolean> {
  const stored = frozenGraph();
  if (!stored) return true;
  return confirmAction({
    title: "Replace the saved walls?",
    body: [
      `This map already has ${wallRuns(stored).length} walls saved, and any moving, drawing or ` +
        "erasing done to them in the wall editor goes with them. It cannot be undone.",
      "What replaces them is the graph on screen, exactly as it is drawn. Your reading settings, " +
        "your map choice and your ink edits are untouched either way.",
    ],
    confirmLabel: "Replace them",
    destructive: true,
  });
}

/**
 * The two ways out of the ink mode that keep its result.
 *
 * Both save and both push; the second goes on to open the editor. Two buttons rather than one and a
 * follow-up prompt, because the choice is made *before* the work rather than after it — a GM who
 * knows they are going to hand-edit should not have to wait for a push and then answer a question.
 *
 * **The hand-off is part of the feature rather than a nicety.** Split across two modes, the editor
 * is invisible from this surface; the cost of the split, stated when it was designed, is that the
 * sequence stops being legible from one accordion. This is what pays it.
 */
export function renderFreezeAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "chip";
  save.textContent = "Put the walls on the map";

  const handOff = document.createElement("button");
  handOff.type = "button";
  handOff.className = "chip";
  handOff.textContent = "Edit the walls";

  const note = document.createElement("p");
  note.className = "sub";
  note.innerHTML =
    "Both of these save the graph above and replace what we put in the scene before. <b>Closing " +
    "without pressing one saves nothing</b> &mdash; your settings and ink edits are kept whatever " +
    "you do, so coming back here is always cheap. <b>Edit the walls</b> saves and then opens the " +
    "editor, which is where a wall is moved, drawn or erased by hand.";

  const run = async (thenEdit: boolean): Promise<void> => {
    if (!(await mayReplace())) return;
    save.disabled = true;
    handOff.disabled = true;
    say(thenEdit ? "saving, then opening the editor…" : "saving and putting it on the map…", "working");
    try {
      if (!(await saveAndPush())) return;
      if (!thenEdit) return;
      /*
        The editor is opened **before** this page closes, which is why the two modes have separate
        modal ids.

        Closing first would mean making the second call from a page that is being torn down, and the
        record already carries one assumption of that shape that turned out to be untested. Opening
        first costs an instant where both modals exist, and the editor is full-screen, so what the GM
        sees is the surface they asked for arriving.
      */
      await openWorkspace("edit");
      await closeWorkspace();
    } catch (error) {
      const detail = describeError(error);
      say(`could not save the walls: ${detail}`, "bad");
      devLog("error", "workspace: saving the graph failed", detail);
      console.error("Fog Nudger — saving the graph failed", error);
    } finally {
      save.disabled = !controlsLive();
      handOff.disabled = !controlsLive();
    }
  };

  save.addEventListener("click", () => void run(false));
  handOff.addEventListener("click", () => void run(true));

  save.disabled = !controlsLive();
  handOff.disabled = !controlsLive();

  actions.append(save, handOff);
  body.append(actions, note);
}
