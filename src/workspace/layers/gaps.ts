/**
 * The gaps layer: what the search proposes, and a ring round every gap it found.
 *
 * A gap merges two rooms, which is the worst outcome this project has. The tool that finds them
 * is the Gaps tool inside the Ink step; this draws what it is holding.
 *
 * ## It draws a PROPOSAL now, not invented ink
 *
 * Until 2026-09-05 the repair ran inside the pipeline and this drew pixels it had already added to
 * the mask. The search is a tool now: nothing is in the ink until the GM accepts it, so the purple
 * here is **what accepting would add** rather than what was added. The moment a gap is accepted
 * its pixels leave this layer and appear on the paint layer in cyan, which is the picture saying
 * exactly what the design says — an accepted gap is added ink like any other.
 *
 * That makes the §8 requirement easier to keep rather than harder. There is no invented ink in the
 * mask to be mistaken for read ink, because there is no invented ink at all.
 *
 * **The search itself is not here**, for the reason it was never here: what it proposes has to be
 * computed from the same composite the trace would use, and a second copy living on a surface is the
 * sibling's harness-versus-room failure waiting to happen. This side only draws what it was handed.
 */

import { devLog } from "../../devlog";
import { parseColour } from "../../overlay/maskImage";
import type { GapMark } from "../../trace/gaps";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { RING_MIN_RADIUS, RING_PADDING } from "../gapGesture";
import { gapMarks, gapRaster } from "../gapSearch";
import { PALETTE } from "../palette";
import { addPainter, invalidate, say, type Painter } from "../shell";

/**
 * The colour a proposed gap is drawn in — the one ink on this surface that is in no mask at all.
 *
 * `DESIGN.md` §8 requires that ink this stage made up never be indistinguishable from ink the map
 * contains, and this meets it twice over: a different colour from the ink, at full alpha on its own
 * layer, with a ring round it — and now also a different colour from **accepted** ink, which is cyan
 * on the paint layer. Purple means "this would be added"; cyan means "this is yours".
 *
 * **Fixed rather than a swatch row**, unlike the ink colour. The ring is what carries identification
 * when a colour collides — drawn dark-then-bright over the same path, so it reads against anything
 * underneath, and it is a shape nothing on a map looks like.
 *
 * Kept in step with the `.gap-key` colour in the page stylesheet by hand.
 */
/*
  Cyan, and the same cyan the added-ink layer uses, because a gap proposal *is* the additive category
  in its proposed state — accepting one writes into that very layer. It was purple, which made it look
  like a third kind of thing.

  What separates proposed from committed is the treatment rather than the hue: a ring rather than a
  fill. That is also what stops the failure this layer has already had, where an unexamined gap was
  drawn solid and became indistinguishable from ink the repair had really invented.
*/
const GAP_COLOUR = PALETTE.additive;

let painted: Bitmap | null = null;
/** The marks the bitmap was built from, so it is rebuilt only when the search finds something new. */
let builtFrom: readonly GapMark[] | null = null;

/**
 * Rasterise the proposed pixels of every acceptable mark.
 *
 * Only the acceptable ones. A channel the flood ran out of budget on is a **guess**, and accepting
 * it is not offered — so painting its pixels would show ink about to be added that no click can add.
 * That is the failure this layer already had once in the other direction: it drew an unexamined
 * gap as a solid block indistinguishable from ink the repair had really invented.
 */
function rebuild(marks: readonly GapMark[]): void {
  const raster = gapRaster();
  if (!raster || marks.length === 0) {
    painted = null;
    return;
  }

  const colour = parseColour(GAP_COLOUR);
  if (!colour) return;

  const needed = raster.width * raster.height * 4;
  const buffer =
    painted && painted.buffer.length === needed ? painted.buffer : new Uint8ClampedArray(needed);
  // Cleared wholesale rather than by walking the previous marks: that set is already gone by the
  // time this runs, and a stale proposal is a promise the tool will not keep.
  buffer.fill(0);

  for (const mark of marks) {
    if (!mark.fillable) continue;
    for (let i = 0; i < mark.pixels.length; i++) {
      const p = mark.pixels[i]! * 4;
      if (p < 0 || p + 3 >= buffer.length) continue;
      buffer[p] = colour.r;
      buffer[p + 1] = colour.g;
      buffer[p + 2] = colour.b;
      buffer[p + 3] = 255;
    }
  }

  const bitmap = bitmapFrom(buffer, raster.width, raster.height, painted);
  if (!bitmap) {
    painted = null;
    devLog("error", "workspace: could not allocate the gap overlay");
    // On the state line as well as in the log, matching the other map-sized layers. This layer
    // exists to warn, and a warning that fails quietly is the failure the surface was built to
    // prevent — the log is explicitly not a channel to the GM. The rings still draw; see the painter.
    say("could not allocate the gap fill — rings only", "bad");
    return;
  }
  painted = bitmap;
}

