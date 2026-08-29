/**
 * The action popover. Skeleton scope: say plainly whether the extension is talking to Owlbear.
 *
 * It exists at this stage as a second, independent signal. The background page reports through the
 * dev log; this reports on screen. Two signals separate "the manifest never loaded" from "the
 * manifest loaded and the background script failed", which one signal cannot do.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { themeVariables } from "./theme";
// `placeProbeShapes`, `promoteStaged` and `removeProbeShapes` are deliberately NOT wired up. They
// answered roadmap step 1 — every finding is recorded in DESIGN.md §4 — and leaving their buttons
// on the panel would invite someone to scatter magenta squares across a real map. The code stays
// so re-measuring is cheap if Owlbear's fog behaviour ever changes; import them here to bring the
// buttons back, and re-add the markup in panel.html.
import { inspectFogShapes, logCensus } from "./probe/fogProbe";
// The overlay probe is not wired up either, and for a stronger reason than the shape-placing
// buttons: it measured whether a *click-through* sheet over the map was possible at all, and that
// design is closed — the workspace owns its input instead, and its probe measured the same modal
// answering a harder question. `overlayProbeControl.ts` and its page stay as the record of how the
// answer was got; re-import `openOverlayProbe` here and re-add the markup to bring it back.
import { closeWorkspaceProbe, openWorkspaceProbe } from "./probe/workspaceProbeControl";
import { dryRun, probeWorldPoint } from "./pipeline";
import { openWorkspace } from "./workspace/workspaceControl";
import {
  DEFAULT_SETTINGS,
  isStageDefault,
  resetStage,
  STAGES,
  type Settings,
  type Stage,
} from "./settings";
import { readSettings, writeSettings } from "./settingsStore";
import {
  acceptStaged,
  removeOurs,
  restyleStaged,
  returnToStaging,
} from "./emit/emitRegions";


installDevLog("ui");

/**
 * Ask the pipeline what it computed where the GM is looking.
 *
 * The viewport centre rather than a click or a selection, because it needs no new interaction to
 * learn and no item to exist: centre the view on the thing that looks wrong and press the button.
 */
async function probeViewportCentre(): Promise<string> {
  const [width, height] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);
  const centre = await OBR.viewport.inverseTransformPoint({ x: width / 2, y: height / 2 });
  return probeWorldPoint(centre.x, centre.y);
}

let sceneReady = false;
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
 */
function wireButton(id: string, run: () => Promise<string>): HTMLButtonElement | null {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) return null;

  button.addEventListener("click", () => {
    button.disabled = true;
    reportResult("Working…", "ok");
    void run()
      .then((message) => reportResult(message, "ok"))
      .catch((error: unknown) => {
        const detail = describeError(error);
        reportResult(`Failed: ${detail}`, "bad");
        console.error(`Fog Nudger — probe failed: ${detail}`);
      })
      .finally(() => {
        button.disabled = false;
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
function applyTheme(theme: unknown): void {
  const style = document.documentElement.style;
  for (const [property, value] of Object.entries(themeVariables(theme))) {
    style.setProperty(property, value);
  }
}


let settings: Settings = DEFAULT_SETTINGS;

/**
 * Keep the reset buttons honest.
 *
 * All that is left of what was a settings panel. Every control a GM can turn is on the workspace
 * now — the reading's, the deriving stage's, and the two that decide how proposals are drawn, which
 * followed the partition across when the workspace started drawing it. What stays here is what acts
 * on the *scene*, and a scene is the one thing a full-screen sheet over the map cannot show you.
 *
 * The buttons are still worth having on this side: a reset is an action rather than a control, and
 * it is disabled when the stage it would reset is already at its defaults, which is the only reason
 * this function survives.
 */
function renderSettings(): void {
  for (const stage of STAGES) {
    const reset = document.getElementById(`reset-${stage}`);
    if (reset instanceof HTMLButtonElement) {
      reset.disabled = !sceneReady || isStageDefault(settings, stage);
    }
  }
}

async function save(next: Settings, stage?: Stage): Promise<void> {
  try {
    settings = await writeSettings(next);
  } catch (error) {
    const detail = describeError(error);
    reportResult(`Could not save the setting: ${detail}`, "bad");
    console.error(`Fog Nudger — saving settings failed: ${detail}`);
    return;
  }
  renderSettings();
  // Named per stage, because what a GM has to do next differs and so does what it will cost them.
  // A reading change means the image is read again and everything downstream is discarded; a
  // deriving change reuses the reading and only regenerates the polygons.
  reportResult(
    stage === "read"
      ? "Saved. Trace again — this re-reads the map and discards work in tabs 2 and 3."
      : stage === "derive"
        ? "Saved. Derive again — this reuses the reading and discards hand edits."
        : "Saved.",
    "ok",
  );
}

/** Put one stage's parameters back to their defaults, leaving the other stages alone. */
async function resetStageSettings(stage: Stage): Promise<string> {
  await save(resetStage(settings, stage), stage);
  return stage === "read"
    ? "Reading back to defaults. Trace again to see it."
    : stage === "derive"
      ? "Region derivation back to defaults. Derive again to see it."
      : "Appearance back to defaults.";
}

/** Show one tab. Kept plain: one button and one panel per stage, one selected. */
function selectTab(which: Stage): void {
  for (const stage of STAGES) {
    const tab = document.getElementById(`tab-${stage}`);
    const panel = document.getElementById(`panel-${stage}`);
    tab?.setAttribute("aria-selected", String(stage === which));
    if (panel) panel.hidden = stage !== which;
  }
}

// Painted once at load, before Owlbear is known to be there at all. The values are the defaults
// and every control is disabled until a scene opens, but the panel shows what it is rather than an
// empty column — which is the same rule the status line follows, and the reason the map picker was
// reported as broken when it was merely empty.
renderSettings();

// Wired at load rather than inside `onReady`: switching tabs is pure UI and has no business waiting
// on the SDK. It *was* inside, and outside a room the tabs were simply dead — which is also how it
// was caught, since the SDK is inert there by design.
for (const stage of STAGES) {
  document.getElementById(`tab-${stage}`)?.addEventListener("click", () => selectTab(stage));
}
selectTab("read");

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
    wireButton("probe", probeViewportCentre),
    wireButton("open-workspace", openWorkspace),
    wireButton("accept", acceptStaged),
    wireButton("unaccept", returnToStaging),
    wireButton("remove", removeOurs),
    wireButton("census", logCensus),
    wireButton("inspect", inspectFogShapes),
    wireButton("workspace-probe-bare", () => openWorkspaceProbe("bare")),
    wireButton("workspace-probe-framed", () => openWorkspaceProbe("framed")),
    wireButton("workspace-probe-close", closeWorkspaceProbe),
    wireButton("restyle", restyleStaged),
    ...STAGES.map((stage) => wireButton(`reset-${stage}`, () => resetStageSettings(stage))),
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
      sceneReady = open;
      for (const button of buttons) if (button) button.disabled = !open;
      reportResult(open ? "Ready." : "Waiting for a scene.", "ok");
      // Settings live in scene metadata, so there is nothing real to show until a scene is open.
      if (open) {
        void readSettings()
          .then((loaded) => {
            settings = loaded;
            renderSettings();
          })
          .catch((error: unknown) => {
            console.error("Fog Nudger — reading settings failed: " + describeError(error));
          });
      } else {
        renderSettings();
      }
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
