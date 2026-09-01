/**
 * Removing ink that is not connected to anything, and is too small to be a wall.
 *
 * The second tool in stage 1b, and it exists because the first one leaves a residue. Once the
 * minimum stroke width has taken out a printed floor grid, what remains beside the linework is
 * decoration: high-contrast, thick enough to survive an opening, and **stubby** — a compass rose,
 * a scatter of rubble, a stair tread, a furniture glyph.
 *
 * ## Why an island filter separates those from walls at all
 *
 * Not because a wall is large. A wall *segment* between two doorways can be tiny. It is because
 * **walls join up**: the linework of a dungeon is one enormous connected network, while a decoration
 * is an island floating inside a room. So the discriminator is connectivity first and size second,
 * and the size threshold only has to be big enough to catch the islands — it is separating things
 * that differ by orders of magnitude, not by a margin.
 *
 * ## The measure is the bounding box's longest side, not the area
 *
 * A GM can look at a map and say "that compass rose is about two squares across". Nobody can
 * estimate an area in square grid squares by eye, and an irregular glyph makes the number worse. The
 * longest side is also the measure that says *stubby*, which is the property that distinguishes what
 * is left after an opening from what should survive it.
 *
 * ## Eight-connected, which is the conservative direction here
 *
 * The pairing rule for this project is 4-connected space and 8-connected ink, and this must follow
 * it — but the reason is worth stating, because it is not merely consistency. Under 8-connectivity a
 * decoration that touches a wall *even diagonally* counts as part of the wall network and is
 * therefore never removed. Under 4-connectivity it would be a separate island, and deleting it would
 * quietly edit ink that the space labelling one stage later considers load-bearing. Fewer removals
 * is the safe direction for a filter that cannot be told what a wall is.
 *
 * `findInkBlobs` labels ink 4-connected, by inverting the mask and reusing the space labeller. That
 * is harmless there because it only ever *reports*. It would not be harmless here.
 *
 * Pure: no DOM, no SDK.
 */

import { emptyMask, type BinaryMask } from "./binarize";

export interface IslandRemoval {
  /** The mask with small isolated components cleared. The input is never modified. */
  readonly mask: BinaryMask;
  /** How many components were removed. */
  readonly removed: number;
  /** How many ink pixels they held. */
  readonly removedArea: number;
  /**
   * The longest side of the largest component kept, in raster pixels — for the log.
   *
   * **Zero when the filter is off**, which means "not measured" rather than "the largest surviving
   * island is nothing". Nothing prints it wrongly today because the one reader sits inside a
   * `minIslandPx > 0` branch. A caller that wants it unconditionally should make it `null` first,
   * not read the 0.
   */
  readonly largestKeptSpan: number;
}

/**
 * Clear every 8-connected ink component whose bounding box is shorter than `minSpan` on **both**
 * sides.
 *
 * `minSpan` of zero or less is off, and off means the mask comes back untouched — that is the
 * default, so every map that never reaches for this control depends on it changing nothing.
 */
export function removeSmallInkIslands(mask: BinaryMask, minSpan: number): IslandRemoval {
  const { width, height } = mask;
  if (minSpan <= 0 || width === 0 || height === 0) {
    return { mask, removed: 0, removedArea: 0, largestKeptSpan: 0 };
  }

  const labels = new Int32Array(width * height);
  // A pixel index stack rather than recursion: a component can span the whole raster, and 8.4
  // million frames is not a call stack any browser will give us.
  const stack = new Int32Array(width * height);

  let next = 0;
  let removed = 0;
  let removedArea = 0;
  let largestKeptSpan = 0;
  // Component index to whether it survived, so the second pass needs no bookkeeping per pixel.
  const keep: boolean[] = [];

  for (let start = 0; start < labels.length; start++) {
    if (mask.data[start] !== 1 || labels[start] !== 0) continue;

    next += 1;
    const label = next;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;

    let area = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (top > 0) {
      const index = stack[--top]!;
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Eight neighbours, so a diagonal touch joins. See the note above: this is what stops a
      // decoration resting against a wall from being treated as separable from it.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (mask.data[neighbour] !== 1 || labels[neighbour] !== 0) continue;
          labels[neighbour] = label;
          stack[top++] = neighbour;
        }
      }
    }

    const span = Math.max(maxX - minX + 1, maxY - minY + 1);
    const survives = span >= minSpan;
    keep[label] = survives;
    if (survives) {
      if (span > largestKeptSpan) largestKeptSpan = span;
    } else {
      removed += 1;
      removedArea += area;
    }
  }

  if (removed === 0) return { mask, removed: 0, removedArea: 0, largestKeptSpan };

  const out = emptyMask(width, height);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    out.data[i] = label !== 0 && keep[label] ? 1 : 0;
  }

  return { mask: out, removed, removedArea, largestKeptSpan };
}
