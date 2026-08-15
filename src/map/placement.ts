/**
 * Raster pixels to Owlbear world coordinates.
 *
 * This is roadmap step 7's arithmetic arriving early, because the dry run has to *report* the
 * transform even though it emits nothing through it. Reporting it now is the cheap half: a
 * placement that is wrong by a factor or a flip shows up as absurd numbers in a log long before it
 * shows up as fog in the wrong place.
 *
 * ## Scale per axis, never one uniform scale
 *
 * Inherited from the sibling, where it was a bug before it was a rule. A single width-derived scale
 * applied to both axes drifts progressively down the image whenever the map's world bounds are not
 * exactly the image's aspect ratio — and GMs nudge maps out of proportion routinely, to line the
 * drawn grid up with Owlbear's. A silent one percent put its strokes eight pixels clear of walls
 * three pixels wide.
 *
 * Pure, and deliberately free of SDK imports. The shapes here are structural so a test can hand
 * them plain objects, and so pulling the SDK into a Node test run — which does not survive it — is
 * never necessary.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned world-space box, as `getItemBounds` reports one. */
export interface WorldBounds {
  readonly min: Point;
  readonly max: Point;
}

export interface RasterPlacement {
  /** World position of the raster's top-left corner. */
  readonly origin: Point;
  readonly unitsPerPixelX: number;
  readonly unitsPerPixelY: number;
  readonly width: number;
  readonly height: number;
}

export function createPlacement(
  bounds: WorldBounds,
  rasterWidth: number,
  rasterHeight: number,
): RasterPlacement {
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldHeight = bounds.max.y - bounds.min.y;

  return {
    origin: { x: bounds.min.x, y: bounds.min.y },
    // A zero-sized raster yields a zero scale rather than an infinity. Every world point then
    // collapses onto the origin, which is visibly wrong in a log — where a NaN propagates silently
    // through arithmetic and only surfaces much later as geometry that refuses to render.
    unitsPerPixelX: rasterWidth > 0 ? worldWidth / rasterWidth : 0,
    unitsPerPixelY: rasterHeight > 0 ? worldHeight / rasterHeight : 0,
    width: rasterWidth,
    height: rasterHeight,
  };
}

/** A raster pixel coordinate in world space. */
export function toWorldPoint(
  placement: RasterPlacement,
  x: number,
  y: number,
): Point {
  return {
    x: placement.origin.x + x * placement.unitsPerPixelX,
    y: placement.origin.y + y * placement.unitsPerPixelY,
  };
}

/**
 * How far the map's world bounds are from the raster's aspect ratio, as a fraction.
 *
 * Worth reporting on every run because the usual cause is **rotation**: an axis-aligned box drawn
 * round a rotated image has a different aspect from the image itself. Rotation is not handled, and
 * the symptom without this number is output landing in the wrong place with nothing said about why.
 *
 * Returns 0 when either side is degenerate — no aspect exists to disagree about, and the caller
 * already has the zero dimensions themselves to report.
 */
export function aspectMismatch(
  bounds: WorldBounds,
  rasterWidth: number,
  rasterHeight: number,
): number {
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldHeight = bounds.max.y - bounds.min.y;
  if (worldWidth <= 0 || worldHeight <= 0 || rasterWidth <= 0 || rasterHeight <= 0) {
    return 0;
  }

  const worldAspect = worldWidth / worldHeight;
  const rasterAspect = rasterWidth / rasterHeight;
  return Math.abs(worldAspect - rasterAspect) / rasterAspect;
}

/**
 * How far a single width-derived scale would have pushed the raster's bottom edge.
 *
 * The mismatch above is a *ratio*; this is the same disagreement as a *displacement*, which is the
 * form that can be compared against the width of the linework. The sibling's record has the two
 * being confused: a mismatch dismissed as "one percent, negligible" was nearly eight pixels on a
 * map whose walls were three wide.
 *
 * Read it as how much work the per-axis scaling is doing on this map, not as an error left behind.
 * A non-zero value is expected on any map nudged out of proportion to line up with the grid.
 */
export function absorbedDrift(placement: RasterPlacement): number {
  return placement.height * (placement.unitsPerPixelX - placement.unitsPerPixelY);
}
