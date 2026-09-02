/**
 * What the pipeline thinks is at one pixel.
 *
 * ## Why this exists
 *
 * A GM reported light areas inside rooms showing through as bare map. Four explanations were
 * offered before this module was written — fog painting over the staging layer, tokens rendering
 * above it, holes kept by a size rule, and a filled tone landing on the ink side of the threshold —
 * and every one of them was argued from geometry or from an aggregate. Two were refuted by a
 * measurement that already existed, and one by the GM pointing out that the areas are *white*, which
 * no binariser is going to call ink.
 *
 * The common fault is not that the guesses were bad. It is that **every other diagnostic here
 * reports a total**, and a total cannot answer "what is happening *there*". The coverage line sums
 * areas, the ink-shape check ranks components — neither can be pointed at the thing a human is
 * looking at.
 *
 * That is also why this one survived when both censuses were deleted on 2026-09-02. The workspace
 * draws the ink, the skeleton and the partition, so most of what an aggregate used to stand in for
 * can simply be looked at now. **This answers what looking cannot**: what luminance was actually
 * read, whether the threshold called it ink, and whether that ink was invented by the gap repair
 * rather than read from the map.
 *
 * So this reports one pixel, and the numbers it returns are the ones that discriminate:
 *
 * - **Luminance**, which settles "is this actually white" objectively rather than by eye through two
 *   layers of tint.
 * - **Ink or not**, from the same mask that was labelled.
 * - **Which face**, including for ink — see below. Outcomes that look identical on screen and have
 *   completely different causes.
 *
 * ## Ink is usually covered now, and this module said the opposite for weeks
 *
 * Under the region-first partition, regions were the space *between* the strokes, so an ink pixel
 * was by construction outside every region and "it is ink, so nothing covers it" was correct. Under
 * the wall graph a face boundary is the wall's **centreline**, so about half of every wall's
 * thickness lies inside the face on each side of it. Most ink a GM probes is now covered, and this
 * is the diagnostic they reach for when something looks wrong — so the old answer was expensive.
 *
 * The fix is to look the label up **even when the point is ink**. The labelling handed in is of the
 * *framed skeleton*, so an ink pixel carries a face label unless it is one of the thinned centreline
 * pixels themselves, which are the boundary rather than the interior of either neighbour.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import type { ScalarField } from "./field";
import { GAP_FILLED, type GapLabels } from "./gaps";
import type { LabelledSpace } from "./label";

export type PointKind =
  | "outside-raster"
  /**
   * Ink in the chosen mask — which says nothing about whether it is covered.
   *
   * Read `region` alongside it: non-zero means this ink is inside that face, which is the ordinary
   * case for anything but the centreline itself.
   */
  | "ink"
  /**
   * Ink **this run invented** — the break repair filled it, and the map has no ink there.
   *
   * Worth its own kind rather than a clause on `"ink"`, because every word of the ink message is
   * misdirection here: the luminance is light *because there is nothing there*, the local threshold
   * did not call it ink, and the binariser is not wrong. The old answer sent a GM to tune the
   * threshold when the control that did this is the break repair.
   */
  | "invented-ink"
  /**
   * Not ink, and nothing more can be said yet: no partition has been derived in this frame.
   *
   * The honest answer while the GM is still on the reading steps, where the labelling has not been
   * run. Inventing a verdict from the absence of one is the failure this case exists to avoid.
   */
  | "space"
  /**
   * Not ink, and carrying no face label.
   *
   * **Was `"discarded"`, and that name described a control that no longer exists.** It meant a
   * region below the minimum area; the smallest-room filter is gone, and every space labelling in
   * the pipeline now runs at `minArea: 0`. What is left is the one-pixel border frame painted round
   * the raster by `frameSkeleton`, which is skeleton without being ink — a rare probe target, but a
   * real one, and it deserves an answer that is true.
   */
  | "unlabelled"
  /** Not ink, and inside a face that is emitted as its own shape. */
  | "region";

export interface PointReading {
  readonly x: number;
  readonly y: number;
  readonly kind: PointKind;
  /** 0–1, from the field the binariser actually read. `null` outside the raster. */
  readonly luminance: number | null;
  /**
   * The face this pixel is inside, or 0.
   *
   * **Meaningful for `"ink"` as well as `"region"`**, which is the whole of the correction above: 0
   * against ink means the pixel is on the centreline, not that nothing covers it.
   */
  readonly region: number;
}

