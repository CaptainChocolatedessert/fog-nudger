/**
 * Thinning: reducing ink to a one-pixel skeleton down the middle of it.
 *
 * ## Why thinning rather than a medial axis — and a correction, measured 2026-08-29
 *
 * The design record says thinning is required because the medial axis of a rectangle stops half a
 * wall width short of each free end. **The second half of that is right and the implied contrast is
 * wrong: thinning pulls back too, by the same amount.** Measured on bars of known width, the
 * skeleton's free end falls short of the ink's by `(w + 1) / 2` pixels — two on a three-wide stroke,
 * four on a seven-wide one. Nothing here reaches the true end of a stroke.
 *
 * **What actually distinguishes it is that the branch survives at all.** Thinning deletes boundary
 * pixels only where doing so cannot break a connection or open a hole, so a stub off a wall comes
 * out as a stub: an edge hanging off a junction, shortened at its tip. The region-first approach
 * deletes it *entirely* — a watershed provably drops every wall that separates nothing — and that is
 * the difference the whole pivot rests on. A stub shortened by three pixels is a wall; a stub that
 * is gone is not.
 *
 * The retraction is a real cost and is left standing rather than corrected, because how much it
 * matters is a question about maps: half a wall width of gap at the free tip of a stub is about
 * 0.06 of a grid square on this project's test map. If a room shows it mattering, the fix is
 * extending each branch end back along its own direction to the ink boundary — end restoration, not
 * a different skeleton.
 *
 * ## Zhang–Suen, and what the conditions mean
 *
 * Two sub-iterations per pass, differing only in which of the four neighbours must be background.
 * A pixel is deleted when all four hold:
 *
 * 1. **It has between two and six ink neighbours.** One neighbour is an endpoint — deleting it
 *    shortens a branch. Seven or eight means it is interior, and deleting interior pixels would eat
 *    the shape from the inside rather than from the edge.
 * 2. **Exactly one 0→1 transition** going round the eight neighbours in order. This is the
 *    connectivity test: two transitions means the pixel is a bridge between two arms, and removing
 *    it would sever them.
 * 3 and 4. **The two direction conditions**, which alternate between sub-iterations so the shape is
 *    eroded from opposite sides in turn. Doing it from one side only would make the skeleton drift
 *    off centre.
 *
 * Deletions within a sub-iteration are decided against the state at the *start* of it and applied
 * together. Deleting as you go makes the result depend on scan order, which is how a thinning
 * implementation ends up asymmetric without anyone noticing.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";

/** What thinning did, for the log — the interesting part is how many passes a map needs. */
export interface ThinningResult {
  readonly mask: BinaryMask;
  readonly passes: number;
  /** Ink pixels in, skeleton pixels out. The ratio is roughly the mean stroke width. */
  readonly before: number;
  readonly after: number;
}

/**
 * The eight neighbours, clockwise from north.
 *
 * The order is load-bearing: the transition count in condition 2 is a walk round this ring, so a
 * different order would count a different number of transitions and delete different pixels.
 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/**
 * Thin a mask until nothing more can be deleted.
 *
 * Iterates over a **list of surviving ink pixels** rather than the whole raster. A map is a few per
 * cent ink, so the difference on this project's test map is roughly six hundred thousand pixels
 * examined per pass against eight and a half million — and the list shrinks as the skeleton
 * emerges, which is the opposite of what a full-raster scan does.
 *
 * The border is treated as background, which matches every other pass in this pipeline: counting
 * off-image as ink would keep a rind of skeleton down the edge of every map.
 */
export function thin(mask: BinaryMask): ThinningResult {
  const { width, height } = mask;
  const data = new Uint8Array(mask.data);

  let live: number[] = [];
  for (let i = 0; i < data.length; i++) if (data[i] === 1) live.push(i);
  const before = live.length;

  let passes = 0;
  for (;;) {
    let changed = false;
    for (const step of [0, 1] as const) {
      const doomed: number[] = [];
      for (const index of live) {
        if (data[index] !== 1) continue;
        if (deletable(data, width, height, index, step)) doomed.push(index);
      }
      if (doomed.length > 0) {
        changed = true;
        for (const index of doomed) data[index] = 0;
      }
    }

    passes += 1;
    if (!changed) break;

    // Rebuilt from the survivors rather than spliced: a pass that deletes a third of the skeleton
    // would otherwise leave the list carrying the other two thirds plus every hole in it.
    live = live.filter((index) => data[index] === 1);
  }

  return { mask: { width, height, data }, passes, before, after: live.length };
}

/** Whether a pixel may be deleted in this sub-iteration. See the four conditions above. */
function deletable(
  data: Uint8Array,
  width: number,
  height: number,
  index: number,
  step: 0 | 1,
): boolean {
  const x = index % width;
  const y = (index - x) / width;

  // Read once into a ring, because conditions 1, 2 and the direction tests all walk the same eight.
  const ring: number[] = [];
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    ring.push(nx < 0 || ny < 0 || nx >= width || ny >= height ? 0 : (data[ny * width + nx] ?? 0));
  }

  let neighbours = 0;
  for (const value of ring) neighbours += value;
  if (neighbours < 2 || neighbours > 6) return false;

  let transitions = 0;
  for (let at = 0; at < 8; at++) {
    if (ring[at] === 0 && ring[(at + 1) % 8] === 1) transitions += 1;
  }
  if (transitions !== 1) return false;

  const [north, , east, , south, , west] = ring as unknown as number[];
  if (step === 0) {
    if (north! * east! * south! !== 0) return false;
    if (east! * south! * west! !== 0) return false;
  } else {
    if (north! * east! * west! !== 0) return false;
    if (north! * south! * west! !== 0) return false;
  }
  return true;
}
