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
 * The common fault is not that the guesses were bad. It is that **every diagnostic in this project
 * reports a total**, and a total cannot answer "what is happening *there*". The census counts
 * regions, the coverage line sums areas, the ink-shape check ranks components — none of them can be
 * pointed at the thing a human is looking at.
 *
 * So this reports one pixel, and the numbers it returns are the ones that discriminate:
 *
 * - **Luminance**, which settles "is this actually white" objectively rather than by eye through two
 *   layers of tint.
 * - **Ink or not**, from the same mask that was labelled.
 * - **Which region**, or that it is ink, or that it is space the minimum-area filter discarded —
 *   three outcomes that look identical on screen and have completely different causes.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import type { ScalarField } from "./field";
import type { LabelledSpace } from "./label";

export type PointKind =
  | "outside-raster"
  /** Ink in the chosen mask, so never a region and never covered by one. */
  | "ink"
  /**
   * Not ink, and nothing more can be said yet: no partition has been derived in this frame.
   *
   * The honest answer while the GM is still on the reading steps, where the labelling that separates
   * a kept region from a discarded one has not been run. Saying "discarded" there would be inventing
   * a verdict from the absence of one.
   */
  | "space"
  /** Space, but a component too small to keep — it has no shape of its own. */
  | "discarded"
  /** Part of a surviving region, and therefore under that region's emitted shape. */
  | "region";

export interface PointReading {
  readonly x: number;
  readonly y: number;
  readonly kind: PointKind;
  /** 0–1, from the field the binariser actually read. `null` outside the raster. */
  readonly luminance: number | null;
  /** The surviving region's id, or 0. */
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
): PointReading {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) {
    return { x: px, y: py, kind: "outside-raster", luminance: null, region: 0 };
  }

  const i = py * mask.width + px;
  const luminance = field.data[i] ?? 0;
  if (mask.data[i] === 1) return { x: px, y: py, kind: "ink", luminance, region: 0 };

  if (!labelled) return { x: px, y: py, kind: "space", luminance, region: 0 };

  const region = labelled.labels[i] ?? 0;
  return {
    x: px,
    y: py,
    // Space with no label is space the minimum-area filter dropped. It is not ink and it is not a
    // region, and on screen it is indistinguishable from both.
    kind: region === 0 ? "discarded" : "region",
    luminance,
    region,
  };
}

/**
 * One line a human can act on, naming what would have to be true for each outcome.
 *
 * Says something in every case including the dull one, and the dull one here — "it is a region" —
 * is the most informative of the lot, because it means the gap being reported is not a gap at all.
 */
export function describePoint(reading: PointReading, pxPerSquare: number): string {
  const at = `raster (${reading.x}, ${reading.y})`;
  const tone =
    reading.luminance === null ? "" : ` luminance ${reading.luminance.toFixed(3)}`;

  switch (reading.kind) {
    case "outside-raster":
      return `${at} is outside the map image entirely — the point did not land on the traced map.`;
    case "ink":
      return (
        `${at}${tone} is INK, so it is not part of any region and nothing covers it. ` +
        (reading.luminance !== null && reading.luminance > 0.8
          ? `That luminance is nearly white, which a local threshold should not call ink — if this ` +
            `is a flat area rather than fine linework, the binariser is wrong here.`
          : `It is dark enough for that to be the expected answer.`)
      );
    case "space":
      return (
        `${at}${tone} is not ink. Whether it survives as a region is a deriving-stage question, ` +
        `and nothing has been derived yet — open Regions to find out.`
      );
    case "discarded":
      return (
        `${at}${tone} is floor, but its region was below the minimum area ` +
        `(${(1 / pxPerSquare ** 2).toFixed(4)} squares per pixel) and was discarded, so no shape ` +
        `covers it unless a filled hole swallowed it.`
      );
    case "region":
      return (
        `${at}${tone} is inside region ${reading.region}, which is emitted as its own shape — so ` +
        `this point IS covered. Anything looking bare here is a rendering question, not a tracing ` +
        `one: check the fill opacity against the map's own colour, and what sits above the layer.`
      );
  }
}
