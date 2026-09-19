/**
 * *Straighten*, the slider that fits the walls in front of the GM rather than the ones the trace made.
 *
 * ## Why it is an action and not the setting it replaces
 *
 * Straightening was a tolerance the derive read, so it could only ever apply to a fresh derivation —
 * which meant turning the handle **discarded every hand edit**, and that is why the group carrying it
 * had to be locked at all. Applied to the current graph it discards nothing, needs no lock, and works
 * on a map the GM has been correcting for an hour.
 *
 * The fitting tolerance that keeps a region inside Owlbear's command cap is a different number and
 * stays inside the derive, where it is computed from the measured ink width rather than chosen.
 *
 * ## The drawer is the gesture
 *
 * `graphLatch.ts` carries the reasoning; the short version is that opening the Walls drawer pins the
 * graph, the handle previews against that fixed base so dragging back and forth is exact, and closing
 * the drawer applies the result once as a single undo entry. **The handle starts at zero every time**,
 * because at any other position it would describe work already done.
 *
 * ## The preview substitutes
 *
 * It replaces the walls *and* the room fills on the canvas (user, 2026-09-18), rather than drawing a
 * proposal over them: the question is whether these are the walls you want, which only the result
 * answers, and an overlay would draw every wall of a dense map twice.
 *
 * **Searched at most once a frame**, and timed into the dev log. Straightening runs a total quadratic
 * crossing sweep — the one edit that cannot sweep only what moved, because it moves everything — so if
 * a room reports the handle dragging heavily, the split to make is a geometry-only preview with the
 * sweep left to the commit. That is not done yet, and the log is what would say it is needed.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { SETTING_LIMITS } from "../settings";
import { simplifyWalls } from "../trace/planarOps";
import type { WallGraph } from "../trace/wallGraph";
import { onStepChange } from "./drawer";
import {
  NO_LATCH,
  aimLatch,
  commitOf,
  openLatch,
  previewOf,
  revalidate,
  type GraphLatch,
} from "./graphLatch";
import { graphScaleTop, onGraphScale } from "./graphScale";
import { editableGraph, substituteGraph } from "./regions";
import { say } from "./shell";
import { saveEditedWalls, wallsEdited } from "./stage";
import { fromSlider, SLIDER_STEPS, toSlider, type ScaleLimits } from "../sliderScale";

const SLIDER_ID = "straighten-amount";
const READOUT_ID = "straighten-readout";
const NOTE_ID = "straighten-note";

let latch: GraphLatch = NO_LATCH;
/** Set while a frame is owed a preview, so a drag costs one straighten per frame rather than per pixel. */
let frameAsked = false;

/**
 * The track's top, measured off the graph.
 *
 * The largest **bend** — how far one vertex sits off the line joining its neighbours — which is
 * per-vertex rather than per-wall on purpose: a whole wall's deviation from the chord between its ends
 * is dominated by the exterior, which departs from its own chord by something like half the map, and
 * every useful setting would sit in the first percent of the track.
 *
 * Still read through the settings' own scale entry while the tolerance is still declared there. When
 * that declaration goes, this becomes a direct call for the same measurement.
 */
function limits(): ScaleLimits | null {
  const top = graphScaleTop("simplifyGraphUnits");
  if (!top || !(top > 0)) return null;
  const declared = SETTING_LIMITS.simplifyGraphUnits;
  return { min: 0, max: top, step: declared.step, floor: declared.floor };
}

export function renderStraightenAction(body: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "setting";

  const label = document.createElement("label");
  label.htmlFor = SLIDER_ID;
  label.textContent = "Straighten";

  const readout = document.createElement("span");
  readout.id = READOUT_ID;
  readout.className = "readout";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = SLIDER_ID;
  slider.min = "0";
  slider.max = String(SLIDER_STEPS);
  slider.step = "1";
  slider.value = "0";

  const note = document.createElement("p");
  note.id = NOTE_ID;
  note.className = "sub";

  slider.addEventListener("input", () => {
    aim(Number(slider.value));
  });

  row.append(label, readout, slider);
  body.append(row, note);
  refresh();
}

