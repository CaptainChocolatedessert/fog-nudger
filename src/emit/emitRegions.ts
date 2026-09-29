/**
 * The SDK half — putting traced regions and walls into the scene, and taking them out again.
 *
 * **Push** runs the pipeline, clears what we put there last time, and writes the result onto the
 * `FOG` layer. **Remove** deletes ours and touches nothing else. That is the whole surface: staging,
 * accepting and returning to staging are gone (`DESIGN.md` §4), because the workspace judges a
 * partition without writing anything and the scene is a rendering rather than working state.
 *
 * Everything about *what* an item is lives next door in `fogShapes.ts` and `wallLines.ts`, where it
 * can be tested. What lives here is the part no test in this repository can reach: the calls
 * themselves, and the handling of what Owlbear says back.
 *
 * **That untestable boundary has already bitten once.** Removing staging deleted the promotion step
 * that set the layer and the visibility, and the item builders below were left writing to `DRAWING`
 * while everything around them said fog. It shipped, and a GM found it. The four values an emitted
 * item must carry — layer, visibility, fill opacity, stroke width — are now declared together in
 * `fogShapes.ts` rather than spelled out here, so the next such edit has one place to miss instead
 * of four.
 *
 * ## Throttle and refusal are not the same failure, and this is where that matters
 *
 * A rate limit is temporary and giving up on it loses regions; a validation failure is permanent
 * and retrying it is a hang. They arrive through the same channel and read alike (DESIGN.md §7), so
 * every write here asks which it was before deciding what to do. A refused batch stops the run and
 * says so; a throttled one waits and tries again.
 */

import OBR, { buildLine, buildPath, Command, type Item } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError, isRateLimited } from "../describeError";
import { PathOp, type PathCommandLike } from "../geometry/ring";
import { runTrace } from "../pipeline";
import { readGridDpi, readMapBounds, resolveTraceMap } from "../map/mapImage";
import type { Point } from "../map/placement";
import { readRegionMarks } from "../regionMarksStore";
import { describeWallFaces } from "../trace/wallFaces";
import type { WallGraph } from "../trace/wallGraph";
import { graphExtent } from "../trace/graphUnits";
import { DYNAMIC_FOG_DOORS_KEY } from "./doorRecords";
import { wallEmission } from "./wallEmission";
import {
  ACCEPTED_FILL_OPACITY,
  ACCEPTED_STROKE_WIDTH,
  EMITTED_LAYER,
  EMITTED_VISIBLE,
  planBatches,
  REGION_KEY,
  stageShapes,
  totalCommands,
  type FogShapeSpec,
  type StageableRegion,
} from "./fogShapes";
import {
  ACCEPTED_WALL_STROKE,
  stageWallLines,
  WALL_KEY,
  type WallLineSpec,
} from "./wallLines";

/**
 * Compile-time assertion that the numbers mirrored in `geometry/ring` still match the SDK's enum.
 * That module cannot import the enum — it is a runtime value, and importing it would drag the SDK
 * into a node test and kill it. If Owlbear ever renumbers `Command`, the build breaks here instead
 * of the pipeline silently emitting a path made of the wrong opcodes.
 */
const _pathOpsMatchSdk: [Command.MOVE, Command.LINE, Command.CLOSE] = [
  PathOp.MOVE,
  PathOp.LINE,
  PathOp.CLOSE,
];
void _pathOpsMatchSdk;

/**
 * Batch limits, and both are first guesses to be measured rather than settled numbers.
 *
 * The item count paces writes against the rate limiter; the command count bounds a single call's
 * payload. What the real ceilings are is not known — the sibling measured the *item* cap by
 * bisection and never had cause to find where a write starts being refused for size, because it
 * never wrote a quarter of a million numbers at once. Expect these to move once a real map has been
 * pushed, and change one at a time.
 */
const BATCH_LIMITS = { maxItems: 24, maxCommands: 20_000 } as const;

