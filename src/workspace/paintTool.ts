/**
 * The ink tools: the pointer events, which one is in hand, and saving what they wrote.
 *
 * What a gesture *means* is in `paintGesture.ts` and is tested there. This is the wiring — which
 * tool, which layer it writes into, where the last sample was, and what saving does.
 *
 * ## The mode is the step, and the tool says which layer
 *
 * Entering the Ink step takes a working copy of **both** paint layers; leaving it writes both. The
 * picker inside the step chooses which one a press writes into, and the merge that made that
 * necessary is the point (user, 2026-09-05): keying the mode to the tool instead would put a scene
 * write — about a second — between every flick from one brush to the other.
 *
 * So `tool` names a *layer* rather than a verb, which is the inversion the merge forced. Paint and
 * erase are a pair inside each brush, and Shift swaps them for the length of one stroke.
 *
 * ## A brush takes every press; the other two decline
 *
 * A stroke has to be able to start anywhere, so a brush cannot decide by looking. That is the case
 * the shell's brush branch was written for, and it is why the record's standing debt to a trackpad
 * user — no unmodified drag left for panning — comes due here and is paid by Ctrl.
 *
 * **With no tool chosen, and with the gap tool, a press falls through to a pan.** The first is what
 * makes the sliders above usable without a modifier; the second is because a map with forty rings on
 * it is one a GM spends most of their time moving around, so a tool that swallowed every drag would
 * put panning behind Ctrl for the whole of it.
 *
 * ## Nothing is written until the step is left, or Save is pressed
 *
 * A scene write takes the better part of a second, so one per stroke would make the tool unusable.
 * The working copies absorb every stroke and one write happens at the end (user, 2026-09-05), which
 * is also what makes the recomposite happen once rather than per mark.
 */

import { devLog } from "../devlog";
import { PAINT_NAMES, type PaintKind } from "../inkPaintStore";
import { paintStroke, paintedCount } from "../trace/inkPaint";
import { refreshPaintRegion, setBrushPosition } from "./layers/paint";
import { describeAccepted, describeSearch, markAt } from "./gapGesture";
import {
  acceptAllGaps,
  acceptGap,
  gapMarks,
  gapRaster,
  clearGapSearch,
  fillableCount,
  runGapSearch,
} from "./gapSearch";
import { gapsChanged } from "./layers/gaps";
import {
  brushKind,
  brushRadius,
  rasterPoint,
  strokeSegment,
  verbFor,
  type BrushPoint,
  type PaintTool,
  type PaintVerb,
} from "./paintGesture";
import {
  anyUnsavedPaint,
  beginPaint,
  commitPaint,
  discardPaint,
  endPaint,
  paintModeOpen,
  workingLayer,
} from "./paintState";
import { requestRecompose } from "./reading";
import { currentSettings } from "./settingsState";
import { invalidate, say, setGrabTarget, setMapDragHandler, type MapPoint } from "./shell";

/**
 * Which tool is in hand.
 *
 * Starts at `none`, which is the Ink step being a place to move the sliders in. A step that took
 * every press the moment it opened would make its own controls unusable without a modifier, and the
 * first thing a GM does there is tune the threshold rather than paint.
 */
let tool: PaintTool = "none";

/**
 * Paint or erase, held per brush rather than shared.
 *
 * Two brushes, two independent verbs. One shared verb would mean that setting Erase to fix a
 * suppression stroke and then switching to added ink silently arms a delete on the other layer,
 * which is a mode change nobody asked for. Shift inverts whichever is set, for one stroke.
 */
const verbs: Record<PaintKind, PaintVerb> = { suppress: "paint", ink: "paint" };

/** The last sample of the stroke in progress. `null` between gestures, which is what keeps them apart. */
let last: BrushPoint | null = null;
/** Which verb the gesture in progress is using, fixed at the press so a modifier let go mid-stroke does not flip it. */
let verb: PaintVerb = "paint";
/** How many pixels this gesture has changed, for the state line. */
let strokePixels = 0;
/** A write is in flight, so nothing may start on top of it. */
let busy = false;

export function currentPaintTool(): PaintTool {
  return tool;
}

