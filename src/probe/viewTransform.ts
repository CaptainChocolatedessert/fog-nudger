/**
 * The workspace's own pan and zoom, as arithmetic.
 *
 * ## Why this is ours rather than a dependency
 *
 * The requirement is not "zooming works" — it is **"it feels like Owlbear's"**, and a library hands
 * you someone else's feel, which you then tune through its abstractions instead of by changing a
 * constant. Our case is also unusually small: one image, no rotation, no tiling, one transform, and
 * a surface that already owns every pointer event. What is left is the twenty lines below.
 *
 * The cost, stated: device quirks — trackpad pinch arriving as ctrl+wheel, `deltaMode` differing
 * between browsers, touch, high-DPI — are ours to handle, and that is the unglamorous work a
 * library would have absorbed. It is affordable here because the device matrix is one machine.
 * `DESIGN.md` §11.
 *
 * ## The convention
 *
 * `screen = world * scale + offset`, with no rotation. One number and two offsets describe the
 * whole view, which is why nothing here needs a matrix.
 *
 * Pure. No DOM, no SDK, no canvas.
 */

/** A pan-and-zoom state: uniform scale plus a screen-space offset. */
export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** A width and a height, in whatever space the caller is working in. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A point, in whatever space the caller is working in. */
export interface Vec {
  readonly x: number;
  readonly y: number;
}

