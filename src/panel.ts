/**
 * The action popover: what acts on the *scene*, and nothing else.
 *
 * Every control a GM turns is a step on the workspace now. What is left here is the button that
 * opens it, removing what we put in the scene, and the diagnostics — and what those have in common is
 * that they are about a scene rather than about a picture. Which is also why they are not on the
 * workspace: a full-screen sheet over the map is the one place you cannot look at the map as
 * Owlbear is actually drawing it, and that is exactly what these buttons need you to do.
 *
 * **This used to list three buttons for moving staged items around.** Staging is gone: there is one
 * operation, push, and the workspace both judges the partition and triggers the write.
 *
 * **The three stage tabs went with the controls.** They carried a cascade that is still real and
 * still declared — reading destroys deriving, deriving destroys adjusting — but a cascade is a
 * property of *settings*, and there are none here. Tabs over a short list of actions with no
 * ordering between them would have been claiming one.
 *
 * It also remains what it started as: a second, independent signal that the extension is talking to
 * Owlbear. The background page reports through the dev log; this reports on screen. Two signals
 * separate "the manifest never loaded" from "the manifest loaded and the background script failed",
 * which one signal cannot do.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { themeVariables } from "./theme";
// `placeProbeShapes` and `removeProbeShapes` are deliberately NOT wired up. They answered roadmap
// step 1 — every finding is recorded in DESIGN.md §4 — and leaving their buttons on the panel would
// invite someone to scatter magenta squares across a real map. The code stays so re-measuring is
// cheap if Owlbear's fog behaviour ever changes; import them here to bring the buttons back, and
// re-add the markup in panel.html.
//
// `promoteStaged` was a third and is **deleted**, not unwired. It modelled the accept gesture, and
// staging is gone — but the reason to delete rather than keep was its doc, which recorded
// `visible: false` on the FOG layer as "not known to be load-bearing". It was: on that layer the
// flag is the difference between a shape that *is* fog and one that has been cleared, and believing
// that note is what shipped every accepted room coming back revealed. A corrected copy of a
// function for a design that no longer exists is an invitation to re-wire it.
import { inspectFogShapes } from "./probe/fogProbe";
// The overlay probe is not wired up either, and for a stronger reason than the shape-placing
// buttons: it measured whether a *click-through* sheet over the map was possible at all, and that
// design is closed — the workspace owns its input instead, and its probe measured the same modal
// answering a harder question. `overlayProbeControl.ts` and its page stay as the record of how the
// answer was got; re-import `openOverlayProbe` **and `closeOverlayProbe`** here and re-add both
// buttons to bring it back. Both, because opening a sheet you cannot close from the panel is
// survivable only for a click-through one, and would not be for anything else.
import { closeWorkspaceProbe, openWorkspaceProbe } from "./probe/workspaceProbeControl";
import { dryRun } from "./pipeline";
import { openWorkspace } from "./workspace/workspaceControl";
import { clearWallGraph } from "./wallGraphStore";
import {
  removeOurs,
} from "./emit/emitRegions";


installDevLog("ui");

const status = document.getElementById("status");
const result = document.getElementById("result");

function report(text: string, state: "ok" | "bad"): void {
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

function reportResult(text: string, state: "ok" | "bad"): void {
  if (!result) return;
  result.textContent = text;
  result.dataset.state = state;
}

/**
 * Wire a panel button.
 *
 * Buttons are disabled while their action runs. Not politeness: several of these write to the
 * scene, and a second click landing mid-write would place two sets of shapes or race a delete
 * against the add that created them. Staging in particular can take seconds on a large map, which
 * is exactly long enough for someone to click again.
 *
 * A failure is reported in plain words on the panel and in full to the console, through
 * `describeError` — the SDK rejects with a raw payload rather than an `Error`, so reading
 * `.message` would print `undefined` for every refusal it can produce, which is the whole class of
 * outcome this probe exists to observe.
 *
 * ## Two owners of `disabled`, reconciled through one flag
 *
 * The readiness subscription also sets `disabled` on every button, and it used to fight this one: a
 * readiness change landing mid-action re-enabled the button and defeated the double-click guard the
 * paragraph above exists for, while this one's `finally` set `disabled = false` unconditionally and
 * could enable a button after the scene had closed. Both now read `sceneOpen`, and the readiness
 * handler skips a button that is mid-run.
 */
/** Whether a scene is open, which is the other half of what decides a button's `disabled`. */
let sceneOpen = false;

/** Buttons whose action is still in flight, so the readiness handler leaves them alone. */
const running = new Set<HTMLButtonElement>();

