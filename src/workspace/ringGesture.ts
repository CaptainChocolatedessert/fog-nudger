/**
 * What a click near a ringed proposal *means*, for the two wall tools that ring what they would take:
 * *Collapse small regions* and *Prune the dead ends*. The ring a GM aims at, separated from the events.
 *
 * ## One module for both, rather than a copy each
 *
 * It was *Collapse small regions*' own until Prune became ringed on 2026-09-22, and the two would have
 * been line-for-line the same: a ring round a set of points, sized in screen pixels, nearest centre wins.
 * So it takes the points and nothing else — a region's outline, a dead end's vertices — and neither
 * tool's shape is known here.
 *
 * ## The target is the ring, not the thing
 *
 * What these tools ring is a few pixels across with the whole map in view, too small to see or hit. So
 * each is ringed in **screen** space at a minimum size, with **the same two numbers** the ink tool's
 * gaps and Mend's proposals use — a ring in any of them is the same size to aim at. What a layer draws
 * and what this answers must agree, because between them they are what "there is something here" means.
 *
 * Centred on the middle of the points' bounds: a region with fewer than two connections has no star
 * centre, a dead end has no centre at all, and the ring is about what goes.
 *
 * Positions are graph units and `perPixel` is graph units per screen pixel, which is one number that is
 * right on both axes.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";

interface Bounds {
  readonly centre: Vector2;
  /** The diagonal of the points' bounds, in graph units. */
  readonly across: number;
}

const boundsOf = new WeakMap<readonly Vector2[], Bounds>();

function bounds(points: readonly Vector2[]): Bounds {
  const cached = boundsOf.get(points);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const found = {
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    across: Math.hypot(maxX - minX, maxY - minY),
  };
  boundsOf.set(points, found);
  return found;
}

/** The middle of the points' bounds, which is where the ring is centred. */
export function ringCentre(points: readonly Vector2[]): Vector2 {
  return bounds(points).centre;
}

/** The radius the ring is drawn at, in screen pixels: clear of the points, never below the floor. */
export function ringRadius(points: readonly Vector2[], perPixel: number): number {
  const across = perPixel > 0 ? bounds(points).across / perPixel : 0;
  return Math.max(RING_MIN_RADIUS, across / 2 + RING_PADDING);
}

/**
 * Which ringed target a click at `(x, y)` in graph units lands in, or `null`.
 *
 * Nearest centre wins among the rings the click falls inside, rather than the first in the list: what
 * these tools ring clusters along a wall and the rings overlap, and picking by list order would make
 * which one you get depend on how the search sorted them.
 */
export function ringAt(
  targets: readonly (readonly Vector2[])[],
  x: number,
  y: number,
  perPixel: number,
): number | null {
  if (!(perPixel > 0)) return null;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const points = targets[i]!;
    const centre = ringCentre(points);
    const distance = Math.hypot(centre.x - x, centre.y - y) / perPixel;
    if (distance > ringRadius(points, perPixel) || distance >= bestDistance) continue;
    best = i;
    bestDistance = distance;
  }
  return best;
}

/** What the state line says about a small-region search, in one place so its callers cannot word it apart. */
export function describeCollapses(found: number): string {
  if (found === 0) return "no regions that small — drag the size up to look for larger ones";
  return `${found} small region${found === 1 ? "" : "s"} to collapse`;
}

/** What the state line says about a dead-end search. */
export function describePrunes(found: number): string {
  if (found === 0) return "no dead ends that short — drag the length up to look for longer ones";
  return `${found} dead end${found === 1 ? "" : "s"} to prune`;
}