/**
 * How far the view may be scaled, as a multiple of the image's own pixels.
 *
 * The lower bound stops the map shrinking to a speck that cannot be found again; the upper bound is
 * well past one screen pixel per image pixel, because inspecting ink at the pixel level is a thing
 * this surface exists for. Neither is a feel decision — the feel lives in the wheel step.
 */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 32;

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  // NaN survives `Math.min`/`Math.max` untouched, and a NaN scale is unrecoverable by navigation:
  // `zoomAbout`'s equal-scale early return never fires, because `NaN === NaN` is false, so every
  // later zoom recomputes NaN offsets and `panBy` adds to NaN. The map stops drawing and nothing
  // says why. `min` rather than 1, because the range is caller-supplied and 1 may be outside it.
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/** Where a world point currently sits on screen. */
export function worldToScreen(view: View, point: Vec): Vec {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

/** What world point is under a screen position. */
export function screenToWorld(view: View, point: Vec): Vec {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/**
 * Fit content into a viewport and centre it.
 *
 * The fallback when there is no Owlbear view to inherit, and what the `f` key returns to.
 */
export function fitToViewport(content: Size, viewport: Size, padding = 0): View {
  if (content.width <= 0 || content.height <= 0) return { scale: 1, x: 0, y: 0 };

  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(
    Math.min(usableWidth / content.width, usableHeight / content.height),
  );

  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/**
 * Build a view from where the content already sits on screen.
 *
 * This is how the workspace opens showing exactly what Owlbear was showing: ask Owlbear for the
 * screen positions of the map's two opposite world corners and hand them here. Opening on the GM's
 * current view rather than on a fitted one means nothing appears to jump at the moment the sheet
 * goes up, which is also what makes a comparison of *feel* honest — the two navigations start from
 * the same place.
 *
 * Takes the corners in either order, since which of them is the minimum depends on Owlbear's
 * conventions rather than on ours.
 *
 * ## It assumes the content is axis-aligned with the world, and that is not checked
 *
 * The rectangle between two transformed corners is the content's extent only when nothing is
 * rotated. A **rotated** map's bounding box is strictly larger than the image on *both* axes, so
 * both ratios come out too large in the same direction and the averaging below cancels nothing — the
 * surface opens at the wrong scale and the wrong offset, with the ink misregistered against the map
 * under it. Registration by construction does not save it: map and mask are wrong together, against
 * Owlbear's idea of where the map is.
 *
 * Nothing here can detect that, because a rotation is not visible in two corner positions.
 * `viewportSettle.ts` states the same assumption for its own two-point transform; this file did not.
 * Whether an Owlbear map image can be rotated at all is **unestablished** — the fix, if it is ever
 * wanted, belongs to the caller: read the item's rotation and fall back to a fit when it is
 * non-zero, losing the no-jump property rather than opening misregistered.
 */
export function viewFromScreenRect(a: Vec, b: Vec, content: Size): View {
  // Written as `!(x > 0)` rather than `x <= 0` so a NaN takes the fallback: `NaN <= 0` is false, and
  // a NaN corner from `transformPoint` would otherwise pass straight through into a NaN view.
  if (!(content.width > 0) || !(content.height > 0)) return { scale: 1, x: 0, y: 0 };

  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (!(width > 0) || !(height > 0)) return { scale: 1, x: 0, y: 0 };

  // The two axes should agree; averaging rather than picking one means a small disagreement shows
  // as a slight misfit either side instead of a whole edge hanging off.
  const scale = clampScale((width / content.width + height / content.height) / 2);
  return { scale, x: left, y: top };
}

/** Slide the view by a screen-space delta. */
export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}

/**
 * Zoom about a fixed screen point — the cursor, or the centre of a pinch.
 *
 * **The invariant is that the world point under that screen position does not move.** Everything
 * else about a zoom is taste; this is the part that is simply right or wrong, and getting it wrong
 * produces a view that creeps away from whatever the GM was looking at. It is also invisible in any
 * single frame and maddening over a dozen, which is why it lives here with a test rather than in an
 * event handler.
 */
export function zoomAbout(
  view: View,
  anchor: Vec,
  factor: number,
  min = MIN_SCALE,
  max = MAX_SCALE,
): View {
  const scale = clampScale(view.scale * factor, min, max);

  /*
    At a limit, do nothing at all.

    Solving the anchor equation with an unchanged scale still returns the same view, so this is not
    strictly necessary — but it says the intent, and it protects the one case where the arithmetic
    would otherwise drift: a factor that rounds the scale to itself while the offsets are recomputed
    from a slightly different number. A map that slides sideways when you keep scrolling at full
    zoom looks broken in a way nobody would attribute to the zoom limit.
  */
  if (scale === view.scale) return view;

  // Keep `anchor` over the same world point: solve `anchor = world * scale + offset` for the offset,
  // using the world point that is under the anchor right now.
  const world = screenToWorld(view, anchor);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

/**
 * The multiplier one wheel notch applies, given a step expressed as a percentage.
 *
 * Separated out because the *step* is the feel knob — it is the number the GM will want raised or
 * lowered until scrolling matches Owlbear — and expressing it as a percentage per notch keeps it
 * something a person can hold in their head, where a raw multiplier is not.
 *
 * `deltaY` is used only for its sign and is deliberately not scaled by its magnitude: browsers
 * report wildly different magnitudes for one physical notch, and honouring them makes the same
 * gesture feel different on two machines.
 */
export function wheelFactor(deltaY: number, stepPercent: number, inverted = false): number {
  // A zero delta is not a zoom in either direction. Without this, the sign test below reads zero as
  // "not zooming in" and returns `1 / step` — a zoom **out** for an event that asked for nothing.
  // Reachable: `classifyWheel` sends every non-pixel-mode event here without looking at `deltaY`, so
  // a purely horizontal wheel in line or page mode (a tilt wheel, a horizontal scroll wheel) zoomed
  // the map out a full notch. Returning the identity makes `zoomAbout`'s equal-scale early return
  // fire, so the view is untouched rather than recomputed to the same numbers.
  if (deltaY === 0) return 1;
  const step = 1 + Math.max(0, stepPercent) / 100;
  const zoomingIn = inverted ? deltaY > 0 : deltaY < 0;
  return zoomingIn ? step : 1 / step;
}

/**
 * What a wheel event was meant to do.
 *
 * Three intents arrive down one event, from two devices, and treating them as one is what made a
 * two-finger scroll zoom the map.
 */
export type WheelIntent = "zoom-notch" | "zoom-pinch" | "pan";

/**
 * A `deltaY` at or above this, integer and with no horizontal component, is a mouse notch.
 *
 * The backstop for a browser that reports mouse wheels in pixels rather than lines — Chrome sends
 * 100 or 120 per notch where Firefox sends lines. A trackpad reaching this while being exactly
 * integer and exactly vertical is possible and rare, and costs one zoom notch when it happens.
 */
export const COARSE_NOTCH_MIN = 40;

/**
 * Decide what a wheel event meant, from what the device actually sent.
 *
 * **Measured rather than reasoned**, on the run that found the problem: 315 wheel events, of which
 * 168 carried `ctrlKey` — the trackpad's pinch — and the rest split between `deltaMode 1` notches
 * from the mouse and fractional `deltaMode 0` deltas from a two-finger scroll. The rules below are
 * that observation, in order of how much each is to be trusted.
 *
 * 1. **`ctrlKey` is a pinch.** Not a modifier the GM is holding: browsers synthesise it for a
 *    trackpad pinch, and it is the one signal here that is a convention rather than a heuristic.
 * 2. **A `deltaMode` other than pixels is a mouse.** Lines and pages are notch units; no trackpad
 *    reports them.
 * 3. **A coarse, integer, purely vertical delta is a mouse** in a browser that reports pixels.
 * 4. **Everything else is a two-finger scroll**, and it means pan.
 *
 * The cost, stated: rules 3 and 4 are a guess about a device from the shape of its numbers, and no
 * such guess is reliable in general. It is checkable rather than silent — the probe reports what it
 * classified each event as — and the failure is one wrong gesture, visible immediately and undone
 * by making the opposite one.
 */
export function classifyWheel(event: {
  readonly ctrlKey: boolean;
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
}): WheelIntent {
  if (event.ctrlKey) return "zoom-pinch";
  if (event.deltaMode !== 0) return "zoom-notch";
  if (
    event.deltaX === 0 &&
    Number.isInteger(event.deltaY) &&
    Math.abs(event.deltaY) >= COARSE_NOTCH_MIN
  ) {
    return "zoom-notch";
  }
  return "pan";
}

/**
 * The multiplier a pinch applies, which — unlike a notch — **does** scale with the delta.
 *
 * A notch is one discrete event and its magnitude is an arbitrary number the browser chose, so
 * `wheelFactor` ignores it. A pinch is a continuous gesture delivered as a stream of small events,
 * and its magnitude is the actual movement of the fingers. Applying a whole notch to each event of
 * that stream is what made trackpad zoom unusably fast: dozens of 12% steps for one gesture.
 *
 * Exponential rather than linear, so the same finger movement zooms by the same *ratio* wherever it
 * starts — and so that a pinch out exactly undoes a pinch in, since `exp(a)·exp(−a)` is 1. A linear
 * factor fails both.
 */
export function pinchFactor(deltaY: number, sensitivity: number): number {
  return Math.exp((-deltaY * Math.max(0, sensitivity)) / 100);
}
