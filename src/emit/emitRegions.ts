/**
 * Roadmap step 8, SDK half — the three gestures that put traced regions in front of a GM.
 *
 * **Stage** runs the pipeline and writes proposals to the `DRAWING` layer. **Accept** promotes them
 * to `FOG`, which is where they become fog and where Dynamic Fog starts deriving walls from them.
 * **Return to staging** is accept's exact inverse, keeping the items and every hand edit on them.
 * **Remove** deletes ours and touches nothing else.
 *
 * Everything about *what* a shape is lives next door in `fogShapes.ts`, where it can be tested.
 * What lives here is the part no test in this repository can reach: the calls themselves, and the
 * handling of what Owlbear says back.
 *
 * ## Throttle and refusal are not the same failure, and this is where that matters
 *
 * A rate limit is temporary and giving up on it loses regions; a validation failure is permanent
 * and retrying it is a hang. They arrive through the same channel and read alike (DESIGN.md §7), so
 * every write here asks which it was before deciding what to do. A refused batch stops the run and
 * says so; a throttled one waits and tries again.
 *
 * ## Staging a second time is refused rather than merged
 *
 * Emitting over an existing set would double every region, and deciding *which* of the two to keep
 * is the re-run question — a product decision (DESIGN.md §10) that step 9 owns and that a first
 * emit path has no business answering quietly. So this refuses and says how many of ours are
 * already there, and the remedy is the explicit remove.
 */

import OBR, {
  buildLine,
  buildPath,
  Command,
  isLine,
  isPath,
  type Item,
  type Line,
  type Path,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError, isRateLimited } from "../describeError";
import { PathOp, type PathCommandLike } from "../geometry/ring";
import { runTrace } from "../pipeline";
import { readSettings } from "../settingsStore";
import {
  ACCEPTED_FILL_OPACITY,
  planBatches,
  REGION_KEY,
  stageShapes,
  totalCommands,
  type FogShapeSpec,
} from "./fogShapes";
import { stageWallLines, WALL_KEY, type WallLineSpec } from "./wallLines";

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
 * Trace the scene's map and stage the result as proposals on the `DRAWING` layer.
 *
 * Nothing here can affect play. A staged item is invisible to players, renders in its own colour
 * for the GM, and derives zero walls — inert by construction rather than by our being careful,
 * which is what makes a first run in a real room a safe thing to do.
 */
