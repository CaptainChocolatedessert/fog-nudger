/**
 * The breaks layer: what the repair invented, and a ring round every break it found.
 *
 * A break merges two rooms, which is the worst outcome this project has. The controls that find and
 * repair them sit in the ink step; this draws the result, in a colour the map does not contain.
 *
 * **The search itself is not here.** It moved into the pipeline the moment the fill became real: the
 * fill invents ink that the regions are derived from, so the search and the repair have to be the
 * same computation that produces the mask, not a second copy of it living on a surface. This side
 * only draws what it was handed.
 *
 * **Both stage-one steps ask for this layer**, ink and walls alike, which is the one argued
 * exception to "each step shows its own layer". The reason is not that the walls step manufactures
 * breaks — the minimum stroke width that can sever a wall is an *Ink* parameter, and this doc named
 * the wrong step for it until 2026-09-01. It is that the walls step is where a severed wall becomes
 * visible: a gap in the ink is a gap in the skeleton, and without the rings a GM looking at a broken
 * centreline cannot tell a doorway from something their own filter cut.
 */

import { devLog } from "../../devlog";
import { paintGaps, parseColour } from "../../overlay/maskImage";
import type { GapFinding, GapMark } from "../../trace/gaps";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { maskShowing, onReading } from "../reading";
import { addPainter, say, type Painter } from "../shell";

/**
 * The colour a repaired break is drawn in — and it is the only ink on this surface the map does not
 * contain.
 *
 * `DESIGN.md` §8 requires that invented ink never be indistinguishable from read ink, and this is
 * that rule met: a different colour from the ink, drawn at full alpha on its own layer, with a ring
 * round it. A GM who has tinted the ink down to look at the linework underneath has not also turned
 * the repair down.
 *
 * There were briefly two colours — purple for a break found, green for one repaired — when finding
 * and repairing were separate controls. With one control everything found is repaired, so there is
 * one colour, and the second *state* is drawn by withholding it: a break the search could not
 * finish examining gets no fill at all and a **dashed** ring. Marking on a guess is a warning;
 * inventing ink on a guess is not, and neither is drawing ink that was not invented.
 *
 * **Fixed rather than a swatch row**, unlike the ink colour, and the reason the ink colour is
 * adjustable applies here too: no colour is readable on every map. The ring is what carries the
 * identification when a colour collides — drawn dark-then-bright over the same path, so it reads
 * against anything underneath, and it is a shape nothing on a map looks like. If a room reports the
 * marks vanishing into the paper anyway, a picker is the answer.
 *
 * Kept in step with the `.gap-key` colour in the page's own stylesheet by hand.
 */
const GAP_COLOUR = "#a855f7";

/**
 * The ring is drawn in **screen** pixels, which is the whole point of it.
 *
 * A break is a handful of raster pixels. With a whole map on screen those pixels are smaller than
 * one screen pixel, so a mark that scaled with the view would be invisible in exactly the situation
 * it exists for — a GM scanning the map for something they do not already know about. It grows to
 * enclose the break once the view is zoomed in past the ring's own size.
 */
const RING_MIN_RADIUS = 11;
const RING_PADDING = 6;

/**
 * The breaks, on their own layer.
 *
 * Separate from the ink rather than mixed into it, for two reasons. It is drawn at full alpha
 * whatever the ink opacity is set to, so a GM who has tinted the ink down to look at the linework
 * underneath has not also turned the warning down. And invented pixels must never be
 * indistinguishable from read ones.
 *
 * The cost is a second full-resolution RGBA buffer, about 34MB on this project's test map. It is
 * allocated only when there is something to draw in it.
 */
let painted: Bitmap | null = null;
let marks: readonly GapMark[] = [];

/**
 * Paint the breaks that arrived with the mask.
 *
 * The layer is allocated lazily. A map with no breaks does not pay for a second full-resolution
 * RGBA buffer.
 */
