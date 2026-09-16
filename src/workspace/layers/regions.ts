/**
 * The regions layer: the partition, drawn as the push will write it.
 *
 * ## Why it is drawn here at all
 *
 * The only way to look at a partition used to be to *stage* it — write a few hundred shapes into the
 * scene, look, and remove them. That made the one question this project cannot answer by reasoning
 * (is this a partition a GM actually wants?) cost a scene write every time it was asked. Here it
 * costs opening a step, which is what made staging redundant and then deleted.
 *
 * ## Vectors, not a bitmap
 *
 * Unlike the ink and the gaps, this is drawn as paths every frame rather than rasterised once. The
 * regions *are* vectors — a few hundred polygons of a few thousand points between them — and
 * rasterising them at map resolution to draw them scaled would throw away the sharpness that makes a
 * boundary judgeable at zoom, which is the whole reason to look at them.
 *
 * ## The same six colours, cycled the same way
 *
 * Neighbouring regions differ so the partition is what you see, rather than one colour over full
 * coverage, which is a wash. The palette is the emit path's own — though note what that does and does
 * not buy: preview and scene are one picture by **geometry**, not by colour, because a fog item's
 * colour is not rendered as fog. The palette is a preview affordance that the emit path happens to
 * share.
 *
 * *Cosmetic caveat:* the push skips a region over the command cap, and a skipped region shifts the
 * colours of everything after it. Nothing has ever been over the cap on a real map, and the
 * alternative — teaching this layer the emit path's skip rule — would be a second implementation of
 * it.
 */

import { PROPOSAL_COLOURS } from "../../emit/fogShapes";
import {
  currentRegions,
  outlineUnitsPerSquare,
  regionsShowing,
} from "../regions";
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

/*
  `WALL_COLOUR`, `WALL_CASING` and `WALL_WIDTH_PX` went with the lines they drew. The casing argument
  they carried is not lost — it is the general rule now, and `regenerateGuard.ts` and the graph layer
  both state it: a saturated core over a light casing is what makes a centreline readable on dark ink
  and pale paper alike, which are the only two backgrounds a wall is ever drawn against.
*/

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const regions = currentRegions();
  if (regions.length === 0 || !regionsShowing()) return;

  // The rings are in graph units, and the map is drawn at the image's own aspect — so the longer
  // drawn side is one unit on both axes, and one scale puts the partition exactly over the ink.
  const scale = Math.max(drawWidth, drawHeight);

  const settings = currentSettings();
  /*
    The width is read live and the *unit* is asked for, which is the split that matters.

    A grid square is a number of graph units that only a trace can measure, and only the
    partition's own module knows whether one has. Reading the setting here keeps the outline
    responding to the slider without a re-derive; asking for the conversion keeps that knowledge
    out of the painter.
  */
  const strokeInRingUnits = settings.review.strokeSquares * outlineUnitsPerSquare();

  context.save();
  context.lineJoin = "round";
  context.lineWidth = Math.max(MIN_STROKE_PX, strokeInRingUnits * scale);

  regions.forEach((region, index) => {
    const colour = PROPOSAL_COLOURS[index % PROPOSAL_COLOURS.length]!;

    context.beginPath();
    for (const ring of region.rings) {
      if (ring.length === 0) continue;
      ring.forEach((point, at) => {
        const x = view.x + point.x * scale;
        const y = view.y + point.y * scale;
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
    **The emitted wall lines were drawn here and are gone** (user, 2026-09-15).

    They were the walls that emit as `LINE` items rather than as part of a ring — a stub hanging into
    a room being the usual case — stroked in red over the fills. The reason given was that otherwise
    "the preview would show *fewer walls than staging writes*", and that was true when the graph layer
    appeared in one step only.

    It is on always now and draws every wall, bridges included, so the preview shows all of them
    regardless. What the red added was *which* walls emit as lines rather than as ring boundaries —
    an emit-path distinction, drawn over the one thing this layer exists to show.

    **And it read as a fault.** Turning the Walls layer off left a great many walls still on screen,
    apparently changing colour: two layers drawing walls, one of them switched off. Red also stops
    doing a job it was not supposed to have — the palette reserves it for destruction, and this was
    one of the two uses §7a already wanted gone.
  */

  context.restore();
};

/** Wire the layer up. Drawn over the ink, since the partition is the thing being judged. */
export function registerRegionsLayer(): void {
  addPainter("regions", paint);
}
