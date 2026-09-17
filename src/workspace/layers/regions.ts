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

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { PROPOSAL_COLOURS } from "../../emit/fogShapes";
import { colourFor } from "../palette";
import {
  currentMarkStates,
  currentRegions,
  outlineUnitsPerSquare,
  regionsShowing,
} from "../regions";
import { currentSettings } from "../settingsState";
import { addPainter, type Painter } from "../shell";
import { currentTool } from "../toolPalette";
import { pendingMark } from "../wallEdit";

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

/** Half the length of a mark's arms, and the widths of its core and casing, in screen pixels. */
const MARK_ARM_PX = 6;
const MARK_CORE_PX = 2.5;
const MARK_CASING_PX = 5;
/** A mark that suppresses nothing, because it lands outside every region. */
const IDLE_MARK_ALPHA = 0.45;

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  // The rings are in graph units, and the map is drawn at the image's own aspect — so the longer
  // drawn side is one unit on both axes, and one scale puts the partition exactly over the ink.
  const scale = Math.max(drawWidth, drawHeight);
  const regions = currentRegions();
  if (regions.length > 0 && regionsShowing()) paintRegions(context, view, scale);
  paintMarks(context, view, scale);
};

/**
 * The suppression marks, on this layer because they explain a gap in it.
 *
 * **Drawn whenever the rooms are**, and switched off with them. An unfilled region is how this
 * surface shows a room that has leaked to the outside — its loudest failure — and a suppressed room is
 * unfilled too, so without its mark the two would look the same.
 *
 * A cross, as the tool's glyph is, in the palette's subtractive colour, which is what suppression
 * already wears for ink; solid and cased, because a mark is committed. **Dimmed** when it lands
 * outside every region and suppresses nothing. And while the tool is in hand, what a click would do:
 * the mark it would remove in the destructive colour, or a dashed ghost where it would place one.
 */
function paintMarks(context: CanvasRenderingContext2D, view: { x: number; y: number }, scale: number): void {
  const marks = currentMarkStates();
  const pending = currentTool() === "suppressRegion" ? pendingMark() : null;
  if (marks.length === 0 && pending === null) return;

  const cross = (point: Vector2) => {
    const x = view.x + point.x * scale;
    const y = view.y + point.y * scale;
    context.beginPath();
    context.moveTo(x - MARK_ARM_PX, y - MARK_ARM_PX);
    context.lineTo(x + MARK_ARM_PX, y + MARK_ARM_PX);
    context.moveTo(x + MARK_ARM_PX, y - MARK_ARM_PX);
    context.lineTo(x - MARK_ARM_PX, y + MARK_ARM_PX);
  };
  const stroke = (colour: string) => {
    context.strokeStyle = colourFor("casing");
    context.lineWidth = MARK_CASING_PX;
    context.stroke();
    context.strokeStyle = colour;
    context.lineWidth = MARK_CORE_PX;
    context.stroke();
  };

  context.save();
  context.lineCap = "round";
  marks.forEach((mark, index) => {
    const removing = pending !== null && "remove" in pending && pending.remove === index;
    context.globalAlpha = mark.active || removing ? 1 : IDLE_MARK_ALPHA;
    cross(mark.point);
    stroke(colourFor(removing ? "destructive" : "subtractive"));
  });
  if (pending !== null && "place" in pending) {
    context.globalAlpha = 1;
    context.setLineDash([3, 3]);
    cross(pending.place);
    stroke(colourFor("subtractive"));
  }
  context.restore();
}

function paintRegions(
  context: CanvasRenderingContext2D,
  view: { x: number; y: number },
  scale: number,
): void {
  const regions = currentRegions();

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
}

/** Wire the layer up. Drawn over the ink, since the partition is the thing being judged. */
export function registerRegionsLayer(): void {
  addPainter("regions", paint);
}
