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
  /**
   * Where the logarithmic part of the track starts, for a scale whose far left means **off**.
   *
   * A log scale cannot begin at zero, and a control whose zero is a real state — off — has to be
   * able to express it exactly. So the two are declared separately: `min` stays **0**, because that
   * is the parameter's true minimum and the settings normaliser clamps to it, and this is the
   * smallest value the log range can reach.
   *
   * **`min` must not be used for this.** The normaliser clamps a stored value into `[min, max]`, so
   * a positive `min` would silently raise a stored zero to the floor on every read — destroying the
   * off state at the one moment nothing is watching.
   *
   * Present means the far-left position is off; absent means an ordinary scale.
   */
  readonly floor?: number;
}

/**
 * The log range's lower bound, or `null` when this scale has no logarithmic part.
 *
 * Two ways to have one: a `floor`, which puts an off position at the far left, or a positive `min`,
 * which is an ordinary log scale whose bottom is a real value. Anything else falls back to linear.
 */
function logBase(limits: ScaleLimits, scale: Scale): number | null {
  if (scale !== "log") return null;
  if (limits.floor !== undefined && limits.floor > 0) return limits.floor;
  return limits.min > 0 ? limits.min : null;
}

/**
 * Whether the far-left position of this track means off.
 *
 * Keyed on the **position** rather than on the value, deliberately. Keying on the value would make
 * `floor` a sentinel meaning two things at once, and `fromSlider` snaps log values to three
 * significant figures — so whether a low position collided with the floor and silently read back as
 * off would depend on the *leading digit* of the floor constant. Measured: at a floor of 2e-4
 * nothing collides at any plausible top, and at 1e-4 exactly one position does. Small, and not a
 * thing correctness should rest on. One integer is unambiguous.
 */
function hasOff(limits: ScaleLimits, scale: Scale): boolean {
  return scale === "log" && limits.floor !== undefined && limits.floor > 0;
}

/** Where on the track a value sits. Clamped, so a stored value out of range still shows somewhere. */
export function toSlider(value: number, limits: ScaleLimits, scale: Scale): number {
  const { min, max } = limits;
  if (!(max > min) || !Number.isFinite(value)) return 0;
  const base = logBase(limits, scale);
  const off = hasOff(limits, scale);

  // Off is the far left, and it is the *only* thing there: the log part starts one step in, so
  // position 1 is the floor rather than a value indistinguishable from off.
  if (off && value <= 0) return 0;

  const lowest = base ?? min;
  const clamped = Math.min(max, Math.max(lowest, value));

  const fraction =
    base !== null
      ? Math.log(clamped / base) / Math.log(max / base)
      : (clamped - min) / (max - min);

  const first = off ? 1 : 0;
  return first + Math.round(fraction * (SLIDER_STEPS - first));
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
  const base = logBase(limits, scale);
  const off = hasOff(limits, scale);

  // The half that must be built with `toSlider` rather than after it. Change one side alone and the
  // round trip breaks, which is the failure this whole module exists to prevent.
  if (off && position <= 0) return 0;

  const first = off ? 1 : 0;
  const span = SLIDER_STEPS - first;
  const fraction = Math.min(1, Math.max(0, (position - first) / span));

  if (base !== null) {
    const value = base * Math.pow(max / base, fraction);
    return clampTo(Number(value.toPrecision(3)), base, max);
  }

  const raw = min + fraction * (max - min);
  const snapped = min + Math.round((raw - min) / step) * step;
  // Steps like 0.02 do not survive repeated addition in binary floating point, so the result is
  // re-rounded to the step's own precision rather than left with a tail of noise.
  const decimals = decimalsOf(step);
  return clampTo(Number(snapped.toFixed(decimals)), min, max);
}

/**
 * A track position as one to a hundred, for a control whose own unit means nothing to a GM.
 *
 * Two controls store a fraction of the map — the unit that outlives the raster, which is what a
 * value re-applied on every derive has to do — and no spelling of that is a number anybody can
 * hold on to (user, 2026-09-07: *"an
 * arbitrary large number and log scale don't make sense to the user"*). What the readout is for is
 * **remembering a setting so you can go back to it**, and where the handle sits serves that.
 *
 * Position zero is the off state on those tracks and is answered before this is reached, so the range
 * that matters begins at 1: the first usable position reads as 1 and the last as exactly 100.
 *
 * **It reports a place, not a quantity**, so it moves when the track does. These tracks have a top
 * measured off the graph when a step opens, and the graph changes as walls are pruned and
 * straightened — so one stored setting can read 40 today and 43 tomorrow. Stable for as long as the
 * step is open, which is when a GM is comparing two settings. Numbering against a fixed reference
 * range instead would be stable forever and would put the handle at the far right while the readout
 * said 78, which is wrong in a way you can see.
 */
export function positionReadout(position: number): number {
  const clamped = Math.min(SLIDER_STEPS, Math.max(1, position));
  return 1 + Math.round(((clamped - 1) / (SLIDER_STEPS - 1)) * 99);
}

/** How a value should be written next to its slider. */
export function formatValue(value: number, limits: ScaleLimits, scale: Scale): string {
  // Off is a state rather than a number, and "0.000200" beside a slider that is doing nothing reads
  // as a setting rather than as a switch.
  if (hasOff(limits, scale) && value <= 0) return "off";
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
