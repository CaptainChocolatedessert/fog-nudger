/**
 * Erosion, dilation, and the opening built from them.
 *
 * ## Erosion and a minimum width are different tools
 *
 * Worth stating at the top, because naming a filter by its *effect* rather than its *operation* is
 * a confusion this project has already had once:
 *
 * - **Erosion** shrinks every ink region by the radius. Thin marks vanish; thick marks survive
 *   **thinner**. Since regions are bounded by ink, thinning ink *grows every region* — so erosion on
 *   its own is the global outward offset, which DESIGN.md §11 considered and left out.
 * - **An opening** — erode then dilate by the same radius — deletes marks narrower than roughly
 *   twice the radius and returns everything else to its original width. That is what "minimum line
 *   width" means, and it is the only one of the two exposed as a control.
 *
 * ## Why this is the right axis for a printed floor grid
 *
 * The other global lever is the texture blur, and it works on **contrast**, so it cannot touch a
 * grid printed as dark as the walls without taking linework with it. An opening works on **width**,
 * which is the axis a grid line actually differs on.
 *
 * ## Square structuring element, separable, and O(n) in the radius
 *
 * The naive neighbourhood is `(2k+1)²` per pixel, which at 8.4 megapixels and a radius of five is
 * about a billion tests. A square element separates into a horizontal pass and a vertical one, and
 * each pass is a running count rather than a rescan — so the whole thing is linear in the pixel
 * count and *independent* of the radius.
 *
 * Square rather than circular is a real approximation and not merely a convenience: a diagonal
 * stroke has to be slightly thicker to survive than an axis-aligned one of the same width. On a
 * printed grid, which is axis-aligned, that bias points the right way.
 *
 * ## Borders clamp rather than count as ground
 *
 * `inkMetrics` deliberately treats off-image as ground, because for *measuring* thinness that can
 * only make a shape look thinner. Here it would be wrong: eroding a band the width of the radius
 * off every edge would delete a wall drawn along the map's border, and the dilation could not bring
 * back what no longer exists. So a window that runs off the edge is clipped to what is there, which
 * is what Sauvola's window already does a stage earlier.
 *
 * Pure: no DOM, no SDK.
 */

import { emptyMask, type BinaryMask } from "./binarize";

/**
 * The radius that removes marks narrower than `width` pixels.
 *
 * An erosion of radius `k` clears anything whose half-width is under `k`, so a mark survives at
 * about `2k` across. Rounded rather than floored: the control is a feel, not a specification, and
 * half a pixel of precision in it would be false.
 *
 * **Zero means off**, and that has to stay exactly true — a radius of zero must leave the mask
 * identical rather than nearly so, because this is the default and every map that never touches the
 * control depends on it changing nothing.
 */
export function radiusForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.round(width / 2));
}

/**
 * One separable pass, in whichever direction and with whichever rule.
 *
 * `require` is the count a window must reach to write ink: its full length for erosion (every
 * neighbour must be ink), or one for dilation (any neighbour will do). Sharing the traversal keeps
 * the four passes from drifting apart — the horizontal and vertical versions of the same operation
 * differing by an off-by-one is exactly the bug that would show as ink shifted by a pixel, which
 * against five-pixel linework is invisible until it is not.
 *
 * A line's addressing is a **base and a stride** rather than a function call per pixel. That is not
 * tidiness: the closure it replaces ran twice for every pixel of every pass, and at 8.4 megapixels
 * an opening was measuring 440ms in a room — most of it spent deciding, sixty-seven million times,
 * which of two multiplications to do. The gap marks add a second morphological operation to the
 * same surface, which is what made the cost worth paying attention to.
 */
function pass(
  source: Uint8Array,
  target: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  erode: boolean,
): void {
  const along = horizontal ? width : height;
  const across = horizontal ? height : width;
  // Running counts over a line, as a prefix sum: the ink in `[lo, hi]` is one subtraction.
  const prefix = new Int32Array(along + 1);

  // A row is contiguous; a column steps by a row's width. Both are then `base + i * stride`.
  const stride = horizontal ? 1 : width;

  for (let line = 0; line < across; line++) {
    const base = horizontal ? line * width : line;

    for (let i = 0, at = base; i < along; i++, at += stride) {
      prefix[i + 1] = prefix[i]! + source[at]!;
    }

    for (let i = 0, at = base; i < along; i++, at += stride) {
      const lo = i - radius > 0 ? i - radius : 0;
      const hi = i + radius < along - 1 ? i + radius : along - 1;
      const count = prefix[hi + 1]! - prefix[lo]!;
      const span = hi - lo + 1;
      target[at] = erode ? (count === span ? 1 : 0) : count > 0 ? 1 : 0;
    }
  }
}

function morph(mask: BinaryMask, radius: number, erode: boolean): BinaryMask {
  const { width, height } = mask;
  if (radius <= 0 || width === 0 || height === 0) {
    return { width, height, data: Uint8Array.from(mask.data) };
  }
  const middle = emptyMask(width, height);
  const out = emptyMask(width, height);
  pass(mask.data, middle.data, width, height, radius, true, erode);
  pass(middle.data, out.data, width, height, radius, false, erode);
  return out;
}

/** Shrink ink by `radius`. Thin marks vanish; thick marks survive thinner. */
export function erodeMask(mask: BinaryMask, radius: number): BinaryMask {
  return morph(mask, radius, true);
}

/** Grow ink by `radius`. */
export function dilateMask(mask: BinaryMask, radius: number): BinaryMask {
  return morph(mask, radius, false);
}

/**
 * Delete marks narrower than about `2 * radius`, leaving everything else at its original width.
 *
 * The order is what makes it a width filter rather than an offset: erosion decides *what survives*
 * and dilation restores *how wide it is*. Swapping them gives a closing, which fills thin gaps —
 * the opposite operation, and one that would merge two rooms across a doorway.
 */
export function openMask(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return mask;
  return dilateMask(erodeMask(mask, radius), radius);
}

/**
 * Fill breaks narrower than about `2 * radius`, leaving everything else where it was.
 *
 * The exact inverse of the opening, and it is used here for one thing only: **finding** the narrow
 * breaks, not sealing them. What the closing adds over the original mask is precisely the set of
 * channels too narrow to survive — cracks, seams, notches and enclosed pockets — which is the
 * candidate set the gap detector then sifts.
 *
 * **The repair does write a subset of this back**, from `gaps.ts`: the pixels of the channels that
 * were marked as breaks, and never the whole closing. That distinction is the safety property, and
 * it is the answer to a danger this doc used to describe as prospective. The danger is the mirror
 * image of the opening's and worse — an opening that severs a wall leaves a visible absence, while
 * a closing that seals a doorway looks like perfectly good wall, and Dynamic Fog would then derive
 * a wall across an open door. Keeping the whole closing would do exactly that, silently.
 */
export function closeMask(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return mask;
  return erodeMask(dilateMask(mask, radius), radius);
}

/** How many ink pixels an opening removed, for the log. */
export function removedInk(before: BinaryMask, after: BinaryMask): number {
  let removed = 0;
  for (let i = 0; i < before.data.length; i++) {
    if (before.data[i] === 1 && after.data[i] === 0) removed += 1;
  }
  return removed;
}
