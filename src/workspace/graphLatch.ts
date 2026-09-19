/**
 * The latch behind an action with an amount — *Straighten* and *Prune the dead ends*.
 *
 * ## What an action with an amount is, and why it is not a setting
 *
 * Straightening and pruning were settings read by the derive: stored, fed into the trace, and
 * reversible because a derivation is not spent by being redone — turn the handle back and the detail
 * comes back from the ink. They are **applied to the walls in front of you** now, which is what lets
 * them work on a graph the GM has hand-edited, and what retires the lock they used to need.
 *
 * That change costs the handle its meaning. Applied to the current graph, the operation is
 * cumulative: straighten at one amount, then a smaller one, and the detail does not return, because
 * the document no longer holds it. So the handle cannot describe a state, and a slider whose position
 * describes nothing is the non-monotonic trap the two-slider gap design already collapsed under.
 *
 * ## The latch is what buys the slider back
 *
 * Opening the drawer **latches** the graph as it stands. The handle then previews against that fixed
 * base rather than against the last result, so dragging back and forth inside one opening is free and
 * exact — the same property the derive-time version had, with the base being the graph rather than
 * the ink. Closing the drawer applies the result once.
 *
 * **The amount starts at zero on every opening**, and that is the load-bearing half. Left where the
 * GM put it last, the handle would sit describing work already done, and one nudge would straighten
 * again from the already-straightened base — the ratchet back through the side door. At zero it reads
 * honestly as *how much more*, and three things fall out for free: a drawer closed untouched applies
 * nothing, a drawer stolen by another press commits nothing, and one opening is one undo entry.
 *
 * ## The staleness rule, which is the only subtle thing here
 *
 * A latched base describes the document as it was. Two things replace the document while a drawer is
 * open — **an undo**, and **a derive landing** — and applying an operation computed against the old
 * base would silently throw away whatever replaced it. So the latch is **void** the moment the
 * current graph is not the object that was latched, and a void latch commits nothing.
 *
 * Identity, not equality: every edit and every derive replaces the graph wholesale, which is the same
 * property the face traversal's cache is keyed on. Two graphs that are equal but distinct are still a
 * replacement, and treating them as one would be trusting a comparison nothing guarantees.
 *
 * Pure: no DOM, no SDK. The pointer plumbing lives in the caller, which is the split that fixed three
 * sequencing defects in a row when the gesture deciders were pulled out.
 */

import type { WallGraph } from "../trace/wallGraph";

/** A latched base, the amount aimed at it, and where the base came from. */
export type GraphLatch = {
  /**
   * The graph as it stood when the drawer opened, or `null` for no latch.
   *
   * Held by reference on purpose — see the staleness rule above.
   */
  readonly base: WallGraph | null;
  /**
   * Whether the base was a derivation rather than the stored document.
   *
   * Carried because the save needs it: an edit applied to a derivation is the moment a document
   * becomes necessary, and the store adopts the derivation and the result in one write. Deciding it
   * at commit time instead would read a predicate that may have changed since the latch.
   */
  readonly fromDerivation: boolean;
  /** How much to apply, in graph units. Zero means the action is off. */
  readonly amount: number;
};

/** No latch: nothing is open, nothing is pending. */
export const NO_LATCH: GraphLatch = { base: null, fromDerivation: false, amount: 0 };

/**
 * Latch a graph as a drawer opens.
 *
 * **The amount is always zero**, never carried over from the last opening, for the reason in the
 * module note. A `null` graph latches nothing, which is the state on a map with no walls yet.
 */
export function openLatch(graph: WallGraph | null, fromDerivation: boolean): GraphLatch {
  if (!graph) return NO_LATCH;
  return { base: graph, fromDerivation, amount: 0 };
}

/**
 * Aim the handle at an amount.
 *
 * Negative and non-finite values land on zero rather than being refused: this is a slider's live
 * position, so the safe reading of nonsense is *off*.
 */
export function aimLatch(latch: GraphLatch, amount: number): GraphLatch {
  const wanted = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (!latch.base || wanted === latch.amount) return latch;
  return { ...latch, amount: wanted };
}

/**
 * Void the latch if the document has been replaced under it.
 *
 * Called whenever the graph changes while a drawer is open — an undo, a derive, another tool's edit.
 * Returns the latch unchanged when the base is still the current graph.
 */
export function revalidate(latch: GraphLatch, current: WallGraph | null): GraphLatch {
  if (!latch.base) return latch;
  return latch.base === current ? latch : NO_LATCH;
}

/** What the latch would preview: the base and a positive amount, or nothing. */
export function previewOf(latch: GraphLatch): { base: WallGraph; amount: number } | null {
  if (!latch.base || latch.amount <= 0) return null;
  return { base: latch.base, amount: latch.amount };
}

/**
 * What closing the drawer should commit, or `null` for nothing.
 *
 * The same test as `previewOf` by design — what commits is exactly what was being drawn, so the
 * preview cannot promise something the commit does not do. It carries `fromDerivation` because the
 * save needs it and the preview does not.
 */
export function commitOf(
  latch: GraphLatch,
): { base: WallGraph; amount: number; fromDerivation: boolean } | null {
  const preview = previewOf(latch);
  return preview ? { ...preview, fromDerivation: latch.fromDerivation } : null;
}
