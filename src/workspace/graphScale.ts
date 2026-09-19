/**
 * The top end of the two graph-derived tracks, measured off the graph rather than declared.
 *
 * ## Why the top is not a constant
 *
 * Spur pruning and edge simplification are both denominated in graph units — the map's longer side is
 * 1 — because that is the unit that outlives the raster, which a value re-applied on every derive has
 * to: a graph has no raster and no ink width, so anything measured off the reading is unavailable to it.
 *
 * A graph unit is honest and it is a terrible thing to put a fixed ceiling on. Two maps of
 * the same pixel size can carry 3px linework or 12px, and every setting a GM wants sits within a few
 * multiples of the map's own ink. A ceiling generous enough for the coarse map puts the whole useful
 * range of the fine one in the first percent of the track. So the top is **measured**: the longest
 * wall *run* for pruning, the largest single-vertex bend for simplification. Each is the setting at
 * which that tool has done everything it can do — and for pruning that is a claim about a *bound*
 * rather than about today's candidates, which is why it counts every run and not only the ones with a
 * free end. `longestRun` carries why that distinction cost a room a puzzle.
 *
 * > *"Maybe a log scale from the smallest to the largest observed bend/spur? If we find a good
 * > version of that, we should use the same in both cases."* — user, 2026-09-06
 *
 * ## The bottom is pinned, and that is the half that matters
 *
 * The floor is a constant in `SETTING_LIMITS`, not the smallest observed spur or bend. **Both tools
 * delete from the bottom**, so the observed minimum is the most mobile quantity there is: prune at
 * limit B and the shortest surviving spur is B. A tracking bottom would chase the slider upward
 * every pass, so "30%" would mean a larger bite each time — which is exactly the non-monotonicity
 * that collapsed the two-slider gap design and is worth refusing twice.
 *
 * ## Measured once per opening, not once per derive
 *
 * The tops are forgotten when the drawer rebuilds — which is every press in the strip, so in practice
 * when the step is opened — and taken from the first graph seen after that. A re-measurement on
 * every derive would reintroduce the chase from the other end: raising the tolerance flattens the
 * bends, which would lower the top, which would move the handle the GM had just let go of.
 *
 * > *"that's fine for it to be relative each time you start the tool"* — user, 2026-09-06
 *
 * **A re-measured top moves the handle, never the value.** The stored setting is the absolute
 * tolerance, because the reading's settings are durable inputs a re-run has to reproduce — storing
 * "40% of an observed range" would make the emitted fog depend on a measurement taken at the moment
 * a slider was released.
 *
 * No DOM, no SDK.
 */

import { largestBend, longestRun, type WallGraph } from "../trace/wallGraph";

interface Tops {
  /**
   * The longest wall run, in graph units. Zero when there is nothing to prune.
   *
   * **Every run, not only those with a free end today.** Pruning cascades, so a run between two
   * junctions now can be a dead end three rounds later; a top measured from today's spurs alone was
   * too short to reach exactly those, which is what left long walls standing at the far right.
   */
  readonly spur: number;
  /** The largest single-vertex bend, in graph units. Zero when there is nothing to straighten. */
  readonly bend: number;
}

let tops: Tops | null = null;

/**
 * The graph most recently derived, kept so a step opened over a current partition can measure at
 * once rather than waiting for a derive that is not going to happen.
 *
 * Held separately from `tops` because the two have different lifetimes: this follows the partition,
 * and the measurement is deliberately saved for the life of an opening.
 */
let latest: WallGraph | null = null;

let listeners: (() => void)[] = [];

/** Whatever draws the graph tells this, every time the partition changes. */
export function noteGraph(graph: WallGraph | null): void {
  latest = graph;
  if (tops !== null || graph === null) return;
  tops = measure(graph);
  for (const tell of listeners) tell();
}

/**
 * Forget the measurement and the listeners, which the caller must do before rebuilding the rows.
 *
 * Both together, deliberately: a listener belongs to a row, and a row that has been replaced would
 * otherwise be repositioned for ever, one more time per rebuild. Same rule, and the same reason, as
 * the hint painters beside it.
 */
export function forgetGraphScale(): void {
  tops = null;
  listeners = [];
}

/** Called when a measurement arrives after a row was built, so the handle can be repositioned. */
export function onGraphScale(tell: () => void): void {
  listeners.push(tell);
}

/*
  **`graphScaleTop` was here and went on 2026-09-18.**

  It answered "what is the top of this *control's* track" for the two settings with graph-derived
  ranges. Neither is a setting any more — straightening and pruning are amounts a GM presses — so the
  two measurements are named directly below instead, and nothing keyed by `SettingName` is left.
*/

/**
 * The largest **bend** in the graph, which is *Straighten*'s track top.
 *
 * Named rather than keyed by a setting, because straightening stopped being one on 2026-09-18 — it is
 * an amount applied to the walls in front of the GM. The measurement is unchanged and so is the reason
 * it is per **vertex**: how far one point sits off the line joining its neighbours. A whole wall's
 * deviation from the chord between its ends is dominated by the exterior, which departs from its own
 * chord by something like half the map, and every useful amount would sit in the first percent.
 *
 * `null` when nothing has been derived, or when the graph is already straight enough to offer nothing
 * to measure — a graph with no bend has no largest bend, and the caller says so rather than offering a
 * track with no range.
 */
export function bendTop(): number | null {
  if (tops === null && latest !== null) tops = measure(latest);
  if (tops === null) return null;
  return tops.bend > 0 ? tops.bend : null;
}

/**
 * The longest wall **run** in the graph, which is *Prune the dead ends*' track top.
 *
 * The longest run rather than the longest spur, and that distinction was learned the hard way.
 * Measuring only runs that have a free end *today* never counts a run sitting between two junctions —
 * and the cascade frees exactly such runs on later rounds, so at the far right, where a GM reasonably
 * expects every dead end to go, those are the walls left standing. No run can be longer than the
 * longest run, so a limit there reaches anything the cascade ever frees while staying a real
 * measurement. It must be the run and not the longest segment, because pruning removes a whole run at
 * a time.
 *
 * `null` when nothing has been derived, or when there is no run to measure.
 */
export function spurTop(): number | null {
  if (tops === null && latest !== null) tops = measure(latest);
  if (tops === null) return null;
  return tops.spur > 0 ? tops.spur : null;
}

function measure(graph: WallGraph): Tops {
  return { spur: roundUp(longestRun(graph)), bend: roundUp(largestBend(graph)) };
}

/**
 * Round a measurement **up** to three significant figures, which is what the slider snaps to.
 *
 * Without it the top of the track lands a hair *below* what was measured: `fromSlider` snaps a log
 * value to three figures, so a maximum of 0.1364 comes back as 0.136, and the prune limit then
 * fails to reach the very run it was measured from. Rounding the bound up is what keeps the far left
 * meaning exactly off and the far right meaning exactly everything, which is the pair of guarantees
 * these two tracks exist to offer.
 */
function roundUp(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 2);
  return Math.ceil(value / magnitude) * magnitude;
}
