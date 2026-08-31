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
 * staged, and change one at a time.
 */
const BATCH_LIMITS = { maxItems: 24, maxCommands: 20_000 } as const;

/** Pause between batches. Deliberately unhurried: this runs once at prep time, not in play. */
const BATCH_PAUSE_MS = 120;

/** Waits between retries of a throttled batch, in milliseconds. Gives up after the last one. */
const RETRY_BACKOFF_MS = [250, 750, 2_000] as const;

/**
 * What the scene last received, so a look-and-close does not rewrite every fog item in it.
 *
 * The map's identity plus the settings that produced the result. Held in memory rather than in
 * scene metadata deliberately: it is an optimisation, and the safe direction when it is lost is to
 * push again. Stale in the other direction is not possible, because anything that changes the
 * result also changes this string.
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
export async function pushToFog(fingerprint?: string): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open — nothing to trace.";

  const outcome = await runTrace();
  if (!outcome.ok) return outcome.message;
  const { run } = outcome;

  const runId = new Date().toISOString();
  const { shapes, skipped } = stageShapes(run.regions, {
    run: runId,
    mapId: run.mapId,
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
  const { lines, dropped } = stageWallLines(
    run.walls.map((wall) => ({ edge: wall.edge, points: wall.placed, ids: wall.ids })),
    { run: runId, mapId: run.mapId, colour: fogColour, strokeWidth: ACCEPTED_WALL_STROKE },
  );
  if (dropped > 0) {
    devLog("warn", `emit: dropped ${dropped} zero-length wall segments — nothing to select there`);
  }

  if (shapes.length === 0 && lines.length === 0) {
    return "Traced, but nothing was emittable — see dev.log.";
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
      return `Could not clear the previous run: ${detail}. Nothing new was written.`;
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
      return (
        `Stopped after ${written} of ${shapes.length} shapes: ${detail}. ` +
        `The scene holds a partial result — push again once the cause is dealt with.`
      );
    }
    written += batch.length;
    // Pacing ahead of the limiter rather than only reacting to it. A backoff recovers from a
    // throttle; a pause makes hitting one less likely in the first place.
    if (index < batches.length - 1) await pause(BATCH_PAUSE_MS);
  }

  let walls = 0;
  for (const batch of chunk(lines, BATCH_LIMITS.maxItems)) {
    try {
      await writeWithBackoff(
        () => OBR.scene.items.addItems(batch.map(wallLineItem)),
        "wall batch",
      );
    } catch (error) {
      const detail = describeError(error);
      devLog("error", `emit: stopped after ${walls} of ${lines.length} wall segments — ${detail}`);
      forgetPushed();
      return (
        `Pushed ${written} regions, then stopped after ${walls} of ${lines.length} wall ` +
        `segments: ${detail}. The scene holds a partial result.`
      );
    }
    walls += batch.length;
    await pause(BATCH_PAUSE_MS);
  }

  lastPushed = fingerprint ?? null;
  devLog("info", `emit: pushed ${written} shapes and ${walls} wall segments onto the FOG layer`);
  return (
    `${run.summary}. On the map: ${written} regions` +
    (walls > 0 ? ` and ${walls} wall segments` : "") +
    (skipped.length > 0 ? `, skipped ${skipped.length} over the cap` : "") +
    `.`
  );
}

/** Delete every item this pipeline created, and nothing else. */
export async function removeOurs(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const ours = await ourItems();
  if (ours.length === 0) return "Nothing of ours in this scene.";

  try {
    await writeWithBackoff(
      () => OBR.scene.items.deleteItems(ours.map((item) => item.id)),
      "remove",
    );
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — removing our shapes failed: ${detail}`);
    return `Could not remove: ${detail}`;
  }

  devLog("info", `emit: removed ${ours.length} of our shapes`);
  return `Removed ${ours.length}. Nothing the GM drew was touched.`;
}

/** Only ours. The GM's fog — 419 hand-drawn items in this project's own test scene — is not ours. */
/** Split a list into batches of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
    .metadata({ [WALL_KEY]: line.provenance })
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
    .metadata({ [REGION_KEY]: shape.provenance })
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
