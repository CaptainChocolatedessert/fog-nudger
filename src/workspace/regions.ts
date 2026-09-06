/**
 * The partition: running the deriving stage, and deciding when it is worth running.
 *
 * ## Why this is not the reading cycle again
 *
 * It has the same shape — ask, blank, publish, drop a superseded answer — but a different rule about
 * *when*. A reading is what every stage-one step is looking at, so it runs whenever a stage-one
 * control moves. The partition is looked at in two steps — Walls, with the centrelines over it, and
 * Edit walls, with the frozen graph over it — and deriving it costs the better part of a second on
 * top of a cached mask. So it runs
 * **lazily**: on entering one of those steps, and on a change while one is open. Anywhere else, a
 * change only marks it stale.
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
 *
 * ## Two sources, one partition — and the second is not a second implementation
 *
 * In stage two the map is no longer what the rooms are made of: the frozen graph is, and the reading
 * that produced it has been closed. So the partition comes from walking that graph instead, which is
 * a different *input* rather than a parallel chain — the traversal is the one place faces are
 * derived from a frozen graph, exactly as `runTrace` is the one place they are derived from a map.
 * Getting this wrong is not cosmetic: drawing the traced partition in stage two would show the GM
 * the rooms **before** their edits, which is the one thing this surface exists to prevent.
 *
 * It is also cheap enough to be synchronous — no reading, no thinning, no fitting, just a walk of a
 * graph already in hand — so the laziness below is stage one's concern and costs stage two nothing.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import type { Ring } from "../geometry/ring";
import { lastPixelsPerSquare, runTrace } from "../pipeline";
import type { StepId } from "../steps";
import { buildFrozenFaces, describeFrozenFaces, wallSegments } from "../trace/frozenFaces";
import { wallRuns, type FrozenGraph } from "../trace/frozenGraph";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { currentPaint } from "./paintState";
import { onReading } from "./reading";
import { currentSettings } from "./settingsState";
import { invalidate, isClosing, say } from "./shell";
import { frozenGraph } from "./stage";

/**
 * The least a partition painter needs, so the two stages can supply it from different shapes.
 *
 * `TracedRegion` and `TracedWall` satisfy these already; the frozen traversal's faces are converted
 * to them. Widening the accessors rather than converting the frozen faces *into* a `TracedRegion`
 * is the honest direction: a frozen face has no raster rings, no placement and no grid area, and
 * inventing those fields would be claiming it came from a trace.
 */
export interface PreviewRegion {
  readonly rings: readonly Ring[];
}

export interface PreviewWall {
  readonly points: readonly Vector2[];
}

const requests = new MaskRequests();
let inFlight = false;
let regions: readonly PreviewRegion[] = [];
/** The walls that emit as lines rather than as part of a ring. Drawn with them, or the preview
 * would show fewer walls than the push writes. */
let walls: readonly PreviewWall[] = [];
/**
 * The space the rings are in, which is what the painter scales by.
 *
 * Stage one's is the trace's raster in pixels. **Stage two's is 1×1**, because a frozen graph is
 * stored in fractions of the map's own extent — so the same multiplication puts both over the map
 * with no branch in the painter and no second scale to keep consistent.
 */
let raster: { readonly width: number; readonly height: number } | null = null;
/**
 * Ring units in one grid square, or zero when there is no way to know.
 *
 * The *conversion* rather than the width: the outline setting is a display parameter and the painter
 * reads it live, so storing the product here would leave the outline stale until the next derive.
 * What changes with the stage is only the unit, and that is what this carries.
 *
 * **In stage two it is always zero, and that is a stated cost rather than an oversight.** The
 * setting is denominated in grid squares; converting it needs a pixels-per-square measurement that
 * only a trace produces, and a GM who reopens a room already in stage two has never run one.
 * Honouring it only when a trace happens to have run this session would be an invisible divergence,
 * which is worse than not at all — so in stage two the outline is drawn at its screen-pixel floor.
 * The fills and the shapes, which are what the step is for, are unaffected.
 */
let unitsPerSquare = 0;

/**
 * Whether the partition in hand is for the settings now applied.
 *
 * Starts stale rather than absent, which is the state a workspace opens in: no partition has been
 * derived, and one is owed the moment anybody looks.
 */
let stale = true;

/** Whether the step that shows the partition is the one open. */
let watching = false;

export function currentWalls(): readonly PreviewWall[] {
  return walls;
}

export function currentRegions(): readonly PreviewRegion[] {
  return regions;
}

export function currentRaster(): { readonly width: number; readonly height: number } | null {
  return raster;
}

/** Ring units in one grid square; zero means the painter's screen-pixel floor decides. */
export function outlineUnitsPerSquare(): number {
  return unitsPerSquare;
}

/** Whether a partition current for the applied settings exists, which is what the painter checks. */
export function regionsShowing(): boolean {
  return shouldPaint(requests.current());
}

/** The last figures, for the state line. */
let lastSummary = "";
/** Whether that summary is bad news, so re-saying it keeps its tone. */
let lastSummaryOk = true;

