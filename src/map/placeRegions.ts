/**
 * Roadmap step 7 — putting traced geometry where the map is.
 *
 * The pipeline works entirely in the pixel space of whatever raster it was handed. This is the one
 * affine step that gets it into the scene, and it is the last stage before anything is visible.
 *
 * ## The transform itself is not built here, and that is the inherited decision
 *
 * `placement.ts` derives the raster-to-world mapping from `getItemBounds` rather than by composing
 * the map image's position, scale, grid offset and dpi by hand. The sibling settled that: those
 * factors compose in an order the SDK documents nowhere, and guessing at an undocumented convention
 * has already cost this pair of projects once. Let the app answer the question it can answer
 * exactly.
 *
 * The cost is named rather than minimised: `getItemBounds` returns an **axis-aligned** box, so a
 * rotated map image reports the box its corners span instead of its own footprint, and geometry
 * placed against it is both mis-scaled and mis-positioned. `aspectMismatch` is how that gets
 * noticed rather than shipped — a rotated image's box has a different aspect from the image, so the
 * two disagreeing is the signal, and the dry run warns on it.
 *
 * ## Each region is anchored at its own centre
 *
 * A `Path`'s commands are relative to its `position` — measured in a room in step 1, against a
 * `SHAPE`, which is positioned from its corner instead. So something has to choose where each
 * item's origin sits, and the choice is not free.
 *
 * The centre of the region's own bounding box, for two reasons of unequal strength. The solid one,
 * and the one that still applies, is that command magnitudes stay small and symmetric about zero,
 * so a number that looks wrong in a log is obviously wrong rather than being a small perturbation
 * of a large world coordinate.
 *
 * The second is **historical, and its prediction was confirmed**. It ran: an item's `rotation` and
 * `scale` almost certainly pivot about its `position`, so a GM rotating a proposed region would
 * swing it about its own middle rather than about a distant shared origin. A room checked it —
 * rotation does pivot about the bounding-box centre, which is what regions are anchored on. What
 * has gone is the scenario: staging was removed on 2026-08-30, so there is no proposed region for a
 * GM to rotate, the scene is written directly, and a hand edit does not survive the next push. Kept
 * written down rather than deleted, because it becomes live again the moment step G lets a GM move
 * anything.
 *
 * ## What cannot be verified here
 *
 * That raster (0,0) corresponds to the world box's minimum corner is an assumption about Owlbear's
 * conventions, not arithmetic. A flip or a transpose satisfies every check this module can make —
 * the placed geometry still fills the map's bounds exactly — so no test in this repository can
 * distinguish a correct placement from a mirrored one. **Only an asymmetric shape looked at in a
 * room can**, which is why the dry run reports where each of the largest regions sits as a fraction
 * across and down the map: those figures are checkable against the map by eye, without emitting
 * anything.
 *
 * Pure: no DOM, no SDK.
 */

import type { Ring } from "../geometry/ring";
import { toWorldPoint, type Point, type RasterPlacement, type WorldBounds } from "./placement";

/** Everything this stage needs from a simplified region. */
export interface PlaceableRegion {
  readonly id: number;
  readonly rings: readonly Ring[];
}

export interface PlacedRegion {
  readonly id: number;
  /** World position the item sits at. Its path commands are relative to this. */
  readonly position: Point;
  /** Rings in world units, **relative to `position`** — ready to become path commands. */
  readonly rings: readonly Ring[];
  /** Absolute world box the region occupies, for reporting and for sanity checks. */
  readonly bounds: WorldBounds;
}

export function placeRegions(
  regions: readonly PlaceableRegion[],
  placement: RasterPlacement,
): PlacedRegion[] {
  return regions.map((region) => placeRegion(region, placement));
}

export function placeRegion(
  region: PlaceableRegion,
  placement: RasterPlacement,
): PlacedRegion {
  // One pass to absolute world coordinates, tracking the box as it goes, then one subtraction to
  // make them relative. Doing it the other way round would need the box before the points exist.
  const absolute: Point[][] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const ring of region.rings) {
    const converted: Point[] = [];
    for (const point of ring) {
      const world = toWorldPoint(placement, point.x, point.y);
      if (world.x < minX) minX = world.x;
      if (world.y < minY) minY = world.y;
      if (world.x > maxX) maxX = world.x;
      if (world.y > maxY) maxY = world.y;
      converted.push(world);
    }
    absolute.push(converted);
  }

  // An empty region has no box and therefore no centre. Anchoring it at the origin keeps the shape
  // of the result uniform, and it carries no rings for the anchor to be wrong about.
  const empty = minX > maxX;
  const bounds: WorldBounds = empty
    ? { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }
    : { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  const position = boundsCentre(bounds);

  return {
    id: region.id,
    position,
    rings: absolute.map((ring) =>
      ring.map((point) => ({ x: point.x - position.x, y: point.y - position.y })),
    ),
    bounds,
  };
}

export function boundsCentre(bounds: WorldBounds): Point {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
  };
}

/**
 * The world box every placed region falls inside, or `null` if there are none.
 *
 * The check this exists for: it should match the map's own world bounds closely, because the
 * outside region normally runs to all four edges of the raster. A placed box that is a fraction of
 * the map's, or larger than it, means the scale is wrong — which is the failure that *is* catchable
 * without a room, unlike a flip.
 */
export function placedBounds(placed: readonly PlacedRegion[]): WorldBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const region of placed) {
    if (region.rings.length === 0) continue;
    if (region.bounds.min.x < minX) minX = region.bounds.min.x;
    if (region.bounds.min.y < minY) minY = region.bounds.min.y;
    if (region.bounds.max.x > maxX) maxX = region.bounds.max.x;
    if (region.bounds.max.y > maxY) maxY = region.bounds.max.y;
  }

  if (minX > maxX) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Where a point sits inside a box, as a fraction along each axis.
 *
 * The form the placement diagnostic needs. "34% across, 61% down" is something a GM can check
 * against the map in front of them; a pair of world coordinates is not, and this project's own
 * record has world units being misread as image pixels once already.
 */
export function fractionWithin(bounds: WorldBounds, point: Point): Point {
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  return {
    x: width > 0 ? (point.x - bounds.min.x) / width : 0,
    y: height > 0 ? (point.y - bounds.min.y) / height : 0,
  };
}
