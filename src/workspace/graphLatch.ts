/**
 * The latch behind *Straighten* — the one action with an amount left.
 *
 * ## It was two amounts until 2026-09-22
 *
 * *Prune the dead ends* shared it, and left to become a ringed tool like Mend (user, 2026-09-22):
 * rings on what it would take, one piece a click, a button for all. Each click there is its own edit,
 * so there is nothing to pin. What follows was written for both and holds for the one; the passage on
 * why one pin carried two amounts rather than two latches is kept because the reason still applies to
 * anything that ever joins Straighten here.
 *
 * ## What an action with an amount is, and why it is not a setting
 *
 * Both were parameters the derive read: stored, fed into the trace, and reversible because a derivation
 * is not spent by being redone — turn the handle back and the detail comes back from the ink. They are
 * **applied to the walls in front of the GM** now, which is what lets them work on a graph that has been
 * hand-edited, and what retires the lock they used to need. After this, the only things that regenerate
 * the walls are the map and the ink.
 *
 * That change costs each handle its meaning. Applied to the current graph the operation is cumulative:
 * prune at one amount, then a smaller one, and the runs do not come back, because the document no longer
 * holds them. So a handle cannot describe a state, and a slider whose position describes nothing is the
 * non-monotonic trap the two-slider gap design already collapsed under.
 *
 * ## The latch is what buys the sliders back
 *
 * Opening the drawer **pins** the graph. Both handles then preview against that fixed base rather than
 * against the last result, so dragging back and forth inside one opening is free and exact — the same
 * property the derive-time versions had, with the base being the graph rather than the ink. Closing the
 * drawer applies the result once.
 *
 * **Both amounts start at zero on every opening**, and that is the load-bearing half. Left where the GM
 * put them, a handle would sit describing work already done, and one nudge would re-apply it to the
 * already-pruned base — the ratchet back through the side door. At zero each reads honestly as *how much
 * more*, and three things fall out for free: a drawer closed untouched applies nothing, a drawer stolen
 * by another press commits nothing, and one opening is one undo entry.
 *
 * ## If a second amount ever joins: one pin, not two latches
 *
 * Two sliders in one drawer with two independent latches would pin the same graph and both try to
 * commit on the way out — and the first to save **replaces the document**, which voids the second by the
 * staleness rule below. The second amount would vanish with nothing said. One pin carrying both is what
 * made the drawer's commit a single operation while Prune shared it, and it is the shape to go back to.
 *
 * ## The staleness rule, which is the only subtle thing here
 *
 * A pinned base describes the document as it was. Two things replace the document while a drawer is
 * open — **an undo**, and **a derive landing** — and applying an operation computed against the old base
 * would silently throw away whatever replaced it. So the latch is **void** the moment the current graph
 * is not the object that was pinned, and a void latch commits nothing.
 *
 * Identity, not equality: every edit and every derive replaces the graph wholesale, which is the same
 * property the face traversal's cache is keyed on. Two graphs that are equal but distinct are still a
 * replacement, and treating them as one would be trusting a comparison nothing guarantees.
 *
 * Pure: no DOM, no SDK. The pointer plumbing lives in the caller, which is the split that fixed three
 * sequencing defects in a row when the gesture deciders were pulled out.
 */

import type { WallGraph } from "../trace/wallGraph";

/** A pinned base and the amounts aimed at it. */
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
  /** How much to straighten by, in graph units. Zero means straightening is off. */
  readonly straighten: number;
};

/** No latch: nothing is open, nothing is pending. */
export const NO_LATCH: GraphLatch = {
  base: null,
  fromDerivation: false,
  straighten: 0,
};

/**
 * Pin a graph as the drawer opens.
 *
 * **The amount is zero**, never carried over from the last opening, for the reason in the module note.
 * A `null` graph pins nothing, which is the state on a map with no walls yet.
 */
export function openLatch(graph: WallGraph | null, fromDerivation: boolean): GraphLatch {
  if (!graph) return NO_LATCH;
  return { base: graph, fromDerivation, straighten: 0 };
}

/**
 * Aim the handle.
 *
 * Negative and non-finite values land on zero rather than being refused: this is a slider's live
 * position, so the safe reading of nonsense is *off*.
 */
export function aimLatch(latch: GraphLatch, amount: number): GraphLatch {
  const wanted = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (!latch.base || wanted === latch.straighten) return latch;
  return { ...latch, straighten: wanted };
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

/** What the latch would apply: the base and the amount, or nothing when it is off. */
export function previewOf(latch: GraphLatch): { base: WallGraph; straighten: number } | null {
  if (!latch.base || latch.straighten <= 0) return null;
  return { base: latch.base, straighten: latch.straighten };
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
): { base: WallGraph; straighten: number; fromDerivation: boolean } | null {
  const preview = previewOf(latch);
  return preview ? { ...preview, fromDerivation: latch.fromDerivation } : null;
}
