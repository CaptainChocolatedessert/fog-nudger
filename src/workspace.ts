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
import { onStepChange, onStepOpen, registerStepContent, renderPanel } from "./workspace/accordion";
import { registerBreaksLayer } from "./workspace/layers/breaks";
import { registerInkLayer } from "./workspace/layers/ink";
import { registerPaintLayer } from "./workspace/layers/paint";
import { registerGraphLayer } from "./workspace/layers/graph";
import { registerRegionsLayer } from "./workspace/layers/regions";
import { registerSkeletonLayer } from "./workspace/layers/skeleton";
import { renderMapPicker, watchSceneMaps } from "./workspace/mapPicker";
import { renderSwatches } from "./workspace/swatches";
import { loadNominatedMap } from "./workspace/mapSource";
import { noteReadingForBreaks } from "./workspace/breakSearch";
import { noteRaster, onPaintWriteFailure } from "./workspace/paintState";
import { renderInkTools } from "./workspace/paintControls";
import { finishPaint, registerPaintTool, requestPaintMode } from "./workspace/paintTool";
import { onReading } from "./workspace/reading";
import { invalidateRegions, registerRegionInvalidation, watchRegions } from "./workspace/regions";
import { registerSkeletonInvalidation, watchSkeleton } from "./workspace/skeleton";
import { pushOnClose, renderPushAction } from "./workspace/pushAction";
import { refreshHints, setControlsLive } from "./workspace/settingRows";
import { registerWallEdit } from "./workspace/wallEdit";
import { renderWallTools } from "./workspace/wallTools";
import { renderFreezeAction } from "./workspace/freezeAction";
import { onStageChange } from "./workspace/stage";
import { loadSettings, onSettingsWriteFailure } from "./workspace/settingsState";
import { onMapClick, say, setCloseAction, start } from "./workspace/shell";

installDevLog("workspace");

// The settings holder is DOM-free on purpose, so it cannot report its own failures. A failed write
// loses the GM's whole tuning, which is not something to leave in the log alone.
onSettingsWriteFailure((message) => {
  say(message, "bad");
});

// The same arrangement for the paint layers, and the same reason: a failed write means the GM goes
// on painting into something that is not being saved, which the log alone cannot tell them.
onPaintWriteFailure((message) => {
  say(message, "bad");
});

/*
  A paint layer is the size of the mask it acts on, so the reading is what says how big to make one.

  Registered before the layers for the reason the two invalidations above it are: this cannot fail
  and does not draw anything, so it must not be skipped by a layer that could not allocate. A paint
  mode opened before this has ever run has no raster and declines, which is what lets the press pan
  instead.
*/
onReading((result) => {
  noteRaster(result.mask.width, result.mask.height);
  /*
    And the break search takes its base ink from the same reading, dropping whatever it had found.

    **Dropping rather than keeping** is the part that matters: the marks describe ink that has just
    been replaced, and there is no way to know they are still where they were without searching
    again. A ring left over a map whose reading has moved is exactly the failure this project has
    already paid for once — a diagnostic that looked clean and was answering about something else.
  */
  noteReadingForBreaks(result.mask);
});