/** Pause between batches. Deliberately unhurried: this runs once at prep time, not in play. */
const BATCH_PAUSE_MS = 120;

/** Waits between retries of a throttled batch, in milliseconds. Gives up after the last one. */
const RETRY_BACKOFF_MS = [250, 750, 2_000] as const;

/**
 * What the scene last received, so a close straight after an update does not rewrite it all again.
 *
 * The fingerprint `pushAction.ts` builds: the map's id, every setting, the stored walls and their doors,
 * the paint and the crosses. Held in memory, so the safe direction when it is lost is to push again.
 *
 * **It is lost at every opening** (checked 2026-09-29): the workspace is a fresh page each time it opens,
 * so this starts empty and every close pushes — the skip's log line appears nowhere in `dev.log` from
 * 09-18 to 09-29. What it saves is only a close after an *Update scene* in the same opening. It said a
 * look-and-close rewrote nothing, which was never true of this page.
 *
 * **And it is not complete, which is harmless only while it is lost that often**: the map's
 * placement is not in it — only the item's id — and neither is the scene's fog colour, and both
 * change what a push writes. Kept in the scene, it would leave a moved map's fog where it was; the
 * user decided not to keep it (2026-09-29), since opening and closing resetting the doors is
 * consistent with every other in-scene edit.
 */
let lastPushed: string | null = null;

/** Whether pushing now would write anything different from what is already there. */
export function pushWouldChange(fingerprint: string): boolean {
  return lastPushed !== fingerprint;
}

/** Forget what was pushed, so the next close writes whatever the settings now say. */
export function forgetPushed(): void {
  lastPushed = null;
}

/**
 * Whether the GM has asked the write in flight to stop.
 *
 * ## Cooperative, and between batches only
 *
 * A push is a sequence of `addItems` calls, and an in-flight one cannot be aborted — so this is a
 * flag the batch loops read *before starting the next chunk*, not an interruption. "Stopped" always
 * means some shapes were written and the rest were not, and the loops report exactly where they got
 * to.
 *
 * ## Why there is no rollback
 *
 * A push deletes our previous items **before** it writes the replacements, so by the time a write is
 * slow enough to want out of, the old fog is already gone. There is nothing to roll back *to*: undoing
 * the partial write reaches an empty fog layer, which in Owlbear hides the whole map. And undoing is
 * itself more writes through the connection that is already slow, at the moment the GM has said they
 * want out — an escape hatch that can stall is not one.
 *
 * So a stop leaves the partial set and says so. That is not permanent: every item carries our
 * namespace key, and the next push deletes all of ours before writing, so it is cleaned up by the
 * next push rather than needing to be cleaned up now. `forgetPushed()` is called on the way out, so
 * that next push is not skipped by a fingerprint describing a result the scene only partly holds.
 */
let stopRequested = false;

/** Ask the write in flight to stop at the next batch boundary. */
export function requestPushStop(): void {
  stopRequested = true;
}

/**
 * Trace the scene's map and put the result on the fog layer, replacing whatever we put there before.
 *
 * ## One operation, because the scene was never the working state
 *
 * There is no staging layer any more (user, 2026-08-30). Proposals on `DRAWING`, accepting, going
 * back to staging and applying appearance are all gone, and with them the refusal to emit over an
 * existing set — which had been standing in for "step 9's problem", choosing which copy survives.
 * The answer is that there is only ever one copy: the wall graph is the document and the scene is a
 * rendering of it, so a re-run replaces rather than accumulates.
 *
 * What made staging redundant is the workspace. Judging a partition used to require writing a few
 * hundred shapes into the scene and looking; it now costs opening a step. The layer that existed so
 * a first run could not affect play was answering a question nobody has to ask any more.
 *
 * **The trade, stated:** a hand edit to one of our fog items does not survive the next push. That is
 * the point rather than a regression — what you see is the current state — but it does mean the
 * workspace is now the only place to edit, which leans on step G harder than the old design did.
 *
 * ## Old first, then new
 *
 * Ours are deleted before the replacements are written (user, 2026-08-30). The alternative was
 * writing first so the map is never briefly unfogged, and it was rejected on the better argument: a
 * fog layer holding nothing fogs everything, so the gap is safe, while overlapping duplicates of
 * every shape on the map are a state nothing else here is designed for.
 *
 * *If a push is ever seen to flash the map visible, that premise is wrong and inverting the order is
 * the whole of the fix.*
 */
