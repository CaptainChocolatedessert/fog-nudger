/**
 * The track *Collapse small regions* draws its size against, and where the handle starts.
 *
 * ## Off, then logarithmic up to the whole map — user, 2026-09-21
 *
 * **The top is the area of the whole map**, on a log scale, *"in keeping with Straighten, where we
 * intentionally made going too far possible so the user can find a middle ground."* At the far right
 * every region qualifies, which is useless and visible, and that is the point: a track whose top still
 * looks reasonable gives no feel for where the edge is.
 *
 * **The far left is off**, as on Straighten and Prune's tracks, keyed on the position by `sliderScale`.
 * The floor the log part starts from is **the square of theirs** — they measure a length and this an
 * area, both in graph units, so the same smallest step means the same smallest thing.
 *
 * ## The start is eight square ink widths, every opening
 *
 * **Eight rather than four** (user offered either, 2026-09-21). Areas are measured between wall
 * centrelines, so a cell whose open floor is one ink width across already measures about four, half of
 * each surrounding stroke counting; four would ring only cells with almost no floor. Eight reaches floor
 * nearly two ink widths across. The rings are proposals a GM looks at before anything is taken, so a
 * generous start is the cheap direction. **Reasoning, not measurement.**
 *
 * **Back at the start every time the drawer opens**, and not stored (user: *"Always go back to that
 * starting point when opening the drawer"*). It is a Mend-style control whose first position should be
 * a good guess rather than wherever it was last left.
 *
 * **No measured ink width, a fixed start**: eight square ink widths of a 3px line on a 3,300px map, the
 * test map's figures. The tool still works; only the first guess is less informed.
 *
 * Pure: no DOM, no SDK.
 */

import type { ScaleLimits } from "../sliderScale";

/** Square ink widths the handle starts at. */
export const START_INK_WIDTHS_SQUARED = 8;

/** Where the log part of the track starts: the square of Straighten and Prune's floor of 2e-4. */
export const AREA_FLOOR = 4e-8;

/** The start when no ink width was measured — 8 × (3 / 3300)², in graph units squared. */
export const FALLBACK_START = START_INK_WIDTHS_SQUARED * (3 / 3300) ** 2;

/** The track for a map `extent` graph units across by down, or `null` for a map with no area. */
export function collapseLimits(extent: { readonly x: number; readonly y: number }): ScaleLimits | null {
  const top = extent.x * extent.y;
  if (!(top > AREA_FLOOR)) return null;
  return { min: 0, max: top, step: AREA_FLOOR, floor: AREA_FLOOR };
}

/**
 * The size the handle starts at, in graph units squared: eight square ink widths, converted from raster
 * pixels by the raster's pixels per graph unit.
 */
export function startingSize(inkWidthPx: number | null, rasterPerUnit: number | null): number {
  if (inkWidthPx === null || !(inkWidthPx > 0) || rasterPerUnit === null || !(rasterPerUnit > 0)) {
    return FALLBACK_START;
  }
  const inkWidth = inkWidthPx / rasterPerUnit;
  return START_INK_WIDTHS_SQUARED * inkWidth * inkWidth;
}
