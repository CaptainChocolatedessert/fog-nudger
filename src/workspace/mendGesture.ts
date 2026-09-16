/**
 * What a click near a proposed mend *means* — the ring a GM aims at, separated from the events.
 *
 * ## The target is the ring, not the mend
 *
 * The break this tool is for leaves a mend a pixel or two long with the whole map in view, which is
 * too small to see or hit. So each mend is ringed in **screen** space at a minimum size, as the ink
 * tool's gaps are, with **the same two numbers** — so a ring in one tool and a ring in the other are
 * the same size to aim at. What the layer draws and what this answers must agree, because between
 * them they are what "there is something here" means.
 *
 * Positions are graph units and `perPixel` is graph units per screen pixel, which is one number that
 * is right on both axes.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { Mend } from "../trace/mends";
import { RING_MIN_RADIUS, RING_PADDING } from "./gapGesture";

/** The middle of a mend, which is where its ring is centred. */
export function mendCentre(mend: Mend): Vector2 {
  return { x: (mend.start.x + mend.end.x) / 2, y: (mend.start.y + mend.end.y) / 2 };
}

/** The radius a mend's ring is drawn at, in screen pixels: clear of the mend, never below the floor. */
export function mendRingRadius(mend: Mend, perPixel: number): number {
  const across = perPixel > 0 ? mend.length / perPixel : 0;
  return Math.max(RING_MIN_RADIUS, across / 2 + RING_PADDING);
}

/**
 * Which mend a click at `(x, y)` in graph units lands in, or `null`.
 *
 * Nearest centre wins among the rings the click falls inside, rather than the first in the list:
 * rings overlap once several mends sit close together, and picking by list order would make which
 * one you get depend on the order the search took them in.
 */
export function mendAt(
  mends: readonly Mend[],
  x: number,
  y: number,
  perPixel: number,
): number | null {
  if (!(perPixel > 0)) return null;

  let best: number | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < mends.length; i++) {
    const mend = mends[i]!;
    const centre = mendCentre(mend);
    const distance = Math.hypot(centre.x - x, centre.y - y) / perPixel;
    if (distance > mendRingRadius(mend, perPixel) || distance >= bestDistance) continue;
    best = i;
    bestDistance = distance;
  }
  return best;
}

/** What the state line says about a search, in one place so its callers cannot word it apart. */
export function describeMends(found: number): string {
  if (found === 0) return "no gaps in the walls found — Largest gap to look for widens the search";
  return `${found} gap${found === 1 ? "" : "s"} in the walls to mend`;
}