/** Which of the two verbs a brush is set to, for the picker to show. */
export function currentVerb(kind: PaintKind): PaintVerb {
  return verbs[kind];
}

/** Set a brush's verb. The picker's only job beyond choosing the tool. */
export function setVerb(kind: PaintKind, next: PaintVerb): void {
  verbs[kind] = next;
}

/**
 * Switch tools, and run the search when the one arrived at is the gap tool.
 *
 * Running on arrival rather than making the GM press a button first: the tool has exactly one thing
 * to show and no reason to withhold it, and a step that opened on an empty canvas with a "search"
 * button would be a click between the GM and the only thing there. Leaving it drops the marks, so
 * a ring is never on screen while some other tool is in hand and cannot act on it.
 */
export function setPaintTool(next: PaintTool): void {
  tool = next;
  if (next === "gaps") {
    if (runGapSearch()) {
      say(describeSearch(gapMarks().length, fillableCount()));
    } else {
      say("nothing has been read from the map yet, so there is nothing to search");
    }
  } else {
    clearGapSearch();
  }
  // The ring belongs to whichever brush is now in hand, and to no tool at all otherwise. Cleared
  // here because no pointer event fires on a click in the panel.
  setBrushPosition(null);
  setGrabTarget(false);
  gapsChanged();
  invalidate();
}

/** Search again, because a gap setting moved. Silent when the gap tool is not the one in hand. */
export function refreshGapSearch(): void {
  if (tool !== "gaps") return;
  if (runGapSearch()) say(describeSearch(gapMarks().length, fillableCount()));
  gapsChanged();
}

/** The brush width for one layer, in raster pixels. */
function widthFor(kind: PaintKind): number {
  const { overlay } = currentSettings();
  return kind === "suppress" ? overlay.suppressBrushPx : overlay.inkBrushPx;
}

/**
 * Lay one sample down.
 *
 * The verb is the one fixed at the press rather than the one the modifier says now: letting go of
 * Shift halfway through a stroke should not turn the rest of it into the opposite operation.
 */
function apply(kind: PaintKind, at: BrushPoint): void {
  const layer = workingLayer(kind);
  if (!layer) return;

  const segment = strokeSegment(last, at);
  last = at;
  if (!segment) return;

  const result = paintStroke(
    layer,
    segment.from,
    segment.to,
    brushRadius(widthFor(kind)),
    verb === "paint",
  );
  if (!result.bounds) return;
  strokePixels += result.changed;
  refreshPaintRegion(result.bounds);
}

function start(point: MapPoint): boolean {
  if (busy || !paintModeOpen()) return false;

  /*
    The gap tool decides by looking, where the brushes take every press.

    It is the wall tools' rule rather than the brush's, and for the wall tools' reason: this is a
    tool spent mostly *looking* at what the search proposed, so one that swallowed every drag would
    make the looking part cost a modifier. A press inside a ring accepts that break; a press anywhere
    else is a pan.
  */
  if (tool === "gaps") return acceptAt(point);

  const kind = brushKind(tool);
  // No brush in hand — either no tool is chosen, or the layer could not be made because the map has
  // not been read. Declining lets the press pan instead of doing nothing at all.
  if (!kind || !workingLayer(kind)) return false;

  verb = verbFor(verbs[kind], point.modifier);
  last = null;
  strokePixels = 0;
  apply(kind, rasterPoint(point.u, point.v, workingLayer(kind)!));
  setBrushPosition({ u: point.u, v: point.v, kind });
  return true;
}

/**
 * Accept the gap whose ring this press landed in, or decline so the press pans.
 *
 * **Declining is what keeps the tool usable**, not a fallback: a map with forty rings on it is one a
 * GM will spend most of their time moving around, and one that took every drag would put panning
 * behind Ctrl for the whole of it.
 */
function acceptAt(point: MapPoint): boolean {
  const raster = gapRaster();
  if (!raster) return false;

  const index = markAt(gapMarks(), raster, point.u, point.v, point.perPixel);
  if (index === null) return false;

  const result = acceptGap(index);
  if (result.bounds) refreshPaintRegion(result.bounds);
  gapsChanged();
  say(describeAccepted(result.accepted, result.pixels, fillableCount()));
  return true;
}

