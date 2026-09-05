/**
 * The paint layer: what the GM has suppressed and what they have added, over the ink.
 *
 * Two documents in one painter, because they are disjoint in meaning rather than in pixels — a GM
 * may well suppress an area and then draw a wall back across part of it, and the added ink wins,
 * which is exactly what the composition does. Drawing them in one pass with added ink second says
 * that on the canvas.
 *
 * ## Fixed colours, and neither is the ink's
 *
 * The ink is a colour the GM chooses because no single one works on every map. These two are fixed,
 * the same arrangement the break fill has and resting on the same rule: what the map said and what
 * we did to it must never look alike (`DESIGN.md` §8). Amber for ink taken away, cyan for ink put
 * in — and both at full alpha whatever the ink opacity is set to, so a GM who has tinted the mask
 * down to compare it against the linework underneath has not also turned their own edits down.
 *
 * ## A stroke repaints its own rectangle and nothing else
 *
 * The bitmap is the map's whole raster — 8.4 million pixels on this project's test map — and
 * rebuilding it costs tens of milliseconds. A brush delivers a sample every frame, so rebuilding per
 * sample would make the tool unusable. `paintStroke` reports the rectangle it actually changed, and
 * only that rectangle is rewritten and pushed to the canvas.
 *
 * **That rectangle comes from the same loop that did the writing**, which is what keeps this from
 * being a second computation of where the paint went. The alternative was to stroke a line onto the
 * offscreen canvas beside stamping it into the layer — two arithmetics for one mark, which is exactly
 * the divergence a raster document was chosen to remove.
 *
 * ## The brush ring is the size indication
 *
 * The width control is in raster pixels, so how much *screen* a stroke covers changes with the zoom —
 * which is the right behaviour and an impossible one to judge from a number. The ring is drawn at the
 * map's scale rather than a fixed screen size, because saying how much map the next stroke takes is
 * its whole job.
 */

import type { PaintKind } from "../../inkPaintStore";
import { parseColour, type Rgb } from "../../overlay/maskImage";
import type { PaintLayer, StrokeBounds } from "../../trace/inkPaint";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { brushRadius } from "../paintGesture";
import { onPaintChange, openPaintKind, paintLayerFor } from "../paintState";
import { currentSettings } from "../settingsState";
import { addPainter, invalidate, say, type Frame, type Painter } from "../shell";

/**
 * Kept in step with `.suppress-key` and `.addink-key` in the page's stylesheet by hand.
 *
 * Amber and cyan are chosen against what is already on this canvas: red-by-default ink, purple break
 * fills, green skeleton, blue graph handles, and the six cycling region colours. They are also the
 * two that read as opposites, which is what the pair means.
 */
export const SUPPRESS_COLOUR = "#f59e0b";
export const ADD_COLOUR = "#22d3ee";

/**
 * The brush ring's stroke, in screen pixels.
 *
 * Cased white-under-colour, the treatment the wall lines needed after a room reported them
 * invisible: this sits over the map's own linework by definition, since linework is what it is aimed
 * at, and a single ring in one colour disappears into it.
 */
const RING_WIDTH = 1.5;

let painted: Bitmap | null = null;
/** Which two layers the bitmap was built from, so it is only rebuilt when they are replaced. */
let builtFrom: { readonly suppress: PaintLayer | null; readonly ink: PaintLayer | null } | null =
  null;

/** Where the brush is, in map fractions, or `null` when the pointer is not over the map. */
let brushAt: { readonly u: number; readonly v: number } | null = null;

/**
 * Put the brush ring somewhere, or take it away.
 *
 * Called on every hover, so it only invalidates when the ring would actually move — repainting per
 * mouse movement is what a room felt as lag in the wall tools.
 */
export function setBrushPosition(at: { readonly u: number; readonly v: number } | null): void {
  if (!brushAt && !at) return;
  if (brushAt && at && brushAt.u === at.u && brushAt.v === at.v) return;
  brushAt = at;
  invalidate();
}

/** What colour a pixel of the two layers is, with added ink winning where they overlap. */
function colourAt(
  i: number,
  suppress: PaintLayer | null,
  ink: PaintLayer | null,
  sameSuppress: boolean,
  sameInk: boolean,
  amber: Rgb,
  cyan: Rgb,
): Rgb | null {
  if (sameInk && ink!.data[i] !== 0) return cyan;
  if (sameSuppress && suppress!.data[i] !== 0) return amber;
  return null;
}

/**
 * Rebuild the whole bitmap from both layers.
 *
 * Runs when a layer is *replaced* — loaded, committed, discarded, or a mode opened — never per
 * stroke. Those are all moments where a pause of a few tens of milliseconds is invisible.
 */
