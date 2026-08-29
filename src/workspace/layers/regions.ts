/**
 * The regions layer: the partition, drawn as the GM will see it staged.
 *
 * ## Why it is drawn here at all
 *
 * Until now the only way to look at a partition was to *stage* it — write a few hundred shapes into
 * the scene, look, and remove them. That made the one question this project cannot answer by
 * reasoning (is this a partition a GM actually wants?) cost a scene write every time it was asked.
 * Here it costs opening a step.
 *
 * ## Vectors, not a bitmap
 *
 * Unlike the ink and the breaks, this is drawn as paths every frame rather than rasterised once. The
 * regions *are* vectors — a few hundred polygons of a few thousand points between them — and
 * rasterising them at map resolution to draw them scaled would throw away the sharpness that makes a
 * boundary judgeable at zoom, which is the whole reason to look at them.
 *
 * ## The same six colours, cycled the same way
 *
 * Neighbouring regions differ so the partition is what you see, rather than one colour over full
 * coverage, which is a wash. The palette is the emit path's own, so the preview and the staged
 * shapes are the same picture. *Cosmetic caveat:* staging skips a region that is over the command
 * cap, and a skipped region shifts the colours of everything after it. Nothing has ever been over
 * the cap on a real map, and the alternative — teaching this layer the emit path's skip rule — would
 * be a second implementation of it.
 */

import { PROPOSAL_COLOURS } from "../../emit/fogShapes";
import { lastPixelsPerSquare } from "../../pipeline";
import { currentRaster, currentRegions, regionsShowing } from "../regions";
import { currentSettings } from "../settingsState";
import { addPainter, type Painter } from "../shell";

/**
 * The outline never gets thinner than this on screen.
 *
 * The width is a GM setting in grid squares and it is honoured — but a stroke in map space is
 * sub-pixel with a whole map in view, which is exactly when the partition most needs to read as a
 * partition. The setting decides the width; this decides the floor.
 */
const MIN_STROKE_PX = 1;

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const regions = currentRegions();
  const raster = currentRaster();
  if (regions.length === 0 || !raster || !regionsShowing()) return;

  // The rings are in the trace's raster, and the map fills the same rectangle the ink is drawn into
  // — so one scale factor puts the partition exactly over the ink it was derived from.
  const scaleX = drawWidth / raster.width;
  const scaleY = drawHeight / raster.height;

  const settings = currentSettings();
  const pxPerSquare = lastPixelsPerSquare();
  const strokeMapPx = pxPerSquare === null ? 0 : settings.review.strokeSquares * pxPerSquare;

  context.save();
  context.lineJoin = "round";
  context.lineWidth = Math.max(MIN_STROKE_PX, strokeMapPx * scaleX);

  regions.forEach((region, index) => {
    const colour = PROPOSAL_COLOURS[index % PROPOSAL_COLOURS.length]!;

    context.beginPath();
    for (const ring of region.rings) {
      if (ring.length === 0) continue;
      ring.forEach((point, at) => {
        const x = view.x + point.x * scaleX;
        const y = view.y + point.y * scaleY;
        if (at === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }

    // Holes are rings of the same path, cut out by the even-odd rule. A region with a courtyard in
    // it must not be filled across the courtyard here and hollow once it is in the scene.
    context.globalAlpha = settings.review.fillOpacity;
    context.fillStyle = colour;
    context.fill("evenodd");

    context.globalAlpha = 1;
    context.strokeStyle = colour;
    context.stroke();
  });

  context.restore();
};

/** Wire the layer up. Drawn over the ink, since the partition is the thing being judged. */
export function registerRegionsLayer(): void {
  addPainter("regions", paint);
}