/**
 * Accept every gap currently on offer.
 *
 * The reason the automatic search still earns its place (user, 2026-09-05): on a map with a lot of
 * little gaps, closing each by hand is the cost the search exists to remove. One click, one re-run,
 * and what is left is whatever the newly-closed ink turned into.
 */
export function acceptAllShownGaps(): void {
  if (tool !== "gaps") return;
  const result = acceptAllGaps();
  if (result.accepted === 0) {
    say("nothing here can be accepted — the rings left are guesses the search could not finish");
    return;
  }
  if (result.bounds) refreshPaintRegion(result.bounds);
  gapsChanged();
  say(describeAccepted(result.accepted, result.pixels, fillableCount()));
}

function move(point: MapPoint): void {
  // An accept is finished at the press. Nothing follows the pointer, so a drag that began on a ring
  // is over — and treating it as a brush stroke would paint a line out of a gap the GM only clicked.
  const kind = brushKind(tool);
  if (!kind) return;
  const layer = workingLayer(kind);
  if (!layer) return;
  apply(kind, rasterPoint(point.u, point.v, layer));
  setBrushPosition({ u: point.u, v: point.v, kind });
}

function end(): void {
  const kind = brushKind(tool);
  last = null;
  if (!kind || strokePixels === 0) return;
  const verbWord = verb === "paint" ? "painted" : "erased";
  say(`${verbWord} ${strokePixels} px of ${PAINT_NAMES[kind]} · not saved until you leave Ink`);
  strokePixels = 0;
}

function cancel(): void {
  // A cancelled pointer abandons the *gesture*, not the layer: what has been laid down is already in
  // the working copy and there is no half-applied state to undo. Dropping the last sample is all
  // there is to do, and it stops the next press bridging from where this one was interrupted.
  last = null;
}

/**
 * Escape abandons nothing here, and says so by declining.
 *
 * The wall tools consume Escape when a wall is half-drawn, so it does not also close the workspace.
 * A brush has no half-finished state — every stroke is complete the moment it is released — so
 * consuming it would take away the way out of the surface for no gain. Throwing away a session of
 * painting is a button, deliberately: it is destructive and must not be one keystroke away.
 */
function escape(): boolean {
  return false;
}

function hover(point: MapPoint | null): void {
  const kind = brushKind(tool);
  // No brush ring outside a brush: it says how much map the next *stroke* covers, and the other two
  // tools have no stroke. The rings the search drew are what to aim at there.
  setBrushPosition(point && kind && workingLayer(kind) ? { u: point.u, v: point.v, kind } : null);

  /*
    A crosshair wherever the tool will act, which under a brush is everywhere on the map.

    The rule was settled for the wall tools: a crosshair means the tool acts at this point, a hand
    means the surface moves. Under a brush, panning is the secondary action and is behind Ctrl. In
    the gap tool the surface really does move on a drag, so the hand is right *except* over a ring,
    which is the one place a press does something.
  */
  if (!point) {
    setGrabTarget(false);
    return;
  }
  if (kind) {
    setGrabTarget(workingLayer(kind) !== null);
    return;
  }
  const raster = gapRaster();
  const overRing =
    tool === "gaps" &&
    raster !== null &&
    markAt(gapMarks(), raster, point.u, point.v, point.perPixel) !== null;
  setGrabTarget(overRing);
}

let modeChain: Promise<void> = Promise.resolve();

/**
 * Ask for the paint mode to be open or closed, one request at a time.
 *
 * **The record predicted this would disappear with the merge, and it was half right.** Its reason
 * for existing was that switching between the two painting steps is a write and then an open, which
 * cannot happen any more — there is one step. What survives is leaving Ink and coming back inside
 * the second the write takes: the close is asynchronous, so an unchained re-open would copy the
 * layers the scene held *before* the write and then have its working copies cleared out from under
 * it when the close finished. Same failure, different route to it.
 */
