/**
 * Writing the scene: the editor's button, the ink mode's save, and the close hook.
 *
 * ## Who pushes, and when — one answer now, where there used to be two
 *
 * **Closing pushes, and commits first if nothing has been committed yet.** Edits are written to the
 * document as they are made, so the scene is usually just behind a thing the GM already has;
 * catching it up on the way out is what makes a session end by looking at the table. The button is
 * the mid-session case — a change a table is waiting on, made without giving up the surface.
 *
 * **This was asymmetric until 2026-09-14 and the asymmetry is gone with the save button.** The ink
 * mode used to push only when the GM saved, so closing it committed nothing — which was right while
 * a save button existed, because then *not pressing it* meant something. With no button the same
 * behaviour is just a GM tuning for twenty minutes, pressing Escape and getting nothing.
 *
 * What made the old rule necessary is handled elsewhere now: a graph carrying hand edits keeps the
 * screen, so a derivation can never be adopted over work the GM can see.
 *
 * ## Only when something changed
 *
 * Opening the workspace to glance at something and closing it must not rewrite every fog item in the
 * scene. A fingerprint of the map and the settings that produced the result decides, and it is held
 * in memory: losing it means pushing once more than necessary, which is the safe direction.
 *
 * ## It re-derives rather than emitting what is on screen
 *
 * The preview holds region rings and could be turned into shapes here. It must not be: the emit path
 * has rules of its own — the command cap, the batching, the provenance stamped into each item — and
 * a second route into the scene would be a second implementation of them, drifting quietly until a
 * room disagreed with a preview. In stage one `pushToFog` runs the same `runTrace` the preview ran,
 * against a mask that is still cached, so the cost is the deriving half rather than a fresh read.
 *
 * ## In stage two it emits the GM's graph, and this is where that is decided
 *
 * **The push traced unconditionally until 2026-09-05, which made stage two unusable end to end**: a
 * GM could edit their walls all evening and the scene would receive the rooms as read from the map.
 * The wall graph is handed to `pushToFog` from here, because the emit path has no business knowing
 * what stage a workspace is in — and a push driven from the panel could not answer that anyway.
 *
 * **The fingerprint has to know about it too**, and that was the second half of the same defect: it
 * was the map plus the settings, neither of which a vertex drag changes, so closing after an edit
 * could decide there was nothing to push. The encoded graph goes into it — the whole string, because
 * this is a comparison rather than a store, and a hash would be a second thing that can collide.
 *
 * ## The settings are written first, and awaited
 *
 * `pushToFog` reads scene metadata, and the workspace's sliders write there on release without
 * waiting. Pushing a moment after letting go of a slider would otherwise emit the value before it.
 * One `await` closes that window.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { pushToFog, pushWouldChange, requestPushStop } from "../emit/emitRegions";
import { readNominatedMapId } from "../map/mapImage";
import { encodeWallGraph } from "../trace/wallGraph";
import { graphsDiffer } from "../trace/wallGraphDiff";
import { paintRevision } from "../trace/inkPaint";
import { encodeMarks } from "../trace/suppression";
import { confirmAction } from "../confirmDialog";
import { currentMarks } from "./regionMarks";
import { currentRegions, currentWalls, derivationSettled, previewGraph } from "./regions";
import { saveDerivedWalls, wallGraph, wallsEdited } from "./stage";
import { controlsLive } from "./settingsState";
import { currentPaint } from "./paintState";
import { currentSettings, persistSettings } from "./settingsState";
import { say, withEscapeHatch } from "./shell";

/**
 * What the scene would receive, as one string.
 *
 * The map plus every setting, rather than only the ones that reach the emitted geometry. Over-broad
 * on purpose and for the same reason the mask fingerprint is: a missed entry here means a stale
 * scene reported as current, and an extra one costs a push nobody minded.
 */