function paintBreaks(gaps: GapFinding): boolean {
  marks = gaps.marks;
  if (gaps.marks.length === 0) {
    // Cleared rather than left stale. A repaint that kept the previous reading's layer would draw
    // breaks the current settings do not have, which is the blanking rule one derivation down.
    painted = null;
    return true;
  }

  const colour = parseColour(GAP_COLOUR);
  if (!colour) return true;

  // `null` for the open state, which is what `paintGaps` was built to take. This passed `colour`
  // for both until 2026-09-01, on the premise that an unrepaired break has no pixels to paint. It
  // has all of them: the search writes GAP_OPEN over the whole channel exactly as it writes
  // GAP_FILLED, and only the *ink* is left alone. So a break the flood never examined was drawn as
  // a solid block indistinguishable from ink the repair actually invented — the picture claiming an
  // invention the mask had not made, which is the one thing §8 forbids on this surface.
  const buffer = paintGaps(gaps.labels, null, colour, painted?.buffer);
  const bitmap = bitmapFrom(buffer, gaps.labels.width, gaps.labels.height, painted);
  if (!bitmap) {
    painted = null;
    devLog("error", "workspace: could not allocate the break overlay");
    // On the state line as well as in the log, matching the ink layer. This layer exists to warn,
    // and a warning that fails quietly is the failure the surface was built to prevent — the log is
    // explicitly not a channel to the GM. The rings still draw; see the painter.
    say("could not allocate the break fill — rings only", "bad");
    return false;
  }
  painted = bitmap;
  return true;
}

/**
 * A ring round each break, in screen space.
 *
 * Two strokes over one path — a dark halo, then the gap colour inside it — so the ring reads
 * against pale paper and dark stonework alike without anyone choosing a colour for the map in hand.
 *
 * Culled against the viewport, which is what keeps this cheap when zoomed in. Zoomed out every ring
 * is on screen at once, and a map with hundreds of breaks pays for all of them every frame; that is
 * the case to watch if the surface ever feels heavy, and it is also a map telling the GM something.
 */
const paint: Painter = ({ context, view, width, height, drawWidth, drawHeight }) => {
  // Over the ink and at full alpha. The breaks come from the same reading as the ink, so the mask's
  // own freshness gate covers them.
  if (!maskShowing() || marks.length === 0) return;

  // The fill is optional and the rings are not. A layer that could not allocate its buffer used to
  // return here and take the rings with it, which removed the warning entirely and said so only in
  // the log. The rings cost a loop over `marks` and no memory at all.
  if (painted) context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);

  // The marks are in the **trace's raster**, which is the map's own pixels only while the map fits
  // the memory budget — `planRaster` divides by an integer factor above 16 megapixels. `view.scale`
  // converts map pixels to screen pixels, so using it here drew every ring at a fraction of its
  // distance from the map's corner on a large map, while the fill underneath stayed correct because
  // `drawImage` stretches the whole buffer onto the same rectangle. The regions and skeleton layers
  // already take their scale this way; this one predated them.
  const rasterWidth = painted?.canvas.width ?? 0;
  const rasterHeight = painted?.canvas.height ?? 0;
  const scaleX = rasterWidth > 0 ? drawWidth / rasterWidth : view.scale;
  const scaleY = rasterHeight > 0 ? drawHeight / rasterHeight : view.scale;

  for (const mark of marks) {
    const cx = view.x + mark.x * scaleX;
    const cy = view.y + mark.y * scaleY;
    const radius = Math.max(RING_MIN_RADIUS, (mark.span * scaleX) / 2 + RING_PADDING);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > width || cy - radius > height) {
      continue;
    }

    // Dashed for a break the flood never examined. With the fill correctly withheld for those, the
    // ring is the only thing carrying them at all, and at map scale it is the only thing carrying
    // any of them — a few invented pixels are sub-pixel with a whole map on screen. Solid means
    // "repaired, and here is what was added"; dashed means "found, not proved, nothing written".
    context.setLineDash(mark.filled ? [] : [6, 5]);
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

/** Wire the layer up. Registered after the ink, which is what puts invented pixels over read ones. */
export function registerBreaksLayer(): void {
  addPainter("breaks", paint);
  onReading((result) => paintBreaks(result.gaps));
}