export function readPoint(
  field: ScalarField,
  mask: BinaryMask,
  /**
   * The partition, if one has been derived. `null` reports what the *reading* alone can say.
   *
   * Optional rather than a second function: the luminance and the ink verdict are the same lookup
   * either way, and the whole value of this diagnostic is that it reports one pixel from the data
   * that actually produced the picture rather than from a parallel path.
   */
  labelled: LabelledSpace | null,
  x: number,
  y: number,
  /**
   * Which pixels the break repair invented, if a repair ran.
   *
   * Optional beside `labelled` and for the same reason: it is the same lookup, and the whole value of
   * this diagnostic is that it reports from the data that produced the picture rather than from a
   * parallel path. `null` means no repair was running, not that nothing was invented.
   */
  gapLabels: GapLabels | null = null,
): PointReading {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) {
    return { x: px, y: py, kind: "outside-raster", luminance: null, region: 0 };
  }

  const i = py * mask.width + px;
  const luminance = field.data[i] ?? 0;
  const ink = mask.data[i] === 1;
  const invented = ink && gapLabels !== null && gapLabels.data[i] === GAP_FILLED;

  // No partition to consult. The ink verdict is still worth reporting; the coverage question is not
  // answerable, and saying anything about it here would be inventing one.
  if (!labelled) {
    const kind = invented ? "invented-ink" : ink ? "ink" : "space";
    return { x: px, y: py, kind, luminance, region: 0 };
  }

  /*
    The label is looked up for ink too, and that is the correction this module needed.

    It used to short-circuit here and report `region: 0` for every ink pixel without ever consulting
    the labelling — correct when regions were the space between the strokes, and wrong the moment a
    face boundary became the wall's centreline. The labelling is of the framed skeleton, so an ink
    pixel is unlabelled only when it is a centreline pixel itself.
  */
  const region = labelled.labels[i] ?? 0;
  if (invented) return { x: px, y: py, kind: "invented-ink", luminance, region };
  if (ink) return { x: px, y: py, kind: "ink", luminance, region };

  return { x: px, y: py, kind: region === 0 ? "unlabelled" : "region", luminance, region };
}

/**
 * One line a human can act on, naming what would have to be true for each outcome.
 *
 * Says something in every case including the dull one, and the dull one here — "it is a region" —
 * is the most informative of the lot, because it means the gap being reported is not a gap at all.
 */
export function describePoint(reading: PointReading): string {
  const at = `raster (${reading.x}, ${reading.y})`;
  const tone =
    reading.luminance === null ? "" : ` luminance ${reading.luminance.toFixed(3)}`;

  /** The binariser verdict, which is worth shouting about only when the tone contradicts it. */
  const inkTone =
    reading.luminance !== null && reading.luminance > 0.8
      ? ` That luminance is nearly white, which a local threshold should not call ink — if this is ` +
        `a flat area rather than fine linework, the binariser is wrong here.`
      : ` It is dark enough for that to be the expected answer.`;

  switch (reading.kind) {
    case "outside-raster":
      return `${at} is outside the map image entirely — the point did not land on the traced map.`;
    case "ink":
      if (reading.region === 0) {
        return (
          `${at}${tone} is INK and lies on the centreline itself, which is the boundary between two ` +
          `faces rather than the interior of either.${inkTone}`
        );
      }
      return (
        `${at}${tone} is INK, and it sits inside face ${reading.region} — a face boundary is the ` +
        `wall's centreline, so about half a wall's thickness is inside the room beside it. This ` +
        `point IS covered.${inkTone}`
      );
    case "invented-ink":
      return (
        `${at}${tone} is ink this run INVENTED — the break repair filled it. The map has no ink ` +
        `here, which is why the luminance is light, and the threshold did not put it there. If this ` +
        `is wrong, lower the largest break to repair rather than touching the threshold.`
      );
    case "space":
      return (
        `${at}${tone} is not ink. Whether it survives as a region is a deriving-stage question, ` +
        `and nothing has been derived yet — open Regions to find out.`
      );
    case "unlabelled":
      return (
        `${at}${tone} is not ink and carries no face label. Under the graph that means the border ` +
        `frame painted round the raster, not a region that was filtered out — there is no size ` +
        `filter any more.`
      );
    case "region":
      return (
        `${at}${tone} is inside region ${reading.region}, which is emitted as its own shape — so ` +
        `this point IS covered. Anything looking bare here is a rendering question, not a tracing ` +
        `one: check the fill opacity against the map's own colour, and what sits above the layer.`
      );
  }
}