function wireButton(id: string, run: () => Promise<string>): HTMLButtonElement | null {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) return null;

  button.addEventListener("click", () => {
    button.disabled = true;
    running.add(button);
    reportResult("Working…", "ok");
    void run()
      .then((message) => reportResult(message, "ok"))
      .catch((error: unknown) => {
        const detail = describeError(error);
        reportResult(`Failed: ${detail}`, "bad");
        console.error(`Fog Nudger — probe failed: ${detail}`);
      })
      .finally(() => {
        running.delete(button);
        // Not `false`: the scene may have closed while this ran, and re-enabling a button that
        // writes to a scene there is not is worse than leaving it dead.
        button.disabled = !sceneOpen;
      });
  });
  return button;
}

/**
 * Paint the page in Owlbear's colours, over the stylesheet's own readable defaults.
 *
 * Failure here is deliberately quiet on screen and loud in the log: a panel wearing the wrong
 * greys is still perfectly usable, so an error message about it would be noise sitting where the
 * actual content goes.
 */
/**
 * Take our fog out of the scene, and the saved walls with it.
 *
 * **The walls go too, and that is the user's answer to where discarding lives** (2026-09-05: *"the
 * panel has a way to clear objects that we own. the workspace doesn't need to provide that."*). The
 * wall editor therefore has no discard of its own — replacing the graph is what the ink mode's save
 * does, and removing it altogether is this.
 *
 * Without it the two halves would disagree: the fog would go and the next save from either workspace
 * would put the same walls straight back, which is a "remove" that does not remove.
 */
async function removeEverythingOfOurs(): Promise<string> {
  const message = await removeOurs();
  await clearWallGraph();
  return `${message} The saved wall editing for this scene was cleared too.`;
}

function applyTheme(theme: unknown): void {
  const style = document.documentElement.style;
  for (const [property, value] of Object.entries(themeVariables(theme))) {
    style.setProperty(property, value);
  }
}


OBR.onReady(async () => {
  // Same first move as the background page, and for the same reason. This page is a separate
  // iframe from it, so it has its own copy of the shim with its own unset label — which is how
  // this was missed the first time: the background page was labelled, the log looked labelled,
  // and the panel's lines were quietly going out as `?`.
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "ui"));
  } catch (error) {
    devLog("warn", "could not read player role", describeError(error));
  }

  devLog("info", "panel: connection ready");

  // Subscribe before reading, for the same reason the background page does: a theme changed in the
  // window between the two would otherwise never be observed. Both paths run `applyTheme`, which
  // is idempotent, so the overlap costs nothing.
  OBR.theme.onChange(applyTheme);
  try {
    applyTheme(await OBR.theme.getTheme());
  } catch (error) {
    devLog("warn", "could not read Owlbear's theme", describeError(error));
  }

  const buttons = [
    wireButton("dry-run", dryRun),
    /*
      One button, because there is one workspace.

      There were two — read the map, edit the walls — while those were separate pages. Merging them
      leaves nothing for a second button to mean: the reading controls and the wall tools are on the
      same surface, and which of them a GM reaches for is not a decision to make out here before
      seeing the map.
    */
    wireButton("open-workspace", openWorkspace),
    wireButton("remove", removeEverythingOfOurs),
    wireButton("inspect", inspectFogShapes),
    wireButton("workspace-probe-bare", () => openWorkspaceProbe("bare")),
    wireButton("workspace-probe-framed", () => openWorkspaceProbe("framed")),
    wireButton("workspace-probe-close", closeWorkspaceProbe),
  ];

  try {
    // A popover's connection going ready is NOT the scene being ready — the sibling lost two days
    // to treating them as the same event. Ask separately, and say which of the two is true.
    const ready = await OBR.scene.isReady();
    report(
      ready ? "Connected. Scene open." : "Connected. No scene open.",
      "ok",
    );

    // Subscribe as well as check, for the usual reason: a scene opened while the popover is already
    // up would otherwise leave the buttons dead with no explanation.
    const setEnabled = (open: boolean): void => {
      sceneOpen = open;
      // A button mid-action keeps its own `disabled`, which is what makes the double-click guard
      // survive a readiness change landing in the middle of a write.
      for (const button of buttons) {
        if (button && !running.has(button)) button.disabled = !open;
      }
      // Only on the way *down*. This used to write on every change, so a readiness event wiped
      // whatever the GM last clicked — including a failure message. Losing a stale "Ready." is
      // cheaper than losing an error.
      if (!open) reportResult("Waiting for a scene.", "ok");
    };
    OBR.scene.onReadyChange(setEnabled);
    setEnabled(ready);

  } catch (error) {
    // Plain text on screen, full detail to the console. The SDK's rejections are not `Error`s, so
    // this goes through `describeError` rather than reading `.message`, which would be undefined.
    report("Connected, but could not read the scene.", "bad");
    console.error(`Fog Nudger — scene readiness check failed: ${describeError(error)}`);
  }
});
