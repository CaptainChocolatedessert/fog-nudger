/**
 * Connected-component labelling of the *space* — the non-ink pixels, which are the regions we
 * eventually emit as fog.
 *
 * ## The connectivity pairing is a correctness requirement, not a tuning knob
 *
 * Space is labelled **4-connected**, which makes ink implicitly **8-connected**. Using the same
 * connectivity for both produces the classic paradox: a one-pixel diagonal touch of ink
 * simultaneously joins the ink *and* fails to separate the space, so two rooms leak into each other
 * through a wall that looks closed on screen and is closed to the eye. That is the merge failure
 * this project fears most, arriving through a rule that looks like a detail (DESIGN.md §5).
 *
 * Concretely: a pixel joins the region to its west or north only, never diagonally.
 *
 * ## No interior/exterior classification
 *
 * The space outside the dungeon is labelled like anything else and emitted like anything else
 * (DESIGN.md §4). Every rule for recognising it failed on real maps — border-touching fails when
 * rooms run to the edge, tone fails because the convention varies by drawing style — and fog being
 * subtractive means an unrevealed exterior region is indistinguishable from space in no shape at
 * all. So the stage that used to make that decision does not exist, and cannot get it wrong.
 *
 * Two-pass with union-find, so cost is linear in pixels and does not depend on region shape.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";

export interface Region {
  /** Label as it appears in `labels`. Never 0, which means ink or discarded. */
  readonly id: number;
  /** Pixels. */
  readonly area: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /**
   * Whether the region reaches the edge of the raster.
   *
   * Reported, never acted on. It used to be the candidate rule for finding the exterior and was
   * retired for being wrong on any map whose rooms run to the edge — which is common.
   *
   * **No production caller can currently see a `true` here**, and the census stopped printing it on
   * 2026-08-31 for that reason: the pipeline only labels `graph.framed`, whose outer row and column
   * are painted as skeleton before labelling runs, and `labelSpace` skips ink. Kept because this is a
   * general labeller — `inkBlobs` labels an inverted mask through it, and nothing stops a future
   * caller passing an unframed one — but a diagnostic that can only report its own null must not be
   * printed, which is the rule the census was breaking.
   */
  readonly touchesBorder: boolean;
}

export interface LabelledSpace {
  readonly width: number;
  readonly height: number;
  /** Row-major. 0 is ink or a discarded region; anything else is a `Region.id`. */
  readonly labels: Int32Array;
  /** Surviving regions, largest first. */
  readonly regions: readonly Region[];
  /**
   * Regions removed by the minimum-area filter, and the pixels they held.
   *
   * **Both are always zero in the pipeline**, because every production call passes `minArea: 0` — the
   * smallest-room control was deleted on 2026-08-30. The census used to print them and stopped on
   * 2026-08-31, since "dropped 0 below the minimum" on every map reads as evidence that nothing was
   * dropped rather than as evidence that nothing could be.
   *
   * Kept rather than deleted, and this is the reasoning so it is not re-litigated: the filter itself
   * is live — `inkBlobs` passes a non-zero `minArea` — and a filter that drops things without saying
   * how many is worse than one that counts. What was wrong was printing the count where it could not
   * vary, not keeping it.
   */
  readonly discarded: number;
  readonly discardedArea: number;
}

export interface LabelOptions {
  /**
   * Smallest region to keep, in pixels. Below this a region is dropped — not turned into ink, just
   * never emitted, which leaves it permanently hidden and is correct for a sliver.
   *
   * **The region pipeline always passes 0**, and that is the whole of it since 2026-08-30: a face is
   * left out only when it holds no interior pixels, which is an invariant rather than a threshold.
   * The one live caller that passes a non-zero value is `inkBlobs`, filtering specks out of a
   * *diagnostic*.
   *
   * The old guidance said to denominate it in grid squares at the call site. That was written for the
   * smallest-room control and went with it; `inkBlobs` does convert from squares, which is the last
   * place the advice still applies. The trade it described has no free answer either way: high enough
   * to kill cross-hatching, it eventually eats a genuine closet.
   */
  readonly minArea: number;
}

export function labelSpace(
  mask: BinaryMask,
  options: LabelOptions = { minArea: 0 },
): LabelledSpace {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height);
  if (width === 0 || height === 0) {
    return { width, height, labels, regions: [], discarded: 0, discardedArea: 0 };
  }

  // Union-find over provisional labels. Grown by doubling rather than sized for the worst case: a
  // checkerboard needs one label per two pixels, and reserving that up front would cost more memory
  // than the image on every ordinary map.
  let parent = new Int32Array(1024);
  let nextLabel = 1;

  const ensure = (needed: number): void => {
    if (needed < parent.length) return;
    let size = parent.length;
    while (size <= needed) size *= 2;
    const grown = new Int32Array(size);
    grown.set(parent);
    parent = grown;
  };

  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression, so repeated lookups down a long chain stay cheap.
    let walk = start;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  const union = (a: number, b: number): number => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return rootA;
    // Smaller root wins, which keeps ids roughly in scan order and makes the trees shallow.
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    parent[drop] = keep;
    return keep;
  };

  // Pass 1 — provisional labels, west and north only. That "only" is the 4-connectivity that makes
  // the ink 8-connected, and it is the whole diagonal-leak guard.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i] === 1) continue; // ink is not space

      const west = x > 0 ? labels[i - 1]! : 0;
      const north = y > 0 ? labels[i - width]! : 0;

      if (west !== 0 && north !== 0) {
        labels[i] = union(west, north);
      } else if (west !== 0) {
        labels[i] = west;
      } else if (north !== 0) {
        labels[i] = north;
      } else {
        ensure(nextLabel);
        parent[nextLabel] = nextLabel;
        labels[i] = nextLabel;
        nextLabel += 1;
      }
    }
  }

  // Pass 2 — resolve every provisional label to its root and accumulate per-root statistics.
  const area = new Map<number, number>();
  const bounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  const border = new Set<number>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const provisional = labels[i]!;
      if (provisional === 0) continue;

      const root = find(provisional);
      labels[i] = root;

      area.set(root, (area.get(root) ?? 0) + 1);
      const box = bounds.get(root);
      if (box) {
        if (x < box.minX) box.minX = x;
        if (y < box.minY) box.minY = y;
        if (x > box.maxX) box.maxX = x;
        if (y > box.maxY) box.maxY = y;
      } else {
        bounds.set(root, { minX: x, minY: y, maxX: x, maxY: y });
      }
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border.add(root);
    }
  }

  // Filter and compact. Surviving roots are renumbered from 1 in descending area order, so the
  // census reads in the order a human wants and the ids are stable to quote.
  const survivors = [...area.entries()]
    .filter(([, count]) => count >= options.minArea)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  let discarded = 0;
  let discardedArea = 0;
  for (const [root, count] of area) {
    if (count < options.minArea) {
      discarded += 1;
      discardedArea += count;
    }
    void root;
  }

  const remap = new Map<number, number>();
  const regions: Region[] = survivors.map(([root, count], index) => {
    const id = index + 1;
    remap.set(root, id);
    const box = bounds.get(root)!;
    return {
      id,
      area: count,
      minX: box.minX,
      minY: box.minY,
      maxX: box.maxX,
      maxY: box.maxY,
      touchesBorder: border.has(root),
    };
  });

  // Pass 3 — rewrite to compacted ids, zeroing anything the filter dropped.
  for (let i = 0; i < labels.length; i++) {
    const root = labels[i]!;
    if (root === 0) continue;
    labels[i] = remap.get(root) ?? 0;
  }

  return { width, height, labels, regions, discarded, discardedArea };
}
