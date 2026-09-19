/**
 * What a settings change invalidates, and telling whoever needs to know.
 *
 * ## Why this is not part of the row that moved the slider
 *
 * It lived in `settingRows.ts` and was imported from there by the drawer's **Defaults** button,
 * which builds no rows and turns no sliders. That is the tell: the cascade is a property of the
 * *parameter*, not of the control that happened to change it, and two callers reaching a row module
 * to ask "what does this cost" was the old shape showing through.
 *
 * ## It is the one place the three stages are spent
 *
 * `PARAMETER_STAGE` says what a change **destroys**, `PARAMETER_KIND` what it **recomputes**, and
 * this is where those two declarations turn into work. Every write goes through here — a slider's
 * release, a group's Defaults — so the two cannot disagree about what a change costs.
 *
 * DOM only through the invalidations it triggers; the decisions are all read from `settings.ts`.
 */

import {
  PARAMETER_KIND,
  rereadsTheMap,
  type SettingName,
} from "../settings";
import { refreshGapSearch } from "./paintTool";
import { refreshMends } from "./wallEdit";
import { requestReread } from "./reading";
import { invalidateRegions } from "./regions";
import { invalidate } from "./shell";

/**
 * Recompute whatever a set of changed parameters invalidates, and nothing else.
 *
 * Shared by a slider's release and a step's Defaults, so the two cannot disagree about what a change
 * costs. A reading covers the partition as well — the regions subscribe to it — so the two cases are
 * exclusive rather than cumulative.
 */
export function recomputeFor(names: readonly SettingName[]): void {
  /*
    A `tool` parameter recomputes nothing and tells its tool instead.

    That is the whole of the third kind's behaviour on this side. A brush width has no one to tell —
    the next stroke simply reads it — but the gap search is holding a set of marks that the numbers
    it was run with have just stopped describing, and marks on screen that no longer match the
    settings beside them are the stale-diagnostic failure in miniature. Re-running is cheap by
    comparison with a re-read and is what the GM is asking for by moving the slider at all.
  */
  if (names.some((name) => PARAMETER_KIND[name] === "tool")) {
    refreshGapSearch();
    // The mend search likewise, and for the same reason. Each is silent unless its own tool is in hand.
    refreshMends();
  }

  /*
    **Two targets, not three, since 2026-09-18.**

    There was a graph-only branch here — parameters that change the wall graph without changing the ink
    mask, dispatched to a re-prune that cost a run walk and a face traversal rather than a 690ms
    re-read. Its only member was the spur limit, and pruning is an amount a GM presses now rather than
    a parameter, so nothing is left to dispatch. `settings.ts` carries the full note and why both come
    back together if such a parameter ever returns.
  */
  const pipeline = names.filter((name) => PARAMETER_KIND[name] === "pipeline");

  // The same predicate the discard prompt asks, so the two can never disagree about what re-reads.
  if (names.some(rereadsTheMap)) requestReread();
  else if (pipeline.length > 0) invalidateRegions();
  invalidate();
  for (const listener of commitListeners) listener();
}

/**
 * Told whenever a setting has been committed, which is the funnel every write already goes through.
 *
 * **For controls whose availability depends on another control's value.** The three wall actions are
 * disabled while their own limit is at zero, and without this the slider that lifts the limit would
 * leave the button dead until something unrelated happened to redraw the rail — the same defect the
 * tool strip had, where the state changed and nothing was told.
 *
 * Subscribed at module scope and never cleared, so **do not call this from a render function**: a
 * step's body is rebuilt on every accordion click, and a subscription there adds a listener per
 * click.
 */
const commitListeners: (() => void)[] = [];

export function onSettingCommitted(listener: () => void): void {
  commitListeners.push(listener);
}
