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
 */
export function viewFromScreenRect(a: Vec, b: Vec, content: Size): View {
  if (content.width <= 0 || content.height <= 0) return { scale: 1, x: 0, y: 0 };

  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width <= 0 || height <= 0) return { scale: 1, x: 0, y: 0 };

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
  const step = 1 + Math.max(0, stepPercent) / 100;
  const zoomingIn = inverted ? deltaY > 0 : deltaY < 0;
  return zoomingIn ? step : 1 / step;
}