function rebuild(suppress: PaintLayer | null, ink: PaintLayer | null): void {
  const shape = ink ?? suppress;
  if (!shape) {
    painted = null;
    return;
  }

  const amber = parseColour(SUPPRESS_COLOUR);
  const cyan = parseColour(ADD_COLOUR);
  if (!amber || !cyan) return;

  const { width, height } = shape;
  const needed = width * height * 4;
  const buffer =
    painted && painted.buffer.length === needed ? painted.buffer : new Uint8ClampedArray(needed);

  /*
    Only where a layer's own raster matches the one being drawn into.

    A layer painted at another raster is resampled by the pipeline when it composes, and it says so
    in the log. Drawing it here at the wrong scale would put the GM's marks somewhere they are not,
    which is worse than not drawing them — and the mismatch is loud rather than silent, so there is
    somewhere for it to be noticed.
  */
  const sameSuppress = !!suppress && suppress.width === width && suppress.height === height;
  const sameInk = !!ink && ink.width === width && ink.height === height;

  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const colour = colourAt(i, suppress, ink, sameSuppress, sameInk, amber, cyan);
    if (colour) {
      buffer[p] = colour.r;
      buffer[p + 1] = colour.g;
      buffer[p + 2] = colour.b;
      buffer[p + 3] = 255;
    } else {
      // Cleared explicitly rather than assumed zero, for the reason `paintMask` gives: a reused
      // buffer holds the last rasterisation, and stale alpha would draw edits the GM has undone.
      buffer[p] = 0;
      buffer[p + 1] = 0;
      buffer[p + 2] = 0;
      buffer[p + 3] = 0;
    }
  }

  const bitmap = bitmapFrom(buffer, width, height, painted);
  if (!bitmap) {
    painted = null;
    // On the state line as well as the log, matching the other two map-sized layers. A layer that
    // fails to allocate and says nothing is a GM looking at a surface that has quietly stopped
    // showing their own work.
    say("could not allocate the paint overlay", "bad");
    return;
  }
  painted = bitmap;
}

/**
 * Repaint one rectangle out of the layers, after a stroke changed exactly that much.
 *
 * The tool calls this with what `paintStroke` reported. It writes into the same buffer and pushes
 * only the dirty rectangle to the canvas, so the cost is the size of the mark rather than the size of
 * the map.
 */
export function refreshPaintRegion(bounds: StrokeBounds): void {
  const suppress = paintLayerFor("suppress");
  const ink = paintLayerFor("ink");
  const shape = ink ?? suppress;
  if (!painted || !shape) {
    invalidate();
    return;
  }

  const amber = parseColour(SUPPRESS_COLOUR);
  const cyan = parseColour(ADD_COLOUR);
  if (!amber || !cyan) return;

  const { width, height } = shape;
  const sameSuppress = !!suppress && suppress.width === width && suppress.height === height;
  const sameInk = !!ink && ink.width === width && ink.height === height;

  const left = Math.max(0, bounds.left);
  const top = Math.max(0, bounds.top);
  const right = Math.min(width - 1, bounds.right);
  const bottom = Math.min(height - 1, bounds.bottom);
  if (left > right || top > bottom) return;

  const { buffer } = painted;
  for (let y = top; y <= bottom; y++) {
    const row = y * width;
    for (let x = left; x <= right; x++) {
      const i = row + x;
      const p = i * 4;
      const colour = colourAt(i, suppress, ink, sameSuppress, sameInk, amber, cyan);
      buffer[p] = colour ? colour.r : 0;
      buffer[p + 1] = colour ? colour.g : 0;
      buffer[p + 2] = colour ? colour.b : 0;
      buffer[p + 3] = colour ? 255 : 0;
    }
  }

  const context = painted.canvas.getContext("2d");
  // The dirty-rectangle form: the whole `ImageData` is presented but only this rectangle is copied,
  // which is what keeps a brush stroke off the cost of the map.
  context?.putImageData(
    new ImageData(buffer, width, height),
    0,
    0,
    left,
    top,
    right - left + 1,
    bottom - top + 1,
  );
  invalidate();
}

const paint: Painter = ({ context, view, drawWidth, drawHeight }: Frame) => {
  const suppress = paintLayerFor("suppress");
  const ink = paintLayerFor("ink");
  if (!builtFrom || builtFrom.suppress !== suppress || builtFrom.ink !== ink) {
    builtFrom = { suppress, ink };
    rebuild(suppress, ink);
  }
  if (painted) {
    context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
  }
  drawBrushRing(context, view, drawWidth, drawHeight);
};

/**
 * The ring under the cursor, at the size the next stroke will actually cover.
 *
 * Only while a paint mode is open, because in the Ink and Walls steps the paint is being *looked at*
 * rather than edited, and a brush ring there would promise a gesture those steps do not have.
 */
function drawBrushRing(
  context: CanvasRenderingContext2D,
  view: { readonly x: number; readonly y: number },
  drawWidth: number,
  drawHeight: number,
): void {
  const kind = openPaintKind();
  if (!kind || !brushAt) return;

  const layer = paintLayerFor(kind);
  if (!layer || layer.width <= 0) return;

  // The width is in raster pixels and the map is drawn `drawWidth` across, so this is what one raster
  // pixel is worth on screen. From the width alone: the layer and the map share an aspect ratio by
  // construction, since the layer is the raster the map was read into.
  const perPixel = drawWidth / layer.width;
  const radius = brushRadius(widthFor(kind)) * perPixel;
  const x = view.x + brushAt.u * drawWidth;
  const y = view.y + brushAt.v * drawHeight;

  context.save();
  context.beginPath();
  context.arc(x, y, Math.max(RING_WIDTH, radius), 0, Math.PI * 2);
  // Cased, so it reads over dark linework and pale paper alike — the lesson the wall lines taught.
  context.strokeStyle = "rgba(255, 255, 255, 0.9)";
  context.lineWidth = RING_WIDTH * 2.5;
  context.stroke();
  context.strokeStyle = kind === "suppress" ? SUPPRESS_COLOUR : ADD_COLOUR;
  context.lineWidth = RING_WIDTH;
  context.stroke();
  context.restore();
}

function widthFor(kind: PaintKind): number {
  const { overlay } = currentSettings();
  return kind === "suppress" ? overlay.suppressBrushPx : overlay.inkBrushPx;
}

/** Wire the layer up. Registered over the ink and under the breaks — see the composition root. */
export function registerPaintLayer(): void {
  addPainter("paint", paint);
  // A load, a commit, a discard or a mode opening all replace a layer object, which the painter
  // notices on the next frame. This is only here to make sure there *is* a next frame.
  onPaintChange(invalidate);
}
