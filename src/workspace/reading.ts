/**
 * The reading: asking the pipeline for a mask, and deciding whether the answer is still wanted.
 *
 * ## Why this is not in a step
 *
 * Several controls change the reading and they are spread across steps — what counts as ink, the two
 * linework filters, and the break repair, which is a sub-heading inside Ink rather than a step of
 * its own — and every one of them wants the *same* mask back. Putting the request cycle in one step
 * would make the others depend on it, and putting a copy in each would be more implementations of
 * the chain, which is the duplication the sibling paid for. So the steps subscribe: a reading lands
 * here, and whoever wants to draw something from it is handed it.
 *
 * ## Blank rather than stale
 *
 * Whenever the mask in hand is not the mask for the settings that have been **applied**, nothing is
 * painted. Ink drawn for settings the GM has moved past does not lag, it lies, and comparing ink
 * against linework is the whole of stage one. `maskRequest.ts` carries that rule and its tests;
 * `maskShowing()` is how a painter asks it.
 *
 * No DOM. The state line is reached through the shell.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { maskForOverlay, type MaskForOverlay, type MaskOutcome } from "../pipeline";
import { currentPaint } from "./paintState";
import { currentSettings } from "./settingsState";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { invalidate, isClosing, say, sayIfSettled } from "./shell";

/**
 * A step taking a reading.
 *
 * Returning `false` means it could **not** take it — an allocation that failed, in practice — and
 * the reading is then marked failed so nothing paints a half-updated surface. A listener that
 * refuses is expected to have said why on the state line: this side knows a step declined, not what
 * it was trying to do.
 */
export type ReadingListener = (result: MaskForOverlay) => boolean | void;

const listeners: ReadingListener[] = [];

export function onReading(listener: ReadingListener): void {
  listeners.push(listener);
}

const requests = new MaskRequests();
let inFlight = false;

/** The last reading's headline figures, so the two paths that report them cannot word it differently. */
let lastInkShare: number | null = null;
let lastReused = false;

/*
  The break counts were here, and they went with the search (2026-09-05).

  A reading no longer finds breaks — the search is a tool inside Add ink, run when the GM asks — so
  there is nothing here to count. That is a real loss and worth naming: this line reported a total on
  every recompose, which is how a break on a part of the map nobody was looking at got mentioned at
  all. Now nothing mentions one until the tool is opened. The record already accepted the smaller
  version of this cost when the repair was defaulted off; this is the same cost, one step further.
*/

/** Whether a mask current for the applied settings exists, which is what a painter must check. */
export function maskShowing(): boolean {
  return shouldPaint(requests.current());
}

/**
 * Blank the surface and read again, because a pipeline setting changed.
 *
 * Blanking happens here, at the moment the change is applied, rather than when the recomputation
 * starts: the gap between the two is a window in which the old mask sits under the new settings.
 */
export function requestReread(): void {
  requests.request();
  invalidate();
  void refreshMask();
}

/**
 * Recompose the ink because a **paint layer** changed, without blanking what is on screen.
 *
 * This is the one change that may not blank, and the reason is structural rather than a concession.
 * What the ink layer draws is the *base* — the reading after its two filters — and both paint layers
 * compose strictly after it, so painting cannot change the picture the surface is showing. There is
 * nothing on screen that goes stale, so blanking it would take the GM's own map away for the length
 * of a recompose in exchange for nothing.
 *
 * **Nothing on screen lags this any more.** There was one thing that did — the break rings, found on
 * the suppressed mask, so a saved suppression left them describing the ink from just before it. The
 * search is a tool now and holds its own marks, re-running them when the GM asks, so the reading has
 * nothing left that a paint change could make stale.
 *
 * It is also cheap, which is what makes it bearable at all: paint is composed on top of a reading, so
 * this re-runs the cheap half of the cache and never re-reads the map.
 */
export function requestRecompose(): void {
  // Fulfilled immediately, so `maskShowing()` stays true and the layers go on drawing what they have
  // while the new composition is computed. The stamp still **moves**, which is the part that matters:
  // a reply computed before the paint changed would otherwise be accepted as current.
  requests.fulfil(requests.request());
  /*
    And tracked separately, because `waiting()` cannot see this.

    That flag means "blank and waiting", which is exactly what a recompose is not — so a recompose
    asked for while a reading was already in flight would be dropped by the retry at the end of
    `refreshMask`, leaving a composite computed from paint the GM has already replaced and marked
    current. The stale-diagnostic failure, from the one direction the request state cannot express.
  */
  recomposeWanted = true;
  invalidate();
  void refreshMask();
}

/** A recompose was asked for and has not been serviced yet. See `requestRecompose`. */
let recomposeWanted = false;

function shareOfInk(mask: { data: Uint8Array; width: number; height: number }): number {
  let ink = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) ink += 1;
  return mask.data.length === 0 ? 0 : ink / mask.data.length;
}

/**
 * Hand a reading to the steps and record what it says, or report that a step could not take it.
 *
 * The one place a reading becomes what is on screen, shared by the open path and every re-read, so
 * the two cannot drift into painting different things from the same result.
 */
