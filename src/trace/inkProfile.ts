/**
 * What the two ink filters would take, band by band — the shape drawn on their own sliders.
 *
 * ## Why these are sampled from the filters rather than modelled
 *
 * Each filter has a natural "how much is there at each size" question behind it, and each has an
 * obvious cheap way to answer it that is **not** the filter: a distance transform for stroke width,
 * a size histogram for islands. Both would be a second opinion about a quantity the control already
 * decides — and a curve drawn beside a slider to say where to put it is the worst possible place for
 * one. So each profile runs the filter's own machinery and counts what it did.
 *
 * ## The stroke profile is a granulometry
 *
 * Open the mask at each radius the slider can reach and count what survives. An opening removes a
 * stroke entirely if it is narrower than twice the radius and restores everything else to full
 * width, so the drop between consecutive radii is *the ink that lives in strokes of that width* —
 * which is exactly what the slider throws away when it passes that stop.
 *
 * **Not an erosion**, which is what the existing ink-width measurement uses. Erosion leaves the
 * *cores* of the strokes that survive, so its count undercuts by an amount that depends on width. It
 * answers a related question and not this one, and `inkMetrics.ts` saturating at 2px is that
 * difference showing: one radius-1 erosion can only ask whether a stroke is wider than two pixels.
 *
 * ## The island profile is the filter's own walk
 *
 * `walkIslands` is shared with `removeSmallInkIslands`, so there is one definition of an island.
 * Binned by **span**, which is the measure the control is denominated in, and valued by **area**,
 * because area is what leaves the mask.
 *
 * ## Neither depends on the slider it belongs to
 *
 * A profile is taken from the ink *before* its own filter, so moving that handle redraws the same
 * curve with the marker in a new place. The cost falls on the settings above it — the reading, and
 * the GM's paint — and never on the control the picture is for.
 */

import type { BinaryMask } from "./binarize";
import { walkIslands } from "./inkIslands";
import { openMask } from "./morphology";

/** A distribution over a slider's own track: one value per band, left to right. */
export interface Profile {
  /**
   * Ink pixels that leave the mask in each band.
   *
   * `bands[i]` is what going from stop `i` to stop `i + 1` costs. Drawn as a height, so the plot is
   * a picture of *where the ink is* along the track.
   */
  readonly bands: readonly number[];
  /** The ink the profile was measured from, so a band can be read as a share of it. */
  readonly total: number;
}

const EMPTY: Profile = { bands: [], total: 0 };

/**
 * Ink per stroke width, by opening the mask at each radius up to `maxRadius`.
 *
 * `bands[r]` is the ink present after opening at radius `r - 1` minus the ink after opening at
 * radius `r`, for `r` from 1 to `maxRadius` — so the array is `maxRadius` long and band `r - 1` of
 * it belongs to the stop that first applies radius `r`.
 *
 * **The resolution is the control's, not ours.** The filter halves its pixel threshold and rounds to
 * a radius, so a slider with sixty stops can have very few distinct outcomes — six on a map whose
 * ink measures 3.4px. Sampling per radius is what makes the curve describe the control rather than a
 * finer thing the control cannot do.
 */
export function strokeProfile(mask: BinaryMask, maxRadius: number): Profile {
  const total = countInk(mask);
  if (total === 0 || maxRadius < 1) return EMPTY;

  const bands: number[] = [];
  let previous = total;
  for (let radius = 1; radius <= maxRadius; radius++) {
    /*
      From the original mask each time, which is the definition.

      **Chaining off the previous result would give the same answer**, and that is worth recording
      because it is not obvious and because the opposite was asserted here first: openings by square
      structuring elements form a *granulometry*, so opening at 1 and then at 2 is opening at 2. A
      mutation replacing this with the chained form survived every fixture and 120 random masks,
      which is the measurement rather than the theory.

      It stays as it is for two reasons that are not performance — both forms are O(pixels) per
      radius. It is the definition the caller can check by eye, and it does not depend on the
      structuring element continuing to be one that composes that way.
    */
    const survivors = countInk(openMask(mask, radius));
    bands.push(previous - survivors);
    previous = survivors;
  }
  return { bands, total };
}

/**
 * Ink per island span, binned across `0 .. maxSpan` into `binCount` bands.
 *
 * **Islands longer than `maxSpan` are left out entirely**, and that is the right answer rather than
 * a clamp: the slider cannot reach them, so they are not part of the choice being made. It is also
 * what keeps the picture legible — a map's wall network is one island spanning most of the raster
 * and holding most of its ink, and folding it into the last bin would flatten everything the control
 * is actually for into the floor.
 */
export function islandProfile(mask: BinaryMask, maxSpan: number, binCount: number): Profile {
  if (maxSpan <= 0 || binCount < 1) return EMPTY;

  const { islands } = walkIslands(mask);
  const bands = new Array<number>(binCount).fill(0);
  let total = 0;

  for (const island of islands) {
    total += island.area;
    if (island.span > maxSpan) continue;
    /*
      **A band holds the islands the handle removes as it passes, so a span landing exactly on a band
      boundary belongs to the band below it.** That is the filter's own rule rather than a rounding
      preference: `removeSmallInkIslands` keeps an island when `span >= minSpan`, so one of span 4
      survives the setting 4 and goes only above it.

      Written with the multiplication inside the division so the arithmetic is exact. `4 / 10 * 5` is
      2.0000000000000004 in binary floating point and would push a boundary island up a band; `4 * 5
      / 10` is 2. The first version of this got the convention wrong in the other direction — it
      offset by one span, which shifted every island a band to the left and made a genuine overflow
      guard look like dead code.

      No clamp is needed: `span <= maxSpan` holds here because longer islands were skipped above, so
      the ceiling cannot exceed `binCount`.
    */
    const bin = Math.ceil((island.span * binCount) / maxSpan) - 1;
    bands[bin] = bands[bin]! + island.area;
  }

  return { bands, total };
}

function countInk(mask: BinaryMask): number {
  let ink = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] === 1) ink += 1;
  return ink;
}
