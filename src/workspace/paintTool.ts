/**
 * The brush: the pointer events, the tool in hand, and finishing a paint mode.
 *
 * What a gesture *means* is in `paintGesture.ts` and is tested there. This is the wiring — which
 * layer is open, where the last sample was, and what Done and Cancel do.
 *
 * ## The mode is the step, and it opens when the step does
 *
 * Entering a painting step takes a working copy of that layer; leaving it finishes. There is no
 * "start painting" button, because a step is already a mode and a second thing to enter inside it
 * would be a mode inside a mode. What the picker chooses is the *verb* — the same division the wall
 * tools settled into, where the step says what you are editing and the tool says what a press does
 * to it.
 *
 * ## A drag takes every press, and Ctrl is the way out of that
 *
 * A stroke has to be able to start anywhere, so unlike the wall tools this cannot decide by looking.
 * That is the case the shell's brush branch was written for, and it is why the record's standing debt
 * to a trackpad user — no unmodified drag left for panning — comes due here and is paid by Ctrl.
 *
 * ## Nothing is written until the mode is finished
 *
 * A scene write takes the better part of a second, so one per stroke would make the tool unusable.
 * The working copy absorbs every stroke and one write happens at the end (user, 2026-09-05), which
 * is also what makes the recomposite happen once rather than per mark.
 */

import { devLog } from "../devlog";
import { PAINT_NAMES, type PaintKind } from "../inkPaintStore";
import { paintStroke, paintedCount } from "../trace/inkPaint";
import { refreshPaintRegion, setBrushPosition } from "./layers/paint";
import {
  brushRadius,
  rasterPoint,
  strokeSegment,
  verbFor,
  type BrushPoint,
  type PaintVerb,
} from "./paintGesture";
import {
  beginPaint,
  commitPaint,
  discardPaint,
  hasUnsavedPaint,
  openPaintKind,
  reportPaintFailure,
  workingLayer,
} from "./paintState";
import { requestRecompose } from "./reading";
import { inStageTwo } from "./stage";
import { currentSettings } from "./settingsState";
import { invalidate, say, setGrabTarget, setMapDragHandler, type MapPoint } from "./shell";

let tool: PaintVerb = "paint";

/** The last sample of the stroke in progress. `null` between gestures, which is what keeps them apart. */
let last: BrushPoint | null = null;
/** Which verb the gesture in progress is using, fixed at the press so a modifier let go mid-stroke does not flip it. */
let verb: PaintVerb = "paint";
/** How many pixels this gesture has changed, for the state line. */
let strokePixels = 0;
/** A write is in flight, so nothing may start on top of it. */
let busy = false;

export function currentPaintTool(): PaintVerb {
  return tool;
}

export function setPaintTool(next: PaintVerb): void {
  tool = next;
  invalidate();
}

/** The brush width for whichever layer is open, in raster pixels. */
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
function apply(at: BrushPoint): void {
  const layer = workingLayer();
  const kind = openPaintKind();
  if (!layer || !kind) return;

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
  if (busy) return false;
  const layer = workingLayer();
  const kind = openPaintKind();
  // No mode open means no raster to paint at, which happens when a painting step is entered before
  // the map has been read. Declining lets the press pan instead of doing nothing at all.
  if (!layer || !kind) return false;

  verb = verbFor(tool, point.modifier);
  last = null;
  strokePixels = 0;
  apply(rasterPoint(point.u, point.v, layer));
  setBrushPosition({ u: point.u, v: point.v });
  return true;
}

function move(point: MapPoint): void {
  const layer = workingLayer();
  if (!layer) return;
  apply(rasterPoint(point.u, point.v, layer));
  setBrushPosition({ u: point.u, v: point.v });
}

