/**
 * Whether a wall action can act, and which of its two reasons it gives.
 *
 * The decision half of `actionGate`, which is why that half takes the graph as a boolean instead of
 * reading it: the rest of the module is DOM and cannot be imported here at all.
 *
 * **What this is guarding is a defect a room found by pressing three dead buttons.** Straighten,
 * Prune and the frame button were enabled whenever the settings had loaded, and refused after the
 * press by writing to a state line in the opposite corner of a full-screen window. The rule the tool
 * strip already followed — *a tool offered in a state where its presses do nothing is a button that
 * lies* — now covers these too, and this pins the part of it that can be reasoned about without a
 * browser.
 *
 * Mutation-tested: seven mutations, seven caught — including the two that matter most, the
 * ordering swapped so a graphless map is told to raise a slider, and `!(v > 0)` weakened to
 * `v <= 0` so a corrupted setting reads as set.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { actionBlocked, NO_GRAPH } from "./actionGate";

const PRUNE = { value: 0.01, reason: "raise the prune limit under Walls" };

describe("whether a wall action can act", () => {
  it("lets an action through when it has a graph and a limit above zero", () => {
    expect(actionBlocked(true, PRUNE)).toBeNull();
  });

  it("lets an action with no limit of its own through on a graph alone", () => {
    // The frame button. It adds rather than removes, so there is no ceiling to set before pressing
    // it — and passing no limit must not be read as a limit of zero.
    expect(actionBlocked(true)).toBeNull();
  });

  it("blocks every action with no graph, silently", () => {
    /*
      Silently on purpose: `wallTools` draws one sentence at the top of the step for this state, and
      three copies of it under three buttons would say nothing the first did not.

      `NO_GRAPH` is empty, so a caller testing truthiness would read "blocked" as "allowed" — which
      is exactly why the contract is `null` for allowed rather than a boolean.
    */
    expect(actionBlocked(false, PRUNE)).toBe(NO_GRAPH);
    expect(actionBlocked(false)).toBe(NO_GRAPH);
    expect(NO_GRAPH).not.toBeNull();
  });

  it("names the missing graph before the limit, not after", () => {
    /*
      The ordering is the whole of this test, and getting it backwards would be worse than useless:
      with nothing to act on, a limit at zero is **not** why the button is dead, and saying so sends
      a GM to a slider that will not help. Both are wrong at once here, and the graph has to win.
    */
    expect(actionBlocked(false, { value: 0, reason: PRUNE.reason })).toBe(NO_GRAPH);
  });

  it("blocks on a limit of exactly zero, which is the off position", () => {
    expect(actionBlocked(true, { value: 0, reason: PRUNE.reason })).toBe(PRUNE.reason);
  });

  it("blocks on a negative limit rather than treating it as set", () => {
    // `> 0` rather than `!== 0`, so a stored value that has gone negative reads as off instead of as
    // a tolerance. Nothing writes one today; the comparison is what stops it mattering if it ever
    // does.
    expect(actionBlocked(true, { value: -1, reason: PRUNE.reason })).toBe(PRUNE.reason);
  });

  it("blocks on a limit that is not a number", () => {
    // `!(value > 0)` catches NaN where `value <= 0` does not — every comparison against NaN is
    // false, so the `<=` spelling would let a corrupted setting through as though it were set.
    expect(actionBlocked(true, { value: Number.NaN, reason: PRUNE.reason })).toBe(PRUNE.reason);
  });
});
