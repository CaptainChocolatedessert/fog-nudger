/**
 * Finding ink that is not linework.
 *
 * ## The failure this exists to catch
 *
 * Binarisation runs on luminance, so colour is thrown away (DESIGN.md §4). The live risk that leaves
 * is narrow and specific: **a filled area whose tone lands on the ink side of the threshold becomes
 * ink**. What happens next changed completely at the wall-graph pivot, and this module is worth
 * keeping for the new consequence rather than the old one.
 *
 * A blob is thinned like any other ink, so its skeleton becomes **walls running through the middle of
 * whatever room it sits in**, splitting one face into several. That is a merge failure's mirror image
 * — a partition where there should be none — and the symptom on screen is a room broken into pieces
 * around a feature that is not a wall.
 *
 * **The account this replaces described a mechanism that is gone twice over**, and it is deleted
 * rather than corrected in place, per this project's convention. It said the area rendered as bare
 * map inside a revealed room, because ink was never covered by a region. Under the graph a face
 * boundary is a wall's centreline, so ink is mostly *inside* faces — and separately, removing the
 * smallest-room control removed the bare-map path altogether, since nothing is discarded any more.
 *
 * A GM reported the original symptom as unfilled pockets and two stages were investigated before this
 * one, which is why a diagnostic that names the thing directly earns its place either way.
 *
 * ## What separates a blob from linework, in two measures rather than one
 *
 * **Ink is thin by construction** — the same property `polarity.ts` uses to decide which reading is
 * the linework. The obvious way to cash that out is the share of its bounding box a component
 * occupies: a stroke wanders across its box and fills little of it, a filled shape fills most of its
 * own.
 *
 * **That measure alone is wrong, and a test caught it before a map did.** A *straight, axis-aligned*
 * stroke fills its bounding box **completely** — a forty-pixel wall one pixel thick scores 1.0, the
 * same as a solid square. Bounding-box fill separates a blob from a *wandering* stroke and says
 * nothing whatever about a straight one, which is most of the linework on an architectural map.
 *
 * So thickness is the second measure and the load-bearing one: **a blob's narrowest extent is
 * several stroke widths**, where a stroke's is one stroke width by definition. Denominated in
 * measured ink width at the call site, per DESIGN.md §5.
 *
 * The wall network of a whole dungeon is one enormous connected component with a bounding box the
 * size of the map and a fill share near zero, so it disqualifies itself on the first measure. That
 * is the point: this looks for the *compact* things.
 *
 * ## What it does not establish
 *
 * That a blob is wrong. A solid ink blob can be a perfectly correct piece of map — a filled pillar,
 * a block of rubble, a plinth. It is a *candidate*, reported with its position so a human can look
 * at it, and the census's standing rule applies: this is a troubleshooting instrument, not a
 * quality signal.
 *
 * Pure: no DOM, no SDK.
 */

import { emptyMask, type BinaryMask } from "./binarize";
import { labelSpace } from "./label";

export interface InkBlob {
  /** Pixels. */
  readonly area: number;
  readonly squares: number;
  /** Share of its bounding box the blob occupies, 0–1. Linework is low; a filled shape is high. */
  readonly fill: number;
  /** Centre of the bounding box, in raster pixels. */
  readonly x: number;
  readonly y: number;
  readonly widthSquares: number;
  readonly heightSquares: number;
}

export interface InkBlobOptions {
  readonly pxPerSquare: number;
  /** Ignore anything smaller than this many grid squares. Specks are not worth a GM's attention. */
  readonly minSquares?: number;
  /** Bounding-box fill share above which a component stops looking like a *wandering* stroke. */
  readonly minFill?: number;
  /**
   * Smallest narrow-side extent a blob may have, in raster pixels.
   *
   * The measure that actually separates a filled shape from linework, since a straight stroke fills
   * its bounding box perfectly. **Denominate it in measured ink width at the call site** — a stroke
   * is one ink width across its narrow side by definition, so a few multiples of that is the line
   * between "stroke" and "shape" with no reference to the raster.
   */
  readonly minThickness?: number;
  readonly top?: number;
}

/**
 * Ink components compact enough to be filled shapes rather than strokes, largest first.
 *
 * Labelled with the ink as the *labelled* class, which means it is labelled 4-connected — the
 * opposite of the pairing the pipeline proper uses (DESIGN.md §5). That is deliberate and harmless
 * here: a diagonal chain of ink gets split into several components, which can only make a blob look
 * *smaller* than it is, and a solid blob has no diagonal-only joins to split.
 */
export function findInkBlobs(mask: BinaryMask, options: InkBlobOptions): InkBlob[] {
  const minSquares = options.minSquares ?? 0.05;
  const minFill = options.minFill ?? 0.55;
  const minThickness = options.minThickness ?? 0;
  const perSquare = options.pxPerSquare > 0 ? options.pxPerSquare ** 2 : 0;
  if (perSquare === 0) return [];

  const labelled = labelSpace(invert(mask), {
    minArea: Math.max(1, Math.round(minSquares * perSquare)),
  });

  const blobs: InkBlob[] = [];
  for (const region of labelled.regions) {
    const width = region.maxX - region.minX + 1;
    const height = region.maxY - region.minY + 1;
    const fill = region.area / (width * height);
    if (fill < minFill) continue;
    // The narrow side, which is the only thing a stroke has just one stroke width of.
    if (Math.min(width, height) < minThickness) continue;
    blobs.push({
      area: region.area,
      squares: region.area / perSquare,
      fill,
      x: (region.minX + region.maxX) / 2,
      y: (region.minY + region.maxY) / 2,
      widthSquares: width / options.pxPerSquare,
      heightSquares: height / options.pxPerSquare,
    });
  }

  return blobs.slice(0, options.top ?? 5);
}

/** Ink becomes ground and ground becomes ink, so the labeller labels the strokes. */
function invert(mask: BinaryMask): BinaryMask {
  const out = emptyMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) out.data[i] = mask.data[i] === 1 ? 0 : 1;
  return out;
}

/**
 * One line, in every case including the empty one — which here is the *good* case and therefore the
 * one most at risk of being written as silence.
 */
export function describeInkBlobs(blobs: readonly InkBlob[], rasterWidth: number, rasterHeight: number): string {
  if (blobs.length === 0) {
    return "no solid ink blobs — every piece of ink reads as linework, which is what a map of walls should be";
  }

  const listed = blobs
    .map((blob) => {
      const across = rasterWidth > 0 ? (blob.x / rasterWidth) * 100 : 0;
      const down = rasterHeight > 0 ? (blob.y / rasterHeight) * 100 : 0;
      return (
        `${blob.squares.toFixed(2)} sq at ${across.toFixed(0)}% across ${down.toFixed(0)}% down ` +
        `(${blob.widthSquares.toFixed(2)}x${blob.heightSquares.toFixed(2)}, ` +
        `${(blob.fill * 100).toFixed(0)}% of its box)`
      );
    })
    .join("; ");

  return (
    `${blobs.length} compact ink blobs, which are filled shapes rather than strokes — ${listed}. ` +
    `Each is thinned like any other ink, so its skeleton becomes walls running through whatever room ` +
    `it sits in: look for a room split into pieces around one of these. A pillar or a block of ` +
    `rubble is correct; a lightly-tinted feature is a tone falling on the ink side of the threshold, ` +
    `which is the one thing discarding colour costs us`
  );
}
