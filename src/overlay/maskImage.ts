/**
 * Painting the binary mask into RGBA pixels.
 *
 * The whole of what the stage-one overlay draws. Ink gets the chosen colour at full alpha;
 * everything else is left completely transparent, so the map shows through untouched wherever the
 * pipeline found nothing. **Opacity is deliberately not applied here** — it is a display parameter
 * that changes many times a second while the GM drags a slider, and baking it into 8.4 million
 * pixels on every drag would be absurd when the canvas can apply it to the whole image for free at
 * draw time. See `overlay.ts`.
 *
 * Kept pure and separate from the page because the page cannot be tested: it needs a real modal, a
 * real room and a real map. This can be checked against a hand-written grid the way every other
 * fixture in this project is, which is the only reason any of it is verifiable at all.
 *
 * No DOM, no SDK.
 */

import type { BinaryMask } from "../trace/binarize";

/** Red, green and blue, 0–255. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse `#rrggbb`.
 *
 * Returns `null` rather than a fallback colour, so a caller must decide what to do about it. The
 * settings normaliser already guarantees the format, which makes this a second line of defence
 * rather than the first — and one that must not quietly substitute a colour the GM did not choose,
 * because a silently wrong colour is indistinguishable from the picker not working.
 */
export function parseColour(colour: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return null;
  return {
    r: Number.parseInt(colour.slice(1, 3), 16),
    g: Number.parseInt(colour.slice(3, 5), 16),
    b: Number.parseInt(colour.slice(5, 7), 16),
  };
}

/**
 * How many bytes an RGBA buffer for this mask needs.
 *
 * Exported so a caller can decide whether to allocate before trying. At native resolution this is
 * four bytes a pixel over the whole map — about 34MB on this project's test map, on top of the
 * ~75MB of typed arrays the pipeline already holds.
 */
export function rgbaByteLength(mask: BinaryMask): number {
  return mask.width * mask.height * 4;
}

/**
 * Paint ink in `colour`, leave everything else transparent.
 *
 * Writes into `into` when one is supplied, which is what lets a recolour reuse the buffer it
 * already has instead of allocating another 34MB and waiting for the last one to be collected.
 * Alpha is written as fully opaque for ink and zero elsewhere; nothing in between, because a mask
 * pixel is one or the other and softening the edge here would blur the very thing the overlay
 * exists to let a GM look at closely.
 */
export function paintMask(
  mask: BinaryMask,
  colour: Rgb,
  into?: Uint8ClampedArray<ArrayBuffer>,
): Uint8ClampedArray<ArrayBuffer> {
  const needed = rgbaByteLength(mask);
  const out = into && into.length === needed ? into : new Uint8ClampedArray(needed);

  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    if (mask.data[i] === 1) {
      out[p] = colour.r;
      out[p + 1] = colour.g;
      out[p + 2] = colour.b;
      out[p + 3] = 255;
    } else {
      // Cleared explicitly rather than assumed zero. A reused buffer holds the previous colour, and
      // leaving stale alpha behind would paint last run's ink over this run's map — the exact
      // class of failure this project keeps designing against, since it looks like a working
      // overlay that is simply wrong.
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
    }
  }

  return out;
}

/**
 * Where the raster's rectangle sits on screen, from the two probed corners.
 *
 * The corners come back as whatever Owlbear reports for the map's world bounding box, which is not
 * guaranteed to arrive minimum-first — a mirrored placement would swap them. Taking min and max
 * rather than trusting the order costs two comparisons and removes a whole class of "the overlay is
 * inside out" bug that would otherwise only appear on an unusually placed map.
 */
export function screenRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
