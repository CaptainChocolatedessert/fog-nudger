/**
 * Stage one: reading the map, on a surface that owns itself.
 *
 * ## What this file is
 *
 * The composition root, and nothing else. It builds the canvas stack, draws the panel, and runs the
 * start-up sequence. The surface itself is `workspace/shell.ts`; what the steps *are* is declared in
 * `steps.ts`, and each canvas layer is a module under `workspace/layers/`.
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
import { probeMapFraction } from "./pipeline";
import { describeError } from "./describeError";
import { requestPushStop } from "./emit/emitRegions";
import { onStepOpen, registerStepContent, renderPanel } from "./workspace/accordion";
import { registerBreaksLayer } from "./workspace/layers/breaks";
import { registerInkLayer } from "./workspace/layers/ink";
import { registerRegionsLayer } from "./workspace/layers/regions";
import { registerSkeletonLayer } from "./workspace/layers/skeleton";
import { renderMapPicker, watchSceneMaps } from "./workspace/mapPicker";
import { renderSwatches } from "./workspace/swatches";
import { loadNominatedMap } from "./workspace/mapSource";
import { onReading } from "./workspace/reading";
import { registerRegionInvalidation, watchRegions } from "./workspace/regions";
import { registerSkeletonInvalidation, watchSkeleton } from "./workspace/skeleton";
import { pushOnClose, renderPushAction } from "./workspace/pushAction";
import { refreshHints, setControlsLive } from "./workspace/settingRows";
import { renderFreezeAction } from "./workspace/freezeAction";
import { loadStage, onStageChange } from "./workspace/stage";
import { loadSettings, onSettingsWriteFailure } from "./workspace/settingsState";
import { onMapClick, say, setCloseAction, start } from "./workspace/shell";

installDevLog("workspace");

// The settings holder is DOM-free on purpose, so it cannot report its own failures. A failed write
// loses the GM's whole tuning, which is not something to leave in the log alone.
onSettingsWriteFailure((message) => {
  say(message, "bad");
});

/*
  A new reading is a new partition, and a new skeleton.

  **Registered BEFORE the layers, and that order is load-bearing.** `publish` walks its listeners in
  registration order and stops at the first one that refuses a reading, which is how a layer that
  cannot allocate blanks the mask instead of leaving a stale one on screen. Behind the layers, these
  two were part of what got cancelled — so a failed reading left the *partition* from the previous
  mask marked current, and opening the Regions step drew it as though it were this reading's, with
  nothing on the state line by then to say otherwise.

  Marking derived state stale is not a thing that can fail and does not depend on anything being
  paintable. A reading that produced a new mask has invalidated the partition whether or not a layer
  could show it.
*/
registerRegionInvalidation();
registerSkeletonInvalidation();

/*
  The canvas stack, in draw order.

  Ink first, breaks over it: invented pixels sit on top of read ones rather than under them. Which of
  them is on screen at any moment is the open step's call, declared in `steps.ts` — this only says
  what exists and in what order.
*/
registerInkLayer();
registerBreaksLayer();
registerSkeletonLayer();
registerRegionsLayer();
// Deriving costs the better part of a second and is visible in one step, so entering it is what pays
// for it.
onStepOpen("regions", watchRegions);
// Thinning is the same shape of cost and gets the same answer: entering the step pays for it.
onStepOpen("walls", watchSkeleton);

// The one step whose body is not built from parameters: choosing a map is a list of what the scene
// holds, not a number to turn.
registerStepContent("map", renderMapPicker);
// The ink colour leads its step: the first thing a GM does when the overlay is invisible against a
// particular map is change the colour, and it is not a number so it cannot be a row.
registerStepContent("ink", renderSwatches);
// The two actions on this surface that write to the scene, at the *end* of the step that judges what
// would be written. The door comes first: freezing is what decides whether the reading is still
// live, and pushing is the routine thing you do afterwards.
registerStepContent("regions", (body) => {
  renderFreezeAction(body);
  renderPushAction(body);
}, "bottom");

/*
  Closing writes the result to the scene.

  There is no staging layer any more, so the scene is simply a rendering of what the workspace holds
  — and closing is the moment the GM has stopped changing it. The button above is for the other case,
  updating a table mid-session without giving up the surface. Registered as a hook so the shell,
  which owns the way out, does not have to know that leaving means emitting.

  The second argument is how to give up on it. A push deletes our old fog before writing the new, so
  the sheet has to stay up until the write lands or the layer can be left half-replaced -- which
  means a stalled write would hold a GM on an opaque sheet. `requestPushStop` is what the shell's
  Exit anyway button calls, and it lives here rather than in the shell for the same reason
  `pushOnClose` does: the shell owns the way out and must not know what leaving writes.
*/
setCloseAction(pushOnClose, requestPushStop);

/*
  "What is here?" is a click on the map now, in every step.

  It was a button on the panel that probed the *viewport centre*, because a popover beside the map
  had no way to be pointed at anything. This surface does: the GM centres nothing, aims at the thing
  that looks wrong, and clicks it. `DESIGN.md` §8 insists this diagnostic be used rather than reasoned
  around, and the reason it insists is that every other one reports a total.
*/
onMapClick((u, v) => {
  say(probeMapFraction(u, v));
});

/*
  Crossing the door changes which controls are live, so the rows are rebuilt.

  Subscribed **once, here**, rather than by the rows or the button that draws it. Both of those are
  rebuilt on every accordion click, so a subscription inside either would add a listener per click,
  each holding DOM that has already been thrown away.
*/
onStageChange(renderPanel);

// The measurements a readout reports against only exist once a reading has landed. Registered after
// the layers, so a layer that could not take a reading stops this too.
onReading(() => {
  refreshHints();
});

start();
// Drawn now, disabled, from the defaults — see `controlsLive`.
renderPanel();
say("waiting for Owlbear…", "working");

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "workspace"));
  } catch (error) {
    devLog("warn", "workspace: could not read player role", describeError(error));
  }

  await loadSettings();
  // Before the first `renderPanel`, because the stage decides whether the reading controls are drawn
  // live or closed, and a row drawn live and disabled a moment later is a row that invited a click.
  const stage = await loadStage();
  setControlsLive(true);
  // Repainted wholesale rather than patched, so there is no path by which a row keeps a value from
  // the defaults it was first drawn with.
  renderPanel();

  // Said on the state line rather than only in the console, because it is a real loss: something was
  // stored and could not be read, so the GM's wall editing for this scene is gone. Distinguished from
  // "nothing stored yet", which is silent because it is the ordinary state of a new scene.
  if (stage.corrupt) {
    say("the saved wall editing could not be read and has been ignored — see the console", "bad");
  }

  // Watched before the first load, so a scene whose items arrive after this iframe does not leave
  // the picker empty — the race the panel's version lost on its first outing.
  watchSceneMaps();
  await loadNominatedMap(true);
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
