/**
 * The break search as a tool: run it when asked, hold what it found, write what the GM accepts.
 *
 * ## What changed, and why this file exists at all
 *
 * The search used to live inside `composeInk`, and everything it marked was filled — inside the
 * pipeline, on every recompose, for as long as the width was nonzero. That made the repair a
 * standing condition rather than an act, which is only *nearly* the rule its default-off setting was
 * chosen to keep: consenting once is not the same as consenting to every future recomposition of a
 * map that has changed underneath.
 *
 * Here it proposes. The GM accepts one break or all of them, and what is accepted is written into
 * the **added-ink layer** — so from that moment it is paint like any other, with no separate term in
 * the composition and nothing that can re-invent itself. That is what makes stage one exactly three
 * independent layers.
 *
 * ## It searches the composite, which is the thing the pipeline would trace
 *
 * Not the base ink: a break the GM has already brushed closed is not a break, and one their
 * suppression opened is. So this composes the same stack the pipeline does, through the same
 * `composePaint` — the one statement of that order — against the paint **as it is in hand**,
 * including a mode's unsaved working copy.
 *
 * ## Accepting re-runs the search, and the marks visibly reshuffle
 *
 * Deliberate, and the user's specification: an accept is effective immediately and changes what the
 * remaining detection finds. Channels merge and split as the ink changes, which is the same
 * non-monotonicity that collapsed the two-slider design — except that there a slider moved the set
 * invisibly, and here the GM watches it happen one accept at a time.
 *
 * No DOM. The SDK is not reached at all: what this writes goes into the working paint layer, and
 * saving it is the mode's Done.
 */

import { devLog } from "../devlog";
import { composePaint, paintPixels, type StrokeBounds } from "../trace/inkPaint";
import { findGaps, type GapMark } from "../trace/gaps";
import type { BinaryMask } from "../trace/binarize";
import type { MarkRaster } from "./breakGesture";
import { currentPaint, openPaintKind, workingLayer } from "./paintState";
import { currentSettings } from "./settingsState";

/**
 * The base ink of the last reading, which every search composes from.
 *
 * Held rather than requested, because the reading is what produces it and asking the pipeline again
 * would re-run a chain whose answer has not changed. `null` before any reading, which is what makes
 * the tool decline rather than search an empty raster.
 */
let base: BinaryMask | null = null;

let marks: readonly GapMark[] = [];
/** The raster `marks` are in, so a click can be converted into it. */
let raster: MarkRaster | null = null;
/** What the last search cost, for the log. */
let lastMillis = 0;

export function breakMarks(): readonly GapMark[] {
  return marks;
}

export function breakRaster(): MarkRaster | null {
  return raster;
}

/** How many of the marks in hand can actually be accepted. */
export function fillableCount(): number {
  return marks.reduce((total, mark) => total + (mark.fillable ? 1 : 0), 0);
}

/**
 * Adopt a reading's base ink, and drop whatever the last search found.
 *
 * **Dropping is not tidiness.** The marks describe ink that has just been replaced, and a ring drawn
 * over a map whose reading has moved is the stale-diagnostic failure this project has paid for once
 * already. There is no way to know they are still where they were without searching again, so they
 * go and the GM re-runs.
 */
export function noteReadingForBreaks(mask: BinaryMask): void {
  base = mask;
  marks = [];
  raster = null;
}

/** Forget everything, which is what leaving the tool or the step does. */
export function clearBreakSearch(): void {
  marks = [];
  raster = null;
}

/**
 * Run the search against the ink as it now stands.
 *
 * Returns whether it could run at all: before a reading there is no base to compose from, and the
 * caller says so rather than showing an empty result that looks like "no breaks".
 */
export function runBreakSearch(): boolean {
  if (!base) return false;

  const started = performance.now();
  const { gapFillPx, gapTravelPx } = currentSettings().trace;
  // The composite, through the same function the pipeline composes with. A second expression of
  // that order here would be the harness-versus-room failure in miniature: a search that looked at
  // ink the trace would not.
  const composite = composePaint(base, currentPaint());
  const found = findGaps(composite, { fillPx: gapFillPx, travelPx: gapTravelPx });

  marks = found.marks;
  raster = { width: composite.width, height: composite.height };
  lastMillis = performance.now() - started;

  devLog(
    "info",
    `breaks: searched in ${Math.round(lastMillis)}ms at radius ${found.searchRadius}px — ` +
      `${found.channels} narrow channels, ${found.through} passing through; ${found.marks.length} ` +
      `have banks more than ${gapTravelPx}px apart along the ink. ${found.fillable} can be ` +
      `accepted, adding ${found.candidateArea} px; ${found.budgetHits} are guesses the flood could ` +
      `not finish and are never offered.`,
  );
  if (found.budgetHits > 0) {
    devLog(
      "warn",
      `breaks: ${found.budgetHits} channels were marked because the search ran out of budget rather ` +
        `than because the ink was broken. They are ringed and cannot be accepted. Lower the ` +
        `same-wall distance.`,
    );
  }
  return true;
}

/** What an accept did, so the caller can repaint exactly what changed and say what happened. */
export interface AcceptResult {
  /** How many marks were accepted. */
  readonly accepted: number;
  /** How many pixels of added ink that put down. */
  readonly pixels: number;
  /** The rectangle they lie in, for the layer to repaint. `null` when nothing changed. */
  readonly bounds: StrokeBounds | null;
}

const NOTHING: AcceptResult = { accepted: 0, pixels: 0, bounds: null };

/**
 * Accept one mark, or every acceptable one.
 *
 * Both go through here because they differ only in which marks are chosen, and the part that must
 * not differ is what happens afterwards: write into the working layer, then **search again**, so the
 * marks on screen describe the ink as it now is rather than as it was when the tool was opened.
 *
 * Refuses unless the added-ink mode is the one open. What this writes is added ink, and writing it
 * anywhere else — into a suppression layer, or into a committed layer nothing is holding — would be
 * paint the GM never made and cannot see being made.
 */
function accept(chosen: readonly GapMark[]): AcceptResult {
  const layer = workingLayer();
  if (openPaintKind() !== "ink" || !layer || chosen.length === 0) return NOTHING;

  let pixels = 0;
  let left = layer.width;
  let top = layer.height;
  let right = -1;
  let bottom = -1;

  for (const mark of chosen) {
    const result = paintPixels(layer, mark.pixels);
    pixels += result.changed;
    if (!result.bounds) continue;
    if (result.bounds.left < left) left = result.bounds.left;
    if (result.bounds.top < top) top = result.bounds.top;
    if (result.bounds.right > right) right = result.bounds.right;
    if (result.bounds.bottom > bottom) bottom = result.bounds.bottom;
  }

  // Re-run before returning, so the caller never draws the marks the accept invalidated.
  runBreakSearch();

  return {
    accepted: chosen.length,
    pixels,
    bounds: right < left || bottom < top ? null : { left, top, right, bottom },
  };
}

/** Accept the one mark at `index`, which a click identified. */
export function acceptBreak(index: number): AcceptResult {
  const mark = marks[index];
  // Guarded rather than trusted: the index comes from a query against the marks *at the time of the
  // press*, and an accept can land after a re-run has replaced them.
  if (!mark || !mark.fillable) return NOTHING;
  return accept([mark]);
}

/** Accept everything currently shown that can be accepted. */
export function acceptAllBreaks(): AcceptResult {
  return accept(marks.filter((mark) => mark.fillable));
}