export function requestPaintMode(open: boolean): void {
  modeChain = modeChain
    .then(() => (open ? openPaintMode() : closePaintMode()))
    .catch((error: unknown) => {
      devLog("error", "workspace: switching paint mode failed", String(error));
    });
}

/**
 * Open the mode: take a working copy of both layers.
 *
 * Reached through `requestPaintMode` when the accordion moves, never directly.
 */
async function openPaintMode(): Promise<void> {
  if (paintModeOpen()) return;
  await Promise.resolve();

  tool = "none";
  clearGapSearch();
  gapsChanged();

  /*
    There is no stage-two refusal here any more.

    Painting used to be closed once a graph was saved, because a paint layer is a **reading** input
    and the wall graph does not re-derive from ink — so a stroke would have looked like it worked,
    changed nothing visible, and then taken effect on starting over. The editor is a separate page
    now and does not declare this step, so the case cannot arise: the only surface carrying a brush
    is the one whose reading is live.
  */
  if (!beginPaint()) {
    // Not an error and not said out loud: the Ink step opened before the first reading landed, which
    // is the ordinary state for the first second of a session. The tools say so when one is picked.
    devLog("info", "paint: the ink step opened before a reading, so no layers were taken");
  }
  invalidate();
}

/**
 * Close it: write whatever changed, then let go.
 *
 * Closing **finishes** rather than warning: everything else on this surface is safe to leave at any
 * moment because everything durable is in scene metadata, and unsaved paint would be the first thing
 * to gap that claim. Keeping it true is better than teaching a GM to dismiss a dialog.
 */
async function closePaintMode(): Promise<void> {
  await finishPaint("leaving");
  clearGapSearch();
  tool = "none";
  setBrushPosition(null);
  setGrabTarget(false);
  gapsChanged();
  invalidate();
}

/**
 * Write both layers and recompose the ink.
 *
 * The one place painting ends by keeping its work, whether that was Save, changing step, or closing
 * the workspace. A failed write **keeps the working copies**, so a second attempt is possible and the
 * GM is never told their work is safe when it is not.
 *
 * `leaving` lets go of the copies afterwards; `save` re-takes them, so the brush goes on writing into
 * something distinct from what is now stored. **Not re-taking was a real defect in the one-layer
 * version**: pressing Done closed the mode outright, and every press after it silently declined until
 * the GM left the step and came back.
 */
export async function finishPaint(reason: "save" | "leaving"): Promise<boolean> {
  if (!paintModeOpen() || busy) return true;

  if (!anyUnsavedPaint()) {
    // Nothing changed, so there is nothing to write and nothing to recompose. Entering the step to
    // look at a layer and leaving again must not cost a scene write.
    if (reason === "leaving") endPaint();
    invalidate();
    return true;
  }

  const painted = describePainted();
  busy = true;
  say("saving…", "working");
  try {
    const { saved, failed } = await commitPaint();
    if (failed) return false;
    // Only now, because until the layers are committed the composite would be recomputed from paint
    // that is not saved — and a trace whose result outlives a failed write is the mismatch this whole
    // ordering exists to avoid.
    requestRecompose();
    say(`saved ${saved.map((kind) => PAINT_NAMES[kind]).join(" and ")} — ${painted}`);
    devLog("info", `workspace: paint committed on ${reason}`);
    if (reason === "leaving") endPaint();
    else beginPaint();
    return true;
  } finally {
    busy = false;
    invalidate();
  }
}

/** How much is on each layer, for the line that says what was saved. */
function describePainted(): string {
  return (["suppress", "ink"] as const)
    .map((kind) => {
      const layer = workingLayer(kind);
      return `${layer ? paintedCount(layer) : 0} px ${PAINT_NAMES[kind]}`;
    })
    .join(", ");
}

/** Throw away one layer's unsaved edits. The only way work here is lost. */
export function abandonPaint(kind: PaintKind): void {
  discardPaint(kind);
  last = null;
  say(`${PAINT_NAMES[kind]} back to what was last saved`);
  invalidate();
}

/** Wire the brush up. The step declares that a drag means this; the shell offers it every press. */
export function registerPaintTool(): void {
  setMapDragHandler("brush", { start, move, end, cancel, hover, escape });
}
