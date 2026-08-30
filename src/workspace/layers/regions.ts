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
import { currentRaster, currentRegions, currentWalls, regionsShowing } from "../regions";
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

/**
 * Staged wall lines, drawn in the colour the emit path stages them in.
 *
 * **Cased, and that is not decoration.** A wall line is a centreline, so by construction it lies
 * exactly on top of the map's own linework — and the first version drew it near-black, which made it
 * invisible on every wall it described. Reported from a room as "no stubs or bridges showing", when
 * they were all being drawn. A saturated core over a light casing reads on dark ink and on pale
 * paper alike, which is the only pair of backgrounds a wall is ever drawn against.
 *
 * Fixed rather than cycled like the proposal fills: a wall is one kind of thing, and what is being
 * judged is where it runs.
 */
const WALL_COLOUR = "#ff2020";
const WALL_CASING = "#ffffff";
/** Screen pixels. A hairline over busy map art is not a wall a GM can judge. */
const WALL_WIDTH_PX = 2;

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

  /*
    The walls that emit as lines rather than as part of a ring — a stub hanging into a room being the
    usual case.

    Drawn here because otherwise the preview would show *fewer walls than staging writes*, which is
    the one thing this surface exists to prevent: the preview and the staged scene have to be the
    same picture. They are lines rather than fills because that is what they become.
  */
  const walls = currentWalls();
  if (walls.length > 0) {
    context.globalAlpha = 1;
    context.lineCap = "round";
    context.beginPath();
    for (const wall of walls) {
      wall.points.forEach((point, at) => {
        const x = view.x + point.x * scaleX;
        const y = view.y + point.y * scaleY;
        if (at === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
    }
    // One path, stroked twice: the casing first, then the core over it.
    context.strokeStyle = WALL_CASING;
    context.lineWidth = WALL_WIDTH_PX + 2;
    context.stroke();
    context.strokeStyle = WALL_COLOUR;
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
  }

  context.restore();
};

/** Wire the layer up. Drawn over the ink, since the partition is the thing being judged. */
export function registerRegionsLayer(): void {
  addPainter("regions", paint);
}
