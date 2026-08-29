/**
 * Stage one: reading the map, on a surface that owns itself.
 *
 * ## What this file is
 *
 * The composition root, and nothing else. It names the steps, hands them to the shell, and runs the
 * start-up sequence. The surface itself is `workspace/shell.ts`; each step is a module under
 * `workspace/steps/`.
 *
 * ## What this replaces, and why it is smaller than what it replaces
 *
 * The click-through ink overlay was transparent so that drags reached Owlbear, which meant it could
 * never know where the map was except by asking — a 40ms poll of two world points, a settle
 * interval, a blank-and-restore so it was never present-and-wrong, a reserved band down one side so
 * it did not paint over the popover, and a heartbeat from the popover so it knew when to reserve
 * one. Every one of those was machinery for not owning the transform (`DESIGN.md` §4).
 *
 * This surface draws the map itself. Map and mask go into one canvas under one transform, so they
 * agree **by construction** rather than by our arithmetic agreeing with Owlbear's, and a whole class
 * of registration failure stops existing. None of the machinery above is here.
 *
 * ## Wired at module load, and that is not an accident
 *
 * Everything that does not need the SDK is attached before `OBR.onReady` — the steps, their
 * controls, the frame loop, the keyboard claim. The probe learned three times that a listener
 * written inside the Owlbear path is silently dead until Owlbear answers, and outside a room
 * `onReady` never fires at all.
 *
 * ## Getting out
 *
 * Escape, and a button that stays visible when the controls are hidden. **No dismissal timer**: the
 * probe had one because an opaque sheet that might swallow every click is a trap, and that risk was
 * real while input capture was unmeasured. Fifteen runs later it is measured, and a working surface
 * that evicts a GM mid-tuning would trade a certain cost against a retired risk.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { resolveTraceMap } from "./map/mapImage";
import { adoptOpeningReading, onReading, readOnOpen } from "./workspace/reading";
import { refreshHints, setControlsLive } from "./workspace/settingRows";
import { loadSettings } from "./workspace/settingsState";
import { renderSteps, wireSteps, type Step } from "./workspace/step";
import { openOnOwlbearsView, say, setMapImage, setMapName, start } from "./workspace/shell";
import { gapsStep } from "./workspace/steps/gaps";
import { inkStep } from "./workspace/steps/ink";
import { viewStep } from "./workspace/steps/view";
import { wallsStep } from "./workspace/steps/walls";

installDevLog("workspace");

/**
 * The steps, in the order they are met — and, for the painters, the order they are drawn.
 *
 * The ink goes down before the breaks, which is what puts invented pixels over read ones rather
 * than under them. View is last because it is not a step at all: it is the persistent group that
 * decides how everything above it is drawn.
 */
const STEPS: readonly Step[] = [inkStep, wallsStep, gapsStep, viewStep];

wireSteps(STEPS);
// The measurements a readout reports against only exist once a reading has landed. Registered after
// the steps, so a step that could not take a reading stops this too.
onReading(() => {
  refreshHints();
});

start();
// Drawn now, disabled, from the defaults — see `controlsLive`.
renderSteps(STEPS);
say("waiting for Owlbear…", "working");

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "workspace"));
  } catch (error) {
    devLog("warn", "workspace: could not read player role", describeError(error));
  }

  await loadSettings();
  setControlsLive(true);
  // Repainted wholesale rather than patched, so there is no path by which a row keeps a value from
  // the defaults it was first drawn with.
  renderSteps(STEPS);

  const result = await readOnOpen();
  if (!result) {
    say("no map nominated — choose one in the panel", "bad");
    setMapName("No map nominated.");
    return;
  }

  setMapName(result.mapName);

  // The map image, drawn by us rather than by Owlbear. `crossOrigin` matches the pipeline's loader:
  // it proves the CDN sends the headers, and matching it means this cannot succeed where a trace
  // would fail.
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    setMapImage(image);
    void openOnOwlbearsView(result.bounds);
  };
  image.onerror = () => {
    say("the map image would not load", "bad");
    devLog("error", "workspace: the map image failed to load");
  };
  image.src = (await resolveTraceMap())?.image.url ?? "";

  adoptOpeningReading(result);
}

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces no Owlbear activity. That silence is correct rather than a failure.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    say(`Workspace failed: ${detail}`, "bad");
    devLog("error", "workspace: failed to start", detail);
  });
});
