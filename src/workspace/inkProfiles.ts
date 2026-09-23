/**
 * The distributions drawn on the two ink filters' sliders, computed off the critical path.
 *
 * ## Why this is not part of the reading
 *
 * The stroke profile opens the mask once per radius the slider can reach, which is the same order of
 * work as the reading itself. Folding it into the run would roughly double what a slider release
 * costs, to draw a hint — so the map goes up first and the shape arrives after it.
 *
 * **A frame is yielded before the work starts**, which is §7a's implementation trap: a synchronous
 * computation holds the main thread, so anything set immediately before it never paints. Here the
 * consequence would be the map appearing to hang after every reading change rather than after none.
 *
 * ## What invalidates it
 *
 * A reading, and nothing else. Neither filter's setting changes the mask its own profile is measured
 * from — the stroke filter acts on the raw reading and the island filter on what the stroke filter
 * left — so dragging either handle redraws the same curve with the marker in a new place. Moving the
 * **stroke** slider does change the island profile, and that is real rather than an oversight: the
 * islands the second filter sees are whatever the first one left standing.
 */

import { inkProfiles, type InkProfiles } from "../pipeline";
import { SETTING_LIMITS, type SettingName } from "../settings";
import type { ProfilePoint } from "../trace/inkProfile";

/**
 * How many bands the island distribution is cut into.
 *
 * Fewer than the plot has pixels, and enough that two populations separate. The stroke profile has
 * no equivalent constant: its band count is the number of distinct radii the slider can reach, which
 * is the control's own resolution and not ours to choose.
 */
const ISLAND_BANDS = 24;

let current: InkProfiles | null = null;
let booked = false;
const listeners: (() => void)[] = [];

/** The shape for one control, or an empty list where there is nothing to draw. */
export function profileFor(name: SettingName): readonly ProfilePoint[] {
  if (!current) return [];
  if (name === "minStrokeInkWidths") return current.stroke;
  if (name === "minIslandPx") return current.island;
  return [];
}

/** Told when a new pair lands, so the rows on screen can repaint. */
export function onInkProfiles(listener: () => void): void {
  listeners.push(listener);
}

/**
 * Ask for the profiles again, on the next frame.
 *
 * Called when a reading lands. Booking rather than computing means a burst of readings — a GM
 * sweeping a slider, where each release lands its own — does the work once at the end instead of
 * once per release.
 */
/**
 * Whether a row that draws a profile is on screen.
 *
 * **The shape costs about a second and a half on a real map** — measured in a room, 2026-09-22, where
 * every speckle suppressed paid for it — and it is a hint beside two sliders in one drawer. So a
 * reading marks it stale and nothing is computed until something is there to draw it.
 *
 * Set by the rows as they are built and cleared when the panel is rebuilt, which is the same lifetime
 * the painters themselves have.
 */
let watched = false;
/** Whether the shape in hand is for the reading now in hand. */
let stale = true;

/** Told by the rows: one of them draws a profile, so the shape is worth computing. */
export function watchInkProfiles(): void {
  watched = true;
  if (stale) refreshInkProfiles();
}

/** Told by the panel: whatever was drawing a profile is gone. */
export function unwatchInkProfiles(): void {
  watched = false;
}

/** A reading landed, so whatever shape is in hand describes ink that has been replaced. */
export function markInkProfilesStale(): void {
  stale = true;
  if (watched) refreshInkProfiles();
}

function refreshInkProfiles(): void {
  if (booked) return;
  booked = true;
  requestAnimationFrame(() => {
    booked = false;
    const maxInkWidths = SETTING_LIMITS.minStrokeInkWidths.max;
    const maxSpanPx = SETTING_LIMITS.minIslandPx.max;
    const next = inkProfiles(maxInkWidths, maxSpanPx, ISLAND_BANDS);
    stale = false;
    // Kept rather than cleared when there is nothing: before the first reading there is no shape to
    // draw, and after one there always is.
    if (!next) return;
    current = next;
    for (const listener of listeners) listener();
  });
}

/** Forget the shape, which is what loading another map does. */
export function clearInkProfiles(): void {
  current = null;
  for (const listener of listeners) listener();
}
