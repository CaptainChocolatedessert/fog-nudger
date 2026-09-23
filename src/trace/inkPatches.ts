/**
 * What *Suppress speckles* offers and what one press takes: a lump of ink, and whatever it encloses.
 *
 * ## Why the ink and not the image
 *
 * *Suppress blob* floods the map **image** by tone, and the reason is stated in §10: a big solid spot
 * derives as an **outline**, because the binarisation asks whether a pixel is darker than its
 * neighbourhood and the middle of a large dark shape has no contrast in it. So there is no blob in the
 * ink to click — only a ring round its edge.
 *
 * **That ring is still a lump of ink, and it is findable.** Measured 2026-09-22 on a pit 90 raster
 * pixels across, with the window at its default 12: the centre is not ink, 3,112 of the pit's 6,362
 * pixels are — an annulus about one window-radius thick — and the island walk sees it as **one
 * component with a span of 91**. A speck 7 across derives solid and is a component of its own. So one
 * rule reaches both, which is what makes this one tool rather than two (user, 2026-09-22).
 *
 * ## Taking what it encloses is what makes it equal to the tone flood
 *
 * A ring suppressed on its own would be the pit's ink gone and the pit's middle still there to derive
 * from later. Taking the enclosed interior too suppresses the whole shape, which is the tone flood's
 * result reached without a tone, without a tolerance, and without the flood's own fault — an
 * anti-aliased edge is a gradient, so a flood stops somewhere inside it and leaves traces.
 *
 * **And it is what makes retuning safe.** Measured the same day across sensitivity 0.2–0.5 and window
 * radius 8–20: the ring's **outer** edge never moved — 45.0 raster pixels at every setting, drift
 * 0.1px — while its **inner** edge moved from 36.1 to 23.3. The boundary that moves is inside what
 * this takes, so a retune cannot reveal a ring the GM already suppressed. **Blur was not measured**;
 * it works on contrast and could move the outer edge.
 *
 * ## The map's edge is a boundary, not a way in
 *
 * A pit drawn against the edge of the map has an open side, so a flood from outside would walk in and
 * the interior would never be filled. **Where the lump meets the image's border, that stretch of border
 * is a wall** (user, 2026-09-22) — from its first cell on that side to its last, and no further. A shape
 * running off the map is still a shape, and ink cannot arrive from outside the image.
 *
 * **Bounded to the stretch, because blocking the whole side was wrong** and the fixtures said so: on a
 * small raster the flood's own box *is* the border, so open ground beside the lump was never seeded and
 * came back counted as enclosed.
 *
 * **A ring that is broken elsewhere encloses nothing**, and this says so rather than guessing: the
 * flood walks in through the gap and only the arc is taken. The rings are drawn before the press, so
 * that case is visible rather than surprising.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import type { Island, IslandWalk } from "./inkIslands";

/** One lump of ink on offer, and where to find it in the walk. */
export interface Patch extends Island {
  /** Its label in the walk — the island's index plus one, as `labels` holds it. */
  readonly label: number;
}

/**
 * Every lump whose span is at or under `maxSpan`, largest first.
 *
 * **Span is the longer side of the bounding box**, the measure the ink filter already uses because it
 * is the one that means *stubby*. A wall network spans the map, so no setting a GM would choose
 * offers it; a pit is room-scale and a speck is smaller still.
 *
 * Largest first so the list reads as *the biggest thing this would take*, which is the one worth
 * looking at before pressing the button that takes them all.
 */
export function patchesUnder(walk: IslandWalk, maxSpan: number): Patch[] {
  if (!(maxSpan > 0)) return [];
  const found: Patch[] = [];
  for (let index = 0; index < walk.islands.length; index++) {
    const island = walk.islands[index]!;
    if (island.span > maxSpan) continue;
    found.push({ ...island, label: index + 1 });
  }
  return found.sort((a, b) => b.span - a.span || b.area - a.area);
}

/**
 * The lump under one raster pixel, or `null` where there is no ink.
 *
 * **What the free click uses** — a press on ink takes that lump whether or not it was offered, which
 * is how this tool absorbs *Suppress blob*'s gesture. Nothing bounds it by span: a press on the wall
 * network takes the wall network, which is the ruling the blob tool already made about its own worst
 * case, left to the preview to make plain rather than guarded against.
 */
