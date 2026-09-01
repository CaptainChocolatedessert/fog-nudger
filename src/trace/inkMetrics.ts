/**
 * Measuring a binary mask by how much of it survives being eroded.
 *
 * One primitive, read two ways. Erode a mask by a pixel and count what is left:
 *
 * - As a **shape** signal it says how line-like the ink is, which is how polarity is decided
 *   (`polarity.ts`) — linework is thin everywhere, fills and floors are not.
 * - As a **length** signal it says roughly how wide the ink is, which is the unit DESIGN.md §5 asks
 *   every parameter in this project to be denominated in. That unit had no measurement until now,
 *   and it turns out to have been falling out of the polarity decision all along.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";

export interface ErosionCounts {
  readonly ink: number;
  /** Ink pixels whose eight neighbours are all ink. */
  readonly survivors: number;
}

/**
 * Count ink and how much of it survives a one-pixel erosion.
 *
 * **Anything off the edge of the image counts as ground**, so ink running to the border is treated
 * as having an edge there. Conservative on purpose: it can only make a shape look thinner, never
 * thicker.
 */
export function erosionCounts(mask: BinaryMask): ErosionCounts {
  const { width, height, data } = mask;
  let ink = 0;
  let survivors = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] !== 1) continue;
      ink += 1;

      let eroded = false;
      for (let dy = -1; dy <= 1 && !eroded; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
          if (!inside || data[ny * width + nx] !== 1) {
            eroded = true;
            break;
          }
        }
      }
      if (!eroded) survivors += 1;
    }
  }

  return { ink, survivors };
}

/**
 * Share of ink that does not survive erosion: 0 for a solid blob, 1 for a hairline.
 *
 * Returns 0 for a mask with no ink at all, rather than dividing by zero — an empty reading must not
 * be able to win a comparison against a real one.
 */
export function thinness(mask: BinaryMask): number {
  const { ink, survivors } = erosionCounts(mask);
  if (ink === 0) return 0;
  return (ink - survivors) / ink;
}

/**
 * Mean ink width in pixels, inferred from thinness.
 *
 * Eroding a stroke of width `w` leaves `w - 2`, so a long straight stroke has
 * `thinness = 2 / w` and the width is `2 / thinness`.
 *
 * ## What this is and is not
 *
 * For a mask holding strokes of several widths the result is the **area-weighted harmonic mean** of
 * those widths — the algebra falls out of summing `2 / wᵢ` over each stroke's area. A harmonic mean
 * is dominated by its smallest terms, so this is **biased thin**: a scattering of one-pixel noise
 * specks pulls the estimate down regardless of how heavy the real linework is. Read it as an
 * indicator that can be sanity-checked, not as a measurement.
 *
 * It also **saturates at 2**. Erosion removes a one-pixel and a two-pixel stroke alike, so both
 * score a thinness of 1 and both are reported as 2. Anything at or below two pixels is simply "as
 * thin as this can see".
 *
 * Returns `null` when there is no ink, since there is then no width to report and a number would be
 * indistinguishable from a real one.
 */
export function inkWidthFromThinness(value: number): number | null {
  if (!(value > 0)) return null;
  return 2 / value;
}
