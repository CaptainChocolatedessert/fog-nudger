import { describe, expect, it } from "vitest";

import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitToViewport,
  panBy,
  screenToWorld,
  viewFromScreenRect,
  wheelFactor,
  worldToScreen,
  zoomAbout,
  type View,
} from "./viewTransform";

/**
 * A view that is not the identity in any respect.
 *
 * Deliberately asymmetric — scale is not 1, the offsets differ from each other and neither is zero.
 * A fixture at the identity cannot tell a transform that applies the scale from one that forgets
 * it, and one with equal offsets cannot tell x from y. Step 4 of the pipeline paid for that lesson
 * twice with predicates that were wrong before the code was.
 */
const view: View = { scale: 2.5, x: -140, y: 73 };

describe("worldToScreen and screenToWorld", () => {
  it("round-trip", () => {
    const world = { x: 317, y: -58 };
    const back = screenToWorld(view, worldToScreen(view, world));
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it("actually applies the scale and the offset, on both axes", () => {
    // Spelled out rather than round-tripped: a pair of inverse functions that are both wrong in the
    // same way round-trips perfectly.
    expect(worldToScreen(view, { x: 10, y: 20 })).toEqual({ x: 10 * 2.5 - 140, y: 20 * 2.5 + 73 });
  });
});

describe("zoomAbout", () => {
  it("leaves the world point under the anchor exactly where it was", () => {
    // The whole reason this module exists. Anchor deliberately off-centre and off-axis, so a
    // version that anchors on the origin or on the viewport centre fails.
    const anchor = { x: 431, y: 267 };
    const before = screenToWorld(view, anchor);
    const after = screenToWorld(zoomAbout(view, anchor, 1.31), anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("holds the anchor when zooming out as well as in", () => {
    // Both directions, because an error in the offset solution can cancel itself in one of them.
    const anchor = { x: 88, y: 902 };
    const before = screenToWorld(view, anchor);
    const after = screenToWorld(zoomAbout(view, anchor, 1 / 1.31), anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("changes the scale in the direction asked", () => {
    expect(zoomAbout(view, { x: 0, y: 0 }, 2).scale).toBeCloseTo(5, 9);
    expect(zoomAbout(view, { x: 0, y: 0 }, 0.5).scale).toBeCloseTo(1.25, 9);
  });

  it("does not drift when the scale is already at a limit", () => {
    // A map that slides sideways when you keep scrolling at full zoom looks broken in a way nobody
    // would attribute to the zoom limit. Identity on the whole view, not merely on the scale.
    const atMax: View = { scale: MAX_SCALE, x: -140, y: 73 };
    expect(zoomAbout(atMax, { x: 431, y: 267 }, 4)).toEqual(atMax);

    const atMin: View = { scale: MIN_SCALE, x: -140, y: 73 };
    expect(zoomAbout(atMin, { x: 431, y: 267 }, 0.25)).toEqual(atMin);
  });

  it("clamps rather than refusing when a step would overshoot the limit", () => {
    // Overshooting must still move as far as it can. A version that returned the view unchanged
    // whenever the target was out of range would stop short of the limit and never reach it.
    const nearMax: View = { scale: MAX_SCALE / 1.5, x: 0, y: 0 };
    expect(zoomAbout(nearMax, { x: 10, y: 10 }, 4).scale).toBe(MAX_SCALE);
  });
});

describe("fitToViewport", () => {
  it("fits the constrained axis and centres on the other", () => {
    // Content wider than it is tall against a square viewport: width binds, and the spare height is
    // split evenly.
    const fitted = fitToViewport({ width: 400, height: 200 }, { width: 800, height: 800 });
    expect(fitted.scale).toBeCloseTo(2, 9);
    expect(fitted.x).toBeCloseTo(0, 9);
    expect(fitted.y).toBeCloseTo((800 - 400) / 2, 9);
  });

  it("fits the other axis when that is the one that binds", () => {
    // The mirrored case, so a version that always uses width passes the first test and fails here.
    const fitted = fitToViewport({ width: 200, height: 400 }, { width: 800, height: 800 });
    expect(fitted.scale).toBeCloseTo(2, 9);
    expect(fitted.y).toBeCloseTo(0, 9);
    expect(fitted.x).toBeCloseTo((800 - 400) / 2, 9);
  });

  it("honours padding", () => {
    const fitted = fitToViewport({ width: 400, height: 400 }, { width: 800, height: 800 }, 100);
    expect(fitted.scale).toBeCloseTo((800 - 200) / 400, 9);
  });

  it("survives content with no size", () => {
    // A map that failed to decode must not produce NaN offsets that then poison every later pan.
    expect(fitToViewport({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });
});

describe("viewFromScreenRect", () => {
  it("reproduces the rectangle it was given", () => {
    // The property that matters: hand it where the map sits on screen, and drawing with the
    // resulting view must put the map back in exactly that place.
    const content = { width: 3300, height: 2550 };
    const a = { x: 120, y: 64 };
    const b = { x: 120 + 660, y: 64 + 510 };
    const built = viewFromScreenRect(a, b, content);

    const topLeft = worldToScreen(built, { x: 0, y: 0 });
    const bottomRight = worldToScreen(built, { x: content.width, y: content.height });
    expect(topLeft.x).toBeCloseTo(a.x, 6);
    expect(topLeft.y).toBeCloseTo(a.y, 6);
    expect(bottomRight.x).toBeCloseTo(b.x, 6);
    expect(bottomRight.y).toBeCloseTo(b.y, 6);
  });

  it("does not care which corner came first", () => {
    // Which of the two is the minimum is Owlbear's convention, not ours, and it is not worth
    // depending on.
    const content = { width: 400, height: 300 };
    const a = { x: 10, y: 20 };
    const b = { x: 210, y: 170 };
    expect(viewFromScreenRect(b, a, content)).toEqual(viewFromScreenRect(a, b, content));
  });

  it("survives a degenerate rectangle", () => {
    // A map collapsed to nothing on screen — zoomed far out, or bounds not yet read.
    expect(viewFromScreenRect({ x: 5, y: 5 }, { x: 5, y: 5 }, { width: 10, height: 10 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });
});

describe("panBy", () => {
  it("moves the offset and leaves the scale alone", () => {
    expect(panBy(view, 17, -33)).toEqual({ scale: 2.5, x: -123, y: 40 });
  });
});

describe("wheelFactor", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    // The browser convention: scrolling up gives a negative deltaY.
    expect(wheelFactor(-100, 20)).toBeCloseTo(1.2, 9);
    expect(wheelFactor(100, 20)).toBeCloseTo(1 / 1.2, 9);
  });

  it("inverts when asked", () => {
    expect(wheelFactor(-100, 20, true)).toBeCloseTo(1 / 1.2, 9);
    expect(wheelFactor(100, 20, true)).toBeCloseTo(1.2, 9);
  });

  it("ignores the magnitude of the delta", () => {
    // Browsers report wildly different magnitudes for one physical notch — 3, 100, 120 — and
    // honouring them makes the same gesture feel different on two machines. Only the sign is used.
    expect(wheelFactor(-3, 20)).toBeCloseTo(wheelFactor(-4000, 20), 9);
  });

  it("is exactly reversible, so a notch back returns to the same scale", () => {
    // Otherwise a scroll down and up leaves the view slightly changed, which reads as drift.
    expect(wheelFactor(-100, 35) * wheelFactor(100, 35)).toBeCloseTo(1, 9);
  });
});

describe("clampScale", () => {
  it("holds both ends", () => {
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(0.0001)).toBe(MIN_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });
});
