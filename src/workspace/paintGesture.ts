/**
 * What a brush gesture *means* — separated from the pointer events that deliver it.
 *
 * Four decisions live here and every one of them can be wrong in a way the picture would not show:
 * where a pointer position lands in the raster, how wide the mark is, whether one sample continues
 * the last stroke or starts a new one, and whether this press is laying paint down or lifting it.
 * Left in the event handlers they are unreachable by a test, because reaching them needs a DOM and a
 * scene. Here they are ordinary functions.
 *
 * **The third one is where both of the wall tools' defects lived.** Gesture sequencing is the part of
 * a pointer tool that can be pinned without a DOM, and the record's advice after a room found two of
 * them in one day was to pull exactly this out. A brush has the same shape of fault available to it:
 * joining the end of one stroke to the beginning of the next draws a line the GM never made, across
 * whatever lies between.
 *
 * Pure: no DOM, no SDK.
 */

import type { PaintLayer } from "../trace/inkPaint";

/** A position in continuous raster coordinates, which is what the brush takes. */
export interface BrushPoint {
  readonly x: number;
  readonly y: number;
}

/** One segment of a stroke, ready to lay down. */
export interface StrokeSegment {
  readonly from: BrushPoint;
  readonly to: BrushPoint;
}

/**
 * Where a pointer position lands in the layer it is painting into.
 *
 * The surface speaks in fractions of the map and the layer is a raster, so this is the conversion —
 * the same one `probeMapFraction` makes, and made in one place for the same reason.
 *
 * **Not clamped to the raster**, deliberately. A stroke that leaves the map and comes back should
 * draw the part that crossed, and clamping the excursion to the edge would instead smear a mark
 * along the border. The brush clips per pixel, so an off-raster coordinate costs nothing and means
 * exactly what it says.
 */
export function rasterPoint(u: number, v: number, layer: PaintLayer): BrushPoint {
  return { x: u * layer.width, y: v * layer.height };
}

/**
 * The radius a width setting means.
 *
 * The control is a **width**, because that is what a person can estimate by looking at a mark, and
 * the brush takes a radius. Halving in one place stops the two drifting apart, which would make
 * every readout in the panel a lie about what the stroke covers.
 */
export function brushRadius(widthPx: number): number {
  return Math.max(0, widthPx) / 2;
}

/**
 * What one pointer sample lays down, or `null` for nothing.
 *
 * Three cases, and the first two are why this exists:
 *
 * - **No previous sample** — this is the start of a stroke, and it lays a *dab*: a segment from the
 *   point to itself. Without it a click that never moves would paint nothing, and a click is how
 *   every small correction is made.
 * - **A previous sample from this same stroke** — a segment between them, which is what covers the
 *   ground a fast pointer skipped over.
 * - **The same position twice** — nothing. A pointer that has not moved has nothing to add, and
 *   laying a zero-length segment again would only re-walk the same pixels.
 *
 * The caller passes `null` at every press and keeps the last point only for the duration of one
 * gesture. That is the whole of the rule against joining one stroke to the next: this function
 * cannot know where the previous stroke ended, so it cannot draw a line to it.
 */
export function strokeSegment(previous: BrushPoint | null, at: BrushPoint): StrokeSegment | null {
  if (!previous) return { from: at, to: at };
  if (previous.x === at.x && previous.y === at.y) return null;
  return { from: previous, to: at };
}

/** Which of the two things a brush does. */
export type PaintVerb = "paint" | "erase";

/**
 * Which tool the Ink step has in hand.
 *
 * **It names the layer rather than the verb**, which is the change the three ink steps becoming one
 * forced. While each layer had a step of its own the step said *what* was being edited and the
 * picker said *which verb*; with one step the picker has to carry both, and the layer is the half
 * that cannot be recovered from anything else. The verb comes from `verbFor` and from Shift.
 *
 * `"none"` is a real state rather than a missing value: it is the Ink step being a place to move the
 * sliders in, where a plain drag pans. It is also where the step starts, because a step that took
 * every press the moment it opened would make the sliders above unusable without a modifier.
 *
 * `"gaps"` is not a brush at all — it takes a click on a ring rather than a drag — which is why
 * the brush code asks for a kind and gets one only when the tool is a brush.
 */
export type PaintTool = "none" | "suppress" | "ink" | "gaps" | "blob" | "speckles";

/**
 * The layer a tool paints into, or `null` when the tool is not a brush.
 *
 * Narrowing in one place, so no caller has to remember which members of the union are brushes. A
 * press handed `null` is declined, which is what lets a drag pan in the gap tool and with no tool
 * chosen — nothing is painted by dragging in either.
 *
 * The two brush members are spelled out rather than imported as `PaintKind`, because that type lives
 * beside the SDK and this module is one of the pure ones. They are the same two strings, and
 * `paintTool.ts` is where the two meet and the compiler checks it.
 */
export function brushKind(tool: PaintTool): "suppress" | "ink" | null {
  return tool === "suppress" || tool === "ink" ? tool : null;
}

/**
 * What this press does, given the tool in hand and whether the modifier is down.
 *
 * Shift **inverts** rather than meaning "erase", which is the convention every painting tool has and
 * is the more useful half of it: the common gesture is a few strokes and a correction, and having to
 * change tool and change back for two seconds of erasing is what makes people stop correcting. It
 * also means the modifier does something in both tools rather than being dead in one.
 *
 * Shift rather than ALT, which is the standing choice on this surface: a room found that Firefox
 * raises its menu bar on ALT and takes the keyboard away mid-drag. Ctrl was never available — it
 * pans, which under a brush is the only way to pan at all.
 */
export function verbFor(tool: PaintVerb, modifier: boolean): PaintVerb {
  if (!modifier) return tool;
  return tool === "paint" ? "erase" : "paint";
}
