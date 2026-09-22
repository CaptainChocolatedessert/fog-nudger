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
import {
  registerToolContent,
  registerStepContent,
  renderPanel,
} from "./workspace/drawer";
import { applyPalette } from "./workspace/palette";
import { registerLayerRow } from "./workspace/layerRow";
import { onToolChange, registerToolPalette } from "./workspace/toolPalette";
import { registerUndoAction } from "./workspace/undoAction";
import { refreshInkProfiles } from "./workspace/inkProfiles";
import { registerBlobLayer } from "./workspace/layers/blob";
import { registerGapsLayer } from "./workspace/layers/gaps";
import { registerInkLayer } from "./workspace/layers/ink";
import { registerPaintLayer } from "./workspace/layers/paint";
import { registerGraphLayer } from "./workspace/layers/graph";
import { registerMendsLayer } from "./workspace/layers/mends";
import { registerCollapsesLayer } from "./workspace/layers/collapses";
import { registerDeltaLayer } from "./workspace/layers/delta";
import { registerRegenerateReview } from "./workspace/regenerateGuard";
import { registerRegionsLayer } from "./workspace/layers/regions";
import { registerDefaultSeeds } from "./workspace/seedDefaults";
import { refreshWallAmounts, renderAmountControls } from "./workspace/wallAmounts";
import { renderMapPicker, watchSceneMaps } from "./workspace/mapPicker";
import { renderSwatches } from "./workspace/colourRows";
import { loadNominatedMap } from "./workspace/mapSource";
import { noteReadingForGaps } from "./workspace/gapSearch";
import { noteRaster, onPaintWriteFailure } from "./workspace/paintState";
import { renderToolControls } from "./workspace/paintControls";
import { renderMendControls } from "./workspace/mendControls";
import { renderCollapseControls } from "./workspace/collapseControls";
import { renderMarkControls } from "./workspace/markControls";
import { finishPaint, registerPaintTool } from "./workspace/paintTool";
import { onReading } from "./workspace/reading";
import { invalidateRegions, registerRegionInvalidation } from "./workspace/regions";
import { pushOnClose, renderPushAction } from "./workspace/pushAction";
import { onSettingCommitted } from "./workspace/recompute";
import { refreshHints } from "./workspace/settingRows";
import { setControlsLive } from "./workspace/settingsState";
import { registerWallEdit } from "./workspace/wallEdit";
import { onStageChange } from "./workspace/stage";
import { loadSettings, onApplied, onSettingsWriteFailure } from "./workspace/settingsState";
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
    And the gap search takes its base ink from the same reading, dropping whatever it had found.

    **Dropping rather than keeping** is the part that matters: the marks describe ink that has just
    been replaced, and there is no way to know they are still where they were without searching
    again. A ring left over a map whose reading has moved is exactly the failure this project has
    already paid for once — a diagnostic that looked clean and was answering about something else.
  */
  noteReadingForGaps(result.mask);
  /*
    And ask for the two ink filters' distributions, which arrive a frame later.

    **Booked rather than computed here.** The stroke profile opens the mask once per radius the
    slider can reach, which is the same order of work as the reading that has just finished — doing
    it inside this listener would roughly double what a slider release costs, to draw a hint. The map
    goes up first and the shape follows it.
  */
  refreshInkProfiles();
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

/*
  Seed the per-map defaults — the simplification tolerance and the mend tool's two distances — from
  the first reading of a map.

  Registered here rather than inside the Walls step because it belongs to the *reading*, not to any
  step, and because a step's body is rebuilt on every accordion click — a subscription there leaks a
  listener per click. It is deliberately order-independent of the invalidation above: it invalidates
  the partition itself rather than relying on running first.
*/
registerDefaultSeeds();