/**
 * The frozen partition's room count and whether its arithmetic check held, or `null` in stage one.
 *
 * Exposed because the freeze needs it and cannot compute it: the traversal runs *inside* the stage
 * change the freeze triggers, so by the time the freeze has a graph the answer already exists.
 *
 * **This is here because a room found the check reporting into a channel nobody could see**
 * (2026-09-05). The traversal said EULER FAILED on every run and the freeze's own message, written
 * a moment later, overwrote it — so the one warning stage two has went unread for a day. A check
 * that fires where nothing shows it is the §8 failure in its purest form.
 */
export function partitionCheck(): { readonly rooms: number; readonly ok: boolean } | null {
  return frozenCheck;
}

let frozenCheck: { readonly rooms: number; readonly ok: boolean } | null = null;

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

/**
 * Which of the steps that draw the partition are open.
 *
 * A set rather than a flag because **two** steps draw it now — Walls and Edit walls, which is what
 * dissolving the Regions step means: the partition is drawn wherever a graph is drawn. The accordion is exclusive so only one can be open, but every listener is told on
 * every change, one true and the rest false, and the order they are told in is not ours to depend
 * on. A flag would be set by one listener and cleared by the other.
 */
const lookers = new Set<StepId>();

/** Called when a step opens or closes, so entering a step that draws it is what pays for it. */
export function watchRegions(step: StepId, open: boolean): void {
  if (open) lookers.add(step);
  else lookers.delete(step);
  watching = lookers.size > 0;
  if (!watching) return;
  if (stale) {
    void derive();
    return;
  }
  /*
    Nothing to recompute, so say what is already on screen.

    Without this, entering a step whose partition is current says nothing at all, and the figures
    that describe what the GM is looking at are only ever visible in the instant they were derived.
    A room asked for the room count and there was no way to get it back.
  */
  if (lastSummary !== "") say(lastSummary, lastSummaryOk ? "" : "bad");
}

async function derive(): Promise<void> {
  if (inFlight || isClosing()) return;

  // Stage two: the rooms are made of the frozen graph, not of the map. Walking it needs no reading
  // and no fitting, so it happens here and now rather than through the async cycle below.
  const graph = frozenGraph();
  if (graph) {
    deriveFrozen(graph);
    return;
  }

  // Whatever is outstanding rather than a new stamp, for the reason the reading gives: the caller
  // registered the change, and asking again here would blank a second time for the same edit.
  const generation = requests.latest();
  inFlight = true;
  invalidate();
  say("deriving the regions…", "working");

  /*
    No copy. `Settings` is readonly through and through and `setSettings` replaces the whole object
    rather than writing into it, so the reference taken here is already a snapshot of what was
    current when the request went out. This used to be a shallow spread, which defended against
    nothing that happens and implied a guard it could not give anyway — `trace`, `review` and
    `overlay` would have stayed shared references.

    The paint is taken at the same moment and for the same reason. Both are the durable inputs, and
    a partition derived from this instant's settings and some later instant's paint would be a
    picture neither of them describes.
  */
  const wanted = { settings: currentSettings(), paint: currentPaint() };
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
    // Rings are in raster pixels here, so a grid square is however many pixels the run measured.
    unitsPerSquare = lastPixelsPerSquare() ?? 0;
    frozenCheck = null;
    stale = false;
    // The wall count belongs here as much as the region count: they are staged together, and when
    // the lines were being drawn invisibly there was nothing on this surface that could say so.
    const segments = walls.reduce((total, wall) => total + Math.max(0, wall.points.length - 1), 0);
    lastSummary =
      `${regions.length} region${regions.length === 1 ? "" : "s"}` +
      (walls.length === 0
        ? " · no separate walls"
        : ` · ${walls.length} wall${walls.length === 1 ? "" : "s"} in ${segments} segments`);
    lastSummaryOk = true;
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
 * The partition in stage two: the faces of the frozen graph, walked here and now.
 *
 * Synchronous, and it goes through the same request cycle anyway. That is not ceremony — the cycle
 * is what `regionsShowing` reads, so skipping it would leave the painter drawing whatever it held
 * before while a blank was owed. Cheap enough that the blank is never seen, which is the point.
 *
 * **The walls are the traversal's own answer**, not a guess: an edge no emitted ring covers is what
 * the bridge criterion returns, and it is the same criterion the emit path uses. Drawing fewer walls
 * here than a push would write is the one failure this surface exists to prevent.
 */
function deriveFrozen(graph: FrozenGraph): void {
  const generation = requests.latest();
  const result = buildFrozenFaces(graph);
  if (!requests.fulfil(generation)) return;

  regions = result.faces.map((face) => ({ rings: face.rings }));
  walls = wallSegments(graph, result).map((points) => ({ points }));
  // Fractions of the map, so one unit is the whole map and the painter's scale needs no branch.
  raster = { width: 1, height: 1 };
  unitsPerSquare = 0;
  stale = false;

  const rooms = `${regions.length} room${regions.length === 1 ? "" : "s"}`;
  const points = graph.nodes.length;
  frozenCheck = { rooms: regions.length, ok: result.eulerHolds };
  lastSummary =
    `${rooms} · ${wallRuns(graph).length} walls in ${graph.edges.length} segments · ${points} points` +
    (result.eulerHolds ? "" : " · CHECK FAILED, see the log");
  lastSummaryOk = result.eulerHolds;
  say(lastSummary, result.eulerHolds ? "" : "bad");
  devLog("info", `workspace: frozen partition — ${describeFrozenFaces(result)}`);
  invalidate();
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