export async function stageRegions(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open — nothing to trace.";

  const existing = await ourItems();
  if (existing.length > 0) {
    return (
      `${existing.length} of our shapes are already in this scene. Remove them first — ` +
      `replacing them without losing hand edits is step 9's problem, not this button's.`
    );
  }

  const outcome = await runTrace();
  if (!outcome.ok) return outcome.message;
  const { run } = outcome;

  const review = (await readSettings()).review;
  const stroke = Math.max(0, run.dpi * review.strokeSquares);
  const runId = new Date().toISOString();
  const { shapes, skipped } = stageShapes(run.regions, {
    run: runId,
    mapId: run.mapId,
    strokeWidth: stroke,
    fillOpacity: review.fillOpacity,
  });

  if (skipped.length > 0) {
    devLog(
      "warn",
      `emit: skipped ${skipped.length} regions still over the command cap — ` +
        `${skipped.map((id) => `#${id}`).join(", ")}. They are absent from the scene, not ` +
        `truncated, so what is there is correct as far as it goes.`,
    );
  }

  if (shapes.length === 0) {
    return "Traced, but nothing was emittable — see dev.log.";
  }

  const batches = planBatches(shapes, BATCH_LIMITS);
  devLog(
    "info",
    `emit: staging ${shapes.length} shapes (${totalCommands(shapes)} commands) in ` +
      `${batches.length} batches, run ${runId}`,
  );

  let written = 0;
  for (const [index, batch] of batches.entries()) {
    const items = batch.map(stagedItem);
    try {
      await writeWithBackoff(() => OBR.scene.items.addItems(items), `batch ${index + 1}`);
    } catch (error) {
      // Partial output is left in the scene rather than rolled back. Undoing it would be another
      // batch of writes through the same limiter that just refused one, and the GM can see what
      // landed and remove it deliberately. Saying how far it got is the part that matters.
      const detail = describeError(error);
      console.error(`Fog Nudger — staging failed after ${written} shapes: ${detail}`);
      devLog("error", `emit: stopped after ${written} of ${shapes.length} shapes — ${detail}`);
      return (
        `Stopped after ${written} of ${shapes.length} shapes: ${detail}. ` +
        `What landed is still in the scene — remove it before trying again.`
      );
    }
    written += batch.length;
    // Pacing ahead of the limiter rather than only reacting to it. A backoff recovers from a
    // throttle; a pause makes hitting one less likely in the first place, and the difference at
    // prep time is a couple of seconds nobody is waiting on.
    if (index < batches.length - 1) await pause(BATCH_PAUSE_MS);
  }

  devLog("info", `emit: staged ${written} shapes on the DRAWING layer`);

  // ## The walls no shape's boundary covers
  //
  // A stub hanging into a room is the usual case. These go out as `LINE` items, which is what
  // Dynamic Fog's own wall mode builds and the only item type with no interior to reveal.
  const { lines, dropped } = stageWallLines(
    run.walls.map((wall) => ({ edge: wall.edge, points: wall.placed, ids: wall.ids })),
    { run: runId, mapId: run.mapId, colour: WALL_COLOUR, strokeWidth: Math.max(1, stroke) },
  );
  if (dropped > 0) {
    devLog("warn", `emit: dropped ${dropped} zero-length wall segments — nothing to select there`);
  }

  let walls = 0;
  if (lines.length > 0) {
    devLog(
      "info",
      `emit: staging ${lines.length} wall segments from ${run.walls.length} uncovered edges`,
    );
    for (const batch of chunk(lines, BATCH_LIMITS.maxItems)) {
      try {
        await writeWithBackoff(
          () => OBR.scene.items.addItems(batch.map(stagedLine)),
          `wall batch`,
        );
      } catch (error) {
        const detail = describeError(error);
        devLog("error", `emit: stopped after ${walls} of ${lines.length} wall segments — ${detail}`);
        return (
          `Staged ${written} proposals, then stopped after ${walls} of ${lines.length} wall ` +
          `segments: ${detail}. What landed is still in the scene.`
        );
      }
      walls += batch.length;
      await pause(BATCH_PAUSE_MS);
    }
    devLog("info", `emit: staged ${walls} wall segments on the DRAWING layer`);
  }

  return (
    `${run.summary}. Staged ${written} proposals` +
    (walls > 0 ? ` and ${walls} wall segments` : "") +
    (skipped.length > 0 ? `, skipped ${skipped.length} over the cap` : "") +
    `. Coloured, GM-only, no walls — neighbouring regions differ so the partition is visible.`
  );
}

/**
 * Accept the staged proposals: move ours from `DRAWING` onto `FOG`.
 *
 * A property update rather than a delete-and-recreate, so ids survive and hundreds of items are one
 * call. Three properties change together because staged and accepted want different values for each,
 * and all three were measured in a room (DESIGN.md §4):
 *
 * - **layer to `FOG`** — the promotion itself. Dynamic Fog filters on layer plus type, so walls
 *   appear on arrival and did not exist a moment earlier.
 * - **`fillOpacity` to 1** — required, not aesthetic. Below 1 a fog shape leaves a translucent tint
 *   of the fog colour over ground the party has revealed, for players as well as the GM.
 * - **`visible` to false** — matching what Owlbear's own fog tool produces. Not known to be
 *   load-bearing, but an unexplained difference from the tool we are imitating is one that
 *   surprises someone later.
 *
 * The magenta is left alone deliberately: fog rendering ignores an item's colour, so it costs
 * nothing, and demoting back to `DRAWING` restores the marking with no extra bookkeeping.
 */
