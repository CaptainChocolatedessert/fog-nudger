/**
 * What a click on a gap ring *means* — separated from the pointer events that deliver it.
 *
 * Two decisions, and both can be wrong in ways the picture would not show: which ring a press lands
 * in, and whether that ring is one the GM may accept at all. Left in the event handler they need a
 * DOM and a scene to reach; here they are ordinary functions over a list of marks.
 *
 * ## The target is the ring, not the gap
 *
 * A gap is a handful of raster pixels — sub-pixel on screen with a whole map in view, which is
 * precisely the situation the search exists for. So the ring is drawn in **screen** space at a
 * minimum size, and the thing a GM aims at is that ring. Hit-testing the pixels instead would make
 * every mark unclickable at the zoom where they are found, and hit-testing a fixed distance on the
 * map would drift from what is drawn at every zoom level.
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
 * The floor is what makes a four-pixel gap clickable at map-wide zoom; the padding is what keeps a
 * ring clear of the gap it encloses once zoomed in far enough for the gap itself to be bigger
 * than the floor. Both are shared with the layer that draws them — one declaration, so the mark a GM
 * sees and the target they hit are the same circle.
 */
export const RING_MIN_RADIUS = 11;
export const RING_PADDING = 6;

/**
 * Screen pixels per raster pixel, the same on both axes.
 *
 * `perPixel` is graph units per screen pixel, and a graph unit is the map's longer side — so the
 * raster's longer side is one graph unit too. That is what makes one number right in both
 * directions, and it is the scale the layer draws the ring at, since the map is drawn at the image's
 * own aspect.
 *
 * **It was the raster's width, and that was a real distortion** until 2026-09-16: `perPixel` has
 * always come from the longer drawn side, so on a portrait map the radius here disagreed with the
 * radius drawn, and the offsets below — which divided a fraction of each side by it — made the
 * clickable area an ellipse, squashed by the map's aspect on whichever axis was the shorter.
 */
function screenPerRasterPixel(raster: MarkRaster, perPixel: number): number {
  const long = Math.max(raster.width, raster.height);
  return long > 0 && perPixel > 0 ? 1 / long / perPixel : 0;
}

/**
 * The radius a mark's ring is drawn at, in screen pixels.
 *
 * The mark's span is in *raster* pixels, so it converts to screen pixels at the raster's own scale.
 * The floor then applies in the space the ring is actually drawn in.
 */
export function ringRadius(mark: GapMark, raster: MarkRaster, perPixel: number): number {
  return Math.max(
    RING_MIN_RADIUS,
    (mark.span / 2) * screenPerRasterPixel(raster, perPixel) + RING_PADDING,
  );
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
 * freely once several gaps sit close together, and picking by list order would make which one you
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
  const scale = screenPerRasterPixel(raster, perPixel);

  let best: number | null = null;
  let bestDistance = Infinity;

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    if (!mark.fillable) continue;

    // The click in raster pixels — `u` and `v` are fractions of each side — then the offset on screen.
    const dx = (mark.x - u * raster.width) * scale;
    const dy = (mark.y - v * raster.height) * scale;
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
  if (found === 0) return "no gaps found — widen the largest gap to repair, or there are none";
  const gaps = fillable === 1 ? "1 gap" : `${fillable} gaps`;
  const unproven = found - fillable;
  if (unproven === 0) return `${gaps} found · click a ring to accept one`;
  // The two states have to be named separately when they differ, which is the correction the
  // reading's own line needed once: a total stated as if it were the acceptable count implies a
  // larger total still.
  return `${gaps} found, ${unproven} not examined · click a ring to accept one`;
}

/** What accepting says afterwards, given what it added and what it left. */
export function describeAccepted(marks: number, pixels: number, remaining: number): string {
  const what = marks === 1 ? "1 gap" : `${marks} gaps`;
  const left = remaining === 0 ? "none left" : `${remaining} left`;
  return `closed ${what}, ${pixels} px of added ink · ${left} · not saved until you press Done`;
}
