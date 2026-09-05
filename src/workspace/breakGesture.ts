/**
 * What a click on a break ring *means* — separated from the pointer events that deliver it.
 *
 * Two decisions, and both can be wrong in ways the picture would not show: which ring a press lands
 * in, and whether that ring is one the GM may accept at all. Left in the event handler they need a
 * DOM and a scene to reach; here they are ordinary functions over a list of marks.
 *
 * ## The target is the ring, not the break
 *
 * A break is a handful of raster pixels — sub-pixel on screen with a whole map in view, which is
 * precisely the situation the search exists for. So the ring is drawn in **screen** space at a
 * minimum size, and the thing a GM aims at is that ring. Hit-testing the pixels instead would make
 * every mark unclickable at the zoom where they are found, and hit-testing a fixed distance in map
 * fractions would drift from what is drawn at every zoom level.
 *
 * That is the same rule the wall tools follow, and the same one a room enforced there: what the
 * layer draws and what the query answers must agree, because between them they are what "there is
 * something here" means.
 *
 * Pure: no DOM, no SDK.
 */

import type { GapMark } from "../trace/gaps";

/** The raster a set of marks was found in, which is what their coordinates are in. */
export interface MarkRaster {
  readonly width: number;
  readonly height: number;
}

/**
 * How big a ring is on screen, in screen pixels.
 *
 * The floor is what makes a four-pixel break clickable at map-wide zoom; the padding is what keeps a
 * ring clear of the break it encloses once zoomed in far enough for the break itself to be bigger
 * than the floor. Both are shared with the layer that draws them — one declaration, so the mark a GM
 * sees and the target they hit are the same circle.
 */
export const RING_MIN_RADIUS = 11;
export const RING_PADDING = 6;

/**
 * The radius a mark's ring is drawn at, in screen pixels.
 *
 * `perPixel` is map fractions per screen pixel, so this converts the mark's span — which is in
 * *raster* pixels — into screen pixels by way of the raster's width. The floor then applies in the
 * space the ring is actually drawn in.
 */
export function ringRadius(mark: GapMark, raster: MarkRaster, perPixel: number): number {
  // One raster pixel as a fraction of the map, then as screen pixels.
  const screenPerRasterPixel = raster.width > 0 ? 1 / raster.width / perPixel : 0;
  return Math.max(RING_MIN_RADIUS, (mark.span / 2) * screenPerRasterPixel + RING_PADDING);
}

/**
 * Which mark a click at `(u, v)` lands in, or `null`.
 *
 * **Only marks that can be accepted are targets.** A guess the flood ran out of budget on is ringed
 * and never offered, so a click near one must not pick it — and must not pick a *further* acceptable
 * one either, because a GM aiming at the guess would then accept something else entirely. It is
 * skipped as a candidate rather than treated as blocking, which is the same choice `nearestEdge`
 * makes: pure proximity among the things the tool can act on.
 *
 * Nearest centre wins among those the click falls inside, rather than the first found. Rings overlap
 * freely once several breaks sit close together, and picking by list order would make which one you
 * get depend on raster scan order — invisible, and different every time the search re-runs.
 */
export function markAt(
  marks: readonly GapMark[],
  raster: MarkRaster,
  u: number,
  v: number,
  perPixel: number,
): number | null {
  if (raster.width <= 0 || raster.height <= 0 || perPixel <= 0) return null;

  let best: number | null = null;
  let bestDistance = Infinity;

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    if (!mark.fillable) continue;

    // The mark's centre as a fraction of the map, then the offset in screen pixels.
    const dx = (mark.x / raster.width - u) / perPixel;
    const dy = (mark.y / raster.height - v) / perPixel;
    const distance = Math.hypot(dx, dy);
    const radius = ringRadius(mark, raster, perPixel);
    if (distance > radius || distance >= bestDistance) continue;
    best = i;
    bestDistance = distance;
  }

  return best;
}

/** What the state line says about a search, in one place so the two callers cannot word it apart. */
export function describeSearch(found: number, fillable: number): string {
  if (found === 0) return "no breaks found — widen the largest break to repair, or there are none";
  const breaks = fillable === 1 ? "1 break" : `${fillable} breaks`;
  const unproven = found - fillable;
  if (unproven === 0) return `${breaks} found · click a ring to accept one`;
  // The two states have to be named separately when they differ, which is the correction the
  // reading's own line needed once: a total stated as if it were the acceptable count implies a
  // larger total still.
  return `${breaks} found, ${unproven} not examined · click a ring to accept one`;
}

/** What accepting says afterwards, given what it added and what it left. */
export function describeAccepted(marks: number, pixels: number, remaining: number): string {
  const what = marks === 1 ? "1 break" : `${marks} breaks`;
  const left = remaining === 0 ? "none left" : `${remaining} left`;
  return `closed ${what}, ${pixels} px of added ink · ${left} · not saved until you press Done`;
}
