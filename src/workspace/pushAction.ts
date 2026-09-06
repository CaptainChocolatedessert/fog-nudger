/**
 * "Put on the map" — the one button on this surface that writes to the scene, and the close hook.
 *
 * The **Walls** step ends with it, because that is the last step of stage one and the one that now
 * shows what would be written — the partition, with the centrelines that decide it drawn over the
 * top. Judging a thing and writing it belong next to each other. It was the Regions step until that
 * step was dissolved into this one.
 *
 * ## Closing pushes, and the button is for not having to close
 *
 * The scene is a rendering of the wall graph, so it should say what the graph currently says. Closing
 * the workspace is the natural moment for that: the GM has stopped tuning. The button exists for the
 * other case — a mid-session change a table is waiting on, made without giving up the surface.
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
 * The frozen graph is handed to `pushToFog` from here, because the emit path has no business knowing
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
import { pushToFog, pushWouldChange } from "../emit/emitRegions";
import { readNominatedMapId } from "../map/mapImage";
import { encodeFrozenGraph } from "../trace/frozenGraph";
import { paintRevision } from "../trace/inkPaint";
import { frozenGraph } from "./stage";
import { controlsLive } from "./settingRows";
import { currentPaint } from "./paintState";
import { currentSettings, persistSettings } from "./settingsState";
import { say } from "./shell";

/**
 * What the scene would receive, as one string.
 *
 * The map plus every setting, rather than only the ones that reach the emitted geometry. Over-broad
 * on purpose and for the same reason the mask fingerprint is: a missed entry here means a stale
 * scene reported as current, and an extra one costs a push nobody minded.
 */
async function fingerprint(): Promise<string> {
  const map = await readNominatedMapId();
  const graph = frozenGraph();
  // In stage two the settings no longer decide the geometry, so on their own they would report an
  // evening of editing as "nothing changed".
  const edits = graph ? encodeFrozenGraph(graph) : "";
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
 * than frozen.
 *
 * **The status is said after the fingerprint check, not before**, and that ordering is the whole of
 * requirement 4. Opening the workspace to glance at something and closing it is the common case, and
 * it pushes nothing — announcing "putting it on the map…" and then vanishing would put a flicker on
 * every close that did no work, which reads as the tool doing something it did not do.
 */
export async function pushOnClose(): Promise<void> {
  if (!controlsLive()) return;
  const mark = await fingerprint();
  if (!pushWouldChange(mark)) {
    devLog("info", "workspace: closing with nothing to push — the scene already says this");
    return;
  }

  say("putting it on the map…", "working");
  try {
    await persistSettings();
    const message = await pushToFog(mark, frozenGraph() ?? undefined);
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
    "Replaces what we put in the scene before with what is on screen now — your edited walls once " +
    "the graph is generated, and what the map reads before that. Closing the workspace does the " +
    "same thing, so this is only needed to update the table without stopping work.";

  button.addEventListener("click", () => {
    // Disabled while it runs. A push takes seconds on a large map, which is exactly long enough for
    // a second click to land and write a second copy of everything.
    button.disabled = true;
    say("putting it on the map…", "working");
    void persistSettings()
      .then(fingerprint)
      .then((mark) => pushToFog(mark, frozenGraph() ?? undefined))
      .then((message) => say(message))
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
