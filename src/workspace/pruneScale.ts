/**
 * The track *Prune the dead ends* draws its length against, and where the handle starts.
 *
 * ## Off, then logarithmic up to the longest wall run
 *
 * **The top is the longest wall run in the graph**, measured when the tool opens (`graphScale.ts` says
 * why the run and not the longest dead end: the cascade frees runs that sit between two junctions
 * today, and at the far right every one of those should go). It is the same top the amount had, and the
 * far right is as useless and as visible as it always was — the point of reaching it.
 *
 * **The far left is off**, and the log part starts from `TRACK_FLOOR`, shared with Straighten.
 *
 * ## The start is four ink widths, every opening — decided in building, 2026-09-22
 *
 * **Twice the automatic prune's two**, so the first rings are the next band of dead ends above what
 * every derive already took: short strokes of detail attached to a wall, a fragment between two breaks.
 * A stub a GM wants is usually longer. **Reasoning, not measurement**, and it is a guess about maps in
 * general where *Collapse small regions*' eight square ink widths had the same argument behind it.
 * Back at the start every time the drawer opens, as Collapse's is — a good first guess rather than
 * wherever it was last left.
 *
 * **No measured ink width, a fixed start**: four ink widths of a 3px line on a 3,300px map, the test
 * map's figures.
 *
 * Pure: no DOM, no SDK.
 */

import type { ScaleLimits } from "../sliderScale";
import { TRACK_FLOOR } from "./graphScale";

/** Ink widths the handle starts at. */
export const START_INK_WIDTHS = 4;

/** The start when no ink width was measured — 4 × 3 / 3300, in graph units. */
export const FALLBACK_START = START_INK_WIDTHS * (3 / 3300);

/** The track, from off up to `top` — the longest wall run — or `null` when there is nothing to measure. */
export function pruneLimits(top: number | null): ScaleLimits | null {
  if (top === null || !(top > TRACK_FLOOR)) return null;
  return { min: 0, max: top, step: TRACK_FLOOR, floor: TRACK_FLOOR };
}

/** The length the handle starts at, in graph units: four ink widths, converted from raster pixels. */
export function startingLength(inkWidthPx: number | null, rasterPerUnit: number | null): number {
  if (inkWidthPx === null || !(inkWidthPx > 0) || rasterPerUnit === null || !(rasterPerUnit > 0)) {
    return FALLBACK_START;
  }
  return (START_INK_WIDTHS * inkWidthPx) / rasterPerUnit;
}
