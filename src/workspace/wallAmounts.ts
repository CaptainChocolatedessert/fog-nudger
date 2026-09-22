/**
 * *Straighten* — the one action with an amount: a slider applied to every wall in front of the GM.
 *
 * ## Why it is an action and not the setting it replaced
 *
 * It was a parameter the derive read, so it could only ever apply to a fresh derivation — which meant
 * turning it **discarded every hand edit**, and that is why the group carrying it had to be locked at
 * all. Applied to the current graph it discards nothing, needs no lock, and works on a map the GM has
 * been correcting for an hour. After this the only things that regenerate the walls are the map and the
 * ink, which is the whole point of the workflow rework.
 *
 * The **fitting tolerance** that keeps a region inside Owlbear's command cap is a different number and
 * stays inside the derive, computed from the measured ink width rather than chosen.
 *
 * ## Prune shared this until 2026-09-22
 *
 * *Prune the dead ends* was the second amount here, with one pin and one commit for both. It is a
 * ringed tool now, like Mend (`pruneSearch.ts`): it takes a piece a click, so there is nothing to pin
 * and nothing to apply on the way out. **Straighten stays an amount because it has to** — it changes
 * every wall at once, so there is no piece of it to ring.
 *
 * ## One pin, one commit
 *
 * `graphLatch.ts` carries the reasoning. Arming the tool opens its drawer, which pins the graph; the
 * handle previews against that fixed base, so dragging back and forth is exact; putting the tool down
 * applies the result once as one undo entry. **The handle starts at zero every opening**, because at
 * any other position it would describe work already done.
 *
 * ## The preview substitutes
 *
 * It replaces the walls *and* the room fills on the canvas (user, 2026-09-18) rather than drawing a
 * proposal over them: the question is whether these are the walls you want, which only the result
 * answers, and straightening replaces every wall, so an overlay would draw a dense map twice.
 *
 * **Recomputed at most once a frame**, and timed into the dev log past 50ms. Straightening runs a total
 * quadratic crossing sweep — the one edit that cannot sweep only what moved, because it moves
 * everything — so if a room reports the handle dragging heavily, the split to make is a geometry-only
 * preview with the sweep left to the commit. That is not done, and the log is what would say it is
 * needed.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { fromSlider, SLIDER_STEPS, type ScaleLimits } from "../sliderScale";
import { simplifyWalls } from "../trace/planarOps";
import { currentToolDrawer, onStepChange } from "./drawer";
import { NO_LATCH, aimLatch, commitOf, openLatch, previewOf, revalidate, type GraphLatch } from "./graphLatch";
import { TRACK_FLOOR, bendTop, onGraphScale } from "./graphScale";
import { editableGraph, substituteGraph } from "./regions";
import { invalidate, say } from "./shell";
import { saveEditedWalls, wallsEdited } from "./stage";
import { workOn } from "./subject";

/**
 * The track's step. Its floor is `TRACK_FLOOR`, shared with Prune's and pinned for the reason given
 * there. **Nothing is stored, so there are no `SETTING_LIMITS` to borrow**: this is a transient amount,
 * which needs a range to draw a track against and nothing to normalise.
 */
const AMOUNT_STEP = 0.0001;

const SLIDER_ID = "straighten-amount";
const READOUT_ID = "straighten-readout";
const NOTE_ID = "wall-amounts-note";
/** What the note says with the handle at zero — the one sentence the name cannot carry. */
const RESTING = "Drag to fit the walls you have.";

let latch: GraphLatch = NO_LATCH;
/** Set while a frame is owed a preview, so a drag costs one recompute per frame rather than per pixel. */
let frameAsked = false;

function limits(): ScaleLimits | null {
  const top = bendTop();
  if (!top || !(top > 0)) return null;
  return { min: 0, max: top, step: AMOUNT_STEP, floor: TRACK_FLOOR };
}

export function renderAmountControls(body: HTMLElement): void {
  if (currentToolDrawer() !== "straighten") return;
  /*
    **The ordinary row's markup, which this did not use** (room, 2026-09-21: the readout printed as
    part of the label, *"Straighten7"*).

    It set `setting` and `readout`, and **neither class exists in the stylesheet** — so the label and
    the readout were two inline elements with nothing placing them and nothing colouring them, and they
    ran together. `settingRows.ts` builds `row > top > (label, value)` with the slider under it:
    `.row .top` is the flex that pushes the readout to the right, and `.row .value` is what makes it the
    monospace yellow.

    This is §8's rule from the other side. The sweep there finds classes a stylesheet styles that
    nothing sets; this was a class something set that nothing styles, which fails **silently** — the
    element is there, it is simply unstyled, and only a room can see that.

    No `track` wrapper, unlike a setting row: that exists to position a ghost mark and an ink profile
    against the rail, and an amount has neither.
  */
  const wrapper = document.createElement("div");
  wrapper.className = "row";
  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.htmlFor = SLIDER_ID;
  label.textContent = "Straighten";
  const readout = document.createElement("span");
  readout.id = READOUT_ID;
  readout.className = "value";
  top.append(label, readout);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = SLIDER_ID;
  slider.min = "0";
  slider.max = String(SLIDER_STEPS);
  slider.step = "1";
  slider.value = "0";
  slider.addEventListener("input", () => {
    // Aiming the amount at the walls in front of you is wall work. This draws its own track rather than
    // going through `settingRows`, so it says it for itself.
    workOn("walls");
    aim(Number(slider.value));
  });

  wrapper.append(top, slider);
  body.append(wrapper);

  const note = document.createElement("p");
  note.id = NOTE_ID;
  note.className = "sub";
  body.append(note);
  refresh();
}

