/**
 * The reading: asking the pipeline for a mask, and deciding whether the answer is still wanted.
 *
 * ## Why this is not in a step
 *
 * Several controls change the reading and they are spread across steps — what counts as ink, the two
 * linework filters, and the gap repair, which is a sub-heading inside Ink rather than a step of
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
import { currentSettings, markApplied } from "./settingsState";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { invalidate, isClosing, say, unsay, whileWorking } from "./shell";

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
/**
 * How to abandon the reading in flight, which a newer request does — since 2026-09-24, when the ink
 * moved to a worker and the job in flight became something that can be stopped rather than only
 * disowned when it lands. `maskRequest.ts`' rule is unchanged: an answer for settings the GM has left
 * is not worth waiting for; what is new is that it is no longer waited for at all.
 */
let inFlightControl: AbortController | null = null;

/** Abandon the reading in flight, if there is one, so the request just made starts at once. */
function abandonInFlight(): void {
  inFlightControl?.abort();
}

/**
 * Whether a failure is a job the ink worker abandoned for a newer one — superseded, not failed.
 *
 * **New with the ink worker (2026-09-24).** While the reading ran on the page nothing could ask for
 * another until it finished; off the page a newer request abandons the running job, which rejects with
 * an `AbortError`, and that is an answer to stop waiting for rather than a fault to report.
 */
export function isAbandoned(error: unknown): boolean {
  return (error as { readonly name?: unknown } | null)?.name === "AbortError";
}

/*
  **What a re-read locks, and what waits on the ink** — both new with the ink worker (2026-09-24).

  While the reading and the recompose blocked the page, nothing could be pressed until the new ink had
  landed and its derive had started. Off the page two things can arrive in between, and each needs
  telling apart from what the page used to guarantee:

  - **Fill gaps and Suppress marks** search the reading's base ink with the current paint composed onto it,
    so a *re-read* — a reading or filter slider released, which blanks the ink until the new base lands
    — would leave them searching the base being replaced. They lock for that long (user, 2026-09-24:
    *"lock them"*), as the wall tools do during a derive. A paint-only recompose does not lock them:
    it cannot change the base, and they already compose the paint in hand themselves.
  - **A push** commits the walls of the last derive that landed, and a derive starts only once the ink
    it is made from has landed — so *Update scene* pressed straight after an ink slider would find no
    derive to wait for and push the walls of the settings just left. `inkSettled` is what it waits on
    first.
*/
const inkListeners: (() => void)[] = [];
const settledWaiters: (() => void)[] = [];

/** Told when a re-read starts or ends. */
export function onInkChange(listener: () => void): void {
  inkListeners.push(listener);
}

function tellInkChange(): void {
  for (const listener of inkListeners) listener();
}

/** The ink is blank and new ink is on its way — a reading or filter change not yet landed. */
export function inkBeingReread(): boolean {
  return requests.waiting();
}

/** Anything asked of the ink and not yet on screen: running, or owed a run. */
export function inkOwed(): boolean {
  return inFlight || requests.waiting() || recomposeWanted;
}

/**
 * Resolves once no reading is running or owed, so the ink on screen is the ink the settings and the
 * paint now make — and any derive that ink sets off has been asked for.
 *
 * **During a close only what is running is waited for**: the cycle starts nothing new then, so an owed
 * run would never come, and the close routes owed ink into its derive instead (`workspace.ts`).
 */
export function inkSettled(): Promise<void> {
  if (inkIdle()) return Promise.resolve();
  return new Promise((resolve) => settledWaiters.push(resolve));
}

function inkIdle(): boolean {
  return !inFlight && (isClosing() || (!requests.waiting() && !recomposeWanted));
}

function settleIfIdle(): void {
  if (!inkIdle()) return;
  for (const resolve of settledWaiters.splice(0)) resolve();
}

/** The last reading's headline figures, so the two paths that report them cannot word it differently. */
let lastInkShare: number | null = null;