function publish(result: MaskForOverlay, generation: number): boolean {
  for (const listener of listeners) {
    if (listener(result) === false) {
      requests.fail(generation);
      return false;
    }
  }

  lastInkShare = shareOfInk(result.mask);
  lastReused = result.reused;
  sayReading();
  return true;
}

function sayReading(): void {
  if (lastInkShare === null) return;
  sayIfSettled(`ink ${(lastInkShare * 100).toFixed(1)}%${lastReused ? " (cached)" : ""}`);
}

/** How a reading was arrived at, for the log. */
function describeReuse(result: MaskForOverlay): string {
  return result.reused
    ? "reused whole"
    : result.readingReused
      ? "reading reused, ink recomposed"
      : "read from the map";
}

/**
 * Ask for a mask for the settings as they now are, and paint it if it is still wanted when it lands.
 *
 * **Nothing queues.** A request made while one is in flight only bumps the generation; the reply
 * that eventually arrives is checked against the latest stamp and dropped if it has been
 * superseded, and then this runs again for whatever is current. A queue would work through every
 * intermediate position of a drag to reach somewhere the GM left seconds ago.
 */
async function refreshMask(): Promise<void> {
  if (inFlight || isClosing()) return;

  // Whatever is outstanding, not a new stamp: the caller already registered the change, and asking
  // again here would blank the sheet a second time for the same edit.
  const generation = requests.latest();
  // Cleared here rather than in `requestRecompose`, so a request that arrives while one is in flight
  // survives the early return above and is picked up by the retry below.
  recomposeWanted = false;
  inFlight = true;
  invalidate();
  say("reading the map…", "working");

  // No copy. `Settings` is readonly through and through and `setSettings` replaces the whole object
  // rather than writing into it, so the reference taken here is already a snapshot of what was
  // current when the request went out. This used to be a shallow spread, which defended against
  // nothing that happens and implied a guard it could not give anyway — `trace`, `review` and
  // `overlay` would have stayed shared references.
  const wanted = { settings: currentSettings(), paint: currentPaint() };
  try {
    const outcome = await maskForOverlay(wanted);
    if (isClosing()) return;

    if (!outcome.ok) {
      if (requests.fail(generation)) say(describeMaskFailure(outcome), "bad");
      return;
    }
    const result = outcome.reading;

    if (!requests.fulfil(generation)) {
      // Superseded while it computed. The sheet is already blank for the newer generation, so
      // there is nothing to undo — only something not to draw.
      devLog("info", `workspace: mask ${generation} superseded before it landed`);
      return;
    }

    if (!publish(result, generation)) return;

    devLog(
      "info",
      `workspace: mask ${generation} painted for "${result.mapName}" — ` +
        `${result.mask.width}x${result.mask.height}, ink ${((lastInkShare ?? 0) * 100).toFixed(1)}%, ` +
        `${describeReuse(result)}`,
    );
  } catch (error) {
    if (requests.fail(generation)) {
      const detail = describeError(error);
      say(`reading failed: ${detail}`, "bad");
      devLog("error", "workspace: reading the map failed", detail);
      console.error("Fog Nudger — workspace could not read the map", error);
    }
  } finally {
    inFlight = false;
    invalidate();
    // Anything that arrived while this was running is now the current generation, and nothing has
    // been computed for it. Run again rather than leaving the sheet blank with no work in flight —
    // or, for a recompose, showing ink composed from paint that has since been replaced.
    if (!isClosing() && (requests.waiting() || recomposeWanted)) void refreshMask();
  }
}

/**
 * What to put on the state line for each way a reading can fail.
 *
 * One function rather than a sentence at each call site, so the two surfaces that read a mask
 * cannot describe one failure two ways — which is how "no map chosen" came to be shown for a map
 * that was chosen and visibly on screen.
 */
export function describeMaskFailure(outcome: MaskOutcome & { ok: false }): string {
  return outcome.reason === "no-map"
    ? "no map chosen — pick one under Map"
    : // Matches `runTrace`'s wording for the same failure. The console is where the detail is, and
      // it is genuinely there in a production build now.
      `could not read pixels from "${outcome.mapName}" — see the console`;
}

/** Read the nominated map now. Returns the outcome, because the map name and bounds come with it. */
export async function takeReading(): Promise<MaskOutcome> {
  return maskForOverlay({ settings: currentSettings(), paint: currentPaint() });
}

/**
 * Adopt a reading as the one on screen.
 *
 * Separated from `takeReading` so the caller can start loading the map image in between: the surface
 * has nothing to draw the mask *over* until the image lands, and the reading is what names the map.
 */
export function adoptReading(result: MaskForOverlay): void {
  const generation = requests.request();
  if (requests.fulfil(generation) && publish(result, generation)) {
    devLog(
      "info",
      `workspace: showing "${result.mapName}" — mask ${result.mask.width}x${result.mask.height}, ` +
        `ink ${((lastInkShare ?? 0) * 100).toFixed(1)}%, ` +
        `${result.reused ? "reused from cache" : "recomputed"}`,
    );
  }
  invalidate();
}
