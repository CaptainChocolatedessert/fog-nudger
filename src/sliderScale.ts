/**
 * Mapping a setting onto a slider track, and back.
 *
 * ## Why this is not just `input.value`
 *
 * A range input is linear over its track, and one of these parameters is not a linear quantity. The
 * smallest-room threshold spans 0.002 to 6 grid squares — **three orders of magnitude** — and every
 * value a GM will ever want sits in the bottom few percent. On a linear track the useful range is
 * about three pixels wide and the other ninety-seven percent selects between "absurd" and "more
 * absurd". A slider that cannot express the values it exists to set is worse than the number box it
 * replaced.
 *
 * So a setting can be **logarithmic**, which spreads the same range evenly in *ratio* rather than in
 * difference: each step multiplies rather than adds. That is the right shape for an area threshold,
 * where the interesting question is "twice as big" and never "0.01 bigger".
 *
 * ## Round-tripping is the property that matters
 *
 * A value arrives from scene metadata and has to position the slider; the slider then has to
 * reproduce that value. If those disagree, merely opening the panel silently rewrites a GM's
 * setting — which is the worst failure available to a control, because nothing announces it.
 *
 * Pure: no DOM, no SDK.
 */

export type Scale = "linear" | "log";

/**
 * Track positions. Fine enough that a drag feels continuous and the quantisation is invisible, and
 * integral so the browser never renders a value between two positions.
 */
export const SLIDER_STEPS = 1000;

export interface ScaleLimits {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** Where on the track a value sits. Clamped, so a stored value out of range still shows somewhere. */
export function toSlider(value: number, limits: ScaleLimits, scale: Scale): number {
  const { min, max } = limits;
  if (!(max > min) || !Number.isFinite(value)) return 0;
  const clamped = Math.min(max, Math.max(min, value));

  const fraction =
    scale === "log" && min > 0
      ? Math.log(clamped / min) / Math.log(max / min)
      : (clamped - min) / (max - min);

  return Math.round(fraction * SLIDER_STEPS);
}

/**
 * What value a track position means.
 *
 * Snapped on the way out — to the setting's own step when linear, and to three significant figures
 * when logarithmic, where a fixed step would be far too coarse at the bottom of the range and
 * far too fine at the top. Without snapping every drag would store something like
 * 0.10300000000000001, which is the number a GM then sees in their log.
 */
export function fromSlider(position: number, limits: ScaleLimits, scale: Scale): number {
  const { min, max, step } = limits;
  if (!(max > min)) return min;
  const fraction = Math.min(1, Math.max(0, position / SLIDER_STEPS));

  if (scale === "log" && min > 0) {
    const value = min * Math.pow(max / min, fraction);
    return clampTo(Number(value.toPrecision(3)), min, max);
  }

  const raw = min + fraction * (max - min);
  const snapped = min + Math.round((raw - min) / step) * step;
  // Steps like 0.02 do not survive repeated addition in binary floating point, so the result is
  // re-rounded to the step's own precision rather than left with a tail of noise.
  const decimals = decimalsOf(step);
  return clampTo(Number(snapped.toFixed(decimals)), min, max);
}

/** How a value should be written next to its slider. */
export function formatValue(value: number, limits: ScaleLimits, scale: Scale): string {
  if (scale === "log") return String(Number(value.toPrecision(3)));
  return value.toFixed(decimalsOf(limits.step));
}

function clampTo(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}