/**
 * What a push is made of, from whichever of the two sources produced it.
 *
 * **Stage two has to emit the GM's graph, not the map** — the whole point of saving a graph is that the
 * map stops being what the rooms are made of. So the *source* varies and nothing downstream does:
 * the deletion order, the batching, the provenance, the rate limiting and the stop are the same
 * apparatus either way, and they are where this file's hard-won behaviour lives.
 *
 * The caller passes the graph rather than this file asking which stage it is in. The emit path has
 * no business knowing about a workspace's stage holder, and a push driven from the panel would have
 * no way to answer.
 */
interface PushSource {
  readonly mapId: string;
  readonly regions: readonly StageableRegion[];
  readonly walls: readonly { readonly edge: number; readonly points: readonly Point[] }[];
  /** One line for the log, saying which source produced this and what it found. */
  readonly note: string;
}

async function wallGraphSource(graph: WallGraph): Promise<PushSource | string> {
  const map = await resolveTraceMap();
  if (!map) return "No map chosen.";
  const [bounds, dpi] = await Promise.all([readMapBounds(map), readGridDpi()]);
  // The image's own pixel size, which is what graph units are defined against — not the world box,
  // which a GM may have stretched out of proportion. The trace takes the same figure from the decoded
  // image, so the two sides agree on what one unit is.
  const extent = graphExtent(map.image.width, map.image.height);
  /*
    Read from the scene rather than handed in, because a push has two sources and only one of them
    has a workspace behind it — the same reason the trace reads the paint layers for itself. A mark
    is written the moment it is placed, so the store is never behind what the GM sees.
  */
  const { marks, corrupt } = await readRegionMarks(map.id);
  if (corrupt) devLog("warn", "emit: the suppression marks could not be read, so nothing is suppressed");
  const emission = wallEmission(graph, bounds, dpi, extent, marks);

  const check = emission.faces.eulerHolds
    ? "check holds"
    : "CHECK FAILED — the graph is not a valid embedding, see the lines above";
  if (!emission.faces.eulerHolds) devLog("warn", `emit: ${describeWallFaces(emission.faces)}`);

  return {
    mapId: map.id,
    regions: emission.regions,
    walls: emission.walls,
    /*
      The check stays here and nowhere a GM reads (text rules, 2026-09-29). It said which source the
      push came from and whether Euler's identity held, and a GM can act on neither: the identity
      fails legitimately on two walls lying along each other, and otherwise only on a fault of ours,
      which the region fills already show. What is wanted instead is that the doubled-wall case
      cannot arise at all — DESIGN.md §10's resume point carries it.
    */
    note:
      `emit: from the wall graph — ${emission.regions.length} rooms, ` +
      `${emission.suppressed} suppressed, ${emission.walls.length} wall lines, ` +
      `${emission.doors.placed} doors, ${check}` +
      // Every door's wall goes out on some item, so this should never print. Said if it does.
      (emission.doors.unplaced > 0 ? ` — ${emission.doors.unplaced} DOORS ON NO ITEM` : ""),
  };
}

