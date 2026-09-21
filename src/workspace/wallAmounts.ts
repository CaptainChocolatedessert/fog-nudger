/**
 * The Walls drawer's two actions: *Prune the dead ends* and *Straighten*.
 *
 * ## Why they are actions and not the settings they replace
 *
 * Both were parameters the derive read, so they could only ever apply to a fresh derivation — which
 * meant turning either **discarded every hand edit**, and that is why the group carrying them had to be
 * locked at all. Applied to the current graph they discard nothing, need no lock, and work on a map the
 * GM has been correcting for an hour. After this the only things that regenerate the walls are the map
 * and the ink, which is the whole point of the rework.
 *
 * The **fitting tolerance** that keeps a region inside Owlbear's command cap is a different number and
 * stays inside the derive, computed from the measured ink width rather than chosen.
 *
 * ## One pin, two amounts, one commit
 *
 * `graphLatch.ts` carries the reasoning. Opening this drawer pins the graph; both handles preview
 * against that fixed base, so dragging back and forth is exact; closing applies the result once as one
 * undo entry. **Both handles start at zero every opening**, because at any other position they would
 * describe work already done.
 *
 * Two latches would not do: the first to save replaces the document, which voids the second by the
 * staleness rule, and its amount would vanish with nothing said.
 *
 * ## Pruning is applied first, and that is a decision
 *
 * Pruning deletes whole runs and straightening fits what remains. In that order the quadratic crossing
 * sweep runs on the smaller graph, and the result is the one a GM would predict — clean off the hairs,
 * then smooth what is left. The other order also *works*, but straightening first can shorten or lengthen
 * a dead end across the prune limit, so what the second handle takes would depend on the first in a way
 * neither preview shows.
 *
 * ## The preview substitutes
 *
 * It replaces the walls *and* the room fills on the canvas (user, 2026-09-18) rather than drawing a
 * proposal over them: the question is whether these are the walls you want, which only the result
 * answers, and straightening replaces every wall, so an overlay would draw a dense map twice.
 *
 * Pruning keeps its **red preview** as well, and it gets truer — it used to mark what a limit would take
 * from the *saved* graph on the grounds that a fresh derivation already had the limit applied. Nothing
 * applies it on the way through now, so the red marks what this drawer's press will take from the walls
 * in front of the GM, whichever graph those are.
 *
 * **Recomputed at most once a frame**, and timed into the dev log past 50ms. Straightening runs a total
 * quadratic crossing sweep — the one edit that cannot sweep only what moved, because it moves
 * everything — so if a room reports a handle dragging heavily, the split to make is a geometry-only
 * preview with the sweep left to the commit. That is not done, and the log is what would say it is
 * needed.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { fromSlider, SLIDER_STEPS, type ScaleLimits } from "../sliderScale";
import { simplifyWalls } from "../trace/planarOps";
import { pruneWallGraph, type WallGraph } from "../trace/wallGraph";
import { currentToolDrawer, onStepChange } from "./drawer";
import {
  NO_LATCH,
  aimLatch,
  commitOf,
  labelFor,
  openLatch,
  previewOf,
  revalidate,
  type GraphLatch,
  type WallAmount,
} from "./graphLatch";
import { bendTop, onGraphScale, spurTop } from "./graphScale";
import { editableGraph, substituteGraph } from "./regions";
import { invalidate, say } from "./shell";
import { saveEditedWalls, wallsEdited } from "./stage";
import { workOn } from "./subject";

/**
 * The floor both tracks start from, in graph units.
 *
 * **Pinned rather than the smallest thing in the graph**, and the reason is sharp: both of these delete
 * from the bottom, so the smallest run and the smallest bend are the most mobile quantities there are.
 * Prune at limit B and the shortest surviving run is B — a tracking floor would chase the handle upward
 * every opening, and the same position would mean a larger bite each time. That is the non-monotonicity
 * the two-slider gap design collapsed under.
 *
 * **Nothing is stored, so there are no `SETTING_LIMITS` to borrow.** Those belonged to the two
 * parameters the derive read. What is left here is a pair of transient amounts, which need a range to
 * draw a track against and nothing to normalise.
 */
