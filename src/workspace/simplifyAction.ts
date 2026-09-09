/**
 * Straightening the walls in the editor: the tolerance applied once, when asked.
 *
 * ## The same operation as the ink mode's, on opposite terms
 *
 * There, simplification is a **fitting parameter**. The graph is re-derived from the reading every
 * time anything moves, so turning the slider down puts the detail straight back and sweeping it costs
 * nothing but a derive.
 *
 * Here the graph **is** the document. Nothing re-derives it, so a vertex this removes is gone —
 * including one the GM placed by hand a minute ago. So the editor gets its own number, starting at
 * off, and a deliberate act to apply it. Same reasoning as the prune button beside it, and the reason
 * the two modes hold two keys rather than one: they need different defaults, which is what says they
 * are different settings.
 *
 * ## The sweep is total, and that is what makes it slow
 *
 * Simplification can pull a wall across one that was clear of it, which pruning cannot — deleting
 * never breaks planarity. So this has to check for crossings, and because it touches **every** wall
 * there is no untouched set whose planarity the previous state still vouches for. The sweep is
 * therefore quadratic in the segment count (user, 2026-09-07: *"Sweep everything, and warn if it's
 * slow"*), which is worst on exactly the graphs that most want simplifying.
 *
 * So the confirmation says so before it runs, and the log says what it actually cost afterwards. The
 * work is synchronous and will hold the frame while it runs; a graph large enough for that to matter
 * is one the ink mode should have simplified before saving, which is what the warning points at.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { readParameter } from "../settings";
import { wallRuns } from "../trace/wallGraph";
import { simplifyWalls } from "../trace/planarOps";
import { confirmAction } from "./confirmDialog";
import { currentSettings } from "./settingsState";
import { controlsLive } from "./settingRows";
import { say } from "./shell";
import { wallGraph, saveEditedWalls } from "./stage";

/**
 * Segment count past which the crossing sweep is worth warning about.
 *
 * The sweep is quadratic, so this is where the pair count reaches the low millions — around the
 * point a synchronous pass stops being instant on the machines this has been run on. **Reasoned
 * rather than measured**, and stated as such: nobody has timed the sweep at any size, so it is the
 * order of magnitude that is meant rather than the figure.
 */
const SLOW_SWEEP_SEGMENTS = 2_000;

/** How long a sweep may take before the log says it was slow, in milliseconds. */
const SLOW_SWEEP_MS = 1_000;

export function renderSimplifyAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Straighten the walls";
  button.disabled = !controlsLive();

  const note = document.createElement("p");
  note.className = "sub";
  note.innerHTML =
    "Applies <b>Straighten walls</b> above, once, to every wall at once. Junctions and the ends of " +
    "walls never move, so the rooms stay joined where they were joined; what goes is the wandering " +
    "in between. <b>It cannot be undone</b> &mdash; there is nothing here to derive the detail back " +
    "from. Set the slider to off and nothing happens.";

  button.addEventListener("click", () => {
    void run(button);
  });

  actions.append(button);
  body.append(actions, note);
}

async function run(button: HTMLButtonElement): Promise<void> {
  const graph = wallGraph();
  if (!graph) {
    say("no walls saved for this map yet", "bad");
    return;
  }

  const tolerance = readParameter(currentSettings(), "editSimplifyFraction");
  if (!(tolerance > 0)) {
    say("straightening is off — raise the slider above the left-hand end first", "bad");
    return;
  }

  /*
    Warned about **before** it runs, because the sweep is the expensive half and a synchronous pass
    holds the frame while it happens. Told as a count of what is about to be swept rather than a
    time, since no time has been measured and inventing one would be a guess in the voice of a
    measurement.
  */
  const segments = graph.edges.length;
  if (segments >= SLOW_SWEEP_SEGMENTS) {
    const ok = await confirmAction({
      title: "This may take a while",
      body: [
        `There are ${segments.toLocaleString()} wall segments, and straightening has to check every ` +
          "one against every other for crossings — there is no shortcut once every wall has moved. " +
          "The surface will not respond while it runs.",
        "A graph this size is usually a sign the reading was saved with very little smoothing. " +
          "Reopening the ink mode and raising Edge simplification there is the cheaper fix.",
      ],
      confirmLabel: "Straighten them anyway",
    });
    if (!ok) return;
  }

  const before = wallRuns(graph).length;
  button.disabled = true;
  say("straightening…", "working");

  try {
    const started = performance.now();
    const result = simplifyWalls(graph, tolerance);
    const elapsed = performance.now() - started;

    if (result.removed === 0 && result.splits === 0) {
      say("nothing to straighten at this setting — raise it and try again");
      return;
    }

    await saveEditedWalls(result.graph, "straightening the walls");
    devLog(
      elapsed >= SLOW_SWEEP_MS ? "warn" : "info",
      `workspace: straightened ${before} walls at ${tolerance.toExponential(2)} of the map in ` +
        `${Math.round(elapsed)}ms — ${result.removed} points dropped, ${result.splits} segments ` +
        `split where walls crossed, ${result.overlaps} collinear overlaps left alone, ` +
        `${result.preserved} runs kept whole because fitting would have closed a room up`,
    );

    /*
      What the state line says is the part a GM can act on, and the collapse count leads when it is
      not zero: a run kept whole is a room that would have vanished, which is worth knowing before
      the next press rather than after.
    */
    say(
      `${result.removed} point${result.removed === 1 ? "" : "s"} removed` +
        (result.splits === 0 ? "" : ` · ${result.splits} crossings split`) +
        (result.preserved === 0
          ? ""
          : ` · ${result.preserved} wall${result.preserved === 1 ? "" : "s"} left alone to keep a ` +
            "room open"),
    );
  } catch (error) {
    // The write is what makes it real, so a failure leaves the GM the graph they had.
    const detail = describeError(error);
    say(`could not save the straightened walls: ${detail}`, "bad");
    devLog("error", "workspace: straightening failed to save", detail);
    console.error("Fog Nudger — straightening failed to save", error);
  } finally {
    button.disabled = !controlsLive();
  }
}