/*
  The canvas stack, in draw order.

  Ink first, gaps over it: invented pixels sit on top of read ones rather than under them. Which of
  them is on screen at any moment is the open step's call, declared in `steps.ts` — this only says
  what exists and in what order.
*/
registerInkLayer();
/*
  Over the ink and under the gaps, which is the order the three compose in.

  A pixel the GM suppressed and the repair then filled **is** ink downstream — suppression runs
  before the gap search — so the purple has to sit over the amber or the picture would claim a
  removal the mask did not make. Added ink is drawn by the same painter and wins over suppression
  within it, matching its place at the end of the composition.
*/
registerPaintLayer();
registerGapsLayer();
/*
  Over the paint and under the partition: a fill preview says what the ink is about to lose, so it
  belongs with the other marks on the ink rather than over the rooms those marks would change.
*/
registerBlobLayer();
/*
  The partition, under the graph in both modes.

  It could sit anywhere while only one step drew it. Both of the steps that draw it now put a graph
  on top, and the order is the whole of whether either is legible: the rooms are an area fill and a
  wall is a two-pixel line, so a fill drawn after it covers the thing being judged. Rooms under their
  cause, in both modes.
*/
registerRegionsLayer();
// Last, so the graph sits over the rooms it makes rather than under them.
registerGraphLayer();
// Over the walls, so a proposed mend sits on top of the break it would close.
registerMendsLayer();
// And the small regions on offer, over the walls a collapse would take.
registerCollapsesLayer();
/*
  Last, so the delta draws over the walls it is about.

  Under them it would be the wrong way round: the marks say *these are the ones at stake*, and
  the blue centreline they lie exactly on top of would hide most of each one.
*/
registerDeltaLayer();
// The two answers the delta is drawn for, in the bar rather than in a box over the map.
registerRegenerateReview();
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
  Deriving costs the better part of a second in the ink mode and is visible in one step per mode, so
  entering that step is what pays for it. Every listener is told on each change, which is why the
  module keeps a set rather than a flag — the two ids never coexist on one page, but the module does
  not know that and should not have to.

  In the editor it is a walk of a graph already in hand, which is cheap enough that the laziness
  costs nothing there.
*/
/*
  The paint mode follows the **tool**, not a heading, and `toolPalette` is where that happens.

  It was `onStepChange((step) => requestPaintMode(step === "ink"))` while a step was the mode. Under
  a rail that no longer forces one section shut, a heading says nothing about what a press does — so
  a GM could collapse Ink with a brush still in hand and the working copies would have gone out from
  under it. Tying the copies to the brush is also what they always meant.
*/

// Published before anything is drawn, so the stylesheet's colour words and the canvas's marks come
// from one declaration rather than two that have to be kept in step by hand.
applyPalette();
// The tool strip, which owns what a press means and is why the rail below it need not be exclusive.
registerToolPalette();
// The layer switches, and the one subscription that keeps the canvas and the row agreeing about what
// is drawn.
// The row lives in the drawer, so a layer change asks the drawer to redraw rather than
// rebuilding a fixed element in place.
registerLayerRow(renderPanel);
// Undo, in the bar rather than in a group: it takes back a change to the document, not to whatever
// section happens to be expanded.
registerUndoAction();