const AMOUNT_FLOOR = 2e-4;
const AMOUNT_STEP = 0.0001;

interface Row {
  readonly which: WallAmount;
  readonly label: string;
  readonly sliderId: string;
  readonly readoutId: string;
  readonly top: () => number | null;
  /** What the note says when the handle is at zero — the one sentence a name cannot carry. */
  readonly resting: string;
}

const ROWS: readonly Row[] = [
  {
    which: "prune",
    label: "Prune the dead ends",
    sliderId: "prune-amount",
    readoutId: "prune-readout",
    top: spurTop,
    resting: "Drag to remove dead ends up to a length. What would go is drawn in red.",
  },
  {
    which: "straighten",
    label: "Straighten",
    sliderId: "straighten-amount",
    readoutId: "straighten-readout",
    top: bendTop,
    resting: "Drag to fit the walls you have.",
  },
];

const NOTE_ID = "wall-amounts-note";

let latch: GraphLatch = NO_LATCH;
/** Set while a frame is owed a preview, so a drag costs one recompute per frame rather than per pixel. */
let frameAsked = false;

function limitsFor(row: Row): ScaleLimits | null {
  const top = row.top();
  if (!top || !(top > 0)) return null;
  return { min: 0, max: top, step: AMOUNT_STEP, floor: AMOUNT_FLOOR };
}

/**
 * The pruning the drawer is about to do, for the layer that draws it in red.
 *
 * The **base** as well as the limit, because the marks have to be computed against the graph the press
 * will act on rather than against whatever is on screen — and while a preview is substituting, those are
 * different objects.
 */
export function pendingPrune(): { base: WallGraph; limit: number } | null {
  if (!latch.base || latch.prune <= 0) return null;
  return { base: latch.base, limit: latch.prune };
}

export function renderAmountControls(body: HTMLElement): void {
  /*
    **One row, belonging to the tool in hand** (user, 2026-09-21). Both used to be drawn together at
    the foot of the Walls group's drawer; they are two tools now, each opening its own.

    Asked of the drawer rather than of the armed tool, which is the same question by the shorter
    route: the drawer shows a tool's controls exactly while that tool is in hand, and this is
    registered as tool content so it is only called at all when one of the two is showing.
  */
  const armed = ROWS.filter((row) => row.which === currentToolDrawer());
  for (const row of armed) {
    const wrapper = document.createElement("div");
    wrapper.className = "setting";

    const label = document.createElement("label");
    label.htmlFor = row.sliderId;
    label.textContent = row.label;

    const readout = document.createElement("span");
    readout.id = row.readoutId;
    readout.className = "readout";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = row.sliderId;
    slider.min = "0";
    slider.max = String(SLIDER_STEPS);
    slider.step = "1";
    slider.value = "0";
    slider.addEventListener("input", () => {
      // Aiming an amount at the walls in front of you is wall work. These two draw their own tracks
      // rather than going through `settingRows`, so they say it for themselves.
      workOn("walls");
      aim(row, Number(slider.value));
    });

    wrapper.append(label, readout, slider);
    body.append(wrapper);
  }

  const note = document.createElement("p");
  note.id = NOTE_ID;
  note.className = "sub";
  body.append(note);
  refresh();
}

