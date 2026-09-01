/**
 * The partition: running the deriving stage, and deciding when it is worth running.
 *
 * ## Why this is not the reading cycle again
 *
 * It has the same shape — ask, blank, publish, drop a superseded answer — but a different rule about
 * *when*. A reading is what every stage-one step is looking at, so it runs whenever a stage-one
 * control moves. The partition is looked at in exactly one step, and deriving it costs the better
 * part of a second on top of a cached mask. So it runs **lazily**: on entering the Regions step, and
 * on a change while that step is open. Anywhere else, a change only marks it stale.
 *
 * That is the cascade the three stages already declare, spent rather than merely described: reading
 * destroys deriving, so a new mask invalidates this — but invalidating is free and recomputing is
 * not, and nobody is looking.
 *
 * ## One implementation, again
 *
 * It calls `runTrace`, the same function the emit path calls, with the settings the GM is looking at
 * rather than the ones metadata has caught up to. A second, lighter "just for the preview" chain is
 * exactly the duplication that made the sibling's harness and its rooms disagree in direction.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { runTrace, type TracedRegion, type TracedWall } from "../pipeline";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { onReading } from "./reading";
import { currentSettings } from "./settingsState";
import { invalidate, isClosing, say } from "./shell";

const requests = new MaskRequests();
let inFlight = false;
let regions: readonly TracedRegion[] = [];
/** The walls that emit as lines rather than as part of a ring. Drawn with them, or the preview
 * would show fewer walls than the push writes. */
let walls: readonly TracedWall[] = [];
/** The raster the rings are in, which is what the painter scales by. */
let raster: { readonly width: number; readonly height: number } | null = null;

/**
 * Whether the partition in hand is for the settings now applied.
 *
 * Starts stale rather than absent, which is the state a workspace opens in: no partition has been
 * derived, and one is owed the moment anybody looks.
 */
let stale = true;

/** Whether the step that shows the partition is the one open. */
let watching = false;

export function currentWalls(): readonly TracedWall[] {
  return walls;
}

export function currentRegions(): readonly TracedRegion[] {
  return regions;
}

export function currentRaster(): { readonly width: number; readonly height: number } | null {
  return raster;
}

/** Whether a partition current for the applied settings exists, which is what the painter checks. */
export function regionsShowing(): boolean {
  return shouldPaint(requests.current());
}

/** The last figures, for the state line. */
let lastSummary = "";

/**
 * Mark the partition out of date, and rebuild it if anyone is looking.
 *
 * The two callers are the two things that invalidate it: a new reading, because the mask is what the
 * partition is made of, and a deriving parameter, because it decides what is made of the mask.
 */
export function invalidateRegions(): void {
  stale = true;
  requests.request();
  invalidate();
  if (watching) void derive();
}

/** Called when a step opens or closes, so entering the Regions step is what pays for it. */
export function watchRegions(open: boolean): void {
  watching = open;
  if (open && stale) void derive();
}

async function derive(): Promise<void> {
  if (inFlight || isClosing()) return;

  // Whatever is outstanding rather than a new stamp, for the reason the reading gives: the caller
  // registered the change, and asking again here would blank a second time for the same edit.
  const generation = requests.latest();
  inFlight = true;
  invalidate();
  say("deriving the regions…", "working");

  // No copy. `Settings` is readonly through and through and `setSettings` replaces the whole object
  // rather than writing into it, so the reference taken here is already a snapshot of what was
  // current when the request went out. This used to be a shallow spread, which defended against
  // nothing that happens and implied a guard it could not give anyway — `trace`, `review` and
  // `overlay` would have stayed shared references.
  const wanted = currentSettings();
  try {
    const outcome = await runTrace(wanted);
    if (isClosing()) return;

    if (!outcome.ok) {
      if (requests.fail(generation)) say(outcome.message, "bad");
      return;
    }

    if (!requests.fulfil(generation)) {
      devLog("info", `workspace: partition ${generation} superseded before it landed`);
      return;
    }

    regions = outcome.run.regions;
    walls = outcome.run.walls;
    raster = outcome.run.raster;
    stale = false;
    // The wall count belongs here as much as the region count: they are staged together, and when
    // the lines were being drawn invisibly there was nothing on this surface that could say so.
    const segments = walls.reduce((total, wall) => total + Math.max(0, wall.points.length - 1), 0);
    lastSummary =
      `${regions.length} region${regions.length === 1 ? "" : "s"}` +
      (walls.length === 0
        ? " · no separate walls"
        : ` · ${walls.length} wall${walls.length === 1 ? "" : "s"} in ${segments} segments`);
    say(lastSummary);
    devLog("info", `workspace: partition ${generation} — ${outcome.run.summary}`);
  } catch (error) {
    if (requests.fail(generation)) {
      const detail = describeError(error);
      say(`deriving failed: ${detail}`, "bad");
      devLog("error", "workspace: deriving the regions failed", detail);
      console.error("Fog Nudger — workspace could not derive the regions", error);
    }
  } finally {
    inFlight = false;
    invalidate();
    if (!isClosing() && watching && requests.waiting()) void derive();
  }
}

/**
 * A new reading is a new partition, whether or not anyone asks for it now.
 *
 * Registered as a reading listener rather than called from the ink controls, so that *every* route
 * to a new mask invalidates this — including the one that opens the workspace, and including
 * whatever route the next step adds.
 */
export function registerRegionInvalidation(): void {
  onReading(() => {
    stale = true;
    requests.request();
    if (watching) void derive();
  });
}
