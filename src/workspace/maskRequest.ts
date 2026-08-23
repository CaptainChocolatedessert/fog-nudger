/**
 * Deciding when a recomputed mask is still worth painting.
 *
 * ## The rule, and why it is a rule rather than a habit
 *
 * A stage-one control changes the mask, and recomputing one costs about 690ms. So a slider being
 * dragged produces values faster than masks can be made for them, and the question at every reply
 * is: *is this answer still about the settings the GM is looking at?*
 *
 * **The sheet is blank whenever the answer is no.** Not stale, not the previous mask, not a
 * best-effort approximation — absent. That is the same posture the click-through overlay took
 * toward a moving viewport, arrived at from the other side: an overlay that shows ink for settings
 * the GM has already moved past does not merely lag, it *lies*, and comparing ink against linework
 * is the whole of stage one. A GM would read the difference as the tool having found the wall in
 * the wrong place.
 *
 * So: blank on any change, paint only what is current, and if that means blanking for 690ms then
 * blank for 690ms. Being briefly absent is cheap; being confidently wrong is not.
 *
 * ## Latest wins, and nothing queues
 *
 * Values arriving while a computation is in flight replace each other rather than accumulating. A
 * queue would work through every intermediate position of a drag to arrive somewhere the GM left
 * seconds ago — the slowest possible route to the only value anyone wants.
 *
 * ## What this module is not
 *
 * It does not make anything faster and it cannot interrupt a computation that has started. If the
 * work runs on the main thread, a value arriving mid-computation waits for that computation to
 * finish before its own begins. Moving the work off-thread would let the in-flight one be abandoned
 * rather than merely disowned — and this interface does not change if that happens, because
 * "disown the answer" and "abandon the work" are the same decision to a caller.
 *
 * Pure. No DOM, no SDK, no timers.
 */

/**
 * A monotonically increasing stamp identifying one requested state of the settings.
 *
 * A counter rather than a hash of the settings, deliberately. Two different drags can pass through
 * the same value, and a hash would call the second one a duplicate of the first and reuse an answer
 * computed for a state the GM has since left and returned to — right by luck, and wrong the moment
 * anything else about the run differs.
 */
export type Generation = number;

/** What the surface should be showing. */
export type MaskState =
  /** Nothing has been asked for yet. */
  | { readonly kind: "idle" }
  /** A computation is in flight and the sheet is blank until it lands. */
  | { readonly kind: "pending"; readonly generation: Generation }
  /** A mask that is current for the settings on screen. */
  | { readonly kind: "current"; readonly generation: Generation }
  /** The last attempt failed; the sheet stays blank and something says so. */
  | { readonly kind: "failed"; readonly generation: Generation };

/** Whether the surface should be painting a mask at all right now. */
export function shouldPaint(state: MaskState): boolean {
  return state.kind === "current";
}

/**
 * Whether a reply that has just arrived is still worth painting.
 *
 * The whole of the correctness here. A reply is current only when its generation is the one most
 * recently asked for — **equality, not recency**. A `>=` would be wrong in the same direction every
 * time: it would accept an answer computed for an older state whenever a newer request had not yet
 * been issued, which is precisely the moment a GM is looking at the sheet expecting it to be blank.
 */
export function isCurrent(reply: Generation, requested: Generation): boolean {
  return reply === requested;
}

/**
 * The tracker, as a small state machine.
 *
 * Kept as a class rather than free functions over a record because there is exactly one of these
 * per surface and its whole purpose is to own the counter — a counter passed around by value is a
 * counter that eventually gets copied and diverges.
 */
export class MaskRequests {
  private requested: Generation = 0;
  private settled: Generation = 0;
  private state: MaskState = { kind: "idle" };

  /** What the surface should currently be showing. */
  current(): MaskState {
    return this.state;
  }

  /**
   * Note that the settings changed, and take the stamp to compute against.
   *
   * Blanking is immediate and unconditional — it happens here, at the moment of the change, rather
   * than when the recomputation starts. Anything else leaves a window in which the old mask is
   * still on screen under the new settings, which is the exact lie this exists to prevent.
   */
  request(): Generation {
    this.requested += 1;
    this.state = { kind: "pending", generation: this.requested };
    return this.requested;
  }

  /**
   * Record a successful reply, and say whether it should be painted.
   *
   * Returns `false` for a superseded answer, and the caller throws it away. The sheet stays blank
   * because a newer request is already pending — no state change, since `pending` for the newer
   * generation is already what it is.
   */
  fulfil(generation: Generation): boolean {
    if (!isCurrent(generation, this.requested)) return false;
    this.settled = generation;
    this.state = { kind: "current", generation };
    return true;
  }

  /**
   * Record a failure the same way.
   *
   * A superseded failure is discarded exactly like a superseded success: it says nothing about the
   * settings now on screen, and reporting it would put an error message under a slider that has
   * moved on. Only a *current* failure is worth showing.
   */
  fail(generation: Generation): boolean {
    if (!isCurrent(generation, this.requested)) return false;
    this.state = { kind: "failed", generation };
    return true;
  }

  /** The generation the surface is painting, or `null` when it is not painting one. */
  painted(): Generation | null {
    return this.state.kind === "current" ? this.settled : null;
  }

  /** Whether anything is in flight — the surface is blank and waiting rather than blank and idle. */
  waiting(): boolean {
    return this.state.kind === "pending";
  }
}
