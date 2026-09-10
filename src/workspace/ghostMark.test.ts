/**
 * The ghost mark: where the picture actually is, when that is not where the handle is.
 *
 * Pinned against the failures a room reported, which were several faults behind one sentence — see
 * `ghostMark.ts`. The one that mattered most is the round trip: a value written from a track
 * position does not convert back to that position exactly, and the old exact comparison of
 * positions left the ghost beside the handle for good.
 *
 * Mutation-tested: seven mutations, seven caught — among them **the original bug reinstated**, the
 * settled test asked in positions instead of values, which is the one that has to fail here.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { ghostPosition, type GhostInput } from "./ghostMark";

/**
 * A track that rounds, the way the real ones do.
 *
 * Positions 0–1000 over values 0–1, but a value converts back through a coarser grid — which is the
 * property that broke the old ghost. Exact identity would hide it.
 */
const lossy = (value: number): number => Math.round(Math.round(value * 1000) / 7) * 7;

function row(overrides: Partial<GhostInput>): GhostInput {
  return {
    lags: true,
    applied: 0.5,
    current: 0.5,
    handle: lossy(0.5),
    placed: lossy(0.5),
    positionOf: lossy,
    ...overrides,
  };
}

describe("where a slider's ghost goes", () => {
  it("shows nothing when the picture is current and the handle is where it was left", () => {
    expect(ghostPosition(row({}))).toBeNull();
  });

  it("marks where the picture is while the handle is being dragged away from it", () => {
    // The drag is pending before anything is written: the settings have not moved, the handle has.
    expect(ghostPosition(row({ handle: 800 }))).toBe(lossy(0.5));
  });

  it("keeps the mark after release until the recompute lands", () => {
    // Released at 800: placed follows the handle, current is the new value, the picture is the old.
    expect(ghostPosition(row({ current: 0.8, handle: 800, placed: 800 }))).toBe(lossy(0.5));
  });

  it("clears once the recompute lands, however the value rounds back onto the track", () => {
    /*
      **The regression this exists for.** The released value converts back to a position that is
      not the handle's — here 0.8 lands on 798 against a handle at 800 — which is exactly the gap an
      exact position test could never close. Compared as values, applied and current are one number
      once `markApplied` has copied it, and there is nothing left to point at.
    */
    expect(lossy(0.8)).not.toBe(800);
    expect(ghostPosition(row({ applied: 0.8, current: 0.8, handle: 800, placed: 800 }))).toBeNull();
  });

  it("never marks a control whose picture cannot lag", () => {
    // A brush width, a gap slider, an opacity: nothing is ever pending on them, so a ghost could
    // only mark a delay that does not exist — which is how theirs used to stay up for good.
    expect(ghostPosition(row({ lags: false, handle: 800 }))).toBeNull();
    expect(ghostPosition(row({ lags: false, current: 0.8, handle: 800, placed: 800 }))).toBeNull();
  });

  it("disappears into the handle when a drag lands back exactly on it", () => {
    // Dragged away and back in one gesture, not yet released: still pending by the handle's own
    // account, but a mark under the handle is invisible and is the "you are back" signal.
    const home = lossy(0.5);
    expect(ghostPosition(row({ handle: home, placed: home + 7 }))).toBeNull();
  });

  it("reports the picture's position, not the handle's", () => {
    // A mark drawn where the handle is would say nothing. It has to be the applied value's place.
    const at = ghostPosition(row({ applied: 0.2, current: 0.9, handle: 900, placed: 900 }));
    expect(at).toBe(lossy(0.2));
    expect(at).not.toBe(900);
  });
});
