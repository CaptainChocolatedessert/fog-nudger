/**
 * Spurs: the short dead-end walls a skeleton leaves behind, and deciding which to prune.
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
 * hard and real stubs go; prune not at all and the graph is hairy.
 *
 * ## This is the decision, not the deletion
 *
 * Runs in, indices out. Nothing here knows what a graph is, which is what lets the ink mode and the
 * editor share it: `pruneFrozenGraph` supplies the runs and takes the answer away. That is the same
 * shape `simplifyPolyline` has, and it is deliberate — the two modes hold the same document now, but
 * the point stands whatever holds it.
 *
 * **The raster version is gone** (2026-09-06). `pruneSpurs` walked the skeleton pixel by pixel from
 * each free end and deleted what it found, between thinning and chaining. Pruning moved past the
 * freeze, where there is no raster to disturb, and the pixel walk went with it — along with the
 * crossing-number subtlety that walk needed and this does not.
 *
 * Pure: no DOM, no SDK, no raster.
 */

/**
 * One run between two junctions, which is what pruning actually acts on.
 *
 * Deliberately not a `FrozenGraph` edge, and not a run of them. The *decision* pruning makes needs
 * two things — which nodes a run joins, and how long it is — and neither is a fact about how the
 * caller stores its geometry. The caller measures the length in the unit its own budget is in.
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