export async function pushToFog(
  fingerprint?: string,
  /** The GM's edited graph. Present in stage two, and it replaces the trace as the source. */
  saved?: WallGraph,
): Promise<string> {
  // Cleared here rather than by the caller: a stop belongs to one push, and a request that arrived
  // while nothing was running must not silently abort the next one.
  stopRequested = false;
  if (!(await OBR.scene.isReady())) return "No scene open.";

  let source: PushSource;
  if (saved) {
    const built = await wallGraphSource(saved);
    if (typeof built === "string") return built;
    source = built;
  } else {
    /*
      Nothing saved for this map, so the trace's own wall graph is what gets emitted.

      This branch used to emit a region list the trace derived from a raster labelling, which made it
      the last consumer of that face build — and a second answer to a question the wall graph
      traversal already answers. Same walk, different grouping.

      **The graph is taken off the run rather than rebuilt here.** `runTrace` has to build it anyway,
      because the escalation ladder measures the command cap against the faces of it, so rebuilding
      would be a second construction of a thing already in hand — and the one way two constructions
      can ever disagree is if somebody changes one of them.
    */
    const outcome = await runTrace();
    if (!outcome.ok) return outcome.message;
    const built = await wallGraphSource(outcome.run.walls.graph);
    if (typeof built === "string") return built;
    source = built;
  }
  devLog("info", source.note);

  const runId = new Date().toISOString();
  const { shapes, skipped } = stageShapes(source.regions, {
    run: runId,
    mapId: source.mapId,
    // The values an emitted shape must carry, not a review preference. Full opacity or revealed
    // ground keeps a tint of the fog colour; no outline or Dynamic Fog offsets its walls by half of
    // one either side of the boundary. Both are explained where they are declared.
    fillOpacity: ACCEPTED_FILL_OPACITY,
    strokeWidth: ACCEPTED_STROKE_WIDTH,
  });

  if (skipped.length > 0) {
    devLog(
      "warn",
      `emit: skipped ${skipped.length} regions still over the command cap — ` +
        `${skipped.map((id) => `#${id}`).join(", ")}. They are absent from the scene, not ` +
        `truncated, so what is there is correct as far as it goes.`,
    );
  }

  const fogColour = await OBR.scene.fog.getColor();
  const { lines, dropped } = stageWallLines(source.walls, {
    run: runId,
    mapId: source.mapId,
    colour: fogColour,
    strokeWidth: ACCEPTED_WALL_STROKE,
  });
  if (dropped > 0) {
    devLog("warn", `emit: dropped ${dropped} zero-length wall segments — nothing to select there`);
  }

  if (shapes.length === 0 && lines.length === 0) {
    /*
      Returning BEFORE the delete below, so the scene keeps whatever the last push put there.

      The message has to say that, because "nothing was emittable" is true about the write and a GM
      reads it as "so the scene is as I left it". What the scene actually holds is fog derived from
      an *earlier* set of settings, which may look nothing like what is on screen — the tool has
      quietly stopped being a rendering of the current graph, and the old wording did not say so.

      Leaving it rather than clearing it is the deliberate half. Reaching zero shapes *and* zero
      lines takes something degenerate — a broken or tiny map image, an empty raster — so it is an
      accident rather than an intent, and an empty fog layer hides the whole map. Clearing would
      answer a mistake by destroying the GM's working fog, on the way out of a workspace that now
      pushes when it closes.

      `lastPushed` is deliberately NOT cleared. It records the last *successful* push and the scene
      still holds exactly that, so the fingerprint is accurate: if the GM returns to those settings
      and closes, skipping the push is correct. The error paths below call `forgetPushed()` because
      they leave the scene partially written and therefore unknown; this path leaves it known.
    */
    devLog(
      "warn",
      "emit: nothing was emittable, so the scene still holds the previous run's fog — it no longer " +
        "matches the settings on screen",
    );
    // Not "the scene is current", which the text pass proposed: the previous fog is still there and
    // no longer matches the walls, which is exactly what the log line above warns about.
    return "No walls to write. Scene left unchanged.";
  }

  // Ours go before the replacements arrive. See the note above on why this order.
  const existing = await ourItems();
  if (existing.length > 0) {
    try {
      await writeWithBackoff(
        () => OBR.scene.items.deleteItems(existing.map((item) => item.id)),
        "clear",
      );
    } catch (error) {
      const detail = describeError(error);
      devLog("error", `emit: could not clear ${existing.length} of our items — ${detail}`);
      return `Update failed: ${detail}. Nothing updated.`;
    }
    devLog("info", `emit: cleared ${existing.length} of our items before writing`);
  }

  const batches = planBatches(shapes, BATCH_LIMITS);
  devLog(
    "info",
    `emit: pushing ${shapes.length} shapes (${totalCommands(shapes)} commands) in ` +
      `${batches.length} batches, run ${runId}`,
  );

  let written = 0;
  for (const [index, batch] of batches.entries()) {
    if (stopRequested) {
      devLog("warn", `emit: stopped at the GM's request after ${written} of ${shapes.length} shapes`);
      forgetPushed();
      // What the Stop button's own line says (text rules): the counts are in the log above.
      return "Stopped. Scene partly updated.";
    }
    const items = batch.map(fogShapeItem);
    try {
      await writeWithBackoff(() => OBR.scene.items.addItems(items), `batch ${index + 1}`);
    } catch (error) {
      // Partial output is left in the scene rather than rolled back. Undoing it would be another
      // batch of writes through the same limiter that just refused one, and the GM can see what
      // landed. Saying how far it got is the part that matters.
      const detail = describeError(error);
      console.error(`Fog Nudger — push failed after ${written} shapes: ${detail}`);
      devLog("error", `emit: stopped after ${written} of ${shapes.length} shapes — ${detail}`);
      forgetPushed();
      return `Update failed: ${detail}. Scene partly updated.`;
    }
    written += batch.length;
    // Pacing ahead of the limiter rather than only reacting to it. A backoff recovers from a
    // throttle; a pause makes hitting one less likely in the first place.
    if (index < batches.length - 1) await pause(BATCH_PAUSE_MS);
  }

  let walls = 0;
  // `.entries()` for the same reason the shape loop above has an index: the pause is between
  // batches, not after each one, and this loop used to pause after the last as well — 120ms spent
  // at the end of every push waiting to be polite to nobody. Two loops side by side with different
  // pacing is also the kind of asymmetry that gets copied into the third.
  const wallBatches = [...chunk(lines, BATCH_LIMITS.maxItems)];
  for (const [index, batch] of wallBatches.entries()) {
    if (stopRequested) {
      devLog(
        "warn",
        `emit: stopped at the GM's request after ${written} shapes and ${walls} wall segments`,
      );
      forgetPushed();
      return "Stopped. Scene partly updated.";
    }
    try {
      await writeWithBackoff(
        () => OBR.scene.items.addItems(batch.map(wallLineItem)),
        "wall batch",
      );
    } catch (error) {
      const detail = describeError(error);
      devLog("error", `emit: stopped after ${walls} of ${lines.length} wall segments — ${detail}`);
      forgetPushed();
      return `Update failed: ${detail}. Scene partly updated.`;
    }
    walls += batch.length;
    if (index < wallBatches.length - 1) await pause(BATCH_PAUSE_MS);
  }

  lastPushed = fingerprint ?? null;
  devLog("info", `emit: pushed ${written} shapes and ${walls} wall segments onto the FOG layer`);
  // Counted in Owlbear's words, since this is about the scene: shapes and lines (text rules).
  return (
    `Updated scene. ${written} shape${written === 1 ? "" : "s"}` +
    (walls > 0 ? ` and ${walls} line${walls === 1 ? "" : "s"}` : "") +
    "." +
    (skipped.length > 0
      ? ` Skipped ${skipped.length} shape${skipped.length === 1 ? "" : "s"} too large to write.`
      : "")
  );
}

