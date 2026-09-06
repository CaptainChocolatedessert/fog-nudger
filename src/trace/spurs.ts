/**
 * Spurs: the short dead-end branches thinning leaves behind, and pruning them.
 *
 * ## What a spur is, and why it is not the same thing as a stub
 *
 * Thinning is faithful to the ink, which means it is faithful to the *bumps* on the ink. A wall
 * drawn by hand has a ragged edge, and every notch wide enough to survive binarisation grows a short
 * branch off the centreline. Those are artefacts of the drawing, not features of the map.
 *
 * A **stub** — a wall sticking a foot into a room and stopping — is the case this whole approach
 * exists to keep, and it looks exactly the same locally: a branch with a free end. **Only its length
 * separates them**, which is why this is a control with a number on it rather than a rule. Prune too
 * hard and real stubs go; prune not at all and the graph is hairy. What the right number is on a
 * real hand-drawn map is precisely what step C exists to find out.
 *
 * ## Junctions are counted by crossings, not by neighbours — and this was a bug first
 *
 * The obvious test for "is this pixel a junction" is *three or more ink neighbours*. It is wrong on
 * a skeleton, and wrong in a way that leaves visible litter. A pixel sitting one row above a
 * horizontal line touches three of that line's pixels diagonally, so it counts three neighbours and
 * looks like a junction — which stops the walk one pixel short and leaves a nub on the wall for
 * every spur pruned.
 *
 * The right measure is the **crossing number**: how many times the eight-neighbour ring changes from
 * background to ink going round. An endpoint is 1, a pixel in the middle of a line is 2, a T is 3.
 * That pixel above the line has a crossing number of 2, because its three neighbours are one
 * contiguous run — which is exactly what "on a path" means.
 *
 * ## Walking rather than measuring
 *
 * A branch is followed pixel by pixel from its free end until the next pixel is a junction, or until
 * it runs past the budget. Length is counted in **pixels stepped**, not straight-line distance: a
 * curled spur is as long as the path along it, and one that doubles back would otherwise measure as
 * short as its endpoints are close.
 *
 * The junction pixel itself is never deleted — it belongs to the arms that survive, and taking it
 * would break the wall the spur hangs off, which is this project's worst outcome wearing a very
 * small hat.
 *
 * Pruning is iterated, because removing one branch can leave the junction it hung off with two arms
 * instead of three, turning it into an ordinary path pixel and exposing a second branch behind the
 * first.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";

export interface PruningResult {
  readonly mask: BinaryMask;
  /** How many branches were removed, over all rounds. */
  readonly removed: number;
  /** Pixels deleted, which is what the picture actually loses. */
  readonly pixels: number;
  readonly rounds: number;
}

/** Clockwise from north, so a walk round the ring is contiguous. Crossing numbers depend on it. */
const RING: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function at(data: Uint8Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return data[y * width + x] ?? 0;
}

function neighboursOf(data: Uint8Array, width: number, height: number, index: number): number[] {
  const x = index % width;
  const y = (index - x) / width;
  const found: number[] = [];
  for (const [dx, dy] of RING) {
    if (at(data, width, height, x + dx, y + dy) === 1) found.push((y + dy) * width + (x + dx));
  }
  return found;
}

/** How many times the ring goes background→ink: 1 at an end, 2 on a path, 3 or more at a junction. */
function crossings(data: Uint8Array, width: number, height: number, index: number): number {
  const x = index % width;
  const y = (index - x) / width;
  const ring = RING.map(([dx, dy]) => at(data, width, height, x + dx, y + dy));
  let count = 0;
  for (let i = 0; i < 8; i++) if (ring[i] === 0 && ring[(i + 1) % 8] === 1) count += 1;
  return count;
}

/**
 * Remove every dead-end branch shorter than `maxLength` pixels.
 *
 * `maxLength` of zero is off and returns the skeleton untouched — the same convention the two ink
 * filters use, and for the same reason: a control that does nothing at its default is a control a GM
 * can leave alone.
 *
 * A branch that reaches the budget without meeting a junction is **kept**. It is either a real stub
 * or a stroke of its own, and the whole point of a length threshold is that everything past it is
 * treated as deliberate.
 */
export function pruneSpurs(skeleton: BinaryMask, maxLength: number): PruningResult {
  const { width, height } = skeleton;
  const data = new Uint8Array(skeleton.data);
  if (maxLength <= 0) {
    return { mask: { width, height, data }, removed: 0, pixels: 0, rounds: 0 };
  }

  let removed = 0;
  let pixels = 0;
  let rounds = 0;

  for (;;) {
    /*
      A set rather than a list, and that is a counting fix rather than a deletion one.

      A branch attached to a wall has one free end. A **free-floating fragment** short enough to
      prune has two, so it was walked from both: `removed` went up twice and `pixels` gained its
      length twice. Deletion was always right — it is deferred to the end of the round and writing 0
      twice is writing 0 — so only the numbers were wrong. On a three-pixel isolated run: `removed`
      2, `pixels` 6, three pixels actually deleted.

      Skipping an end already condemned this round is what makes it once. Two spurs off the same
      junction are unaffected: `walk` stops *before* the junction, so their paths never overlap.
    */
    const doomed = new Set<number>();
    rounds += 1;

    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 1) continue;
      // An isolated pixel is not a dead end — it is a speck, and deleting it here would make this
      // control quietly do the ink-island filter's job with a different number on it.
      if (neighboursOf(data, width, height, index).length === 0) continue;
      if (crossings(data, width, height, index) !== 1) continue;
      if (doomed.has(index)) continue;

      const branch = walk(data, width, height, index, maxLength);
      if (branch) {
        removed += 1;
        for (const pixel of branch) doomed.add(pixel);
      }
    }

    if (doomed.size === 0) break;
    for (const index of doomed) data[index] = 0;
    pixels += doomed.size;
  }

  return { mask: { width, height, data }, removed, pixels, rounds };
}