/*
  The gap counts were here, and they went with the search (2026-09-05).

  A reading no longer finds gaps — the search is a tool inside Add ink, run when the GM asks — so
  there is nothing here to count. That is a real loss and worth naming: this line reported a total on
  every recompose, which is how a gap on a part of the map nobody was looking at got mentioned at
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
  tellInkChange();
  abandonInFlight();
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
 * **Nothing on screen lags this any more.** There was one thing that did — the gap rings, found on
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
  abandonInFlight();
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

  // The share of ink goes to the log only (text rules, 2026-09-29): the picture is the result, and
  // a percentage is a number nobody acts on.
  lastInkShare = shareOfInk(result.mask);
  unsay(READING);
  return true;
}

/** The one working message a reading puts up, so the landing can take down exactly that. */
const READING = "Reading the map…";

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
 * **Nothing queues.** A request made while one is in flight bumps the generation and abandons the
 * one in flight, which lands here as an `AbortError`; this then runs again for whatever is current.
 * A reply that lands anyway is checked against the latest stamp and dropped if it has been
 * superseded. A queue would work through every intermediate position of a drag to reach somewhere
 * the GM left seconds ago.
 */
async function refreshMask(): Promise<void> {
  if (inFlight || isClosing()) return;
  const control = new AbortController();
  inFlightControl = control;

  // Whatever is outstanding, not a new stamp: the caller already registered the change, and asking
  // again here would blank the sheet a second time for the same edit.
  const generation = requests.latest();
  // Cleared here rather than in `requestRecompose`, so a request that arrives while one is in flight
  // survives the early return above and is picked up by the retry below.
  recomposeWanted = false;
  inFlight = true;
  invalidate();
  say(READING, "working");

  // No copy. `Settings` is readonly through and through and `setSettings` replaces the whole object
  // rather than writing into it, so the reference taken here is already a snapshot of what was
  // current when the request went out. This used to be a shallow spread, which defended against
  // nothing that happens and implied a guard it could not give anyway — `trace`, `review` and
  // `overlay` would have stayed shared references.
  const wanted = { settings: currentSettings(), paint: currentPaint() };
  try {
    const outcome = await whileWorking(() => maskForOverlay(wanted, control.signal));
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

    // The mask on screen is now for these reading-stage settings.
    markApplied("read");
    if (!publish(result, generation)) return;

    devLog(
      "info",
      `workspace: mask ${generation} painted for "${result.mapName}" — ` +
        `${result.mask.width}x${result.mask.height}, ink ${((lastInkShare ?? 0) * 100).toFixed(1)}%, ` +
        `${describeReuse(result)}`,
    );
  } catch (error) {
    if (isAbandoned(error)) {
      /*
        A newer job took the worker — this cycle's next run, or a derive resolving newer ink. Run again
        for whatever is current: a re-read's generation is still owed and would retry anyway, but a
        recompose was fulfilled when it was asked for, so without this the composite on screen would
        stay the one from before the paint changed.
      */
      devLog("info", `workspace: mask ${generation} abandoned mid-read for a newer one`);
      recomposeWanted = true;
    } else if (requests.fail(generation)) {
      const detail = describeError(error);
      say(`Reading failed: ${detail}.`, "bad");
      devLog("error", "workspace: reading the map failed", detail);
      console.error("Fog Nudger — workspace could not read the map", error);
    }
  } finally {
    inFlight = false;
    if (inFlightControl === control) inFlightControl = null;
    invalidate();
    // Anything that arrived while this was running is now the current generation, and nothing has
    // been computed for it. Run again rather than leaving the sheet blank with no work in flight —
    // or, for a recompose, showing ink composed from paint that has since been replaced.
    if (!isClosing() && (requests.waiting() || recomposeWanted)) void refreshMask();
    else settleIfIdle();
    tellInkChange();
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
    ? "No map chosen."
    : // Matches `runTrace`'s wording for the same failure. The detail is in the console, which the
      // text rules keep out of what a GM reads.
      `Could not read "${outcome.mapName}".`;
}

/**
 * Read the nominated map now. Returns the outcome, because the map name and bounds come with it.
 *
 * **Asked again if a newer request abandons it**, with whatever is current then. Opening takes a
 * second or two off the page, and a slider moved in that time starts a reading of its own; the open
 * must not fail for having been overtaken, and the retry resolves the same ink as the newer request,
 * so the two share one job.
 */
export async function takeReading(): Promise<MaskOutcome> {
  for (;;) {
    try {
      return await maskForOverlay({ settings: currentSettings(), paint: currentPaint() });
    } catch (error) {
      if (!isAbandoned(error)) throw error;
    }
  }
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