async function fingerprint(): Promise<string> {
  const map = await readNominatedMapId();
  const graph = wallGraph();
  // In stage two the settings no longer decide the geometry, so on their own they would report an
  // evening of editing as "nothing changed".
  const edits = graph ? encodeWallGraph(graph) : "";
  /*
    The paint layers are here for the same reason the graph is.

    They are durable inputs the settings say nothing about, so without them an evening of suppressing
    crosshatching would close reporting "the scene already says this" and push nothing. By content
    rather than by presence, since editing a layer changes neither its existence nor its map.
  */
  const paint = currentPaint();
  const painted = `${paintRevision(paint.suppress)}/${paintRevision(paint.ink)}`;
  // And the suppression marks, which decide which regions go out and which walls become lines.
  const marked = encodeMarks(currentMarks()).join(",");
  return `${map ?? "none"}|${JSON.stringify(currentSettings())}|${edits}|${painted}|${marked}`;
}

/**
 * Bring the stored document up to the derivation on screen, unless the GM has edited it.
 *
 * **This is where the save button went.** Nothing commits on a slider release — a scene write is the
 * better part of a second and sweeping a threshold would pay it on every notch — so between a derive
 * and a push the document is deliberately behind what is drawn. The two moments that close that gap
 * are a hand edit, which adopts what it was applied to, and this, which runs before anything is
 * written to the scene.
 *
 * Three ways to do nothing, and they are all the safe direction. **A graph carrying hand edits wins
 * outright**, because the derivation is not what the GM has. **No derivation** leaves whatever is
 * stored, which is what a workspace opened and closed without looking at the walls should do. And a
 * document that already equals the derivation is not rewritten, since a metadata write that changes
 * nothing is a second a GM waits for no reason.
 *
 * Returns false when it could not commit, which means the push must not go ahead: emitting from a
 * document the scene disagrees with is how a stale set of walls reaches a table.
 */
async function commitDerivation(): Promise<boolean> {
  /*
    A derive still running is for the ink on screen, and the one that landed before it is for ink the
    GM has since changed — so wait for it (2026-09-24). While the derive blocked the page nothing could
    press a push between a reading and its walls; in a worker the close and *Put on the map* both can.
    Hand edits stop derives altogether, so this costs a GM with work in the walls nothing.
  */
  await derivationSettled();
  if (wallsEdited()) return true;

  const derived = previewGraph();
  if (!derived) {
    if (!wallGraph()) {
      devLog("info", "workspace: nothing derived and nothing stored, so there is nothing to push");
      return false;
    }
    return true;
  }

  if (!graphsDiffer(wallGraph(), derived)) return true;

  try {
    await saveDerivedWalls(derived);
    return true;
  } catch (error) {
    const detail = describeError(error);
    say(`could not save the walls: ${detail}`, "bad");
    devLog("error", "workspace: committing the derivation failed", detail);
    console.error("Fog Nudger — committing the derivation failed", error);
    return false;
  }
}

/**
 * Push, unless the scene already holds exactly this. Called on the way out, and **awaited**.
 *
 * The shell keeps the sheet up until this resolves, so the seconds a large map takes are seconds a
 * GM is looking at an opaque surface. Hence the status line: it has to be evidently working rather
 * than saved.
 *
 * **The status is said after the fingerprint check, not before**, and that ordering is the whole of
 * requirement 4. Opening the workspace to glance at something and closing it is the common case, and
 * it pushes nothing — announcing "putting it on the map…" and then vanishing would put a flicker on
 * every close that did no work, which reads as the tool doing something it did not do.
 */
