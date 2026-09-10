/**
 * Where a slider's ghost goes — the mark saying where the picture on screen actually is, when that
 * is not where the handle is.
 *
 * ## What a room found, and why it was five faults rather than one — 2026-09-09
 *
 * *"When I let go it jumps to a place near the new value but not on it, and it doesn't disappear."*
 *
 * - **Near, never on.** The old test compared *track positions*: where the applied value would put
 *   the handle, against where the handle is. But a release snaps its position to the control's step,
 *   or to three significant figures on a log track, and converting that value back to a position
 *   lands a few steps off the handle. An exact comparison of two numbers that differ by rounding is
 *   never equal, so the ghost sat right beside the handle for good.
 * - **Never gone, on controls that recompute nothing.** A brush width, a gap slider or an opacity
 *   changes the picture instantly or not at all — so the settings the picture was computed from never
 *   "catch up" on them, because nothing is ever pending. They had a ghost that no event could clear.
 * - **Never gone, on pruning,** which re-applies without ever recording that it has.
 * - **Never re-asked when a derive landed**, only when a reading did.
 * - **A leak underneath**: every row subscribed to the reading on build, and that list is never
 *   cleared, so each rebuild of the rail added another row's worth of dead listeners.
 *
 * This is the decision half, pure so it can be tested; `settingRows` owns the element.
 *
 * Pure: no DOM, no SDK.
 */

export interface GhostInput {
  /**
   * Whether this control's picture can lag behind its setting at all.
   *
   * **Only a pipeline control can.** Its release starts a recompute that lands later, and until it
   * does the picture is the old answer — which is what the ghost points at. A `display` or `tool`
   * control has no such gap: an opacity repaints on the spot, a brush width is read by the next
   * stroke. A ghost on one of those would be marking a delay that does not exist.
   */
  readonly lags: boolean;
  /** The value the picture on screen was computed from. */
  readonly applied: number;
  /** The value the settings hold now, which a release writes. */
  readonly current: number;
  /** Where the handle is, as a track position. */
  readonly handle: number;
  /** Where the handle was at the last committed release, as a track position. */
  readonly placed: number;
  /** The track position a value puts the handle at. */
  readonly positionOf: (value: number) => number;
}

/**
 * The track position to draw the ghost at, or `null` for no ghost.
 *
 * Two questions, asked in different currencies on purpose:
 *
 * - **Is anything pending?** Asked in *values*, never positions. The applied value and the current
 *   one are the same number once a recompute lands — `markApplied` copies it straight across — so
 *   exact equality is reliable here in a way it can never be after a round trip through the track.
 * - **Where does the picture sit?** Asked in *positions*, because that is what has to be drawn.
 *
 * A drag counts as pending before anything is written: the settings have not moved yet, but the
 * handle has, and the ghost is exactly what shows the GM where they started.
 */
export function ghostPosition(input: GhostInput): number | null {
  if (!input.lags) return null;

  const dragging = input.handle !== input.placed;
  if (!dragging && input.applied === input.current) return null;

  const at = input.positionOf(input.applied);
  // Sitting exactly under the handle it would be invisible anyway, and hiding it is what lets a
  // GM who drags back onto it see it disappear into the handle — which is the whole use of it.
  return at === input.handle ? null : at;
}
