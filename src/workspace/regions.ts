/**
 * The partition: running the deriving stage, and deciding when it is worth running.
 *
 * ## Why this is not the reading cycle again
 *
 * It has the same shape — ask, blank, publish, drop a superseded answer — but a different rule about
 * *when*. A reading is what every stage-one step is looking at, so it runs whenever a stage-one
 * control moves. The partition is looked at in two steps — Walls, with the centrelines over it, and
 * Edit walls, with the wall graph over it — and deriving it costs the better part of a second on
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
 * ## Two inputs, ONE derivation — which it was not until 2026-09-06
 *
 * Both modes walk a wall graph. What differs is where the graph came from: the editor reads the
 * stored one, and the ink mode derives the trace's own and walks that. The faces themselves come
 * from `buildWallFaces` either way, which is the same function the push uses.
 *
 * **It used to draw a region list the trace derived from a raster labelling, and that was a defect.**
 * A push writes faces grouped by containment off the wall graph — same walk, different
 * grouping — so the ink mode previewed one answer and emitted another. Nothing inside the code said
 * the two were meant to agree, which is why it took an outside eye to spot.
 *
 * **Do not reintroduce a second source for the partition here**; what the trace is for is the graph,
 * the fitted edges and the checks over them.
 *
 * The mode still decides which graph, and getting *that* wrong is not cosmetic either: reading the
 * stored graph in the ink mode would show the GM the rooms as **edited** while they moved sliders
 * that do not produce them, and walking the trace's in the editor would show them the rooms before
 * their edits.
 *
 * The walk is cheap enough to be synchronous — no reading, no thinning, no fitting — so it costs
 * the editor nothing, and in the ink mode it is a rounding error beside the trace it follows.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import type { Ring } from "../geometry/ring";
import { lastPixelsPerSquare, runTrace } from "../pipeline";
import type { StepId } from "../steps";
import { buildWallFaces, describeWallFaces, wallSegments } from "../trace/wallFaces";
import {
  pruneWallGraph,
  wallRuns,
  type WallGraph,
} from "../trace/wallGraph";
import { noteGraph } from "./graphScale";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { currentPaint } from "./paintState";
import { onReading } from "./reading";
import { currentSettings, markApplied } from "./settingsState";
import { invalidate, isClosing, say, whileWorking } from "./shell";
import { handEdits, wallGraph } from "./stage";

/**
 * The least a partition painter needs, so the two stages can supply it from different shapes.
 *
 * Deliberately the *least*: rings for a region, points for a wall, and nothing else. The trace used
 * to hand over richer shapes carrying raster rings, world placement and a grid area, and the painter
 * was written against those — so when faces started coming from the wall graph instead, the honest
 * direction was to narrow what the painter asks for rather than to invent those fields on a face
 * that has none of them. Inventing them would have been claiming it came from a trace.
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
 * **Always 1×1 now**, in both modes, because both draw a wall graph and a wall graph is stored
 * in fractions of the map's own extent. Kept as a field rather than folded into the painter because
 * it is the painter's contract — the rings are in *some* space and this says which — and because a
 * third source would arrive needing to say so.
 */
let raster: { readonly width: number; readonly height: number } | null = null;
/**
 * Ring units in one grid square, or zero when there is no way to know.
 *
 * The *conversion* rather than the width: the outline setting is a display parameter and the painter
 * reads it live, so storing the product here would leave the outline stale until the next derive.
 * What changes with the stage is only the unit, and that is what this carries.
 *
 * **In the editor it is always zero, and that is a stated cost rather than an oversight.** The
 * setting is denominated in grid squares; converting it needs a pixels-per-square measurement that
 * only a trace produces, and a GM who opens the editor has not run one. Honouring it only when a
 * trace happens to have run this session would be an invisible divergence, which is worse than not
 * at all — so there the outline is drawn at its screen-pixel floor. The fills and the shapes, which
 * are what the step is for, are unaffected.
 *
 * **In the ink mode it is not zero**, because a trace has just run and the rings are fractions of the
 * same map that trace divided by.
 */
let unitsPerSquare = 0;