// The one step whose body is not built from parameters: choosing a map is a list of what the scene
// holds, not a number to turn.
registerStepContent("map", renderMapPicker);
/*
  Nothing at the foot of Ink. **Save painted strokes** was here and is deleted (user, 2026-09-14):
  putting the brush down saves, switching group saves, and closing saves, so its absence cost
  nothing and its presence implied the opposite.
*/
/*
  The tool's own controls go to the pinned head instead, and only Save is left in the step.

  A room could not find the brush width: it needed the section expanded, a tool selected and a scroll
  to the bottom, all at once. The head cannot be scrolled past or collapsed, and it is where the tool
  hint already sits for the same reason.
*/
registerToolContent(renderToolControls);
registerToolContent(renderMendControls);
// *Collapse small regions*' size and its button, in the drawer arming the tool opens.
registerToolContent(renderCollapseControls);
/*
  And *Suppress region*'s, which is a drawer holding one button and no settings.

  The marks are that tool's own document — nothing else places or removes one — so taking them all
  off belongs beside it rather than in the Walls band, where *Clear wall edits* deliberately leaves
  them alone.
*/
registerToolContent(renderMarkControls);
/*
  And the two amounts, one slider each, in the drawer that arming the tool opens.

  **Registered as tool content since 2026-09-21**, which is what makes the latch work unchanged:
  it pins when the drawer opens and applies when it closes, and those are the same two events they
  always were — arming the tool rather than pressing the group's settings button.
*/
registerToolContent(renderAmountControls);
/*
  The rail redraws when the tool changes, which it did not until now.

  `onToolChange` was exported when the picker moved to the strip and **nothing ever subscribed to
  it** — so choosing a tool set the state, redrew the strip and invalidated the canvas, while the
  rail kept whatever body it was last given. The controls were built correctly and simply never
  drawn again; collapsing and reopening the section was what made them appear, because that is a
  path that does redraw.

  The head has the same dependency, so this one line serves both.
*/
onToolChange(() => renderPanel());
/*
  The three wall actions are disabled while their own limit is at zero, so the slider that lifts one
  has to tell them.

  At module scope rather than inside the step body that draws them: that body is rebuilt on every
  accordion click, and a subscription there would add a listener per click. The refresh looks its
  button up by id and does nothing when the step is closed, which is the same shape the readout
  painters use.

  A graph arriving is the other thing that lifts these, and that path is already covered --
  `onStageChange` rebuilds the whole rail.
*/
onSettingCommitted(() => {
  refreshWallAmounts();
});
/*
  All five markup colours, in the group that is never entered — the ink's included since 2026-09-09,
  when it came down from the top of the Ink step (user: "should move down with the others").

  Grouped by what a colour *means* rather than by which layer shows it, which is the whole point:
  adjusting for a map with an unusual tint moves one control and everything additive follows. They sit
  here for the same reason the preview fill and outline do — they describe marks drawn across several
  groups, so filing them under one would leave the others to reach for them.
*/
registerStepContent("view", renderSwatches, "bottom");
/*
  How each mode ends, at the foot of its last step.

  The **ink mode** ends by saving the graph it has derived and putting it on the map, with the
  hand-off to the editor beside it. That replaces the one-way door: there is no stage to cross any
  more, only a document to commit. The **editor** ends by pushing what it has already committed,
  which is the ordinary "put it on the map".

  Both are registered unconditionally. A step that this mode does not declare is never rendered, so
  the registration for the other one costs a map entry nobody reads — which is cheaper than a branch
  here that has to be kept in step with `steps.ts`.
*/
/*
  Nothing at the foot of Walls any more, and the deletion is the point.

  *Put the walls on the map* lived here and was the crossing into stage two: it saved the derived
  graph and pushed it, with a confirmation naming what it would replace. There is no crossing now.
  The first hand edit adopts the derivation as the document because the edit needs one, and closing
  commits and pushes — so a GM never presses anything to begin editing, and never loses a session by
  not having pressed it.
*/
// What you do with the walls, above the button that writes them.
/*
  Two actions at the foot of the editor, in the order they are reached.

  Pruning changes the document and pushing writes it to the scene, so pruning comes first — and both
  are below the slider that decides what pruning would take, which is the reason the bottom slot
  exists at all. One render rather than a third slot: what wanted separate slots was a *picker* at
  the top against an *action* at the bottom, and these are two actions.
*/
/*
  **Add walls around the map edge**, at the foot of Walls (user, 2026-09-14).

  It was the last thing in Edit walls, which is gone. It belongs with the two sliders that shape
  the graph rather than in a group of its own: all three are things you do to the walls, and this
  is the one that *adds*, which is why it is a deliberate press where they are live.
*/
/*
  The Walls group registers nothing, and so has no drawer and no button in the strip (2026-09-21).

  **Two registrations collided here, and the second silently won.** `renderWallAmounts` and
  `renderFrameAction` were both filed under the same step and the same slot, and the registry keeps
  one render per slot — so the amounts were never drawn from the day they were built, which is why
  they had never been in a room. Keys are contracts, and a map that overwrites one says nothing.

  Both moved out rather than being made to share: the amounts are tools with drawers of their own,
  and the frame button is an act in the strip.
*/

renderPushAction();

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
  The stored graph changed, so what draws it has to be told.

  **The panel in both modes**, because both say something about it: the editor swaps its "no walls
  saved" notice for the tool picker, and the ink mode's save changes what its confirmation has to
  warn about.

  **The partition only in the editor.** There the graph *is* the rooms, so an edit changes them and
  leaving the old ones on screen marked current is the "shows the rooms before your edits" failure
  the two sources exist to prevent. In the ink mode the rooms come from the reading whatever is
  stored, so saving changes nothing about them — and re-deriving would cost a full trace to arrive
  at the picture already on screen, wiping the push's own message on the way.
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
/*
  And whenever the picture catches up with any setting, which is what clears a slider's ghost.

  A reading was the only thing that re-asked, so a derive landing or a prune applying left the ghost
  marking a delay that had already ended. Once here, at module scope, because the rows themselves are
  rebuilt on every accordion click.
*/
onApplied(() => {
  refreshHints();
});

/*
  The heading is the markup's own now.

  It was set from here because the markup was shared between two modes and the query string was what
  distinguished them — a surface whose heading disagreed with the button that opened it would have
  been the worst outcome of sharing a page, since both looked identical and only one was destructive
  to save from. One page, one name, and nothing to keep in step.
*/

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
  await loadNominatedMap();
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