/**
 * A ring round each gap, in screen space.
 *
 * Two strokes over one path — a dark halo, then the gap colour inside it — so the ring reads against
 * pale paper and dark stonework alike without anyone choosing a colour for the map in hand.
 *
 * Culled against the viewport, which is what keeps this cheap when zoomed in. Zoomed out every ring
 * is on screen at once, and a map with hundreds of gaps pays for all of them every frame; that is
 * the case to watch if the surface ever feels heavy, and it is also a map telling the GM something.
 */
const paint: Painter = ({ context, view, width, height, drawWidth, drawHeight }) => {
  const marks = gapMarks();
  /*
    No freshness gate, because there is nothing to be stale against.

    This used to check `maskShowing()`: the marks came from a reading, so a blanked surface had to
    blank them too. The tool holds its own marks now and drops them outright the moment a reading
    lands, so what is here is either current or absent — there is no third state to guard.
  */
  if (marks.length === 0) return;

  if (builtFrom !== marks) {
    builtFrom = marks;
    rebuild(marks);
  }

  // The fill is optional and the rings are not. A layer that could not allocate its buffer used to
  // return here and take the rings with it, which removed the warning entirely and said so only in
  // the log. The rings cost a loop over `marks` and no memory at all.
  if (painted) context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);

  /*
    The marks are in the **search's raster**, which is the map's own pixels only while the map fits
    the memory budget — `planRaster` divides by an integer factor above 16 megapixels. `view.scale`
    converts map pixels to screen pixels, so using it here drew every ring at a fraction of its
    distance from the map's corner on a large map, while the fill underneath stayed correct because
    `drawImage` stretches the whole buffer onto the same rectangle.

    Taken from the raster the tool reports rather than from the bitmap's own canvas, so the rings are
    placed correctly even when the fill could not be allocated — which is exactly the case where the
    rings are the only thing left.
  */
  const raster = gapRaster();
  const scaleX = raster && raster.width > 0 ? drawWidth / raster.width : view.scale;
  const scaleY = raster && raster.height > 0 ? drawHeight / raster.height : view.scale;

  for (const mark of marks) {
    const cx = view.x + mark.x * scaleX;
    const cy = view.y + mark.y * scaleY;
    const radius = Math.max(RING_MIN_RADIUS, (mark.span * scaleX) / 2 + RING_PADDING);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) {
      continue;
    }

    // Dashed for a gap the flood never examined. With the fill correctly withheld for those, the
    // ring is the only thing carrying them at all, and at map scale it is the only thing carrying
    // any of them — a few pixels are sub-pixel with a whole map on screen. Solid means "this can be
    // accepted, and here is what it would add"; dashed means "found, not proved, not on offer".
    context.setLineDash(mark.fillable ? [] : [6, 5]);
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.lineWidth = 4;
    context.strokeStyle = "rgba(6, 4, 12, 0.7)";
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = GAP_COLOUR;
    context.stroke();
  }
  context.setLineDash([]);
};

/**
 * Wire the layer up. Registered after the ink and the paint, so a proposal sits over both.
 *
 * **No reading subscription.** The tool takes the reading it needs and this draws whatever the tool
 * is holding — one subscriber rather than two, which is also what stops the pair disagreeing about
 * which reading the marks on screen belong to.
 */
export function registerGapsLayer(): void {
  addPainter("gaps", paint);
}

/** Repaint, because the tool's marks changed. */
export function gapsChanged(): void {
  invalidate();
}
