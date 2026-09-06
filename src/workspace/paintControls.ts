/**
 * The tool picker inside the Ink step, and the buttons under it.
 *
 * The same shape the wall tools settled into: a row saying what a press does, the controls for
 * whichever one is chosen, and the thing that acts on the work at the bottom. Drawn rather than
 * described, for the reason the map picker and the ink swatches are — a native control opened from a
 * sandboxed third-party iframe paints against the *system* background, and the first version of the
 * map picker rendered white on white and looked empty.
 *
 * ## One picker for three tools, because there is one step now
 *
 * Suppress ink and Add ink were steps with a Paint/Erase picker each. Merging them (user,
 * 2026-09-05) inverts that: the picker names the **layer**, because that is the half a single step
 * can no longer say, and paint-versus-erase becomes a pair inside whichever brush is chosen — "a
 * choice of brushes", in the user's words.
 *
 * ## Clicking the chosen tool turns it off
 *
 * The same gesture the accordion's own headers have, and it is what gives the step a state where a
 * plain drag pans. Without it the Ink step would take every press from the moment it opened, which
 * would make the sliders above it unusable without holding Ctrl.
 *
 * ## Choosing a tool rebuilds the panel rather than patching it
 *
 * Because the disclosed rows are real setting rows, with hint painters registered against them. A
 * local rebuild would leave those painters pointing at detached elements and grow the list on every
 * click; `renderPanel` clears them first, which is the same reason a step's Defaults repaints
 * wholesale. There is deliberately no subscription here — the accordion rebuilds this body on every
 * header click, so a listener would leak one per click.
 */

import { PAINT_NAMES, type PaintKind } from "../inkPaintStore";
import { STEPS, groupControls, toolGroups } from "../steps";
import { confirmAction } from "./confirmDialog";
import { renderPanel } from "./accordion";
import { brushKind, type PaintTool } from "./paintGesture";
import { anyUnsavedPaint, hasUnsavedPaint, paintRaster, workingLayer } from "./paintState";
import {
  abandonPaint,
  acceptAllShownBreaks,
  currentPaintTool,
  currentVerb,
  finishPaint,
  setPaintTool,
  setVerb,
} from "./paintTool";
import { settingRow } from "./settingRows";
import { paintStroke } from "../trace/inkPaint";
import { refreshPaintRegion } from "./layers/paint";
import { invalidate, say } from "./shell";
import { inStageTwo } from "./stage";

/** The step the tools belong to, looked up once so the tool declarations are read rather than copied. */
function inkStep(): (typeof STEPS)[number] | undefined {
  return STEPS.find((step) => step.id === "ink");
}

/**
 * The picker and everything it discloses.
 *
 * Registered as the Ink step's **bottom** content, so it sits under the reading sliders it corrects
 * the results of. That ordering is the step's argument in miniature: the sliders decide what the map
 * says, and the tools are for the places where no slider can be right.
 */
export function renderInkTools(body: HTMLElement): void {
  const step = inkStep();
  if (!step) return;

  if (inStageTwo()) {
    body.append(frozenNotice());
    return;
  }

  const tools = toolGroups(step);
  const active = currentPaintTool();

  const heading = document.createElement("h3");
  heading.textContent = "Correcting it by hand";
  const lead = document.createElement("p");
  lead.className = "sub";
  lead.innerHTML =
    "Three tools, all writing into layers of your own that survive every re-read. Pick one to use " +
    "it; <b>pick it again to put it down</b>, which is when dragging pans as usual.";
  body.append(heading, lead);

  const row = document.createElement("div");
  row.className = "step-actions";
  for (const group of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = group.title;
    // `aria-pressed` is the selected style already, so it carries the look and the meaning together
    // rather than a class saying the same thing beside it.
    button.setAttribute("aria-pressed", String(group.tool === active));
    button.addEventListener("click", () => {
      setPaintTool(group.tool === active ? "none" : (group.tool as PaintTool));
      renderPanel();
    });
    row.append(button);
  }
  body.append(row);

  const chosen = tools.find((group) => group.tool === active);
  if (!chosen) {
    const idle = document.createElement("p");
    idle.className = "hint";
    idle.textContent =
      "No tool in hand, so dragging pans and the sliders above are all that is acting on the map.";
    body.append(idle);
  } else {
    const hint = document.createElement("p");
    hint.className = "sub";
    hint.innerHTML = chosen.blurb;
    body.append(hint);

    const kind = brushKind(active);
    if (kind) body.append(verbRow(kind));

    for (const control of groupControls(chosen)) {
      body.append(settingRow(control));
    }

    body.append(kind ? brushActions(kind) : breakActions());
  }

  // Last, and outside the branch: saving is one act for both layers, so it belongs to the step
  // rather than to whichever tool happens to be in hand — including no tool at all.
  renderSave(body);
}

/**
 * Paint or erase, for whichever brush is in hand.
 *
 * A second row rather than two more entries in the picker above, because they are not the same kind
 * of choice: the picker says which layer is being edited and this says what is being done to it.
 * Five flat buttons would have said neither.
 */
