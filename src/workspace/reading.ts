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
import { maskForOverlay, type MaskForOverlay } from "../pipeline";
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
/** How many breaks the last reading found, and how many of them it repaired. */
let gapTotal = 0;
let gapFilled = 0;

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
  gapTotal = result.gaps.marks.length;
  gapFilled = result.gaps.filled;
  sayReading();
  return true;
}

function sayReading(): void {
  if (lastInkShare === null) return;
  const ink = `ink ${(lastInkShare * 100).toFixed(1)}%${lastReused ? " (cached)" : ""}`;
  if (gapTotal === 0) {
    sayIfSettled(ink);
    return;
  }
  /*
    Reported in the neutral tone, not as an error.

    A found break is a finding rather than a fault — most maps will have a few, and a status line
    that is permanently red is a status line nobody reads, which is the failure §8 is about. The
    rings are the channel that has to be noticed; this is the count that tells a GM whether the
    ones they can see are all of them.

    The count is deliberately not offered as a tally of distinct faults. Channels merge as the
    repair width grows, so it moves around for reasons that have nothing to do with the map getting
    better or worse — which is the fact that collapsed the two-slider design.
  */
  // `gapTotal` is every mark and `gapFilled` is the subset repaired, so the counts have to be named
  // separately when they differ. This read "5 breaks repaired, 2 not examined" for five found and
  // three repaired — stating five repaired, and implying a total of seven.
  const found = gapTotal === 1 ? "1 break" : `${gapTotal} breaks`;
  const unrepaired = gapTotal - gapFilled;
  sayIfSettled(
    unrepaired > 0
      ? `${ink} · ${found}, ${gapFilled} repaired, ${unrepaired} not examined`
      : `${ink} · ${found} repaired`,
  );
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
  inFlight = true;
  invalidate();
  say("reading the map…", "working");

  const wanted = { ...currentSettings() };
  try {
    const result = await maskForOverlay(wanted);
    if (isClosing()) return;

    if (!result) {
      if (requests.fail(generation)) say("no map chosen — pick one under Map", "bad");
      return;
    }

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
        `${gapTotal} breaks of which ${gapFilled} repaired, ${describeReuse(result)}`,
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
    // been computed for it. Run again rather than leaving the sheet blank with no work in flight.
    if (!isClosing() && requests.waiting()) void refreshMask();
  }
}

/** Read the nominated map now. Returns the result, because the map name and bounds come with it. */
export async function takeReading(): Promise<MaskForOverlay | null> {
  return maskForOverlay(currentSettings());
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
        `ink ${((lastInkShare ?? 0) * 100).toFixed(1)}%, ${gapTotal} breaks of which ${gapFilled} repaired, ` +
        `${result.reused ? "reused from cache" : "recomputed"}`,
    );
  }
  invalidate();
}
