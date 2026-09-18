/**
 * A flood of the map's own tone, from one pixel — the blob tool's whole decision.
 *
 * **This is a spike (2026-09-17).** It has no tests, no mutation testing and no oracle, and its one
 * number is a constant rather than a setting. It exists to answer one question a room can answer and
 * a desk cannot: *does flooding the map image by luminance pick out the marks a GM wants gone?* If
 * the answer is yes, the wiring and the tests below are what it then needs; if no, the whole file
 * goes. Do not build on it in the meantime.
 *
 * ## What it does
 *
 * From the clicked pixel, take every connected pixel whose tone is within `tolerance` **of the
 * clicked pixel's own**. Not of its neighbour's: measuring against the neighbour lets the flood walk
 * a gradient and come out on tones the click never had, which on a map with a wash or a vignette is
 * the whole page. Against the seed the fill can never hold a tone further from the click than the
 * tolerance, whatever route it took to get there.
 *
 * **8-connected**, which is §4's pairing applied correctly: 8 for ink, 4 for space, and a mark is
 * ink-like. It was 4 for its first hour, on an argument from *consequence* — this removes ink, and
 * leaking is the expensive mistake — rather than from what is being connected, and a room found the
 * cost immediately. A map's edges are anti-aliased, so the dark fringe along a diagonal is a
 * staircase whose corner pixels touch the mark **only at their corners**. Under 4 the flood cannot
 * reach them, and a filled pool came back ringed with the black pixels it had stepped around.
 *
 * The cost this accepts: two dark marks touching only diagonally are one blob. That is the same
 * family as a mark touching a wall, which the tool already takes wholesale.
 *
 * ## What it deliberately does not do
 *
 * Nothing consults the ink mask. A mark and the linework are usually the same black, so a mark
 * touching a wall is one contiguous region with it and the flood walks the whole network — accepted
 * (user, 2026-09-17) as a bad use of the tool rather than a fault to guard against. A version that
 * used Sauvola as a barrier was designed and cut as not worth the complexity before it was built.
 *
 * ## If it is kept
 *
 * The tolerance becomes a setting (`read` in stage, `tool` in kind, so it needs no post-reading
 * entry — tool parameters never enter the reading fingerprint); this module gets a fixpoint oracle,
 * a random sweep and mutation testing; and if a ring of ink survives round a filled mark, a small
 * dilation of the result is the fix.
 */

import type { ScalarField } from "./field";
import type { StrokeBounds } from "./inkPaint";

/**
 * How far from the clicked pixel's tone a pixel may be and still join it, on luminance's own 0..1.
 *
 * **A provisional constant, not a setting.** 0.12 is a starting guess: a black mark on parchment
 * sits near 0.05 and the paper near 0.8, so this is generous about the mark's own variation and
 * nowhere near the ground. It is one line in one file precisely so a room can say "try 0.2".
 */
export const BLOB_TONE_TOLERANCE = 0.12;

export interface FloodResult {
  /**
   * The raster indices taken, in the order they were reached.
   *
   * A view into this call's own buffer. Nothing retains it — `paintPixels` consumes it at once —
   * and it is handed over as a view rather than copied so a fill covering half a large map does not
   * pay for a second array of itself.
   */
  readonly pixels: Int32Array;
  /** The rectangle they lie in, for the layer to repaint. Never null: the seed is always taken. */
  readonly bounds: StrokeBounds;
  /** The tone at the click, which is what the whole result was measured against. */
  readonly seedTone: number;
}

/**
 * Flood from one raster pixel by tone.
 *
 * Returns `null` only for a seed outside the field. Every seed inside it yields at least itself, so
 * a caller never has to distinguish "nothing found" from "found one pixel".
 */
export function floodByTone(
  field: ScalarField,
  seedX: number,
  seedY: number,
  tolerance: number,
): FloodResult | null {
  const { width, height, data } = field;
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return null;

  const count = width * height;
  const seed = seedY * width + seedX;
  const seedTone = data[seed]!;
  const low = seedTone - tolerance;
  const high = seedTone + tolerance;

  // One byte per pixel for what has been queued, four for the queue itself. Allocated per click
  // rather than kept as scratch: a click is not a hot path, and a shared buffer would alias the view
  // handed back to the caller.
  const queued = new Uint8Array(count);
  const queue = new Int32Array(count);

  let tail = 0;
  queue[tail++] = seed;
  queued[seed] = 1;

  let left = seedX;
  let right = seedX;
  let top = seedY;
  let bottom = seedY;

  for (let head = 0; head < tail; head++) {
    const at = queue[head]!;
    const x = at % width;
    const y = (at - x) / width;

    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;

    const hasLeft = x > 0;
    const hasRight = x + 1 < width;
    const hasAbove = y > 0;
    const hasBelow = y + 1 < height;

    if (hasLeft) tryPixel(at - 1);
    if (hasRight) tryPixel(at + 1);
    if (hasAbove) tryPixel(at - width);
    if (hasBelow) tryPixel(at + width);
    // The four corners, which are what an anti-aliased diagonal edge needs — see the note above.
    if (hasAbove && hasLeft) tryPixel(at - width - 1);
    if (hasAbove && hasRight) tryPixel(at - width + 1);
    if (hasBelow && hasLeft) tryPixel(at + width - 1);
    if (hasBelow && hasRight) tryPixel(at + width + 1);
  }

  function tryPixel(index: number): void {
    if (queued[index] === 1) return;
    const tone = data[index]!;
    if (tone < low || tone > high) return;
    queued[index] = 1;
    queue[tail++] = index;
  }

  return {
    pixels: queue.subarray(0, tail),
    bounds: { left, top, right, bottom },
    seedTone,
  };
}