/**
 * The graph the last derive arrived at, in the form saving would store it.
 *
 * **The ink mode's last step draws this** (user, 2026-09-05): *"the last step of the ink mode
 * displays the graph, post simplification."* Built with `buildWallGraph`, the same function the save
 * uses, so the picture and the document are the same thing rather than two renderings of one idea —
 * which is what makes handing off to the editor a continuation rather than a surprise.
 *
 * It is also where the dropped-segment counts come from. Simplification can collapse a room thinner
 * than its tolerance into a doubled wall, and the derivation drops what is left; reporting that here
 * puts the warning in front of the GM while the slider that caused it is still on screen.
 *
 * `null` in the editor, where the stored graph is the document and nothing derives one.
 */
let preview: WallGraph | null = null;
let previewDropped = 0;

/** The graph the last derive arrived at, or `null` when none has run. */
export function previewGraph(): WallGraph | null {
  return preview;
}

/**
 * Whether what is on screen is the **saved** graph rather than a fresh derivation.
 *
 * The one predicate, read by the partition here and by the layer that draws the walls, because the
 * two disagreeing is a defect this project has already paid for: the ink mode once previewed one
 * face derivation and emitted another, and nothing inside the code said they were meant to match.
 *
 * Two ways to be looking at the saved one. **It carries hand edits**, in which case a derivation is
 * not what the GM has — re-deriving would replace their work and is what the reading controls now
 * ask about. Or **nothing has been derived yet**, which is how the surface opens on a map that has
 * been through it before: show the walls that are there rather than a blank canvas or an unrequested
 * trace.
 *
 * Otherwise the derivation wins, which is what keeps tuning the ink meaningful — the rooms change as
 * the threshold moves, which is where a merge is actually visible.
 */
export function showingSaved(): boolean {
  return wallGraph() !== null && (handEdits() > 0 || !derivation);
}

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

/*
  `partitionCheck` was here, and it is gone with the thing that needed it.

  It handed the wall graph traversal's room count and Euler verdict to the derivation, because **a room found
  that check reporting into a channel nobody could see** (2026-09-05): the traversal said EULER
  FAILED on every run and the derivation's own message, written a moment later, painted over it.

  The two-mode split removes the collision rather than the guard. The traversal runs only in the
  editor, where `derivePartition` below says the verdict on its own line and nothing writes over it; the
  save that used to overwrite it lives on the other page and never triggers a traversal. **Do not
  re-introduce a message written on the heels of a derive** — that is the shape of the fault, and it
  is what §8 is about.
*/

/**
 * Mark the partition out of date, and rebuild it if anyone is looking.
 *
 * The two callers are the two things that invalidate it: a new reading, because the mask is what the
 * partition is made of, and a deriving parameter, because it decides what is made of the mask.
 */
