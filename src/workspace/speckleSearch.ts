/**
 * *Suppress speckles* as a tool: find the lumps, hold them, write what the GM accepts.
 *
 * The gap search's shape, with a different question and the other paint layer — it offers, the GM
 * takes one or all, and what is taken becomes **suppression paint**. From that moment it is paint like
 * any other: one undo step, survives a re-derive, and both clears reach it.
 *
 * ## It searches the composite, for the reason the gap search does
 *
 * Not the base ink: a speck the GM has already brushed away is not a speck, and one their added ink
 * created is. So it composes the same stack the pipeline does, through the same `composePaint`.
 *
 * ## Accepting re-runs the search
 *
 * Unlike the gaps, the remaining lumps do **not** reshuffle: components are independent, so taking one
 * cannot merge or split another. The re-run is for the lump just taken, which has to stop being
 * offered — and for anything the fill swallowed, since taking a ring takes the ink inside it too.
 *
 * ## The span is the tool's own, not the reading's
 *
 * *Smallest mark to keep* is a setting inside the reading and stays one; this is a search bound the GM
 * moves to see more or fewer candidates, and it changes nothing until a press. It starts from that
 * setting's value so the two agree at the moment the tool opens.
 *
 * No DOM, and the SDK is not reached: what this writes goes into the working paint layer, and saving
 * it is the mode's Done.
 */

import { devLog } from "../devlog";
import { composePaint, paintPixels } from "../trace/inkPaint";
import { walkIslands, type IslandWalk } from "../trace/inkIslands";
import {
  enclosureMap,
  patchAt,
  patchEnclosing,
  patchPixels,
  patchesUnder,
  type Patch,
} from "../trace/inkPatches";
import type { BinaryMask } from "../trace/binarize";
import type { MarkRaster } from "./gapGesture";
import { currentPaint, workingLayer } from "./paintState";
import { currentSettings } from "./settingsState";

/** The base ink of the last reading, which every search composes from. */
let base: BinaryMask | null = null;
/** The composite the current walk was made from, kept so a press can take pixels out of it. */
let composite: BinaryMask | null = null;
let walk: IslandWalk | null = null;
/**
 * Which lump encloses each pixel, built on first need and dropped with the walk.
 *
 * **Lazy, because it is a pass over the whole raster** and a GM may never press inside anything. Once
 * built, every press and every hover is a lookup — which is what lets the enclosing rule be unbounded
 * (user, 2026-09-22: *"It should delete the whole wall network if that's what the user clicks."*).
 */
let enclosing: Int32Array | null = null;
let offered: readonly Patch[] = [];
let raster: MarkRaster | null = null;
let span = 0;

export function speckleMarks(): readonly Patch[] {
  return offered;
}

export function speckleRaster(): MarkRaster | null {
  return raster;
}

export function speckleSpan(): number {
  return span;
}

/**
 * Adopt a reading's base ink, and drop what the last search found.
 *
 * **Dropping is not tidiness**, for the reason the gap search gives: the lumps describe ink that has
 * just been replaced, and a ring over a map whose reading has moved is a stale diagnostic.
 */
export function noteReadingForSpeckles(mask: BinaryMask): void {
  base = mask;
  forgetWalk();
  offered = [];
  raster = null;
}

/**
 * Whether a search is worth running again: there is a reading, and a span to search at.
 *
 * **A recompose lands as a new reading**, and a new reading drops what the last search found — which,
 * with this tool in hand, is every ring on screen. A room found exactly that: *"After I click a circle,
 * they all disappear until I adjust the slider."* The caller that knows the tool is armed asks this and
 * runs again.
 */
export function speckleSearchWanted(): boolean {
  return base !== null && span > 0;
}

/** Forget everything, which is what leaving the tool or the step does. */
export function clearSpeckleSearch(): void {
  forgetWalk();
  offered = [];
  raster = null;
}

/**
 * The lump whose **ring** a point falls inside, nearest centre first.
 *
 * **A press inside a ring takes that lump** (room, 2026-09-22: *"Clicking inside a ring should take that
 * blob. I had to click on the ink of the ring itself to get a big blob suppressed."*). The lump under
 * the pointer is the other way in, and the only one that reaches ink no ring was drawn for — but a pit's
 * middle is not ink, so without this the very thing the tool exists for could only be taken by hitting
 * its outline.
 */
export function speckleRingAt(u: number, v: number, floorRadius: number): Patch | null {
  if (!raster) return null;
  const x = u * raster.width;
  const y = v * raster.height;
  let best: Patch | null = null;
  let bestAway = Number.POSITIVE_INFINITY;
  for (const patch of offered) {
    const cx = (patch.minX + patch.maxX + 1) / 2;
    const cy = (patch.minY + patch.maxY + 1) / 2;
    const away = Math.hypot(x - cx, y - cy);
    // The ring as the layer draws it: half the lump's span, or the floor that keeps a speck clickable.
    if (away > Math.max(floorRadius, patch.span / 2)) continue;
    if (away >= bestAway) continue;
    bestAway = away;
    best = patch;
  }
  return best;
}

