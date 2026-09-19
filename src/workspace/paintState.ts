/**
 * The GM's two paint layers as the workspace holds them, and the one place they are written from.
 *
 * ## Committed and working are different things, and the difference is the Done button
 *
 * A paint mode is entered, edited, and *finished* (user, 2026-09-05). That is what makes painting
 * affordable at all: a scene write takes the better part of a second, and one per brush stroke would
 * make the tool unusable, so a mode takes a **working copy**, the brush edits that, and finishing
 * writes it once and recomposes the ink once. Nothing beneath a paint mode has to keep up with it
 * while it runs.
 *
 * So there are two states here. The **committed** layers are what the scene holds and what the
 * pipeline composes from. The **working** layers are what a mode is holding, and while it is held
 * they are what the canvas draws — so the GM is always looking at their own edits even though the
 * trace has not seen them yet.
 *
 * ## A mode holds BOTH layers, and that is what merging the two painting steps bought
 *
 * It held one at a time while suppression and added ink were steps of their own, because entering a
 * step was what opened it. With one Ink step holding both brushes, keying the mode to the *tool*
 * would put a scene write — about a second — between every flick from one brush to the other, which
 * is exactly what "jump between tools freely" rules out (user, 2026-09-05).
 *
 * So the mode is the step: entering Ink opens both as working copies, either brush writes into its
 * own, and leaving Ink writes both. That is **less** machinery than one-at-a-time needed rather than
 * more — the write-then-open serialisation that guarded switching steps has nothing left to guard.
 *
 * ## Leaving a mode any other way saves rather than warns
 *
 * Closing the workspace warns about nothing today, because nothing is ever lost — everything durable
 * is in scene metadata and everything else is derived from it. Unsaved paint would be the first
 * thing to break that, and the answer is not a warning but to keep the claim true: switching step or
 * closing the workspace **finishes** the mode exactly as Done does. Cancel remains, and is the only
 * way to throw work away, which is the shape of a control nobody presses by accident.
 *
 * No DOM. The SDK is reached only through `inkPaintStore`.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import {
  PAINT_NAMES,
  clearPaintLayer,
  readPaintLayer,
  writePaintLayer,
  type PaintKind,
} from "../inkPaintStore";
import type { PaintLayers } from "../pipeline";
import { NO_PAINT } from "../pipeline";
import {
  copyPaint,
  decodePaint,
  emptyPaint,
  encodePaint,
  isPaintEmpty,
  paintedCount,
  type PaintLayer,
} from "../trace/inkPaint";
import { clearUndo } from "./undoHistory";

/** What the scene holds, and what the pipeline composes from. */
let committed: PaintLayers = NO_PAINT;

/** The map these layers belong to, so a write goes back under the same one. */
let mapId: string | null = null;

/**
 * The raster to paint at, from the last reading.
 *
 * A layer is the size of the mask it acts on, and only a reading knows what that is. Null before the
 * first one, which is why entering a paint mode before the map has been read is refused rather than
 * guessed at — a layer created at the wrong size would be resampled forever after.
 */
let raster: { readonly width: number; readonly height: number } | null = null;

/**
 * Both kinds, in one place, so nothing walks them by writing the two strings out again.
 *
 * `PAINT_NAMES` is keyed by them and could be walked instead, but a record's key order is a fact
 * about an object literal rather than a declaration — and this list decides the order the two layers
 * are *written* in on the way out.
 */
const PAINT_KINDS: readonly PaintKind[] = ["suppress", "ink"];

/**
 * The layers a mode is holding, or `null` when no mode is open.
 *
 * Both kinds at once, and a kind inside it may still be `null` — which happens only when there is
 * nothing stored for it and no raster to make an empty one at. Distinguishing "no mode is open" from
 * "the mode is open and this one could not be made" is what lets a brush decline while the surface
 * around it goes on working.
 */
type WorkingLayers = Readonly<Record<PaintKind, PaintLayer | null>>;

let working: WorkingLayers | null = null;

const listeners: (() => void)[] = [];