/** Delete every item this pipeline created, and nothing else. */
export async function removeOurs(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const ours = await ourItems();
  if (ours.length === 0) return "No Fog Nudger items in this scene.";

  try {
    await writeWithBackoff(
      () => OBR.scene.items.deleteItems(ours.map((item) => item.id)),
      "remove",
    );
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — removing our shapes failed: ${detail}`);
    return `Remove failed: ${detail}.`;
  }

  devLog("info", `emit: removed ${ours.length} of our shapes`);
  return `Removed ${ours.length} item${ours.length === 1 ? "" : "s"}.`;
}

/** Split a list into batches of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Only ours. The GM's fog — 419 hand-drawn items in this project's own test scene — is not ours. */
function ourItems(): Promise<Item[]> {
  return OBR.scene.items.getItems(
    (item) => REGION_KEY in item.metadata || WALL_KEY in item.metadata,
  );
}

/**
 * Run a write, retrying only what is worth retrying.
 *
 * The distinction DESIGN.md §7 insists on, in the one place it can be acted on. A throttle waits and
 * goes again; anything else is rethrown immediately, because retrying a refusal is a hang wearing
 * the costume of resilience. Both paths log, so a run that took four attempts and a run that took
 * one are not the same silence.
 */
async function writeWithBackoff<T>(write: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= RETRY_BACKOFF_MS.length) throw error;
      const wait = RETRY_BACKOFF_MS[attempt]!;
      devLog(
        "warn",
        `emit: ${label} throttled, waiting ${wait}ms (attempt ${attempt + 1} of ` +
          `${RETRY_BACKOFF_MS.length + 1})`,
      );
      await pause(wait);
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One wall segment, built the way Dynamic Fog's own wall mode builds one.
 *
 * A `LINE` rather than anything with an interior, because Owlbear reads a fog item's interior as
 * revealable ground and a wall must reveal nothing. Onto `FOG` at the scene's own fog colour, so it
 * is indistinguishable from a wall a GM drew by hand — and at zero width, so the two walls Dynamic
 * Fog derives from it coincide on the centreline rather than straddling it.
 */
function wallLineItem(line: WallLineSpec): Item {
  return buildLine()
    .startPosition({ x: 0, y: 0 })
    .endPosition(line.end)
    .position(line.position)
    .strokeColor(line.colour)
    .strokeOpacity(1)
    .strokeWidth(line.strokeWidth)
    .layer(EMITTED_LAYER)
    .visible(EMITTED_VISIBLE)
    .name(line.name)
    .metadata({
      [WALL_KEY]: line.provenance,
      // The doors on this wall, in Dynamic Fog's own record — the one key here that is not ours.
      ...(line.doors ? { [DYNAMIC_FOG_DOORS_KEY]: line.doors } : {}),
    })
    .build();
}

function fogShapeItem(shape: FogShapeSpec): Item {
  return buildPath()
    .commands(toSdkCommands(shape.commands))
    // Even-odd, so an inner ring cuts a hole whichever way it winds — which retires winding
    // direction as something this pipeline has to get right. Dynamic Fog maps anything that is not
    // "nonzero" onto Skia's even-odd, so both ends agree.
    .fillRule("evenodd")
    .fillColor(shape.colour)
    .fillOpacity(shape.fillOpacity)
    .strokeColor(shape.colour)
    .strokeOpacity(1)
    .strokeWidth(shape.strokeWidth)
    .layer(EMITTED_LAYER)
    // On the fog layer this is not "can it be seen" — it is the difference between a shape that is
    // fog and one that has been cleared. See `EMITTED_VISIBLE`.
    .visible(EMITTED_VISIBLE)
    .position(shape.position)
    .name(shape.name)
    .metadata({
      [REGION_KEY]: shape.provenance,
      ...(shape.doors ? { [DYNAMIC_FOG_DOORS_KEY]: shape.doors } : {}),
    })
    .build();
}

/**
 * The single boundary where locally-built commands become the SDK's type. Safe because of the
 * compile-time assertion above; the same cast without that guard would be a silent hazard.
 */
function toSdkCommands(
  commands: readonly PathCommandLike[],
): Parameters<ReturnType<typeof buildPath>["commands"]>[0] {
  return commands as Parameters<ReturnType<typeof buildPath>["commands"]>[0];
}
