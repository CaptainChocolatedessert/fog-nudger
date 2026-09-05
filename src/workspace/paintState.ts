/**
 * The GM's two paint layers as the workspace holds them, and the one place they are written from.
 *
 * ## Committed and working are different things, and the difference is the Done button
 *
 * A paint mode is entered, edited, and *finished* (user, 2026-09-05). That is what makes painting
 * affordable at all: a scene write takes the better part of a second, and one per brush stroke would
 * make the tool unusable, so a mode takes a **working copy**, the brush edits that, and pressing
 * Done writes it once and recomposes the ink once. Nothing beneath a paint mode has to keep up with
 * it while it runs.
 *
 * So there are two states here. The **committed** layers are what the scene holds and what the
 * pipeline composes from. The **working** layer is what a mode is holding, and while one is held it
 * is what the canvas draws — so the GM is always looking at their own edits even though the trace
 * has not seen them yet.
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
import { copyPaint, emptyPaint, isPaintEmpty, paintedCount, type PaintLayer } from "../trace/inkPaint";

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

/** The layer a mode is holding, if one is open. */
let working: { readonly kind: PaintKind; readonly layer: PaintLayer } | null = null;

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
  return { ...committed, [working.kind]: working.layer };
}

/** One layer as it should be drawn: the working copy where there is one. */
export function paintLayerFor(kind: PaintKind): PaintLayer | null {
  return working?.kind === kind ? working.layer : committed[kind];
}

/** Which layer a mode is holding, or `null` when none is open. */
export function openPaintKind(): PaintKind | null {
  return working?.kind ?? null;
}

/** Whether the mode in hand has anything unsaved in it. */
export function hasUnsavedPaint(): boolean {
  if (!working) return false;
  const stored = committed[working.kind];
  if (!stored) return !isPaintEmpty(working.layer);
  if (stored.width !== working.layer.width || stored.height !== working.layer.height) return true;
  return !stored.data.every((value, i) => value === working!.layer.data[i]);
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
export function beginPaint(kind: PaintKind): boolean {
  const existing = committed[kind];
  if (!existing && !raster) return false;
  working = { kind, layer: existing ? copyPaint(existing) : emptyPaint(raster!.width, raster!.height) };
  announce();
  return true;
}

/** The layer a mode is editing, for the brush to write into. */
export function workingLayer(): PaintLayer | null {
  return working?.layer ?? null;
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
export async function commitPaint(): Promise<void> {
  if (!working) return;
  if (!mapId) throw new Error("no map is nominated, so there is nothing to save paint against");
  const { kind, layer } = working;

  /*
    A layer with nothing on it is **deleted**, not stored as an empty document.

    Clearing a layer and pressing Done otherwise leaves a key holding a perfectly valid record that
    says nothing, which every later read then decodes and every later fingerprint then hashes. More
    to the point, "there is no paint for this map" and "there is paint, and it is blank" are the same
    fact told two ways, and the second one can disagree with the first after a partial write.
  */
  if (isPaintEmpty(layer)) {
    await clearPaintLayer(kind);
    committed = { ...committed, [kind]: null };
    working = null;
    devLog("info", `paint: ${PAINT_NAMES[kind]} is empty, so its stored copy was removed`);
    announce();
    return;
  }

  await writePaintLayer(kind, mapId, layer);
  committed = { ...committed, [kind]: layer };
  working = null;
  devLog(
    "info",
    `paint: finished ${PAINT_NAMES[kind]} — ${paintedCount(layer)} px painted at ` +
      `${layer.width}x${layer.height}`,
  );
  announce();
}

/** Abandon a mode, discarding everything it did. The one way work here is thrown away. */
export function discardPaint(): void {
  if (!working) return;
  devLog("info", `paint: discarded the ${PAINT_NAMES[working.kind]} edits in hand`);
  working = null;
  announce();
}

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