export async function pushOnClose(): Promise<void> {
  if (!controlsLive()) return;
  if (!(await commitDerivation())) return;
  const mark = await fingerprint();
  if (!pushWouldChange(mark)) {
    devLog("info", "workspace: closing with nothing to push — the scene already says this");
    return;
  }

  say("putting it on the map…", "working");
  try {
    await persistSettings();
    const message = await pushToFog(mark, wallGraph() ?? undefined);
    devLog("info", `workspace: pushed on close — ${message}`);
  } catch (error) {
    // Never rethrow: the way out of an opaque full-screen sheet cannot depend on a scene write. The
    // shell catches too, so this is belt-and-braces rather than the only guard — but it is the one
    // that keeps the failure attributable, since the shell cannot say what was being written.
    const detail = describeError(error);
    say(`could not write to the scene: ${detail}`, "bad");
    devLog("error", "workspace: pushing on close failed", detail);
    console.error("Fog Nudger — pushing on close failed", error);
  }
}

/**
 * Push what the scene should now hold, and say how it went.
 *
 * Shared by the editor's button and the ink mode's save, so there is one route into the emit path
 * rather than two — which is the same rule that stopped the preview being emitted directly. The
 * settings are written first and **awaited**: `pushToFog` reads scene metadata, and the sliders write
 * there on release without waiting, so pushing a moment after letting go of one would otherwise emit
 * the value before it.
 */
async function pushCurrent(): Promise<boolean> {
  await persistSettings();
  // Same gap the close path closes, and for the same reason: the scene must be written from the
  // document, and between a derive and a push the document is deliberately behind what is drawn.
  if (!(await commitDerivation())) return false;
  const mark = await fingerprint();

  /*
    Wrapped in the escape hatch, which until 2026-09-07 only closing had.

    A room found the hole: a graph large enough to exceed what a scene write can carry made the ink
    mode's *Edit the walls* button hang, and because the hatch lived inside the close sequence there
    was nothing to press — both buttons disable themselves for the duration, so the sheet said
    "saving, then opening the editor…" and offered no way out. Closing is the one case where the GM
    is already leaving; a button is where they are stuck watching, which is the case that needed it
    more.

    **The label differs from the close path's on purpose.** Stopping here hands the surface back
    rather than leaving, so "Exit anyway" would be a lie about what the button does.
  */
  let message = "";
  const pushing = pushToFog(mark, wallGraph() ?? undefined).then((said) => {
    message = said;
  });

  const { bailed, unwound } = await withEscapeHatch(pushing, {
    stop: requestPushStop,
    label: "Stop writing",
    notice: "still writing to the scene — stopping leaves it partly done",
  });

  if (!bailed) {
    say(message);
    return true;
  }

  /*
    Said rather than silently returning, and the wording is the honest one.

    A stopped push leaves the fog layer partly replaced: `pushToFog` deletes ours before it writes,
    so what is on the map is neither the old set nor the new one. Nothing needs cleaning up by hand —
    the next push deletes all of ours first — but a GM who is not told would reasonably believe the
    map is current.
  */
  devLog(
    unwound ? "info" : "warn",
    unwound
      ? "workspace: the push stopped cleanly at the GM's request"
      : "workspace: the push had not stopped when the grace ran out; a write may still be in flight",
  );
  say("stopped — the map is partly written, so push again when you are ready", "bad");
  return false;
}