function aim(row: Row, position: number): void {
  const scale = limitsFor(row);
  if (!scale) return;
  latch = revalidate(latch, editableGraph());
  if (!latch.base) {
    // The base went while the drawer was open — an undo, or a derive landing. Re-pin to what is there
    // now rather than refusing: the GM is still holding the handle, and the graph under it is real.
    latch = openLatch(editableGraph(), !wallsEdited());
    if (!latch.base) return;
  }
  latch = aimLatch(latch, row.which, position <= 0 ? 0 : fromSlider(position, scale, "log"));
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

/** Prune, then straighten, and put the result on the canvas. */
function applyTo(base: WallGraph, prune: number, straighten: number): WallGraph {
  const pruned = prune > 0 ? pruneWallGraph(base, prune).graph : base;
  return straighten > 0 ? simplifyWalls(pruned, straighten).graph : pruned;
}

function drawPreview(): void {
  const pending = previewOf(latch);
  if (!pending) {
    substituteGraph(null);
    // The red marks are a function of the latch, so a handle returning to zero has to redraw without
    // them even though the substituted graph did not change.
    invalidate();
    return;
  }
  const started = performance.now();
  /*
    **Substituted only when straightening is aimed**, and that is what keeps both previews honest.

    Straightening replaces every wall, so the only way to judge it is to see the result. Pruning
    *removes* runs, and the established channel for that is the red marks — which say *what goes*, where
    a result can only say what is left, and a single missing hair is far harder to spot than a red one.
    So pruning alone shows the walls as they are with the doomed runs in red, exactly as it did when it
    was a slider.

    With both aimed, the result is substituted and the red goes with it: the runs are no longer in the
    picture, and at that point the GM is judging the whole outcome rather than one deletion.

    **The commit prunes first either way**, so what is substituted here is what closing applies. That is
    why straightening is never previewed against the unpruned base — removing a run can merge its
    neighbours into one longer run, which changes how straightening fits them.
  */
  const shown =
    pending.straighten > 0 ? applyTo(pending.base, pending.prune, pending.straighten) : null;
  const ms = performance.now() - started;
  substituteGraph(shown);
  invalidate();
  if (ms > 50) {
    devLog(
      "info",
      `workspace: wall amounts preview took ${ms.toFixed(0)}ms — prune ` +
        `${pending.prune.toExponential(2)}, straighten ${pending.straighten.toExponential(2)} graph units`,
    );
  }
}

/**
 * Which of the two the latch is pinned for, or `null` for neither.
 *
 * **Held rather than derived from the drawer**, because the commit has to know that a latch *was*
 * open after the drawer has already moved on. Reading the drawer at that moment answers where the
 * GM is going, not where they have been.
 */
let pinnedFor: WallAmount | null = null;

/**
 * Pin when one of the two is armed, commit when it is put down.
 *
 * **The drawer is the event, exactly as it was** — what changed on 2026-09-21 is which drawer. It
 * was the Walls group's, opened by its settings button; it is each tool's own now, opened by arming
 * the tool. The latch's rule is untouched: the handle previews against a fixed base, so dragging
 * back and forth inside one opening is free, and closing applies the result once as one undo entry.
 *
 * Every departure commits, including one caused by another press stealing the drawer — safe because
 * an untouched handle is zero and commits nothing. That is the paint tools' own rule: leaving any
 * other way saves rather than warns.
 *
 * **Arming the other one commits the first**, which is the cost of them being two tools rather than
 * two sliders in one drawer. They shared a pinned base and a single undo entry, and with both aimed
 * the straightened result was substituted and Prune's red marks went with it; that is gone.
 */
onStepChange(() => {
  const showing = currentToolDrawer();
  const mine = showing === "prune" || showing === "straighten" ? showing : null;
  if (mine === pinnedFor) return;
  // Synchronous through the part that matters: `commit` reads the latch and clears it before its
  // first await, so re-pinning straight afterwards cannot race the save it started.
  if (pinnedFor) void commit();
  pinnedFor = mine;
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
    Revalidated here and not only while a handle moves, which is the difference between the rule being
    enforced and being described. An undo or a derive landing while the drawer is open replaces the
    document, and committing a result computed against the base that has gone would discard the
    replacement without a word. Nothing is applied in that case — the amounts go with the latch, which
    is the loud answer: the GM sees the walls unchanged rather than quietly tidied.
  */
  const revalidated = revalidate(latch, editableGraph());
  const pending = commitOf(revalidated);
  const label = labelFor(revalidated);
  latch = NO_LATCH;
  substituteGraph(null);
  if (!pending) return;

  const pruned = pending.prune > 0 ? pruneWallGraph(pending.base, pending.prune) : null;
  const from = pruned ? pruned.graph : pending.base;
  const straightened = pending.straighten > 0 ? simplifyWalls(from, pending.straighten) : null;
  const result = straightened ? straightened.graph : from;

  try {
    await saveEditedWalls(result, label, pending.fromDerivation ? pending.base : undefined);
    devLog(
      "info",
      `workspace: ${label} — pruned ${pruned ? pruned.removed : 0} runs (${pruned ? pruned.segments : 0} segments) at ` +
        `${pending.prune.toExponential(2)}, straightened away ${straightened ? straightened.removed : 0} ` +
        `points at ${pending.straighten.toExponential(2)} graph units, ` +
        `${straightened ? straightened.preserved : 0} runs kept whole rather than collapsed, ` +
        `${straightened ? straightened.splits : 0} crossings split`,
    );
    const took =
      (pruned ? `${pruned.removed} dead ends` : "") +
      (pruned && straightened ? " and " : "") +
      (straightened ? `${straightened.removed} points` : "");
    say(took === "" ? "nothing to take at those amounts" : `took ${took}`);
  } catch (error) {
    const detail = describeError(error);
    say(`could not save the tidied walls: ${detail}`, "bad");
    devLog("error", "workspace: wall amounts failed to save", detail);
    console.error("Fog Nudger — wall amounts failed to save", error);
  }
}

/** The readouts and the one note, which say what the handles mean and why they cannot move. */
function refresh(): void {
  const graph = editableGraph();
  for (const row of ROWS) {
    const slider = document.getElementById(row.sliderId);
    const readout = document.getElementById(row.readoutId);
    if (!(slider instanceof HTMLInputElement) || !readout) continue;
    const scale = limitsFor(row);
    slider.disabled = scale === null || graph === null;
    const amount = latch[row.which];
    /*
      **The handle's place on the track, 1 to 100 — not the value** (user, 2026-09-21).

      It printed the amount in graph units, in exponential notation, and a room asked for something
      it could use: *"the values are not user friendly anyway, let's turn them into 1-100 just for
      remembering your place while trying them."* That names what the readout is for exactly. A
      graph unit is a fraction of the map's longer side, so the useful settings are around a
      thousandth and the number was three characters of mantissa and an exponent — unreadable, and
      not comparable to anything a GM can see.

      **It is a position, so it makes no claim to be a measurement.** Nothing is stored, the handle
      starts at zero on every opening, and the only question it has to answer is *where was I before
      I dragged past it*. The real figure still reaches the log on every commit.

      **`off` comes from the amount rather than the handle**, which is why the two are read
      separately. A latch voided by an undo or a derive landing leaves the handle where the GM left
      it and aims nothing — saying "off" there is the same loud answer the note gives.
    */
    const place = Math.max(1, Math.round((Number(slider.value) / SLIDER_STEPS) * 100));
    readout.textContent = amount > 0 ? String(place) : "off";
  }

  const note = document.getElementById(NOTE_ID);
  if (!note) return;
  if (!graph) {
    note.textContent = "No walls yet, so there is nothing to tidy.";
    return;
  }
  const pending = previewOf(latch);
  // Says what closing does, because the commit is caused by leaving rather than by a button.
  /*
    The resting sentence is the armed row's alone. It joined both with a space while the two shared a
    drawer, which read as one instruction about one control the moment they were split apart.
  */
  const armed = ROWS.find((row) => row.which === currentToolDrawer());
  note.textContent = pending
    ? "Applied when this drawer closes. One step of undo takes it back."
    : (armed?.resting ?? "");
}

/** Re-ask the readouts when a graph arrives. */
export function refreshWallAmounts(): void {
  refresh();
}
