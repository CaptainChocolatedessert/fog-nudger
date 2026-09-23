/**
 * The speckles layer: a ring round every lump the span found.
 *
 * The gaps layer's job with a different search and the other colour — these rings are **destructive**,
 * because accepting one suppresses ink, where accepting a gap adds it. The same red the erase target
 * and the doomed spurs use, which is the channel that already means *this is what would go*.
 *
 * ## Rings only, no fill preview
 *
 * The gap tool draws what its fill would add, because a gap's fill is a shape a GM cannot predict from
 * the ring. A lump is different: **the ring is round the thing itself**, and what a press takes is that
 * thing plus what it encloses — which for a pit is the disc the ring is already drawn around. A second
 * picture over the top would say what the ring says.
 *
 * ## The rings are in the search's raster
 *
 * Which is the map's own pixels only while the map fits the memory budget, so the scale comes from the
 * raster the tool reports rather than from `view.scale`. The gaps layer paid for that lesson on a
 * large map, where every ring drew at a fraction of its distance from the corner.
 */

import { colourFor } from "../palette";
import { speckleMarks, speckleRaster } from "../speckleSearch";
import { addPainter, invalidate, type Painter } from "../shell";

/** Smallest ring worth drawing, in screen pixels: a speck is sub-pixel with a whole map on screen. */
const RING_MIN_RADIUS = 7;
/** Clear of the lump it rings, so the ink inside stays readable. */
const RING_PADDING = 3;

const ringColour = (): string => colourFor("destructive");

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const marks = speckleMarks();
  if (marks.length === 0) return;
  const raster = speckleRaster();
  if (!raster || raster.width === 0 || raster.height === 0) return;

  const width = context.canvas.width;
  const height = context.canvas.height;
  const scaleX = drawWidth / raster.width;
  const scaleY = drawHeight / raster.height;

  for (const patch of marks) {
    const cx = view.x + ((patch.minX + patch.maxX + 1) / 2) * scaleX;
    const cy = view.y + ((patch.minY + patch.maxY + 1) / 2) * scaleY;
    const radius = Math.max(RING_MIN_RADIUS, (patch.span * scaleX) / 2 + RING_PADDING);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) continue;

    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    // Cased, like every mark on this canvas: a ring on a map is over ink and paper by turns.
    context.lineWidth = 4;
    context.strokeStyle = "rgba(6, 4, 12, 0.7)";
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = ringColour();
    context.stroke();
  }
};

/** Wire the layer up. Registered after the ink and the paint, so the rings sit over both. */
export function registerSpecklesLayer(): void {
  addPainter("speckles", paint);
}

/** Repaint, because the tool's lumps changed. */
export function specklesChanged(): void {
  invalidate();
}
