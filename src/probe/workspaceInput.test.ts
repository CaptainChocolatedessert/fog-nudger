import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_WINDOW_MS,
  attributeMovement,
  channelVerdict,
  describeKeyboardFocus,
  pointMoved,
  summariseCapture,
  type LastEventTimes,
} from "./workspaceInput";

/**
 * Every channel silent, as a base to override one field at a time.
 *
 * Written out rather than built by a loop so a test reads as a stated situation. Fixtures here are
 * deliberately **asymmetric** — the timestamps differ from each other and from the movement — for
 * the reason step 4 paid for: a fixture where every number is the same cannot tell a function that
 * picks the most recent event from one that returns whichever channel it happens to check first.
 */
const silent: LastEventTimes = { drag: null, wheel: null, key: null, other: null };

describe("attributeMovement", () => {
  it("blames the most recent channel when two are inside the window", () => {
    // The wheel is later, so it wins — and the two are far enough apart that an implementation
    // taking the *earliest* would visibly give the other answer.
    expect(
      attributeMovement(1000, { ...silent, drag: 400, wheel: 900 }),
    ).toBe("wheel");
    // Reversed, to catch a function that simply prefers one channel by name or by declaration
    // order. This is the pair that makes the test capable of failing.
    expect(
      attributeMovement(1000, { ...silent, drag: 900, wheel: 400 }),
    ).toBe("drag");
  });

  it("ignores an event that happened after the movement", () => {
    // A wheel event timestamped later than the movement cannot have caused it, however close it
    // sits. Without the check the nearer-in-time wheel would win and invent a leak on the one
    // channel that was innocent.
    expect(attributeMovement(1000, { ...silent, drag: 950, wheel: 1010 })).toBe("drag");
  });

  it("ignores an event older than the window", () => {
    const stale = 1000 - ATTRIBUTION_WINDOW_MS - 1;
    expect(attributeMovement(1000, { ...silent, drag: stale })).toBe("other");
    // And the boundary from the inside, so a `>` written as `>=` is caught.
    expect(attributeMovement(1000, { ...silent, drag: 1000 - ATTRIBUTION_WINDOW_MS })).toBe("drag");
  });

  it("says `other` when nothing of ours was recent", () => {
    // Someone else in the room panning is a real event and must not be attributed to a channel
    // that was never touched.
    expect(attributeMovement(1000, silent)).toBe("other");
  });

  it("does not attribute movement to the `other` slot's own timestamp", () => {
    // `other` is an output, never an input. A loop written over every key of the record would
    // return it here and the readout would report a leak on a channel that does not exist.
    expect(attributeMovement(1000, { ...silent, other: 990 })).toBe("other");
    expect(attributeMovement(1000, { ...silent, other: 990, key: 500 })).toBe("key");
  });
});

describe("pointMoved", () => {
  it("ignores sub-threshold jitter on both axes", () => {
    expect(pointMoved({ x: 100, y: 200 }, { x: 100.5, y: 200.5 })).toBe(false);
  });

  it("sees a move on either axis alone", () => {
    // Both directions separately: a version testing only x passes the first and fails the second.
    expect(pointMoved({ x: 100, y: 200 }, { x: 140, y: 200 })).toBe(true);
    expect(pointMoved({ x: 100, y: 200 }, { x: 100, y: 240 })).toBe(true);
  });

  it("sees a move in the negative direction", () => {
    // Guards a comparison written without the absolute value, which is right half the time.
    expect(pointMoved({ x: 100, y: 200 }, { x: 60, y: 160 })).toBe(true);
  });
});

describe("channelVerdict", () => {
  it("separates never-tried from tried-and-clean", () => {
    // The distinction the type exists for. Both have zero movements blamed on them, and reporting
    // the first as `ours` is the diagnostic failure DESIGN.md §8 names.
    expect(channelVerdict(0, 0)).toBe("untested");
    expect(channelVerdict(12, 0)).toBe("ours");
  });

  it("reports a leak on a single attributed movement", () => {
    expect(channelVerdict(12, 1)).toBe("leaking");
  });
});

describe("describeKeyboardFocus", () => {
  it("distinguishes focus on open from focus after a click", () => {
    const beforeClick = describeKeyboardFocus({
      hadFocusAtOpen: true,
      keysBeforeAnyPointer: 3,
      keysAfterAPointer: 0,
    });
    const afterClick = describeKeyboardFocus({
      hadFocusAtOpen: false,
      keysBeforeAnyPointer: 0,
      keysAfterAPointer: 3,
    });
    expect(beforeClick).not.toBe(afterClick);
    expect(beforeClick).toMatch(/without clicking/);
    expect(afterClick).toMatch(/only after a click/);
  });

  it("prefers the stronger evidence when both kinds of key arrived", () => {
    // A key before any pointer proves focus on open outright, so later keys cannot downgrade it.
    expect(
      describeKeyboardFocus({
        hadFocusAtOpen: false,
        keysBeforeAnyPointer: 1,
        keysAfterAPointer: 9,
      }),
    ).toMatch(/without clicking/);
  });

  it("says nothing has been typed yet, and whether that is expected", () => {
    const focused = describeKeyboardFocus({
      hadFocusAtOpen: true,
      keysBeforeAnyPointer: 0,
      keysAfterAPointer: 0,
    });
    const unfocused = describeKeyboardFocus({
      hadFocusAtOpen: false,
      keysBeforeAnyPointer: 0,
      keysAfterAPointer: 0,
    });
    expect(focused).toMatch(/no keys yet/);
    expect(unfocused).toMatch(/no keys yet/);
    // The two must not read alike: one is "try typing", the other is "you will have to click
    // first". A single "no keys yet" for both loses the only hint available before anyone types.
    expect(focused).not.toBe(unfocused);
  });
});

describe("summariseCapture", () => {
  it("never lets an untested channel read as a pass", () => {
    const summary = summariseCapture({ drag: "untested", wheel: "ours" });
    expect(summary).toMatch(/drag not tried yet/);
    expect(summary).toMatch(/wheel ours/);
  });

  it("shouts about a leak, since it is the answer that kills the design", () => {
    expect(summariseCapture({ drag: "leaking", wheel: "ours" })).toMatch(/LEAKING/);
  });
});