/**
 * How many scene items a push may be expected to write before it is worth stopping to ask.
 *
 * **Provisional, and calibrated on exactly two observations** — which is stated because a threshold
 * with no measurement behind it invites being trusted. On 2026-09-07 a graph of **5,881** wall
 * segments could not be written at all: Owlbear allows a scene write five seconds, and
 * `OBR_SCENE_ITEMS_ADD_ITEMS` blew through it repeatedly, stopping at 432, 1,104, 1,968, 2,568 and
 * 3,960 across attempts until even asking whether the scene was ready timed out. The same map at a
 * sane tolerance writes **274** items and takes a couple of seconds.
 *
 * So the cliff is somewhere between those, and nobody has bisected it. This sits an order of
 * magnitude above the known-good figure and well below the known-bad one, which makes it a warning
 * that should almost never fire on ordinary work.
 *
 * **It warns and does not refuse.** The GM may have a genuinely enormous map, and this is a
 * prediction about a scene rather than a measurement of one.
 *
 * ## It is the only guard on item count, and that is worth knowing
 *
 * Nothing automatic bounds it. The derive's escalation ladder raises the fitting tolerance until every
 * **face** fits Owlbear's 8192-command cap, which is a different failure — it says nothing about how
 * many items there are. The manual guard used to be the Straightening slider; that became an amount a
 * GM presses on 2026-09-18, so this warning is what stands here alone.
 *
 * **Measured 2026-09-18, from the 38 derives in `dev.log`:** the two maps the project has been through
 * emitted **318 items** (6 regions and 312 wall lines) and **514** (10 and 504), at seeded tolerances
 * with zero escalations. So ordinary work sits an order of magnitude below this. Two maps is not a
 * range, both were line-drawn, and the 5,881-segment failure that calibrated the top of this predates
 * per-map seeding — what is known is that seeding fixed *that*, not that it suffices in general.
 */
const LARGE_PUSH_ITEMS = 1_500;

/**
 * Ask before writing a graph large enough that the scene may not take it.
 *
 * The counts come from the partition already on screen rather than from a fresh traversal, which is
 * the point: what this warns about is exactly what the GM is looking at.
 *
 * **It stands in front of the button and not in front of closing**, which is a change from where it
 * used to live (the deleted save button, the only exit that committed). A dialog in the way out is a
 * dialog a GM meets while leaving, and the case it guards — a write that will not finish — already
 * has the escape hatch, which is a way *out* of the same problem rather than a question about it.
 */
async function mayBeTooLarge(): Promise<boolean> {
  const items = currentRegions().length + currentWalls().length;
  if (items < LARGE_PUSH_ITEMS) return true;

  return confirmAction({
    title: `Put ${items.toLocaleString()} items on the map?`,
    body: [
      `${currentRegions().length} rooms and ${currentWalls().length} wall segments — large enough ` +
        "that the write may stall, or Owlbear may refuse it outright.",
      "Straighten and Prune under Walls cut the count and undo puts them back. You can stop the " +
        "write partway through and push again later.",
    ],
    confirmLabel: "Put it on the map",
  });
}

/**
 * Bind the bar's commit button.
 *
 * **In the bar rather than at the foot of a section, since 2026-09-14.** It is the surface's whole
 * purpose, and a control that only exists while one group happens to be open is a control a GM has
 * to go and find. Beside the way out is where it belongs, because closing does the same thing.
 *
 * Bound by id rather than built, like every other chip in the bar: the markup carries the bar's
 * order, and a button appended from here would have to know where in that order it goes.
 */
export function renderPushAction(): void {
  const button = document.getElementById("push");
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled = !controlsLive();

  // No note. All three of its sentences were reassurance — that closing does the same thing, that
  // edits are saved either way — and reassurance about a button is prose in the shape of a warning.
  /*
    The size question is asked first, and nothing is said or written until it is answered.

    **Through `pushCurrent` rather than the emit path directly**, which this used to call behind its
    back. One route in means this button gets the escape hatch, the settings write and the
    fingerprint on the same terms as every other push, rather than three call sites drifting.
  */
  const run = async (): Promise<void> => {
    try {
      if (!(await mayBeTooLarge())) return;
      say("putting it on the map…", "working");
      await pushCurrent();
    } catch (error) {
      const detail = describeError(error);
      say(`could not write to the scene: ${detail}`, "bad");
      devLog("error", "workspace: push failed", detail);
      console.error("Fog Nudger — push failed", error);
    } finally {
      button.disabled = !controlsLive();
    }
  };

  button.addEventListener("click", () => {
    // Disabled while it runs. A push takes seconds on a large map, which is exactly long enough for
    // a second click to land and write a second copy of everything.
    button.disabled = true;
    void run();
  });
}
