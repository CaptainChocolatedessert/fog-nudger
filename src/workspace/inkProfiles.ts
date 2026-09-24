/**
 * The distributions drawn on the two ink filters' sliders, computed off the critical path.
 *
 * ## Why this is not part of the reading
 *
 * The stroke profile opens the mask once per radius the slider can reach, which is the same order of
 * work as the reading itself. Folding it into the run would roughly double what a slider release
 * costs, to draw a hint — so the map goes up first and the shape arrives after it.
 *
 * **The work is in a worker since 2026-09-24**, beside the derive's own, so the page stays live while
 * it runs and a newer reading abandons it. It was about 1.4 seconds on the page after every reading
 * while this drawer was open, and the walls waited behind it.
 *
 * **And a whole frame passes before it is even asked for**, so the new ink is on screen first. This
 * said a frame was yielded when it was not: the request sat in a single animation-frame callback, and
 * the browser presents a frame only once every callback in it has returned — so the canvas had drawn
 * the new ink and the profiles then held that frame back for their whole second and a half (room,
 * 2026-09-24: the ink and the walls arriving together). Two callbacks deep is one frame presented in
 * between, which is `whileWorking`'s rule in `shell.ts`. It still matters with the worker, since
 * copying the two masks to post them is work on the page, and on the page is where this runs if no
 * worker can be had.
 *
 * ## What invalidates it
 *
 * A reading, and nothing else. Neither filter's setting changes the mask its own profile is measured
 * from — the stroke filter acts on the raw reading and the island filter on what the stroke filter
 * left — so dragging either handle redraws the same curve with the marker in a new place. Moving the
 * **stroke** slider does change the island profile, and that is real rather than an oversight: the
 * islands the second filter sees are whatever the first one left standing.
 */

import { describeError } from "../describeError";
import { devLog } from "../devlog";
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
/**
 * Counts every change to what the shape must describe — a reading, or another map — so an answer for
 * one that has since been replaced is dropped rather than drawn. The worker abandons a running request
 * for a newer one, but a request that finished just before the change would otherwise still land.
 */
let wanted = 0;
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
  wanted += 1;
  stale = true;
  if (watched) refreshInkProfiles();
}

function refreshInkProfiles(): void {
  if (booked) return;
  booked = true;
  // Two callbacks deep, so the frame showing the new ink is presented before any of this runs.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      booked = false;
      void measure(wanted);
    }),
  );
}

async function measure(asked: number): Promise<void> {
  const maxInkWidths = SETTING_LIMITS.minStrokeInkWidths.max;
  const maxSpanPx = SETTING_LIMITS.minIslandPx.max;
  let next: InkProfiles | null;
  try {
    next = await inkProfiles(maxInkWidths, maxSpanPx, ISLAND_BANDS);
  } catch (error) {
    // Abandoned for a newer reading, whose own request is already on its way — not a failure.
    if (error instanceof DOMException && error.name === "AbortError") return;
    // A hint beside two sliders: the shape in hand stays, and the detail goes where it can be read.
    devLog("error", "workspace: the ink profiles could not be measured", describeError(error));
    console.error("Fog Nudger — the ink profiles could not be measured", error);
    return;
  }
  if (asked !== wanted) return;
  stale = false;
  // Kept rather than cleared when there is nothing: before the first reading there is no shape to
  // draw, and after one there always is.
  if (!next) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Forget the shape, which is what loading another map does. */
export function clearInkProfiles(): void {
  wanted += 1;
  current = null;
  for (const listener of listeners) listener();
}