/*
  A new reading is a new partition, and a new skeleton.

  **Registered BEFORE the layers, and that order is load-bearing.** `publish` walks its listeners in
  registration order and stops at the first one that refuses a reading, which is how a layer that
  cannot allocate blanks the mask instead of leaving a stale one on screen. Behind the layers, these
  two were part of what got cancelled — so a failed reading left the *partition* from the previous
  mask marked current, and opening a step that draws it showed it as though it were this reading's, with
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
/*
  Over the ink and under the breaks, which is the order the three compose in.

  A pixel the GM suppressed and the repair then filled **is** ink downstream — suppression runs
  before the break search — so the purple has to sit over the amber or the picture would claim a
  removal the mask did not make. Added ink is drawn by the same painter and wins over suppression
  within it, matching its place at the end of the composition.
*/
registerPaintLayer();
registerBreaksLayer();
/*
  The partition, and it moved BELOW the skeleton when the Regions step was dissolved.

  It could sit anywhere while only one step drew it. Now Walls draws it with the centrelines on top,
  and the order is the whole of whether that step is legible: the rooms are an area fill and the
  skeleton is a one-pixel line, so a fill drawn after it covers the thing being judged. Rooms under
  their cause, in both of the steps that show them.
*/
registerRegionsLayer();
registerSkeletonLayer();
// Last, so the editable graph sits over the rooms it makes rather than under them.
registerGraphLayer();
/*
  The one tool on this surface that changes the GM's own work rather than a setting.

  Registered here with the layers because it is the other half of one thing: the tool holds the
  gesture and the layer draws it, and neither is any use alone. The step declares that a drag means
  this; the shell offers every press to it and it takes the ones that land on a vertex.
*/
registerWallEdit();
/*
  The brush, which is the other tool on this surface.

  Registered against the `brush` drag rather than against a step, so the two tools cannot be swapped
  into the wrong slot: a step declares which kind of drag it wants and the shell reaches for the
  handler that implements it. All three ink tools share this one — which layer a press writes into is
  the tool in hand, not a second handler.
*/
registerPaintTool();
/*
  Deriving costs the better part of a second in stage one and is visible in two steps, so entering
  one of them is what pays for it. Both are told on every change, which is why the module keeps a set
  rather than a flag.

  The two are **Walls and Edit walls** since the Regions step was dissolved: the partition is drawn
  wherever a graph is drawn. Walls therefore subscribes twice, once for the rooms and once for the
  centrelines over them, which is two independent costs a single entry happens to pay for.
*/
onStepOpen("walls", (open) => watchRegions("walls", open));
onStepOpen("edit", (open) => watchRegions("edit", open));
// Thinning is the same shape of cost and gets the same answer: entering the step pays for it.
onStepOpen("walls", watchSkeleton);
/*
  Whether the paint mode is open, which is whether Ink is the step the GM is in.

  `onStepChange` rather than `onStepOpen`, and the reason survived the merge in a weaker form: it
  says where the GM now *is*, once, where the per-step listeners deliver a move as an arrival and a
  departure in registration order. With one painting step that ordering no longer matters, but the
  destination is still the honest thing to be told, and `requestPaintMode` serialises what follows —
  leaving Ink and coming back inside the second the write takes is a write and then an open.
*/
onStepChange((step) => {
  requestPaintMode(step === "ink");
});

// The one step whose body is not built from parameters: choosing a map is a list of what the scene
// holds, not a number to turn.
registerStepContent("map", renderMapPicker);
/*
  The three ink tools, under the sliders they correct the results of, and one Save under them.

  **One step, three tools** since 2026-09-05 (user): the picker names the layer a press writes into
  and a pair inside it says paint or erase. Both paint layers are held open together while the step
  is, which is what makes flicking between them free — the thing two separate steps could not offer,
  because leaving one wrote it to the scene.
*/
registerStepContent("ink", renderInkTools, "bottom");
// The ink colour leads its step: the first thing a GM does when the overlay is invisible against a
// particular map is change the colour, and it is not a number so it cannot be a row.
registerStepContent("ink", renderSwatches);
/*
  The door lives in the step it is the door to.

  It was at the end of Regions, which its own doc called a first answer pending "a step of its own
  once stage two has real editing tools". Edit walls is that step, and the button reads differently
  from inside it: in stage one the step has nothing in it and the button is what puts something
  there, and in stage two it is the way back out. A door at the boundary rather than one room away.
*/
// What you do with the walls, above the way out of the step that holds them.
registerStepContent("edit", renderWallTools);
registerStepContent("edit", renderFreezeAction, "bottom");
/*
  Pushing stays with the partition, which is the thing it writes and the thing being judged.

  That used to mean the Regions step. With Regions dissolved the partition is drawn in two steps,
  and this goes to **Walls** — the last step of stage one, and the one whose two controls decide the
  geometry that gets written. Edit walls has the door at its foot instead, which is what a GM in
  stage two reaches for.
*/
registerStepContent("walls", renderPushAction, "bottom");

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
setCloseAction(async () => {
  /*
    The paint is written **before** the push, and the order is the whole of it.

    A push re-runs the trace from what scene metadata holds, so a layer still sitting in a paint
    mode's working copy would simply not be in what goes on the map — the GM would have painted,
    closed, and got fog derived from ink without their edits. Sequenced here rather than inside the
    push, because the shell owns the way out and the push has no business knowing that a brush
    exists.
  */
  await finishPaint("leaving");
  await pushOnClose();
}, requestPushStop);

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
/*
  Crossing the door also changes what the rooms are made of, so the partition goes with it.

  Freezing, starting over and loading a scene's stored graph all change which of the two sources the
  partition comes from — the map or the frozen graph. Without this, crossing the door would leave the
  previous stage's partition on screen marked current, which is exactly the "shows the rooms before
  your edits" failure the two-source split exists to prevent.
*/
onStageChange(() => {
  renderPanel();
  invalidateRegions();
});

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
  setControlsLive(true);
  // Repainted wholesale rather than patched, so there is no path by which a row keeps a value from
  // the defaults it was first drawn with.
  renderPanel();

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
