/**
 * Graph units: the wall graph's one unit of length, in which the map image's **longer side is 1**.
 *
 * ## Why not a fraction of each side
 *
 * The graph was stored in 0–1 of each axis until 2026-09-16 (user): x a fraction of the map's width
 * and y a fraction of its height. That is a square coordinate space laid over a map that generally is
 * not square, so **a length meant different things in the two directions** — on a 3300×2550 map a
 * vertical wall measured about 29% longer than a horizontal one of the same pixel length. Everything
 * that measures inherited it: the prune limit, straightening, the slider tracks measured off the
 * graph, and every hit radius a tool turns from screen pixels into the document.
 *
 * With the longer side as the unit, one number means one length in every direction, and the map
 * spans `1 × h/w` or `w/h × 1`. Everything the old unit was chosen for survives: it is still
 * independent of the raster the trace ran at and of the megapixel budget, which is what stops the
 * GM's work being denominated in an artefact of our own memory limit.
 *
 * ## The extent comes from the image, not the raster
 *
 * A capped raster is the image divided by an integer factor and **floored**, so its aspect can be a
 * pixel off the image's. The image's own pixel size is a property of the map; the raster is not. So
 * the extent is always computed from the image, and a raster pixel converts per axis against it —
 * which puts the far edge of any raster exactly on the far edge of the extent.
 *
 * Pure: no DOM, no SDK, and deliberately no import of `wallGraph.ts`, which imports this.
 */

/** The map's size in graph units. The longer side is exactly 1. */
export interface GraphExtent {
  readonly x: number;
  readonly y: number;
}

/**
 * The extent of an image `width` by `height` pixels, in graph units.
 *
 * **Quantised to float32**, the rule `documentCoordinate` applies to every stored coordinate, so the
 * short side is a value the document can hold exactly. That is what lets the frame's corners sit
 * *on* the extent and an equality test find them there.
 *
 * A degenerate size is a unit square, which is the only extent with no aspect to get wrong.
 */
export function graphExtent(width: number, height: number): GraphExtent {
  if (!(width > 0) || !(height > 0)) return { x: 1, y: 1 };
  const long = Math.max(width, height);
  return { x: Math.fround(width / long), y: Math.fround(height / long) };
}

/**
 * How many raster pixels make one graph unit, for a raster `rasterWidth` across covering `extent`.
 *
 * The conversion every pixel-denominated figure needs — a fitting tolerance, a readout, a seeded
 * default. Taken along x, which is exact for the raster's width; the other axis agrees to within the
 * one pixel a floored downscale can lose.
 */
export function rasterPixelsPerGraphUnit(rasterWidth: number, extent: GraphExtent): number {
  return extent.x > 0 ? rasterWidth / extent.x : 0;
}

/**
 * A position held inside the map, each axis on its own.
 *
 * **What keeps an edit on the map**, and it is needed because a *drag* is the one gesture that
 * carries a position past the map's edge: every press and hover is handed `null` outside the map,
 * but a drag in progress is given the true pointer position unclamped, deliberately, so the thing
 * being dragged keeps following. That is right for a brush, which clips per pixel and simply paints
 * nothing outside — and wrong for a vertex, whose position is *stored*.
 *
 * A vertex dragged off the map could not be reached again, since a press off the map is not a press
 * at all; with the map's edge walled it also split the wall it belonged to and left a piece outside,
 * unreachable (user, 2026-09-22, in a room).
 *
 * **Per axis, so the vertex slides along the edge it met** rather than stopping dead where it
 * crossed — pushed out through the left, it still follows the pointer up and down. Past a corner it
 * sits in the corner.
 */
export function clampToExtent(
  x: number,
  y: number,
  extent: GraphExtent,
): { readonly x: number; readonly y: number } {
  return {
    x: x < 0 ? 0 : x > extent.x ? extent.x : x,
    y: y < 0 ? 0 : y > extent.y ? extent.y : y,
  };
}