export function patchAt(walk: IslandWalk, index: number): Patch | null {
  if (index < 0 || index >= walk.labels.length) return null;
  const label = walk.labels[index]!;
  if (label === 0) return null;
  const island = walk.islands[label - 1];
  return island ? { ...island, label } : null;
}

/**
 * Every raster pixel one press takes: the lump itself, and anything it encloses.
 *
 * The flood runs over the lump's bounding box grown by one, so it stays proportional to the thing
 * being taken rather than to the map. It is **4-connected**, this project's pairing of 8 for ink and 4
 * for space: space that meets only at a corner is not a way through, or a ring whose pixels sit
 * diagonally would leak.
 */
export function patchPixels(mask: BinaryMask, walk: IslandWalk, patch: Patch): number[] {
  const { width, height } = mask;
  const left = Math.max(0, patch.minX - 1);
  const right = Math.min(width - 1, patch.maxX + 1);
  const top = Math.max(0, patch.minY - 1);
  const bottom = Math.min(height - 1, patch.maxY + 1);
  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  if (boxWidth <= 0 || boxHeight <= 0) return [];

  const mine = (x: number, y: number): boolean => walk.labels[y * width + x] === patch.label;

  /*
    **Where the lump meets the image's border, that stretch of border is a wall.**

    A pit drawn against the edge of the map is cut off by it, so its ring stops at the border and the
    middle is bounded by the two together. Without this the flood walks in along the open side and the
    middle is never filled.

    **Bounded to the stretch the lump actually touches**, between its first and last cell on that
    border, rather than the whole side. The first version blocked every border cell and filled the
    ordinary case wrong: in a small raster the flood's own box *is* the border, so open ground beside
    the lump was never seeded and came back as enclosed.
  */
  const reach = (cells: number, on: (i: number) => boolean): { from: number; to: number } | null => {
    let from = -1;
    let to = -1;
    for (let i = 0; i < cells; i++) {
      if (!on(i)) continue;
      if (from < 0) from = i;
      to = i;
    }
    return from < 0 ? null : { from, to };
  };
  const onTop = reach(width, (x) => mine(x, 0));
  const onBottom = reach(width, (x) => mine(x, height - 1));
  const onLeft = reach(height, (y) => mine(0, y));
  const onRight = reach(height, (y) => mine(width - 1, y));
  const walled = (x: number, y: number): boolean =>
    (y === 0 && onTop !== null && x >= onTop.from && x <= onTop.to) ||
    (y === height - 1 && onBottom !== null && x >= onBottom.from && x <= onBottom.to) ||
    (x === 0 && onLeft !== null && y >= onLeft.from && y <= onLeft.to) ||
    (x === width - 1 && onRight !== null && y >= onRight.from && y <= onRight.to);

  const outside = new Uint8Array(boxWidth * boxHeight);
  const stack: number[] = [];
  const reachTo = (bx: number, by: number): void => {
    const x = left + bx;
    const y = top + by;
    const at = by * boxWidth + bx;
    if (outside[at] === 1) return;
    if (mine(x, y) || walled(x, y)) return;
    outside[at] = 1;
    stack.push(at);
  };

  for (let bx = 0; bx < boxWidth; bx++) {
    reachTo(bx, 0);
    reachTo(bx, boxHeight - 1);
  }
  for (let by = 0; by < boxHeight; by++) {
    reachTo(0, by);
    reachTo(boxWidth - 1, by);
  }

  while (stack.length > 0) {
    const at = stack.pop()!;
    const bx = at % boxWidth;
    const by = (at - bx) / boxWidth;
    if (bx > 0) reachTo(bx - 1, by);
    if (bx < boxWidth - 1) reachTo(bx + 1, by);
    if (by > 0) reachTo(bx, by - 1);
    if (by < boxHeight - 1) reachTo(bx, by + 1);
  }

  const taken: number[] = [];
  for (let by = 0; by < boxHeight; by++) {
    for (let bx = 0; bx < boxWidth; bx++) {
      const index = (top + by) * width + (left + bx);
      // The lump itself, and everything the flood could not reach — which is what it encloses,
      // including any other ink sitting inside it.
      if (walk.labels[index] === patch.label || outside[by * boxWidth + bx] === 0) taken.push(index);
    }
  }
  return taken;
}
