/**
 * Writing the scene: the editor's button, the ink mode's save, and the close hook.
 *
 * ## Who pushes, and when — and the two modes answer differently on purpose
 *
 * **The editor pushes on close.** Its edits are written to the document as they are made, so the
 * scene is simply behind the thing the GM has already committed to; catching it up on the way out is
 * what makes that mode end by looking at the table. Its own button is the mid-session case — a
 * change a table is waiting on, made without giving up the surface.
 *
 * **The ink mode pushes only when the GM saves** (user, 2026-09-05: *"saving out of ink mode pushes
 * that graph"*). Nothing there is committed until they say so, which is exactly what makes reopening
 * it over an edited graph harmless. A close-time push would undo that in one keystroke: a GM who
 * opened stage one to look at their threshold and pressed Escape would have replaced their walls.
 *
 * That asymmetry is the two-mode split showing through rather than an inconsistency. One mode holds
 * a draft; the other holds the document.
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
import { paintRevision } from "../trace/inkPaint";
import { wallGraph } from "./stage";
import { inEditor } from "./mode";
import { controlsLive } from "./settingRows";
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
  return `${map ?? "none"}|${JSON.stringify(currentSettings())}|${edits}|${painted}`;
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
  /*
    The ink mode writes nothing on the way out.

    Its product is a *derivation* — one re-run away from the settings and paint that are already
    stored — so leaving loses nothing, and pushing it would commit a graph the GM did not ask to
    commit over one they may have spent an evening editing. Saving is the deliberate act, and it has
    two buttons of its own at the foot of Walls.
  */
  if (!inEditor()) {
    devLog("info", "workspace: closing the ink mode, which commits nothing on its own");
    return;
  }
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
export async function pushCurrent(): Promise<boolean> {
  await persistSettings();
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

export function renderPushAction(body: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "step-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = "Put on the map";
  button.disabled = !controlsLive();

  const note = document.createElement("p");
  note.className = "sub";
  note.textContent =
    "Replaces what we put in the scene before with the walls as they are now. Closing this does the " +
    "same thing, so it is only needed to update the table without stopping work — your edits are " +
    "saved as you make them either way.";

  button.addEventListener("click", () => {
    /*
      Disabled while it runs. A push takes seconds on a large map, which is exactly long enough for a
      second click to land and write a second copy of everything.

      **Through `pushCurrent` rather than the emit path directly**, which it used to call behind its
      back. One route in means this button gets the escape hatch, the settings write and the
      fingerprint on the same terms as every other push, rather than three call sites drifting.
    */
    button.disabled = true;
    say("putting it on the map…", "working");
    void pushCurrent()
      .catch((error: unknown) => {
        const detail = describeError(error);
        say(`could not write to the scene: ${detail}`, "bad");
        devLog("error", "workspace: push failed", detail);
        console.error("Fog Nudger — push failed", error);
      })
      .finally(() => {
        button.disabled = !controlsLive();
      });
  });

  actions.append(button);
  body.append(actions, note);
}