function end(): void {
  const kind = openPaintKind();
  last = null;
  if (!kind || strokePixels === 0) return;
  const verbWord = verb === "paint" ? "painted" : "erased";
  say(`${verbWord} ${strokePixels} px · not saved until you press Done`);
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
 * consuming it would take away the way out of the surface for no gain. Cancelling a whole session of
 * painting is a button, deliberately: it is destructive and must not be one keystroke away.
 */
function escape(): boolean {
  return false;
}

function hover(point: MapPoint | null): void {
  setBrushPosition(point ? { u: point.u, v: point.v } : null);
  // A crosshair wherever the tool will act, which under a brush is everywhere on the map. The rule
  // this follows was settled for the wall tools: a crosshair means the tool acts at this point, a
  // hand means the surface moves — and here panning is the secondary action, behind Ctrl.
  setGrabTarget(point !== null && openPaintKind() !== null);
}

let modeChain: Promise<void> = Promise.resolve();

/**
 * Ask for a paint mode, one at a time.
 *
 * Switching directly between the two painting steps is one gesture that has to become a *write* and
 * then an open, in that order. Both are asynchronous, and calling them concurrently loses the second
 * one outright: the commit that lands last clears whatever is in hand, so a mode opened while the
 * previous one was still saving is thrown away the moment that save returns — and the GM is left in
 * a painting step whose brush silently declines every press.
 *
 * Chaining is the whole fix, and it is why this exists beside `openPaintMode` rather than inside it:
 * the guard has to cover the gap *between* two calls, which nothing inside one of them can see.
 */
export function requestPaintMode(kind: PaintKind | null): void {
  modeChain = modeChain
    .then(() => openPaintMode(kind))
    .catch((error: unknown) => {
      devLog("error", "workspace: switching paint mode failed", String(error));
    });
}

/**
 * Open a paint mode for a step, or close the one that is open.
 *
 * Reached through `requestPaintMode` when the accordion moves, never directly. Closing **finishes**
 * rather than warning: everything else on this surface is safe to leave at any moment because
 * everything durable is in scene metadata, and unsaved paint would be the first thing to break that
 * claim. Keeping it true is better than teaching a GM to dismiss a dialog.
 */
async function openPaintMode(kind: PaintKind | null): Promise<void> {
  if (openPaintKind() === kind) return;

  /*
    Finish first and open second, and the `await` between them is load-bearing.

    Going straight from one painting step to the other is one gesture to the GM and two operations
    here. An earlier version returned after finishing, which left them in the new step with no mode
    open and a brush that silently declined every press — the shell would pan instead, so it looked
    like the tool had stopped working rather than like something was still saving.
  */
  await finishPaint("leaving");
  if (!kind) {
    invalidate();
    return;
  }
  /*
    Nothing is painted in stage two, and refusing here is what makes the step's notice true.

    A paint layer is a **reading** input: it changes the composed ink, and the frozen graph does not
    re-derive from ink. So a stroke made in stage two would look like it had worked, change nothing
    anyone can see, and then take effect the moment the GM started over — which is a control that
    does nothing until it surprises you, the exact shape the door was built to prevent.
  */
  if (inStageTwo()) {
    invalidate();
    return;
  }
  if (!beginPaint(kind)) {
    say("nothing has been read from the map yet, so there is nothing to paint on");
  }
  invalidate();
}

/**
 * Write the layer in hand and recompose the ink.
 *
 * The one place a paint mode ends by keeping its work, whether that was Done, changing step, or
 * closing the workspace. A failed write **keeps the mode open**, so a second attempt is possible and
 * the GM is never told their work is safe when it is not.
 */
export async function finishPaint(reason: "done" | "leaving"): Promise<boolean> {
  const kind = openPaintKind();
  if (!kind || busy) return true;

  if (!hasUnsavedPaint()) {
    // Nothing changed, so there is nothing to write and nothing to recompose. Entering a step to look
    // at a layer and leaving again must not cost a scene write.
    discardPaint();
    invalidate();
    return true;
  }

  const layer = workingLayer();
  const painted = layer ? paintedCount(layer) : 0;
  busy = true;
  say("saving…", "working");
  try {
    await commitPaint();
    // Only now, because until the layer is committed the composite would be recomputed from paint
    // that is not saved — and a trace whose result outlives a failed write is the mismatch this
    // whole ordering exists to avoid.
    requestRecompose();
    say(`${PAINT_NAMES[kind]} saved — ${painted} px`);
    devLog("info", `workspace: ${PAINT_NAMES[kind]} committed on ${reason}`);
    return true;
  } catch (error) {
    reportPaintFailure(kind, error);
    return false;
  } finally {
    busy = false;
    invalidate();
  }
}

/** Throw away everything the open mode has done. The only way work here is lost. */
export function abandonPaint(): void {
  discardPaint();
  last = null;
  say("changes discarded");
  invalidate();
}

/** Wire the brush up. The step declares that a drag means this; the shell offers it every press. */
export function registerPaintTool(): void {
  setMapDragHandler("brush", { start, move, end, cancel, hover, escape });
}
