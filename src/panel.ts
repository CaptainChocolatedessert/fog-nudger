/**
 * The action popover: what acts on the *scene*, and nothing else.
 *
 * Every control a GM turns is a step on the workspace now. What is left acts on a **scene**: open the
 * workspace, remove what we put in it, and start the scene over. None belongs on the workspace — a
 * full-screen sheet over the map is the one place you cannot look at the map as Owlbear is actually
 * drawing it, and the last of the three resets the workspace itself, so living inside it would put it
 * out of reach in the case that needs it most.
 *
 * **The diagnostics band went on 2026-09-09** (user), after a long stretch of nobody pressing any of
 * it. The five functions behind those buttons are all still exported and still work; the import
 * block below says what each was and what to know before re-wiring it.
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
// The overlay probe is not wired up either, and for a stronger reason than the shape-placing
// buttons: it measured whether a *click-through* sheet over the map was possible at all, and that
// design is closed — the workspace owns its input instead, and its probe measured the same modal
// answering a harder question. `overlayProbeControl.ts` and its page stay as the record of how the
// answer was got; re-import `openOverlayProbe` **and `closeOverlayProbe`** here and re-add both
// buttons to bring it back. Both, because opening a sheet you cannot close from the panel is
// survivable only for a click-through one, and would not be for anything else.
//
/*
  ## The panel is two buttons now (user, 2026-09-09)

  *"Remove everything except open and remove ours. You can keep the machinery in the background if
  it's useful, and we could easily re-display a button for them if we need to. We haven't used them
  in a long time."*

  So five more joined the unwired list, and this is the record of what they were and how to get each
  back. **None of the code was deleted**; every function below is still exported and still works, so
  a button is this import plus one `wireButton` line plus the markup in `panel.html`.

  - `dryRun` from `./pipeline` — *Trace, emit nothing*. **Re-wire this one with care.** Its stated
    value was running exactly the emit path's code, so its numbers and the scene could not disagree
    by construction. The wall graph becoming the document ended that: `pushToFog` emits the **saved**
    graph and only calls `runTrace` when a map has none, so on a map with saved walls the dry run
    reported a freshly-derived graph that was not the one on the map. It also has a live substitute —
    `workspace/regions.ts` logs the identical `runTrace` summary on every derive.
  - `inspectFogShapes` from `./probe/fogProbe` — *Inspect fog*. This one is still entirely true, and
    it is the only thing that says what is actually on the `FOG` layer, ours against the GM's, with
    styles. It went with the band rather than on its own merits, and it is the first to bring back if
    a scene ever looks wrong.
  - `openWorkspaceProbe` and `closeWorkspaceProbe` from `./probe/workspaceProbeControl` — *Workspace
    probe*, *…framed* and *Close probe*. Re-import **both**, for the reason the overlay probe's note
    gives: this sheet is opaque, so opening one the panel cannot close is worse here than there.
    Its original question — whether a full-screen modal without `disablePointerEvents` is usable —
    is answered by the workspace running on that combination. What survives is its **leak
    detector**, still the only way to re-check that a change has not started letting input through
    to Owlbear, and the reason the page and its control are kept. The *framed* variant tested
    `hidePaper: false`; shipping bare decided that, so bare is the one to bring back.
*/
import { clearEverything } from "./clearScene";
import { confirmAction } from "./confirmDialog";
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

/**
 * The full clear, asked for first.
 *
 * **The same dialog the workspace uses**, which is the one way dangerous actions are confirmed here
 * (user, 2026-09-13). It was briefly a pair of armed buttons on the reasoning that a sandboxed iframe
 * cannot rely on `confirm()` — true of the *browser's* dialog, and beside the point: `confirmAction`
 * is ours and is plain DOM, and it carries its own styles so this page can draw it too.
 *
 * It names what goes, because two of the five are the ones a GM does not expect: their tuning, and
 * the map choice that makes the extension ask which image to read as though it had never seen the
 * scene. A declined dialog says so rather than saying nothing, which is what a GM who backed out of
 * a destructive button is checking for.
 */
async function askThenClear(): Promise<string> {
  const ok = await confirmAction({
    title: "Clear everything in this scene?",
    body: [
      "Our fog, the saved walls, the ink you painted, your reading settings and the map choice all " +
        "go. Anything you drew by hand stays.",
      "Undo does not reach this. It is the one thing on this surface that cannot be taken back.",
    ],
    confirmLabel: "Clear everything",
    destructive: true,
  });
  if (!ok) return "Nothing was cleared.";
  return clearEverything();
}

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
 * workspace therefore has no discard of its own — what it has is a prompt that replaces the graph
 * when a setting would rebuild it, and removing the walls altogether is this.
 *
 * Without it the two halves would disagree: the fog would go and the next push would put the same
 * walls straight back, which is a "remove" that does not remove.
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
    /*
      One button, because there is one workspace.

      There were two — read the map, edit the walls — while those were separate pages. Merging them
      leaves nothing for a second button to mean: the reading controls and the wall tools are on the
      same surface, and which of them a GM reaches for is not a decision to make out here before
      seeing the map.
    */
    wireButton("open-workspace", openWorkspace),
    wireButton("remove", removeEverythingOfOurs),
    wireButton("clear", askThenClear),
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