/**
 * Follow a branch from its free end, returning its pixels if it is short enough to prune.
 *
 * Returns `null` when the branch runs past the budget, which is what keeps a real stub. Stops
 * *before* the junction it runs into, and stops as soon as a junction is adjacent rather than after
 * stepping onto it — otherwise the walk can turn along the wall at a diagonal contact and start
 * eating it.
 */
function walk(
  data: Uint8Array,
  width: number,
  height: number,
  start: number,
  maxLength: number,
): number[] | null {
  const path: number[] = [];
  const visited = new Set<number>();
  let current: number | undefined = start;

  while (current !== undefined) {
    if (crossings(data, width, height, current) >= 3) return path;

    path.push(current);
    visited.add(current);
    if (path.length > maxLength) return null;

    const onward: number[] = neighboursOf(data, width, height, current).filter(
      (candidate: number) => !visited.has(candidate),
    );
    if (onward.length === 0) return path;
    // A junction touching this pixel ends the branch here. Stepping onto it and deciding afterwards
    // is what lets a diagonal contact with a wall be mistaken for the branch continuing.
    if (onward.some((candidate) => crossings(data, width, height, candidate) >= 3)) return path;

    current = onward[0];
  }

  return path;
}

/**
 * One run between two junctions, which is what pruning actually acts on.
 *
 * Deliberately not a `WallEdge` or a `FrozenGraph` edge. The two modes hold different graphs — one
 * carries lattice chains and the other float coordinates in fractions of the map — and the *decision*
 * pruning makes depends on neither. It needs which nodes a run joins and how long it is, and the
 * caller measures its own length in the unit its own budget is in.
 *
 * That is the same shape `simplifyPolyline` has: points in, points out, no idea where they came from.
 * It is what lets the ink mode and the wall editor share one implementation rather than growing two
 * that drift.
 */
export interface PrunableRun {
  /** Node indices. Equal when the run is a closed loop. */
  readonly a: number;
  readonly b: number;
  /** How long the run is, in whatever unit the caller's budget is expressed in. */
  readonly length: number;
}

export interface GraphPruning {
  /** Indices into the runs handed in. */
  readonly removed: ReadonlySet<number>;
  /** How many passes it took to settle. Zero when the budget removed nothing. */
  readonly rounds: number;
  /** Total length removed, for the log. */
  readonly length: number;
}

/**
 * Which runs a spur budget removes, iterated until nothing more qualifies.
 *
 * A **spur** is a run with a free end: one of its two nodes is joined to nothing else. Removing one
 * can free the end of another — every arm of a junction becomes a dead end once its neighbours go —
 * so this runs in rounds rather than a single pass. That cascade is why **a budget longer than a
 * wall's arms erodes the whole graph**, which is deliberate over-reach of the same kind the ink
 * filters have: it is visible, because the graph is drawn.
 *
 * ## Degree here is unambiguous, and that retires a whole class of defect
 *
 * The raster version this replaces had to count the **crossing number** — contiguous runs of
 * neighbours around a pixel's ring — rather than raw neighbours, because a pixel one row above a
 * line touches three of its pixels diagonally and reads as a junction, which stopped the branch walk
 * early and left a nub on the wall. On a graph there is no nub to leave: a run is deleted whole, and
 * a node's degree is just how many runs name it. The subtlety does not exist here.
 *
 * ## A closed loop is never a spur
 *
 * A run whose two ends are the same node contributes **two** to that node's degree, so it can never
 * present a free end. That is correct rather than incidental: a loop encloses a face, and deleting it
 * would merge two rooms — which is this project's worst outcome and not something a spur budget may
 * ever do.
 *
 * A run free at *both* ends is a free-standing wall touching nothing, and it does qualify. That
 * matches the raster version, which walked from a free end and consumed the whole chain when it met
 * no junction.
 *
 * Pure: no DOM, no SDK, no raster.
 */
export function spursToPrune(runs: readonly PrunableRun[], budget: number): GraphPruning {
  const removed = new Set<number>();
  if (!(budget > 0) || runs.length === 0) return { removed, rounds: 0, length: 0 };

  let highest = 0;
  for (const run of runs) highest = Math.max(highest, run.a, run.b);
  const degree = new Uint32Array(highest + 1);
  for (const run of runs) {
    degree[run.a]! += 1;
    degree[run.b]! += 1;
  }

  let rounds = 0;
  let length = 0;
  for (;;) {
    const going: number[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (removed.has(i)) continue;
      const run = runs[i]!;
      if (run.length > budget) continue;
      // A loop contributes two to its own node, so it cannot reach one here — which is the guard
      // that stops a budget swallowing a room.
      if (degree[run.a] === 1 || degree[run.b] === 1) going.push(i);
    }
    if (going.length === 0) break;

    /*
      The whole round is decided before any of it is applied.

      Deciding and applying in one pass would let a run removed early in the sweep free the end of a
      later one and take that too — so how much a single round ate would depend on the order the runs
      happened to be in, which is the order the graph builder produced them. Rounds are the mechanism
      for the cascade; within a round, every survivor is judged against the same degrees.
    */
    for (const i of going) {
      removed.add(i);
      const run = runs[i]!;
      degree[run.a]! -= 1;
      degree[run.b]! -= 1;
      length += run.length;
    }
    rounds += 1;
  }

  return { removed, rounds, length };
}