function aim(position: number): void {
  const scale = limits();
  if (!scale) return;
  latch = revalidate(latch, editableGraph());
  if (!latch.base) {
    // The base went while the drawer was open — an undo, or a derive landing. Re-pin to what is there
    // now rather than refusing: the GM is still holding the handle, and the graph under it is real.
    latch = openLatch(editableGraph(), !wallsEdited());
    if (!latch.base) return;
  }
  latch = aimLatch(latch, position <= 0 ? 0 : fromSlider(position, scale, "log"));
  askForPreview();
  refresh();
}

function askForPreview(): void {
  if (frameAsked) return;
  frameAsked = true;
  requestAnimationFrame(() => {
    frameAsked = false;
    drawPreview();
  });
}

function drawPreview(): void {
  const pending = previewOf(latch);
  if (!pending) {
    substituteGraph(null);
    invalidate();
    return;
  }
  const started = performance.now();
  const shown = simplifyWalls(pending.base, pending.straighten).graph;
  const ms = performance.now() - started;
  substituteGraph(shown);
  invalidate();
  if (ms > 50) {
    devLog(
      "info",
      `workspace: straighten preview took ${ms.toFixed(0)}ms at ${pending.straighten.toExponential(2)} graph units`,
    );
  }
}

/** Whether the latch is pinned, held rather than read off the drawer for the reason `commit` gives. */
let pinned = false;

/**
 * Pin when the tool is armed, commit when it is put down.
 *
 * **Held rather than derived from the drawer**, because the commit has to know that a latch *was* open
 * after the drawer has already moved on. Every departure commits, including one caused by another press
 * stealing the drawer — safe because an untouched handle is zero and commits nothing. That is the paint
 * tools' own rule: leaving any other way saves rather than warns.
 */
onStepChange(() => {
  const mine = currentToolDrawer() === "straighten";
  if (mine === pinned) return;
  // Synchronous through the part that matters: `commit` reads the latch and clears it before its first
  // await, so re-pinning straight afterwards cannot race the save it started.
  if (pinned) void commit();
  pinned = mine;
  if (!mine) return;
  latch = openLatch(editableGraph(), !wallsEdited());
  refresh();
});

/** A derive or an undo replaces the document, which voids a latch pinned to the old one. */
onGraphScale(() => {
  latch = revalidate(latch, editableGraph());
  if (!latch.base) substituteGraph(null);
  refresh();
});

async function commit(): Promise<void> {
  /*
    Revalidated here and not only while the handle moves, which is the difference between the rule being
    enforced and being described. An undo or a derive landing while the drawer is open replaces the
    document, and committing a result computed against the base that has gone would discard the
    replacement without a word. Nothing is applied in that case — the amount goes with the latch, which
    is the loud answer: the GM sees the walls unchanged rather than quietly straightened.
  */
  const pending = commitOf(revalidate(latch, editableGraph()));
  latch = NO_LATCH;
  substituteGraph(null);
  if (!pending) return;

  const straightened = simplifyWalls(pending.base, pending.straighten);
  try {
    await saveEditedWalls(
      straightened.graph,
      "straightening the walls",
      pending.fromDerivation ? pending.base : undefined,
    );
    devLog(
      "info",
      `workspace: straightening the walls — straightened away ${straightened.removed} points at ` +
        `${pending.straighten.toExponential(2)} graph units, ${straightened.preserved} runs kept whole ` +
        `rather than collapsed, ${straightened.splits} crossings split`,
    );
    say(`took ${straightened.removed} points`);
  } catch (error) {
    const detail = describeError(error);
    say(`could not save the straightened walls: ${detail}`, "bad");
    devLog("error", "workspace: straightening failed to save", detail);
    console.error("Fog Nudger — straightening failed to save", error);
  }
}

/** The readout and the note, which say what the handle means and why it cannot move. */
function refresh(): void {
  const graph = editableGraph();
  const slider = document.getElementById(SLIDER_ID);
  const readout = document.getElementById(READOUT_ID);
  if (slider instanceof HTMLInputElement && readout) {
    slider.disabled = limits() === null || graph === null;
    /*
      **The handle's place on the track, 1 to 100 — not the value** (user, 2026-09-21): *"the values
      are not user friendly anyway, let's turn them into 1-100 just for remembering your place while
      trying them."* A graph unit is a fraction of the map's longer side, so the useful settings are
      around a thousandth and the number was a mantissa and an exponent.

      **It is a position, so it makes no claim to be a measurement**, and **`off` comes from the amount
      rather than the handle**: a latch voided by an undo or a derive leaves the handle where the GM left
      it and aims nothing, and saying "off" there is the same loud answer the note gives.
    */
    const place = Math.max(1, Math.round((Number(slider.value) / SLIDER_STEPS) * 100));
    readout.textContent = latch.straighten > 0 ? String(place) : "off";
  }

  const note = document.getElementById(NOTE_ID);
  if (!note) return;
  if (!graph) {
    note.textContent = "No walls yet, so there is nothing to straighten.";
    return;
  }
  // Says what closing does, because the commit is caused by leaving rather than by a button.
  note.textContent = previewOf(latch) ? "Applied when this drawer closes. One step of undo takes it back." : RESTING;
}

/** Re-ask the readout when a graph arrives. */
export function refreshWallAmounts(): void {
  refresh();
}
