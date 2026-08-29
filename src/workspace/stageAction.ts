/**
 * "Stage these" — the one button on this surface that writes to the scene.
 *
 * The Regions step ends with it because that is where the partition is judged, and judging it is the
 * only thing that makes staging a sensible next move. Everything else the workspace does is a
 * question about pixels; this is the answer being handed to Owlbear.
 *
 * ## It re-runs the trace rather than emitting what is on screen
 *
 * The preview holds region rings and could be turned into shapes here. It must not be: the emit path
 * has rules of its own — the command cap, the batching, the provenance stamped into each item — and
 * a second route into the scene would be a second implementation of them, drifting quietly until a
 * room disagreed with a preview. `stageRegions` runs the same `runTrace` the preview ran, against a
 * mask that is still cached, so the cost is the deriving half rather than a fresh read.
 *
 * ## The settings are written first, and awaited
 *
 * `stageRegions` reads scene metadata, and the workspace's sliders write there on release without
 * waiting. Clicking Stage a moment after letting go of a slider would otherwise stage the value
 * before it. One `await` closes that window.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { stageRegions } from "../emit/emitRegions";
import { controlsLive } from "./settingRows";
import { persistSettings } from "./settingsState";
import { say } from "./shell";

export function renderStageAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Stage these";
  button.disabled = !controlsLive();

  const note = document.createElement("p");
  note.className = "sub";
  note.textContent =
    "Puts these shapes in the scene on a layer that derives no walls, so a first run cannot " +
    "affect play. Accept or remove them from the panel.";

  button.addEventListener("click", () => {
    // Disabled while it runs. Staging takes seconds on a large map, which is exactly long enough
    // for a second click to land and place a second set of shapes.
    button.disabled = true;
    say("staging…", "working");
    void persistSettings()
      .then(() => stageRegions())
      .then((message) => say(message))
      .catch((error: unknown) => {
        const detail = describeError(error);
        say(`staging failed: ${detail}`, "bad");
        devLog("error", "workspace: staging failed", detail);
        console.error("Fog Nudger — staging failed", error);
      })
      .finally(() => {
        button.disabled = !controlsLive();
      });
  });

  actions.append(button);
  body.append(actions, note);
}