function verbRow(kind: PaintKind): HTMLElement {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = "step-actions";
  const current = currentVerb(kind);
  for (const verb of ["paint", "erase"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = verb === "paint" ? labelFor(kind) : eraseLabelFor(kind);
    button.setAttribute("aria-pressed", String(verb === current));
    button.addEventListener("click", () => {
      setVerb(kind, verb);
      renderPanel();
    });
    row.append(button);
  }

  const note = document.createElement("p");
  note.className = "hint";
  note.innerHTML = "<b>Shift</b> swaps these for the length of one stroke, which is what a correction usually is.";

  wrapper.append(row, note);
  return wrapper;
}

/** What laying paint down is called on each layer, which is not the same word. */
function labelFor(kind: PaintKind): string {
  return kind === "suppress" ? "Cover" : "Draw";
}

function eraseLabelFor(kind: PaintKind): string {
  return kind === "suppress" ? "Uncover" : "Rub out";
}

/**
 * Discard and Clear, for the brush in hand.
 *
 * **There is no Done here**, and its absence is the merge showing through: with both layers open,
 * saving is one act for both and belongs at the foot of the step rather than inside a tool. What is
 * left in the tool is the pair that acts on *this* layer alone — and per layer is the point, since
 * discarding the suppression because a stroke of added ink went wrong would be one button destroying
 * work it was never pointed at.
 */
function brushActions(kind: PaintKind): HTMLElement {
  const wrapper = document.createElement("div");
  const row = document.createElement("div");
  row.className = "step-actions";

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "chip quiet";
  discard.textContent = "Discard changes";
  discard.addEventListener("click", () => {
    if (!hasUnsavedPaint(kind)) {
      say(`the ${PAINT_NAMES[kind]} has not changed since it was last saved`);
      return;
    }
    void confirmAction({
      title: `Discard the changes to the ${PAINT_NAMES[kind]}?`,
      // Names what survives as well as what goes, which is the rule the one-way door's confirmations
      // follow: without it "discard" reads as losing the whole layer.
      body: [
        `The strokes made to the ${PAINT_NAMES[kind]} since it was last saved are lost.`,
        "Everything saved before that stays, and so do the reading settings, the other layer and " +
          "the map.",
      ],
      confirmLabel: "Discard",
      destructive: true,
    }).then((yes) => {
      if (yes) abandonPaint(kind);
    });
  });

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "chip quiet";
  clear.textContent = "Clear layer";
  clear.addEventListener("click", () => {
    void clearWholeLayer(kind);
  });

  row.append(discard, clear);
  wrapper.append(row);
  return wrapper;
}

/** The break tool's one button, which is the reason the automatic search still earns its place. */
function breakActions(): HTMLElement {
  const row = document.createElement("div");
  row.className = "step-actions";

  const acceptAll = document.createElement("button");
  acceptAll.type = "button";
  acceptAll.className = "chip";
  acceptAll.textContent = "Close every break shown";
  acceptAll.addEventListener("click", () => {
    acceptAllShownBreaks();
  });

  row.append(acceptAll);
  return row;
}

/**
 * Save now, at the foot of the step, for both layers at once.
 *
 * **Not the only way work is kept**, and saying so is the point of its blurb: leaving the step or
 * closing the workspace saves too. That keeps the standing claim true — nothing on this surface is
 * ever lost by navigating away — and it makes the tools' own Discard the only control here that
 * throws anything away, which is the right shape for the one that does.
 */
function renderSave(body: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "step-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "chip";
  save.textContent = "Save the ink edits";
  save.addEventListener("click", () => {
    if (!anyUnsavedPaint()) {
      say("nothing has changed since the ink edits were last saved");
      return;
    }
    void finishPaint("save");
  });

  const note = document.createElement("p");
  note.className = "sub";
  note.innerHTML =
    "Writes both hand-made layers and rebuilds the ink. Leaving this step or closing the workspace " +
    "does the same thing &mdash; nothing here is lost by navigating away, and this is only for " +
    "seeing the effect without going anywhere.";

  row.append(save);
  body.append(row, note);
}

/**
 * What the tools say once the graph is frozen.
 *
 * The same treatment the reading sliders get, and for the same reason: §8 wants a boundary visible
 * *before* it is crossed, so the tools are simply not here rather than present and inert. Painting is
 * a reading input and the frozen graph does not re-derive from the reading — a stroke made here would
 * change nothing visible and then take effect on starting over.
 */
function frozenNotice(): HTMLElement {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "Closed — the graph is frozen, so what you painted is not being read any more. Start over, " +
    "under Edit walls, reopens this. Your painting is kept either way.";
  return note;
}

/**
 * Wipe one layer, after asking.
 *
 * Through the brush rather than by replacing the layer, so there is one path by which a paint layer
 * changes and one place the surface finds out about it. Replacing the array would need the painter
 * to be told separately, which is a second mechanism for the same event.
 */
async function clearWholeLayer(kind: PaintKind): Promise<void> {
  const layer = workingLayer(kind);
  if (!layer) return;

  const raster = paintRaster();
  const yes = await confirmAction({
    title: `Clear the whole ${PAINT_NAMES[kind]} layer?`,
    body: [
      `Every mark on the ${PAINT_NAMES[kind]} goes, including ones already saved.`,
      "The reading settings, the other layer and the map are untouched. Nothing is written until " +
        "you save or leave the step, so Discard changes still brings it back.",
    ],
    confirmLabel: "Clear it",
    destructive: true,
  });
  if (!yes) return;

  // A stroke wide enough to cover the raster, which is the brush's own erase applied everywhere.
  const width = raster?.width ?? layer.width;
  const height = raster?.height ?? layer.height;
  const result = paintStroke(
    layer,
    { x: width / 2, y: height / 2 },
    { x: width / 2, y: height / 2 },
    Math.hypot(width, height),
    false,
  );
  if (result.bounds) refreshPaintRegion(result.bounds);
  say(`cleared ${result.changed} px · not saved until you save or leave Ink`);
  invalidate();
}
