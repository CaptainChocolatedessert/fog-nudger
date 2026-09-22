/**
 * What a click near a small region *means* — the ring a GM aims at, separated from the events.
 *
 * ## The target is the ring, not the region
 *
 * The regions this tool is for are a few pixels across with the whole map in view, too small to see
 * or hit. So each is ringed in **screen** space at a minimum size, with **the same two numbers** the
 * ink tool's gaps and Mend's proposals use — a ring in any of the three is the same size to aim at.
 * What the layer draws and what this answers must agree, because between them they are what "there
 * is something here" means.
 *
 * Centred on the middle of the region's bounds rather than on the star's centre: a region with fewer
 * than two connections has no centre, and the ring is about the region, which is what goes.
 *
 * Positions are graph units and `perPixel` is graph units per screen pixel, which is one number that
 * is right on both axes.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { Collapse } from "../trace/collapse";
import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";

interface Bounds {
  readonly centre: Vector2;
  /** The diagonal of the region's bounds, in graph units. */
  readonly across: number;
}

const boundsOf = new WeakMap<Collapse, Bounds>();

function bounds(collapse: Collapse): Bounds {
  const cached = boundsOf.get(collapse);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of collapse.outline) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const found = {
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    across: Math.hypot(maxX - minX, maxY - minY),
  };
  boundsOf.set(collapse, found);
  return found;
}

/** The middle of a region's bounds, which is where its ring is centred. */
export function collapseCentre(collapse: Collapse): Vector2 {
  return bounds(collapse).centre;
}

/** The radius a region's ring is drawn at, in screen pixels: clear of the region, never below the floor. */
export function collapseRingRadius(collapse: Collapse, perPixel: number): number {
  const across = perPixel > 0 ? bounds(collapse).across / perPixel : 0;
  return Math.max(RING_MIN_RADIUS, across / 2 + RING_PADDING);
}

/**
 * Which region a click at `(x, y)` in graph units lands in, or `null`.
 *
 * Nearest centre wins among the rings the click falls inside, rather than the first in the list:
 * small regions cluster along a wall and their rings overlap, and picking by list order would make
 * which one you get depend on how the search sorted them.
 */
export function collapseAt(
  collapses: readonly Collapse[],
  x: number,
  y: number,
  perPixel: number,
): number | null {
  if (!(perPixel > 0)) return null;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < collapses.length; i++) {
    const collapse = collapses[i]!;
    const centre = collapseCentre(collapse);
    const distance = Math.hypot(centre.x - x, centre.y - y) / perPixel;
    if (distance > collapseRingRadius(collapse, perPixel) || distance >= bestDistance) continue;
    best = i;
    bestDistance = distance;
  }
  return best;
}

/** What the state line says about a search, in one place so its callers cannot word it apart. */
export function describeCollapses(found: number): string {
  if (found === 0) return "no regions that small — drag the size up to look for larger ones";
  return `${found} small region${found === 1 ? "" : "s"} to collapse`;
}