export async function acceptStaged(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const staged = await OBR.scene.items.getItems<Path>(
    (item) => REGION_KEY in item.metadata && item.layer === "DRAWING" && isPath(item),
  );
  if (staged.length === 0) return "Nothing of ours staged on the drawing layer.";

  try {
    await writeWithBackoff(
      () =>
        OBR.scene.items.updateItems<Path>(staged, (drafts) => {
          for (const draft of drafts) {
            draft.layer = "FOG";
            draft.visible = false;
            draft.style.fillOpacity = ACCEPTED_FILL_OPACITY;
          }
        }),
      "accept",
    );
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — accepting staged shapes failed: ${detail}`);
    return `Could not accept: ${detail}`;
  }

  const walls = await acceptWallLines();

  devLog("info", `emit: accepted ${staged.length} proposals onto the FOG layer`);
  return (
    `Accepted ${staged.length}${walls > 0 ? ` and ${walls} wall segments` : ""}. They are fog now ` +
    `— if Dynamic Fog is installed, give it a moment and expect roughly two walls per contour.`
  );
}

/**
 * Promote the staged wall lines with the shapes, taking the scene's own fog styling on the way.
 *
 * Dynamic Fog's wall mode reads `OBR.scene.fog.getColor()` and `getStrokeWidth()` when it builds a
 * line, so an accepted wall of ours matches one a GM drew by hand. Staged, they are in the review
 * colour instead, because during review they are something to look at rather than something to
 * match.
 */
async function acceptWallLines(): Promise<number> {
  const staged = await OBR.scene.items.getItems<Line>(
    (item) => WALL_KEY in item.metadata && item.layer === "DRAWING" && isLine(item),
  );
  if (staged.length === 0) return 0;

  const [colour, width] = await Promise.all([
    OBR.scene.fog.getColor(),
    OBR.scene.fog.getStrokeWidth(),
  ]);

  await writeWithBackoff(
    () =>
      OBR.scene.items.updateItems<Line>(staged, (drafts) => {
        for (const draft of drafts) {
          draft.layer = "FOG";
          draft.visible = false;
          draft.style.strokeColor = colour;
          draft.style.strokeWidth = width;
        }
      }),
    "accept walls",
  );
  devLog("info", `emit: accepted ${staged.length} wall segments onto the FOG layer`);
  return staged.length;
}

/**
 * Send accepted shapes back to staging: ours from `FOG` onto `DRAWING`.
 *
 * The exact inverse of accepting, and it costs nothing extra because the shapes never stopped being
 * magenta — fog rendering ignores an item's own colour, so the marking survived promotion unused and
 * is simply visible again on arrival. That was the reason §4 chose to leave the colour in place.
 *
 * Worth having as its own gesture rather than telling a GM to remove and re-run. A re-run recomputes
 * the geometry and destroys any hand edits made since; demoting keeps the items, their ids, and
 * every nudge. The two look similar from the panel and are not remotely the same operation.
 */
export async function returnToStaging(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  // The GM's current staged opacity, not the one the shapes were emitted with. Demoting is how a
  // proposal comes back for another look, so it should come back looking the way proposals look now.
  const stagedOpacity = (await readSettings()).review.fillOpacity;
  const accepted = await OBR.scene.items.getItems<Path>(
    (item) => REGION_KEY in item.metadata && item.layer === "FOG" && isPath(item),
  );
  if (accepted.length === 0) return "Nothing of ours on the fog layer.";

  try {
    await writeWithBackoff(
      () =>
        OBR.scene.items.updateItems<Path>(accepted, (drafts) => {
          for (const draft of drafts) {
            draft.layer = "DRAWING";
            draft.style.fillOpacity = stagedOpacity;
          }
        }),
      "return to staging",
    );
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — returning shapes to staging failed: ${detail}`);
    return `Could not return to staging: ${detail}`;
  }

  const walls = await OBR.scene.items.getItems<Line>(
    (item) => WALL_KEY in item.metadata && item.layer === "FOG" && isLine(item),
  );
  if (walls.length > 0) {
    await writeWithBackoff(
      () =>
        OBR.scene.items.updateItems<Line>(walls, (drafts) => {
          for (const draft of drafts) {
            draft.layer = "DRAWING";
            draft.style.strokeColor = WALL_COLOUR;
          }
        }),
      "return walls to staging",
    );
  }

  devLog("info", `emit: returned ${accepted.length} shapes to the DRAWING layer`);
  return (
    `Returned ${accepted.length} to staging. They are proposals again — no walls, no fog — and ` +
    `every hand edit is still on them.`
  );
}

