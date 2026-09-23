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
import { paintPixels, paintStroke, paintedCount } from "../trace/inkPaint";
import { floodMapFraction } from "../pipeline";
import { clearBlobPreview, setBlobPreview } from "./layers/blob";
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
import { specklesChanged } from "./layers/speckles";
import {
  acceptAllSpeckles,
  acceptSpeckle,
  clearSpeckleSearch,
  speckleAt,
  speckleMarks,
  speckleRaster,
  startSpeckleSearch,
} from "./speckleSearch";
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
import { pushUndo, type Restore } from "./undoHistory";
import {
  anyUnsavedPaint,
  beginPaint,
  commitPaint,
  endPaint,
  paintModeOpen,
  restorePaint,
  snapshotPaint,
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
  if (next === "speckles") {
    if (startSpeckleSearch()) {
      const found = speckleMarks().length;
      say(`${found} lump${found === 1 ? "" : "s"} ringed · click one, or click any ink at all`);
    } else {
      say("nothing has been read from the map yet, so there is nothing to search");
    }
  } else {
    clearSpeckleSearch();
  }
  specklesChanged();
  // The fill preview belongs to the tool that draws it, so arming anything else takes it down. The
  // same rule the mend rings follow, and for the same reason: a mark nothing can act on is a lie.
  if (next !== "blob") clearBlobPreview();
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

/**
 * The layer as it was when the stroke in progress began, and which layer that was.
 *
 * Taken at the press and pushed at the release, because only the release knows whether anything was
 * actually painted — a click that changed no pixels must not fill the undo stack with entries that
 * take nothing back.
 */
let strokeStart: { readonly kind: PaintKind; readonly snapshot: string } | null = null;

/**
 * Remember how to take one paint edit back.
 *
 * **A recompose is asked for on the way back**, which is the same thing committing a stroke asks for
 * and for the same reason: the reading composes from the *working* copy, so a stroke is in the ink
 * from the next composition onward — undoing has to put that right, or the amber would vanish and the
 * ink it produced would stay. A recompose rather than a re-read, because the map has not changed:
 * only what we lay over it has.
 */
export function rememberPaint(kind: PaintKind, snapshot: string, label: string): void {
  pushUndo(label, paintStep(kind, snapshot), "ink");
}

/** One step of a layer's history, which hands back the step that reverses it. */
function paintStep(kind: PaintKind, snapshot: string): Restore {
  return () => {
    /*
      The mode may have closed since, and usually has: putting the brush down writes both layers and
      lets the working copies go, which is exactly when a GM looks at what they drew and wants it
      back. Opening a fresh copy from what was committed is the same thing entering the step does,
      and the snapshot then goes into it.

      Without this the restore had nothing to write into and did nothing at all — a button that says
      "Undo drawing added ink" and silently declines.
    */
    if (!paintModeOpen() && !beginPaint()) return;
    // Taken before the restore, so redo has the state this is about to replace.
    const leaving = snapshotPaint(kind);
    if (!restorePaint(kind, snapshot)) return;
    const layer = workingLayer(kind);
    // The whole layer, because a snapshot says nothing about which part of it moved — where a stroke
    // hands over the rectangle it knows it changed.
    if (layer) {
      refreshPaintRegion({ left: 0, top: 0, right: layer.width - 1, bottom: layer.height - 1 });
    }
    gapsChanged();
    requestRecompose();
    invalidate();
    return leaving === null ? undefined : paintStep(kind, leaving);
  };
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
  if (tool === "blob") return floodAt(point);
  if (tool === "speckles") return takeSpeckleAt(point);

  const kind = brushKind(tool);
  // No brush in hand — either no tool is chosen, or the layer could not be made because the map has
  // not been read. Declining lets the press pan instead of doing nothing at all.
  if (!kind || !workingLayer(kind)) return false;

  verb = verbFor(verbs[kind], point.modifier);
  last = null;
  strokePixels = 0;
  const snapshot = snapshotPaint(kind);
  strokeStart = snapshot === null ? null : { kind, snapshot };
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

  // Accepting writes ordinary added ink, so it is a paint edit and belongs on the stack with the
  // strokes. Snapshotted before, because after it the layer is already changed.
  const before = snapshotPaint("ink");
  const result = acceptGap(index);
  if (before !== null && result.accepted > 0) rememberPaint("ink", before, "closing a gap");
  if (result.bounds) refreshPaintRegion(result.bounds);
  gapsChanged();
  say(describeAccepted(result.accepted, result.pixels, fillableCount()));
  return true;
}

/**
 * Take the lump of ink under this press, and whatever it encloses.
 *
 * **Every press that lands on ink is taken**, ringed or not: the rings say what the span found, and a
 * press on anything else is the same act on a lump the span did not offer — which is how this reaches
 * a pit bigger than the slider, and how it does *Suppress blob*'s job without a tone.
 *
 * A press on ground declines, so panning stays free on a map covered in rings. That is the gap tool's
 * rule and it is right for the same reason: this is a tool spent mostly looking.
 */
function takeSpeckleAt(point: MapPoint): boolean {
  const raster = speckleRaster();
  const layer = workingLayer("suppress");
  if (!raster || !layer) return false;

  const x = Math.floor(point.u * raster.width);
  const y = Math.floor(point.v * raster.height);
  const patch = speckleAt(x, y);
  if (!patch) return false;

  const before = snapshotPaint("suppress");
  const result = acceptSpeckle(patch);
  if (result.pixels === 0) {
    say("that is already suppressed");
    return true;
  }
  if (before !== null) rememberPaint("suppress", before, "suppressing a speckle");
  if (result.bounds) refreshPaintRegion(result.bounds);
  // Recomposed for the reason the blob spike gives: this is not a brush, so the ink layer is drawing
  // the composite and the mark would sit there until the tool was put down.
  requestRecompose();
  specklesChanged();
  say(
    `suppressed a lump of ${result.pixels} px, span ${patch.span} px · ` +
      `${speckleMarks().length} still ringed · not saved until you leave Ink`,
  );
  return true;
}

/** Take everything the span is offering, which is the button in the drawer. */
export function suppressEverySpeckleShown(): void {
  if (tool !== "speckles") return;
  const layer = workingLayer("suppress");
  if (!layer || speckleMarks().length === 0) {
    say("nothing is ringed, so there is nothing to take");
    return;
  }
  const before = snapshotPaint("suppress");
  const result = acceptAllSpeckles();
  if (result.pixels === 0) {
    say("those are already suppressed");
    return;
  }
  if (before !== null) rememberPaint("suppress", before, "suppressing the speckles");
  if (result.bounds) refreshPaintRegion(result.bounds);
  requestRecompose();
  specklesChanged();
  say(`suppressed ${result.accepted} lumps, ${result.pixels} px · not saved until you leave Ink`);
}

/** Search again, because the span moved. Silent when the tool is not the one in hand. */
export function refreshSpeckleSearch(): void {
  if (tool !== "speckles") return;
  specklesChanged();
  invalidate();
}

/**
 * Flood the map's tone from this press and suppress what it takes — the blob spike (2026-09-17).
 *
 * Built on `acceptAt` above, because the two are the same act: a search hands over a set of raster
 * pixels and they go into a paint layer as though a brush had covered them. The differences are
 * which layer (suppression rather than added ink) and that there is nothing to re-run afterwards,
 * since this proposes nothing and holds nothing between presses.
 *
 * **Takes every press that finds pixels**, so the crosshair is honest everywhere on the map and Ctrl
 * is how you pan. There is no "nothing here" — every pixel of the map has a tone and floods to at
 * least itself — so declining would only ever mean the map has not been read.
 */
function floodAt(point: MapPoint): boolean {
  const layer = workingLayer("suppress");
  if (!layer) return false;

  const found = floodMapFraction(point.u, point.v, currentSettings().trace.blobTolerance);
  if (!found) {
    say("nothing has been read from the map yet, so there is no tone to flood");
    return false;
  }

  // Snapshotted before the write, as an accept is: after it the layer is already changed.
  const before = snapshotPaint("suppress");
  const result = paintPixels(layer, found.pixels);
  if (result.changed === 0) {
    say("that blob is already suppressed");
    return true;
  }

  if (before !== null) rememberPaint("suppress", before, "suppressing a blob");
  if (result.bounds) refreshPaintRegion(result.bounds);
  /*
    Recomposed here, unlike a brush stroke, and the difference is which picture answers the question.

    The ink layer draws the **base** while a brush is in hand, so a stroke shows as the GM's own
    colour over it and needs no recompose to be seen. This is not a brush, so the ink layer is
    drawing the composite — and without asking for a new one the mark would still be there until the
    tool was put down. What the spike is for is seeing the ink *go*, and the rooms move with it.
  */
  requestRecompose();
  gapsChanged();
  say(
    `suppressed a blob of ${result.changed} px at tone ${found.seedTone.toFixed(2)} · ` +
      "not saved until you leave Ink",
  );
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
  const before = snapshotPaint("ink");
  const result = acceptAllGaps();
  if (result.accepted === 0) {
    say("nothing here can be accepted — the rings left are guesses the search could not finish");
    return;
  }
  if (before !== null) rememberPaint("ink", before, "closing every gap shown");
  if (result.bounds) refreshPaintRegion(result.bounds);
  gapsChanged();
  say(describeAccepted(result.accepted, result.pixels, fillableCount()));
}

/**
 * The pointer position the preview has not been computed for yet, and whether a frame is booked.
 *
 * **At most one flood a frame.** A hover fires far more often than the screen refreshes, and a flood
 * costs nothing on a pool and about 50ms on a fill the size of a map's whole ink network — so
 * searching per event would queue work nobody will ever see. Span's preview is throttled the same
 * way and for the same reason.
 */
let pendingPreview: MapPoint | null = null;
let previewBooked = false;

/**
 * Show what a click here would fill, at most once a frame.
 *
 * **Measured before it was built** (2026-09-17, at the 3626×2598 raster that first hit the megapixel
 * budget): a mark-sized fill is under a millisecond, a fill covering the whole connected ink network
 * — 1.09 million pixels — is 44 to 50ms, and the hard ceiling, a field with no boundary anywhere and
 * so every one of its 9.4 million pixels taken, is 242 to 339ms. No real map is boundary-free, but a
 * click on the open ground of a large map is the case that approaches it, and the preview will
 * visibly lag there. **The stated cost**, against Span's accepted worst of 170ms.
 */
function previewBlobAt(point: MapPoint | null): void {
  pendingPreview = point;
  if (previewBooked) return;
  previewBooked = true;
  requestAnimationFrame(() => {
    previewBooked = false;
    const at = pendingPreview;
    // The tool may have been put down between booking the frame and running it, and a preview drawn
    // for a tool nobody is holding is a mark with nothing able to act on it.
    if (!at || tool !== "blob" || !workingLayer("suppress")) {
      clearBlobPreview();
      return;
    }
    const found = floodMapFraction(at.u, at.v, currentSettings().trace.blobTolerance, {
      quiet: true,
    });
    setBlobPreview(found, found?.rasterWidth ?? 0, found?.rasterHeight ?? 0);
  });
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
  const began = strokeStart;
  strokeStart = null;
  // Nothing was painted, so there is nothing to take back. A click that changed no pixels must not
  // put an entry on the stack that undoes to the state it is already in.
  if (!kind || strokePixels === 0) return;

  if (began && began.kind === kind) {
    rememberPaint(kind, began.snapshot, `${verb === "paint" ? "drawing" : "erasing"} ${PAINT_NAMES[kind]}`);
  }

  const verbWord = verb === "paint" ? "painted" : "erased";
  say(`${verbWord} ${strokePixels} px of ${PAINT_NAMES[kind]} · not saved until you leave Ink`);
  strokePixels = 0;
}

function cancel(): void {
  // A cancelled pointer abandons the *gesture*, not the layer: what has been laid down is already in
  // the working copy and there is no half-applied state to undo. Dropping the last sample is all
  // there is to do, and it stops the next press bridging from where this one was interrupted.
  //
  // Which is exactly why it ends the stroke the ordinary way rather than dropping the snapshot: the
  // marks are on the layer, so there has to be a way back from them.
  end();
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
  if (tool === "blob") previewBlobAt(point);

  if (!point) {
    setGrabTarget(false);
    return;
  }
  if (kind) {
    setGrabTarget(workingLayer(kind) !== null);
    return;
  }
  // Suppress blob acts anywhere there is a layer to write into, so the crosshair is on throughout the
  // map rather than over a target — which is what the tool actually does.
  if (tool === "blob") {
    setGrabTarget(workingLayer("suppress") !== null);
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
 * Reached through `requestPaintMode`, and **the thing that reaches it is a tool being picked up** —
 * `toolPalette`'s `apply` calls `setPaintTool` and then asks for the mode, in that order.
 *
 * ## It used to put the tool back down, which killed the first pick every time — room, 2026-09-13
 *
 * This began with `tool = "none"`, and that was right while the **accordion** opened the mode: a GM
 * entering the Ink step had no brush in hand yet, so starting from none was the honest state. Since
 * the strip took the verb, the mode is opened *by* choosing a tool — so the reset wiped the very
 * selection that had just asked for it.
 *
 * The symptom was precise and looked like nothing else: the **first** ink tool picked after opening
 * the workspace did nothing at all — the cursor stayed a hand and no stroke landed, because with no
 * tool in hand the brush declines every press and the drag falls through to a pan. Picking any other
 * tool fixed it for the rest of the session, because by then the mode was open and the early return
 * above meant nothing clobbered the tool again.
 *
 * **The tool belongs to `setPaintTool` and to nothing else here.** Closing still puts it down, which
 * is correct: there is no brush in hand once the mode is shut.
 */
async function openPaintMode(): Promise<void> {
  if (paintModeOpen()) return;
  await Promise.resolve();

  /*
    `clearGapSearch()` and `gapsChanged()` were here too, and went with the tool reset for the same
    reason — found while fixing it rather than reported.

    `setPaintTool` owns the search as well as the tool: it runs one when the gap tool is picked up and
    clears it for every other tool. So this cleared a search that had **just been run** by the pick
    that opened the mode — the first time a GM chose Gaps in a session, its rings vanished the instant
    they appeared, while the state line went on reporting how many had been found. Picking any other
    tool and coming back fixed it, exactly as it did for the brush.
  */

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

/*
  `abandonPaint` was here and went on 2026-09-18 with the *Discard changes* button, its only caller.

  It put the working copy back to the last saved layer and pushed the revert itself onto the undo stack,
  so undoing after a discard took the discard back rather than reaching past it. `paintControls.ts`
  carries why the button went: its extent was unknowable, because the save it reverted to is an event
  this surface stopped marking.
*/

/** Wire the brush up. The step declares that a drag means this; the shell offers it every press. */
export function registerPaintTool(): void {
  setMapDragHandler("brush", { start, move, end, cancel, hover, escape });
}
