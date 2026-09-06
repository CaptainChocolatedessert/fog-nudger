/**
 * The top end of the two graph-derived tracks, measured off the graph rather than declared.
 *
 * ## Why the top is not a constant
 *
 * Spur pruning and edge simplification are both denominated in fractions of the map, because that is
 * the only unit the ink mode and the wall editor can both speak — the editor has no raster and no
 * ink width, so anything measured off the reading is unavailable to it.
 *
 * A fraction of the map is honest and it is a terrible thing to put a fixed ceiling on. Two maps of
 * the same pixel size can carry 3px linework or 12px, and every setting a GM wants sits within a few
 * multiples of the map's own ink. A ceiling generous enough for the coarse map puts the whole useful
 * range of the fine one in the first percent of the track. So the top is **measured**: the longest
 * spur for pruning, the largest bend for simplification, each of which is the setting at which that
 * tool has done everything it can do.
 *
 * > *"Maybe a log scale from the smallest to the largest observed bend/spur? If we find a good
 * > version of that, we should use the same in both cases."* — user, 2026-09-06
 *
 * ## The bottom is pinned, and that is the half that matters
 *
 * The floor is a constant in `SETTING_LIMITS`, not the smallest observed spur or bend. **Both tools
 * delete from the bottom**, so the observed minimum is the most mobile quantity there is: prune at
 * budget B and the shortest surviving spur is B. A tracking bottom would chase the slider upward
 * every pass, so "30%" would mean a larger bite each time — which is exactly the non-monotonicity
 * that collapsed the two-slider break design and is worth refusing twice.
 *
 * ## Measured once per opening, not once per derive
 *
 * The tops are forgotten when the accordion rebuilds — which is every header click, so in practice
 * when the step is opened — and taken from the first graph seen after that. A re-measurement on
 * every derive would reintroduce the chase from the other end: raising the tolerance flattens the
 * bends, which would lower the top, which would move the handle the GM had just let go of.
 *
 * > *"that's fine for it to be relative each time you start the tool"* — user, 2026-09-06
 *
 * **A re-measured top moves the handle, never the value.** The stored setting is the absolute
 * tolerance, because the ink mode's settings are durable inputs a re-run has to reproduce — storing
 * "40% of an observed range" would make the emitted fog depend on a measurement taken at the moment
 * a slider was released.
 *
 * No DOM, no SDK.
 */

import type { SettingName } from "../settings";
import { largestBend, longestSpur, type FrozenGraph } from "../trace/frozenGraph";

interface Tops {
  /** The longest run pruning could reach, in map fractions. Zero when there is nothing to prune. */
  readonly spur: number;
  /** The largest single-vertex bend, in map fractions. Zero when there is nothing to straighten. */
  readonly bend: number;
}

let tops: Tops | null = null;

/**
 * The graph most recently derived, kept so a step opened over a current partition can measure at
 * once rather than waiting for a derive that is not going to happen.
 *
 * Held separately from `tops` because the two have different lifetimes: this follows the partition,
 * and the measurement is deliberately frozen for the life of an opening.
 */
let latest: FrozenGraph | null = null;

let listeners: (() => void)[] = [];

/** Whatever draws the graph tells this, every time the partition changes. */
export function noteGraph(graph: FrozenGraph | null): void {
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

/**
 * The top of this control's track, or `null` when it has none.
 *
 * `null` for every control but the two, and for those when nothing has been derived yet or when the
 * graph offers nothing to measure — a map with no spur at all has no longest spur. The caller falls
 * back to the declared maximum, which is a real ceiling rather than a guess.
 */
export function graphScaleTop(name: SettingName): number | null {
  if (tops === null && latest !== null) tops = measure(latest);
  if (tops === null) return null;
  const top = name === "spurPruneFraction" ? tops.spur : name === "simplifyFraction" ? tops.bend : 0;
  return top > 0 ? top : null;
}

function measure(graph: FrozenGraph): Tops {
  return { spur: longestSpur(graph), bend: largestBend(graph) };
}