/**
 * Re-apply the current appearance settings to the shapes already staged.
 *
 * Without this, changing how proposals look would mean removing and re-tracing — which recomputes
 * every region and is the one thing the two-stage split exists to keep separate. Appearance is a
 * stage-two question, so it must be answerable without touching stage one.
 *
 * Only staged items, never accepted ones: an accepted shape is fog, and fog below full opacity
 * leaves a tint over ground the party has revealed.
 */
export async function restyleStaged(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const review = (await readSettings()).review;
  const dpi = await OBR.scene.grid.getDpi();
  const stroke = Math.max(0, dpi * review.strokeSquares);

  const staged = await OBR.scene.items.getItems<Path>(
    (item) => REGION_KEY in item.metadata && item.layer === "DRAWING" && isPath(item),
  );
  if (staged.length === 0) return "Nothing of ours staged to restyle.";

  try {
    await writeWithBackoff(
      () =>
        OBR.scene.items.updateItems<Path>(staged, (drafts) => {
          for (const draft of drafts) {
            draft.style.fillOpacity = review.fillOpacity;
            draft.style.strokeWidth = stroke;
          }
        }),
      "restyle",
    );
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — restyling staged shapes failed: ${detail}`);
    return `Could not restyle: ${detail}`;
  }

  devLog("info", `emit: restyled ${staged.length} staged shapes`);
  return `Restyled ${staged.length} proposals.`;
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
/**
 * The colour staged wall lines are drawn in, matching the workspace preview's core colour.
 *
 * Saturated rather than wall-coloured, and for a reason found in a room: a wall line is a
 * centreline, so it lies exactly on the map's own linework and anything dark is invisible on every
 * wall it describes. Fixed rather than cycled like the proposal fills — a wall is one kind of thing,
 * and what a GM is judging is where it runs. Accepting swaps it for the scene's own fog styling.
 */
const WALL_COLOUR = "#ff2020";

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
 * revealable ground and a wall must reveal nothing. Staged on `DRAWING` in the review colour like
 * every other proposal; `acceptStaged` moves it to `FOG`.
 *
 * **`visible: false`, deliberately unlike Dynamic Fog's wall mode**, which leaves the default of
 * true. Ours are staged before they are accepted, and a visible staged item leaks the map's layout
 * to players during prep — the same reasoning the fog shapes already follow. The conservative
 * direction: if it turns out a hidden line yields no wall, the failure is a missing wall the GM can
 * see is missing, where the other way round is a leak nobody notices.
 */
function stagedLine(line: WallLineSpec): Item {
  return buildLine()
    .startPosition({ x: 0, y: 0 })
    .endPosition(line.end)
    .position(line.position)
    .strokeColor(line.colour)
    .strokeOpacity(1)
    .strokeWidth(line.strokeWidth)
    .layer("DRAWING")
    .visible(false)
    .name(line.name)
    .metadata({ [WALL_KEY]: line.provenance })
    .build();
}

function stagedItem(shape: FogShapeSpec): Item {
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
    .layer("DRAWING")
    // Not optional. With this true, players see the proposals and the dungeon's layout leaks during
    // prep; with it false the GM sees them ghosted and can still select and edit them.
    .visible(false)
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
