/**
 * Which way round is the ink?
 *
 * A binarizer assuming dark ink on a light ground, run on light linework over a dark ground, traces
 * the complement of the structure — confidently, completely, and with region statistics that look
 * much like a correct answer's (DESIGN.md §10). So this has to be decided, and decided visibly.
 *
 * ## Why "the ink is the minority" is not good enough
 *
 * It is the obvious rule, and the histogram already reports what it needs: on line art the ink is a
 * small share of the image, so whichever class is smaller is the ink.
 *
 * It fails on an ordinary and increasingly common map. Take a dungeon drawn with black walls, light
 * room floors, and a **dark fill outside the rooms**. Ink and exterior are both dark, so a global
 * split lands between them and the light rooms, and the "dark" class is most of the image — while
 * the ink is still, plainly, dark. The rule then inverts a map that needed nothing done to it.
 *
 * This project's own test map is the near miss that makes the point: its exterior is a mid tone,
 * light enough to fall on the ground side. Shade that exterior a little darker and the minority rule
 * flips its answer while nothing about the linework has changed.
 *
 * ## What actually distinguishes ink
 *
 * Not that it is rare — that it is **thin**. Linework is thin everywhere by construction; fills,
 * floors and exteriors are not. That property survives whatever the map does with its tones.
 *
 * Measured by erosion, in `inkMetrics.ts`: a mask is eroded by one pixel and the share of ink that
 * *fails to survive* is the score. A one-pixel line loses everything and scores 1. A three-pixel
 * stroke keeps only its spine and scores about two thirds. A large blob loses only its rim and
 * scores near zero. So the higher score is the more line-like reading, and that is the polarity.
 *
 * Pure: no DOM, no SDK.
 */

import { countInk, sauvolaBothPolarities, type BinaryMask, type SauvolaOptions } from "./binarize";
import type { ScalarField } from "./field";
import { inkWidthFromThinness, thinness } from "./inkMetrics";

export type Polarity = "dark-ink" | "light-ink";

/**
 * Ink is never most of the map. A reading above this is disqualified outright rather than scored,
 * because a mask covering most of the image can still be locally thin — a dense cross-hatch, say —
 * and would otherwise win on thinness while being obvious nonsense.
 */
export const MAX_INK_COVERAGE = 0.5;

/**
 * How much clearer one reading must be than the other before the verdict is called confident.
 *
 * Not a tuning knob so much as an honesty threshold: below it the two readings are telling much the
 * same story, the choice is close to arbitrary, and the caller should say so rather than present a
 * coin toss as a measurement.
 */
export const CONFIDENT_MARGIN = 0.1;

export interface PolarityReading {
  readonly polarity: Polarity;
  readonly darkThinness: number;
  readonly lightThinness: number;
  readonly darkCoverage: number;
  readonly lightCoverage: number;
  /** Whether the two readings differ by more than `CONFIDENT_MARGIN`, both being eligible. */
  readonly confident: boolean;
  /** The mask for the chosen polarity, already computed — no reason to make the caller redo it. */
  readonly mask: BinaryMask;
  /**
   * Mean ink width of the chosen reading, in pixels, or `null` if it found no ink.
   *
   * Free: it is the chosen thinness reinterpreted, not a second pass over the mask. See
   * `inkMetrics.ts` for what the figure can and cannot support — it is biased thin and saturates at
   * two pixels.
   */
  readonly inkWidth: number | null;
}

/**
 * Binarise both ways and pick the reading whose ink looks like linework.
 *
 * Returns the chosen mask alongside every number that went into choosing, because the caller's job
 * is to report all of it. A polarity decision that logs only its verdict is the kind of diagnostic
 * this project keeps having to design against: it cannot be checked, and on the map where it is
 * wrong it will be believed.
 */
export function detectPolarity(
  field: ScalarField,
  options?: SauvolaOptions,
): PolarityReading {
  const { dark, light } = sauvolaBothPolarities(field, options);
  const pixels = Math.max(1, field.width * field.height);

  const darkCoverage = countInk(dark) / pixels;
  const lightCoverage = countInk(light) / pixels;
  const darkThinness = thinness(dark);
  const lightThinness = thinness(light);

  const darkEligible = darkCoverage > 0 && darkCoverage <= MAX_INK_COVERAGE;
  const lightEligible = lightCoverage > 0 && lightCoverage <= MAX_INK_COVERAGE;

  let polarity: Polarity;
  let confident: boolean;

  if (darkEligible && !lightEligible) {
    polarity = "dark-ink";
    confident = true;
  } else if (lightEligible && !darkEligible) {
    polarity = "light-ink";
    confident = true;
  } else if (!darkEligible && !lightEligible) {
    // Neither reading produced anything that could be linework — a blank asset, or a photograph.
    // Defaulting to dark ink keeps the pipeline running on the commoner case, and `confident` is
    // what tells the caller to say so loudly.
    polarity = "dark-ink";
    confident = false;
  } else {
    polarity = lightThinness > darkThinness ? "light-ink" : "dark-ink";
    confident = Math.abs(lightThinness - darkThinness) > CONFIDENT_MARGIN;
  }

  return {
    polarity,
    darkThinness,
    lightThinness,
    darkCoverage,
    lightCoverage,
    confident,
    mask: polarity === "dark-ink" ? dark : light,
    inkWidth: inkWidthFromThinness(
      polarity === "dark-ink" ? darkThinness : lightThinness,
    ),
  };
}