/** Aim the handle, and ask for a preview on the next frame. */
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
    return;
  }
  const started = performance.now();
  const result = simplifyWalls(pending.base, pending.amount);
  const ms = performance.now() - started;
  substituteGraph(result.graph);
  if (ms > 50) {
    devLog(
      "info",
      `workspace: straighten preview took ${ms.toFixed(0)}ms at ${pending.amount.toExponential(2)} ` +
        `graph units — ${result.removed} points removed, ${result.splits} crossings split`,
    );
  }
}

/**
 * Latch on the way into Walls, commit on the way out.
 *
 * Every departure commits, including one caused by another press stealing the drawer — which is safe
 * because an untouched handle is zero and commits nothing. That is the paint tools' own rule: leaving
 * any other way saves rather than warns.
 */
onStepChange((step) => {
  if (step === "walls") {
    latch = openLatch(editableGraph(), !wallsEdited());
    const slider = document.getElementById(SLIDER_ID);
    if (slider instanceof HTMLInputElement) slider.value = "0";
    refresh();
    return;
  }
  void commit();
});

/** A derive or an undo replaces the document, which voids a latch pinned to the old one. */
onGraphScale(() => {
  latch = revalidate(latch, editableGraph());
  if (!latch.base) substituteGraph(null);
  refresh();
});

async function commit(): Promise<void> {
  /*
    Revalidated here and not only while the handle moves, which is the difference between the rule
    being enforced and being described. An undo or a derive landing while the drawer is open replaces
    the document, and committing a result computed against the base that has gone would discard the
    replacement without a word. Nothing is applied in that case — the amount goes with the latch,
    which is the loud answer: the GM sees the walls unchanged rather than silently re-straightened.
  */
  const pending = commitOf(revalidate(latch, editableGraph()));
  latch = NO_LATCH;
  substituteGraph(null);
  if (!pending) return;

  const result = simplifyWalls(pending.base, pending.amount);
  try {
    await saveEditedWalls(
      result.graph,
      "straightening the walls",
      pending.fromDerivation ? pending.base : undefined,
    );
    devLog(
      "info",
      `workspace: straightened at ${pending.amount.toExponential(2)} graph units — ` +
        `${result.removed} points removed, ${result.preserved} runs kept whole rather than ` +
        `collapsed, ${result.splits} crossings split, ${result.overlaps} collinear overlaps left`,
    );
    say(
      result.removed === 0
        ? "straightening removed nothing at that amount"
        : `straightened — ${result.removed} points removed`,
    );
  } catch (error) {
    const detail = describeError(error);
    say(`could not save the straightened walls: ${detail}`, "bad");
    devLog("error", "workspace: straighten failed to save", detail);
    console.error("Fog Nudger — straighten failed to save", error);
  }
}

/** The readout and the note, which say what the handle means and why it cannot move. */
function refresh(): void {
  const slider = document.getElementById(SLIDER_ID);
  const readout = document.getElementById(READOUT_ID);
  const note = document.getElementById(NOTE_ID);
  if (!(slider instanceof HTMLInputElement) || !readout || !note) return;

  const scale = limits();
  const graph: WallGraph | null = editableGraph();
  // No check on which drawer is open: this control only exists while the Walls drawer is showing,
  // and asking would make the row depend on the render order settling first.
  const ready = scale !== null && graph !== null;

  slider.disabled = !ready;
  if (!graph) {
    readout.textContent = "";
    note.textContent = "No walls yet, so there is nothing to straighten.";
    return;
  }
  if (!scale) {
    readout.textContent = "";
    note.textContent = "These walls are already straight — no bend to measure a range against.";
    return;
  }

  readout.textContent =
    latch.amount > 0 ? `${latch.amount.toExponential(2)} graph units` : "off";
  // Says what closing does, because the commit is caused by leaving rather than by a button.
  note.textContent =
    latch.amount > 0
      ? "Applied when this drawer closes. One step of undo takes it back."
      : "Drag to fit the walls you have. It applies when the drawer closes.";
}

/** Re-ask the readout when a graph arrives. */
export function refreshStraightenAction(): void {
  refresh();
}

/** Position the handle would sit at for an amount — exported for the tests that pin the scale. */
export function straightenSliderPosition(amount: number): number {
  const scale = limits();
  return scale ? toSlider(amount, scale, "log") : 0;
}