/** Told whenever what is drawn or composed changes: a stroke, a commit, a load. */
export function onPaintChange(listener: () => void): void {
  listeners.push(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * The layers to trace with: the working copy where a mode has one, the committed layer otherwise.
 *
 * **The working copy is included deliberately**, even though it has not been written yet. Everything
 * that traces goes through here, so a recompose triggered while a mode is open — by anything at all
 * — composes the ink the GM can see rather than the ink they had before they started painting.
 */
export function currentPaint(): PaintLayers {
  if (!working) return committed;
  return {
    suppress: working.suppress ?? committed.suppress,
    ink: working.ink ?? committed.ink,
  };
}

/** One layer as it should be drawn: the working copy where there is one. */
export function paintLayerFor(kind: PaintKind): PaintLayer | null {
  return working?.[kind] ?? committed[kind];
}

/** Whether a paint mode is open, which is whether the Ink step is the one the GM is in. */
export function paintModeOpen(): boolean {
  return working !== null;
}

/** Whether one layer has changed since it was last saved. */
export function hasUnsavedPaint(kind: PaintKind): boolean {
  const layer = working?.[kind];
  if (!layer) return false;
  const stored = committed[kind];
  if (!stored) return !isPaintEmpty(layer);
  if (stored.width !== layer.width || stored.height !== layer.height) return true;
  return !stored.data.every((value, i) => value === layer.data[i]);
}

/** Whether either layer has changed, which is what decides whether leaving costs a write at all. */
export function anyUnsavedPaint(): boolean {
  return PAINT_KINDS.some(hasUnsavedPaint);
}

/** The raster a mode would paint at, or `null` before a reading has landed. */
export function paintRaster(): { readonly width: number; readonly height: number } | null {
  return raster;
}

/**
 * Note the raster the last reading produced.
 *
 * Called on every reading. When it *changes* under a mode that is already open — which needs the map
 * image to have been replaced mid-session — the working copy is abandoned rather than stretched: a
 * mode holding a layer for a raster that no longer exists would write marks at the wrong scale, and
 * losing an open mode's edits is the safe direction against that.
 */
export function noteRaster(width: number, height: number): void {
  if (raster && raster.width === width && raster.height === height) return;
  raster = { width, height };
  if (working) {
    devLog("warn", "paint: the raster changed while a paint mode was open, so it was abandoned");
    working = null;
    /*
      And the undo stack with it: every paint snapshot describes a layer at a size that no longer
      exists, and a graph entry on the same stack belongs to the map that has just been replaced.
      Clearing is the same answer `loadStage` gives for the same reason.
    */
    clearUndo();
    announce();
  }
}

/**
 * Read both stored layers for a map and adopt them. Called at start-up and on a map change.
 *
 * Reports `present` as well as `corrupt` so the caller can skip a recompose it does not need: every
 * scene has no paint until someone paints, and folding nothing into the ink is work with no result.
 */
export async function loadPaint(
  forMap: string | null,
): Promise<{ readonly corrupt: boolean; readonly present: boolean }> {
  mapId = forMap;
  working = null;
  if (!forMap) {
    committed = NO_PAINT;
    announce();
    return { corrupt: false, present: false };
  }

  const [suppress, ink] = await Promise.all([
    readPaintLayer("suppress", forMap),
    readPaintLayer("ink", forMap),
  ]);
  committed = { suppress: suppress.layer, ink: ink.layer };
  announce();
  return {
    corrupt: suppress.corrupt || ink.corrupt,
    present: suppress.layer !== null || ink.layer !== null,
  };
}

/**
 * Open a paint mode on one layer, taking a working copy.
 *
 * Refuses before a reading, because there is no raster to create a layer at. A stored layer is
 * adopted at *its* size rather than the current raster's: if the two disagree the pipeline says so
 * and resamples, and quietly resampling it here instead would destroy the original on the next Done.
 */
export function beginPaint(): boolean {
  const next: WorkingLayers = { suppress: workingCopy("suppress"), ink: workingCopy("ink") };
  // Neither could be made, so there is no mode to open. That is a painting tool reached for before
  // the map has been read, and declining is what lets the press pan instead of doing nothing at all.
  if (!next.suppress && !next.ink) return false;
  working = next;
  announce();
  return true;
}

function workingCopy(kind: PaintKind): PaintLayer | null {
  const existing = committed[kind];
  if (existing) return copyPaint(existing);
  return raster ? emptyPaint(raster.width, raster.height) : null;
}

/** The layer one brush is editing, for it to write into. */
export function workingLayer(kind: PaintKind): PaintLayer | null {
  return working?.[kind] ?? null;
}

/**
 * One layer as it is right now, small enough to keep twenty of.
 *
 * **Run-length encoded rather than copied**, which is what makes undo affordable on a raster. A raw
 * clone is a byte per pixel — twenty of those, on two layers, would be hundreds of megabytes on a
 * large map. The codec is the one the scene store already uses, and its own note is the reason this
 * works: an untouched layer is a single run and painted ones are a couple of runs a row, so ordinary
 * brushwork encodes to almost nothing. The cost moves to a pass over the raster per **stroke**, which
 * is once per drag rather than once per pointer sample.
 */
export function snapshotPaint(kind: PaintKind): string | null {
  const layer = working?.[kind];
  return layer ? encodePaint(layer) : null;
}

/**
 * Put a layer back to a snapshot, in place.
 *
 * **In place, into the existing layer object**, because a stroke mutates in place and the painter
 * notices a *replaced* layer by comparing references — handing it a new object here would make it
 * rebuild every pixel on the map for what is usually a mark a few across. The caller repaints the
 * rectangle it knows changed, exactly as a stroke does.
 *
 * Refuses a snapshot of a different size rather than stretching it. That means the raster moved under
 * an open mode, which abandons the working copy anyway — the guard is here so a stale entry cannot
 * write marks at the wrong scale if the two ever get out of step.
 */
export function restorePaint(kind: PaintKind, snapshot: string): boolean {
  const layer = working?.[kind];
  if (!layer) return false;

  const decoded = decodePaint(snapshot);
  if (!decoded || decoded.width !== layer.width || decoded.height !== layer.height) {
    devLog("warn", `paint: a saved ${PAINT_NAMES[kind]} state did not fit the layer, so it was not restored`);
    return false;
  }

  layer.data.set(decoded.data);
  return true;
}

/*
  There is deliberately nothing here for "a stroke happened".

  Every other change to these layers replaces a layer object — a load, a mode opening, a commit, a
  discard — and the painter notices that by comparing references. A **stroke mutates in place**, on
  purpose: copying eight megabytes per pointer sample to keep the reference changing would make the
  brush unusable, and it would tell the painter to rebuild the whole map's worth of pixels for a mark
  a few across.

  So a stroke is reported the other way round: the tool hands the rectangle `paintStroke` says it
  changed straight to the layer, which repaints exactly that much. Announcing here as well would
  undo the point of it.
*/

/**
 * Finish a mode: write the layer and adopt it.
 *
 * Throws on a failed write, and **the working copy is kept** when it does. That is the same rule the
 * wall tools follow one stage later: what must not happen is the GM being told their work is saved
 * and going on to close the surface. Keeping the mode open leaves it where a second Done can try
 * again.
 */
export async function commitPaint(): Promise<{
  readonly saved: readonly PaintKind[];
  readonly failed: PaintKind | null;
}> {
  if (!working) return { saved: [], failed: null };
  if (!mapId) throw new Error("no map is nominated, so there is nothing to save paint against");
  const saved: PaintKind[] = [];

  /*
    Both layers, one at a time, and an unchanged one is not written at all.

    Writing both unconditionally would cost two scene writes on the way out of every visit to the Ink
    step, including the visits that only moved a slider. It also matters for what it *says*: an
    unchanged layer rewritten is a stored record replaced by an identical one, which is work with no
    result and a chance of failing.

    **A failure stops the loop and names the layer it stopped on**, rather than throwing. The caller
    has to know *which* to tell the GM about, and with two layers in play a bare rejection cannot say
    — one may already be safely written. Reporting from inside is also what keeps the mode open with
    its copies intact, which is the standing rule: a GM must never be told their work is saved and go
    on to close the surface.
  */
  for (const kind of PAINT_KINDS) {
    if (!hasUnsavedPaint(kind)) continue;
    const layer = working[kind]!;
    try {

    /*
      A layer with nothing on it is **deleted**, not stored as an empty document.

      Clearing a layer and finishing otherwise leaves a key holding a perfectly valid record that
      says nothing, which every later read then decodes and every later fingerprint then hashes. More
      to the point, "there is no paint for this map" and "there is paint, and it is blank" are the
      same fact told two ways, and the second one can disagree with the first after a partial write.
    */
      if (isPaintEmpty(layer)) {
        await clearPaintLayer(kind);
        committed = { ...committed, [kind]: null };
        devLog("info", `paint: ${PAINT_NAMES[kind]} is empty, so its stored copy was removed`);
      } else {
        await writePaintLayer(kind, mapId, layer);
        committed = { ...committed, [kind]: layer };
        devLog(
          "info",
          `paint: saved ${PAINT_NAMES[kind]} — ${paintedCount(layer)} px painted at ` +
            `${layer.width}x${layer.height}`,
        );
      }
      saved.push(kind);
    } catch (error) {
      reportPaintFailure(kind, error);
      announce();
      return { saved, failed: kind };
    }
  }

  announce();
  return { saved, failed: null };
}

/** Let go of both working copies, once whatever was going to be saved has been. */
export function endPaint(): void {
  if (!working) return;
  working = null;
  announce();
}

/*
  `discardPaint` was here and went on 2026-09-18, with `abandonPaint` above it and the *Discard changes*
  button above that. It replaced a working copy with a fresh copy of what the scene holds.

  `hasUnsavedPaint` stays and is load-bearing: the automatic save loop asks it to skip a layer nothing
  has touched, and something else asks whether anything at all is unsaved.
*/

/**
 * Where a failed write gets reported, supplied by whoever owns a state line.
 *
 * The same arrangement `settingsState` uses and for the same reason: this module is deliberately
 * DOM-free, and a failed write is the one thing here that must reach the GM rather than only the log.
 */
let reportFailure: ((message: string) => void) | null = null;

export function onPaintWriteFailure(report: (message: string) => void): void {
  reportFailure = report;
}

/** Report a failed commit, wherever a state line has been offered. */
export function reportPaintFailure(kind: PaintKind, error: unknown): void {
  const detail = describeError(error);
  devLog("error", `workspace: could not save ${PAINT_NAMES[kind]}`, detail);
  console.error(`Fog Nudger — could not save ${PAINT_NAMES[kind]}`, error);
  reportFailure?.(`could not save your ${PAINT_NAMES[kind]}: ${detail}`);
}