export function invalidateRegions(): void {
  stale = true;
  // The trace is out of date, so the derivation's output is too and there is nothing left to re-prune.
  derivation = null;
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

/**
 * What the last trace produced, before pruning — held so a prune needs no second trace.
 *
 * Spur pruning is an operation on the *fitted* graph now (2026-09-06), which means a change to its
 * limit invalidates nothing the trace did. Keeping the derivation's output lets the slider re-apply in
 * a few milliseconds where a re-derive costs the better part of a second on a cached mask, which is
 * the difference between a control a GM sweeps and one they nudge and wait for.
 *
 * Dropped whenever a reading or a deriving parameter changes, because then the trace itself is out
 * of date and there is nothing here worth re-pruning.
 */
let derivation: {
  /** The derivation's own output, unpruned. Pruning always starts from this rather than from itself. */
  readonly graph: WallGraph;
  /** Segments the derivation dropped for lying on one already stored, plus any of no length. */
  readonly dropped: number;
  /** Points the derivation dropped for lying exactly on the line between their neighbours. Lossless. */
  readonly collinear: number;
  /** The trace's raster width, which is what turns a figure in pixels into a map fraction. */
  readonly rasterWidth: number;
  readonly pxPerSquare: number;
} | null = null;

/**
 * Prune, walk, and put the answer on screen.
 *
 * Shared by the trace's completion and by a prune-only change, so the two cannot disagree about what
 * the partition is. Synchronous throughout: the derivation is already done, and pruning plus a traversal
 * is a few milliseconds against the second the trace took.
 */
function publish(from: NonNullable<typeof derivation>, generation: number): void {
  // Both the limit and the graph are in fractions of the map, so there is nothing to convert —
  // which is the point of the unit, and what lets the editor run the same operation.
  const limit = currentSettings().trace.spurPruneFraction;
  const pruned = pruneWallGraph(from.graph, limit);

  preview = pruned.graph;
  previewDropped = from.dropped;
  /*
    Measured from the graph **before** pruning, which is the graph the slider's own limit acts on.

    Handing over the pruned one would make the top the longest spur that *survived* — which is the
    limit itself, so raising the slider would raise the floor of what it measures against and the
    handle would chase the setting. The bottom of these tracks is pinned for the same reason.
  */
  noteGraph(from.graph);

  const faces = buildWallFaces(pruned.graph);
  regions = faces.faces.map((face) => ({ rings: face.rings }));
  walls = wallSegments(pruned.graph, faces).map((points) => ({ points }));
  // Fractions of the map, exactly as in the editor, so the painter needs no branch either.
  raster = { width: 1, height: 1 };
  unitsPerSquare = from.pxPerSquare > 0 ? from.pxPerSquare / from.rasterWidth : 0;
  stale = false;

  /*
    The same figures the editor says, in the same order, because they now describe the same object.

    The dropped count is on the line because it is a room the map has and the document will not:
    smoothing can fit both walls of a very thin room to the same line, closing it up, and the derivation
    drops what that leaves. Saying so here rather than only at the save is the point — the slider
    that caused it is on screen at this moment, and afterwards it is one mode away.

    Euler's identity is on it for a related reason. A doubled wall is exactly what that check fails
    on, and in this mode there are no hand edits to make such a state a legal one to pass through —
    so a failure here means the derivation produced something a traversal cannot mean anything over,
    which is worth a red line rather than a log entry nobody reads.
  */
  const rooms = `${regions.length} region${regions.length === 1 ? "" : "s"}`;
  lastSummary =
    `${rooms} · ${wallRuns(pruned.graph).length} walls in ` +
    `${pruned.graph.edges.length} segments · ${pruned.graph.nodes.length} points` +
    (pruned.removed === 0 ? "" : ` · ${pruned.removed} spurs pruned`) +
    (previewDropped === 0
      ? ""
      : ` · ${previewDropped} wall${previewDropped === 1 ? "" : "s"} dropped — ` +
        "smoothing has closed a thin room up") +
    (faces.eulerHolds ? "" : " · CHECK FAILED, see the log");
  lastSummaryOk = previewDropped === 0 && faces.eulerHolds;
  say(lastSummary, lastSummaryOk ? "" : "bad");
  devLog(
    "info",
    `workspace: partition ${generation} — pruned ${pruned.removed} spurs ` +
      `(${pruned.segments} segments) in ${pruned.rounds} rounds at a limit of ` +
      `${limit.toExponential(2)} of the map; ${from.collinear} points dropped as exactly ` +
      `collinear, which costs nothing; ${describeWallFaces(faces)}`,
  );
  invalidate();
}

/**
 * Re-apply the spur limit without re-deriving anything.
 *
 * The dispatch calls this for a graph-only change. Falls back to a full derive when there is no
 * derivation in hand — which is the state after any reading or deriving change, and after opening
 * the workspace — so the caller never has to know which of the two it is asking for.
 */
export function repruneRegions(): void {
  // Nothing to re-prune against: what is on screen is the stored document, and the limit reaches it
  // through the button in Edit walls rather than by re-deriving.
  if (showingSaved()) return;
  if (!derivation || inFlight) {
    invalidateRegions();
    return;
  }
  if (!watching) {
    // Nobody is looking, so the cheap thing is still too much. Marked owed, like any other change.
    stale = true;
    requests.request();
    invalidate();
    return;
  }
  requests.request();
  publish(derivation, requests.latest());
  requests.fulfil(requests.latest());
}

async function derive(): Promise<void> {
  if (inFlight || isClosing()) return;

  /*
    The **mode** decides where the rooms come from, not the presence of a stored graph.

    That inverted when the surface became two modes (2026-09-05). It used to read "a graph is saved,
    so use it", which was right while one surface carried both stages. Now the editor's rooms are its
    document and the ink mode's rooms are its reading — and reading a stored graph in the ink mode
    would show the GM the rooms as *edited* while they moved the sliders that do not produce them.

    Walking the wall graph needs no reading and no fitting, so it happens here and now rather than
    through the async cycle below.
  */
  if (showingSaved()) {
    const graph = wallGraph();
    if (graph) derivePartition(graph);
    else clearPartition();
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
    const outcome = await whileWorking(() => runTrace(wanted));
    if (isClosing()) return;

    if (!outcome.ok) {
      if (requests.fail(generation)) say(outcome.message, "bad");
      return;
    }

    if (!requests.fulfil(generation)) {
      devLog("info", `workspace: partition ${generation} superseded before it landed`);
      return;
    }

    /*
      The wall graph the run already built, so what is drawn and what would be stored cannot differ.

      Taken off the run rather than rebuilt from `graph` and `fittedEdges`: the trace has to build it
      anyway, because the escalation ladder measures the command cap against its faces. Rebuilding
      here would be a second construction of a thing already in hand, and two constructions are two
      places to change.
    */
    const stored = outcome.run.walls;
    /*
      And the same traversal the push makes, which is the second half of that sentence.

      The trace used to produce rooms of its own, grouped by a raster labelling, and they were what
      this drew. **They were not what a push writes.** Saving stores the wall graph and the push walks
      *that*, grouped by containment with no raster anywhere, so the ink mode previewed one face
      derivation and emitted another — a defect found from the outside, because nothing inside the
      code said the two were meant to agree.

      One derivation now, and the trace no longer carries a region list at all. What it produces is
      the graph, the fitted edges, and the checks over them — a derivation, not a picture.
    */
    /*
      A grid square as a fraction of the map, which the ink mode can answer and the editor cannot.

      The trace measured it in raster pixels and the derivation divided by that raster, so the two cancel.
      The editor has no trace and leaves this at zero, which is the stated cost recorded above; here
      the measurement exists, so the outline setting is honoured rather than drawn at its floor.
    */
    const pxPerSquare = lastPixelsPerSquare() ?? 0;
    const rasterWidth = Math.max(1, outcome.run.raster.width);
    derivation = {
      graph: stored.graph,
      dropped: stored.duplicates + stored.zeroLength,
      collinear: stored.collinear,
      rasterWidth,
      pxPerSquare,
    };
    // The picture now shows these deriving-stage settings, so any row that was marked ahead of it
    // stops being.
    markApplied("derive");
    publish(derivation, generation);
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
 * The partition in stage two: the faces of the wall graph, walked here and now.
 *
 * Synchronous, and it goes through the same request cycle anyway. That is not ceremony — the cycle
 * is what `regionsShowing` reads, so skipping it would leave the painter drawing whatever it held
 * before while a blank was owed. Cheap enough that the blank is never seen, which is the point.
 *
 * **The walls are the traversal's own answer**, not a guess: an edge no emitted ring covers is what
 * the bridge criterion returns, and it is the same criterion the emit path uses. Drawing fewer walls
 * here than a push would write is the one failure this surface exists to prevent.
 */
/**
 * Nothing to draw: the editor opened on a map with no saved graph.
 *
 * Said rather than left blank, because an empty canvas in the one step this mode has is
 * indistinguishable from one that is still working. The step's own body says what to do about it;
 * this is the line that stops the surface looking stuck.
 */
function clearPartition(): void {
  const generation = requests.latest();
  regions = [];
  walls = [];
  raster = { width: 1, height: 1 };
  unitsPerSquare = 0;
  preview = null;
  stale = false;
  noteGraph(null);
  requests.fulfil(generation);
  lastSummary = "no walls saved for this map yet";
  lastSummaryOk = true;
  say(lastSummary);
  invalidate();
}

function derivePartition(graph: WallGraph): void {
  const generation = requests.latest();
  const result = buildWallFaces(graph);
  if (!requests.fulfil(generation)) return;

  regions = result.faces.map((face) => ({ rings: face.rings }));
  walls = wallSegments(graph, result).map((points) => ({ points }));
  noteGraph(graph);
  // Fractions of the map, so one unit is the whole map and the painter's scale needs no branch.
  raster = { width: 1, height: 1 };
  unitsPerSquare = 0;
  preview = null;
  stale = false;

  const rooms = `${regions.length} room${regions.length === 1 ? "" : "s"}`;
  const points = graph.nodes.length;
  lastSummary =
    `${rooms} · ${wallRuns(graph).length} walls in ${graph.edges.length} segments · ${points} points` +
    (result.eulerHolds ? "" : " · CHECK FAILED, see the log");
  lastSummaryOk = result.eulerHolds;
  say(lastSummary, result.eulerHolds ? "" : "bad");
  devLog("info", `workspace: saved partition — ${describeWallFaces(result)}`);
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
    derivation = null;
    requests.request();
    if (watching) void derive();
  });
}
