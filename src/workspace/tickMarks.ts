/**
 * Where a slider's tick marks go, and which one a value is nearest — the two questions a control
 * whose real resolution is coarser than its track needs answered.
 *
 * ## Why this exists at all
 *
 * `control.stepFor` (`controls.ts`) lets a control's step be measured rather than declared, so that
 * every reachable setting is a genuinely distinct outcome instead of one of a run of stops that all
 * do the same thing. That fixed what the setting *means*; it did nothing for what the slider *shows*.
 * The thumb still glides continuously across a thousand positions, and the number beside it still
 * jumps between whichever few of them are real — a false continuity in the handle and a true
 * discontinuity in the number, side by side. Marking the real stops on the rail, and reporting a
 * count of them rather than the raw value, is what makes the two agree.
 *
 * ## Meaningless off a linear scale, and that is not a gap
 *
 * `step` decides nothing on a log-scaled track, which snaps to three significant figures instead
 * (`sliderScale.ts`) — a fixed number of ticks would be meaningless spaced by ratio. The one caller
 * today, the stroke filter, is linear, and nothing here is written to cope with the other case.
 *
 * This is the decision half, pure so it can be tested; `settingRows` owns the elements.
 *
 * Pure: no DOM, no SDK.
 */

import { toSlider, type Scale, type ScaleLimits } from "../sliderScale";

/**
 * Which tick a value is nearest, as a plain count from the floor — the number a GM reads instead of
 * the value itself.
 *
 * **Not the same question as `formatValue`'s.** That prints the stored number; this answers "how many
 * stops in", which is what actually changed as the handle moved past however many of them did
 * nothing. Rounds rather than floors, so a value that has drifted slightly off its own grid — stored
 * before this control had one, say — still reads as the tick it is closest to.
 */
export function tickIndex(value: number, limits: ScaleLimits): number {
  if (!(limits.step > 0)) return 0;
  return Math.round((value - limits.min) / limits.step);
}

/**
 * Every tick's position on the track, from the floor to the top.
 *
 * One entry per whole step from the floor — `floor`, never `round`, so a step is never walked past
 * the top — **plus the top itself, but only when it is genuinely a different stop.**
 *
 * **The room-reported bug this answers: two ticks a hair apart read as one, doubled.** A range that
 * is not an exact multiple of the step leaves a remainder past the last whole step, and the top
 * always used to get its own mark regardless of size — so a remainder under half a step drew a
 * second tick `tickIndex` would call the *same* stop as the one already there, close enough on
 * screen to look like a thicker version of a single mark rather than two. The top earns its own tick
 * now only when `tickIndex` agrees it is one: `round` past the last whole step, exactly the same
 * question the readout answers, so the marks and the number can never disagree about how many stops
 * there are.
 *
 * **`round` in place of `floor` for `wholeSteps` is still an equivalent mutant, checked by hand
 * again after this rewrite.** An overshooting loop value clamps to the top in `toSlider`, landing on
 * exactly the position an explicit push of `limits.max` would — and `wholeSteps` itself becomes
 * `tickIndex(limits.max, limits)` under the mutant, so the gate above can never fire either. Two
 * different routes to the same final positions; kept as `floor` because it says what is true.
 */
export function tickPositions(limits: ScaleLimits, scale: Scale): readonly number[] {
  if (!(limits.step > 0) || !(limits.max > limits.min)) return [];
  const wholeSteps = Math.floor((limits.max - limits.min) / limits.step);
  const values: number[] = [];
  for (let n = 0; n <= wholeSteps; n++) values.push(limits.min + n * limits.step);
  if (tickIndex(limits.max, limits) > wholeSteps) values.push(limits.max);

  return values.map((value) => toSlider(value, limits, scale));
}