/** Start the search where the reading's own filter sits, so the two agree when the tool opens. */
export function startSpeckleSearch(): boolean {
  if (span <= 0) span = Math.max(1, currentSettings().trace.minIslandPx);
  return runSpeckleSearch();
}

/** Move the search bound. Nothing is written: this only changes what is on offer. */
export function setSpeckleSpan(next: number): boolean {
  span = Math.max(0, Math.round(next));
  return runSpeckleSearch();
}

/**
 * Make sure there is a walk of the ink as it now stands.
 *
 * **The walk is the expensive half, and the span does not change it** — measured in a room: 62–73ms for
 * 2,465 lumps, which the slider was paying on every frame it moved. It is dropped when the ink changes
 * underneath it, which is a new reading or an accept, and re-filtered for nothing in between.
 */
function ensureWalk(): boolean {
  if (!base) return false;
  if (walk && composite && raster) return true;

  const started = performance.now();
  composite = composePaint(base, currentPaint());
  walk = walkIslands(composite);
  raster = { width: composite.width, height: composite.height };
  devLog(
    "info",
    `speckles: walked ${walk.islands.length} lumps in ${(performance.now() - started).toFixed(0)}ms`,
  );
  return true;
}

/** Drop the walk, because the ink under it has changed. */
function forgetWalk(): void {
  composite = null;
  walk = null;
  enclosing = null;
}

/**
 * Keep what the span offers, walking the ink first if the walk has gone.
 *
 * Returns whether it could run at all: before a reading there is no base to compose from, and the
 * caller says so rather than showing an empty result that reads as "nothing to take".
 */
export function runSpeckleSearch(): boolean {
  if (!ensureWalk() || !walk) return false;
  offered = patchesUnder(walk, span);
  devLog(
    "info",
    `speckles: ${offered.length} of ${walk.islands.length} lumps ringed at a span of ${span}px, ` +
      `biggest ${offered[0]?.span ?? 0}px`,
  );
  return true;
}

/** The lump under one raster pixel, which is what a press on ink takes. */
export function speckleAt(x: number, y: number): Patch | null {
  if (!walk || !raster) return null;
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  return patchAt(walk, y * raster.width + x);
}

/**
 * The lump a press landed **inside**, for ground that no ring covers.
 *
 * The third way in, after the ring and the ink: *"I should be able to click inside of it to kill it
 * (like the graph loop deletion tool)"* (user, 2026-09-22). **Unbounded** — a press inside a room finds
 * the walls around it and takes them, which is the ruling the blob tool already made about its own
 * worst case, left to the preview rather than guarded against.
 */
export function speckleEnclosing(x: number, y: number): Patch | null {
  if (!walk || !raster || !composite) return null;
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  if (!enclosing) {
    const started = performance.now();
    enclosing = enclosureMap(composite, walk);
    devLog("info", `speckles: mapped what encloses each pixel in ${(performance.now() - started).toFixed(0)}ms`);
  }
  return patchEnclosing(walk, enclosing, y * raster.width + x);
}

export interface SpeckleAccept {
  readonly accepted: number;
  readonly pixels: number;
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null;
}

const NOTHING: SpeckleAccept = { accepted: 0, pixels: 0, bounds: null };

function accept(chosen: readonly Patch[]): SpeckleAccept {
  const layer = workingLayer("suppress");
  if (!layer || chosen.length === 0 || !composite || !walk) return NOTHING;

  let pixels = 0;
  let left = layer.width;
  let top = layer.height;
  let right = -1;
  let bottom = -1;

  for (const patch of chosen) {
    const result = paintPixels(layer, patchPixels(composite, walk, patch));
    pixels += result.changed;
    if (!result.bounds) continue;
    if (result.bounds.left < left) left = result.bounds.left;
    if (result.bounds.top < top) top = result.bounds.top;
    if (result.bounds.right > right) right = result.bounds.right;
    if (result.bounds.bottom > bottom) bottom = result.bounds.bottom;
  }

  /*
    The walk goes and is rebuilt before returning, so the caller never draws a lump the accept has just
    taken — and so the one taken, plus anything its fill swallowed, stops being offered.
  */
  forgetWalk();
  runSpeckleSearch();

  return {
    accepted: chosen.length,
    pixels,
    bounds: right < left || bottom < top ? null : { left, top, right, bottom },
  };
}

/** Accept one lump — from a ring, or from a press on ink the span never offered. */
export function acceptSpeckle(patch: Patch): SpeckleAccept {
  return accept([patch]);
}

/** Accept everything on offer. The free click is deliberately not part of this. */
export function acceptAllSpeckles(): SpeckleAccept {
  return accept(offered);
}
