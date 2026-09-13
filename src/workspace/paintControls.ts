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
import { confirmAction } from "../confirmDialog";
import { renderPanel } from "./accordion";
import { brushKind } from "./paintGesture";
import { anyUnsavedPaint, hasUnsavedPaint, paintRaster, workingLayer } from "./paintState";
import {
  abandonPaint,
  acceptAllShownGaps,
  currentPaintTool,
  currentVerb,
  finishPaint,
  setVerb,
} from "./paintTool";
import { settingRow } from "./settingRows";
import { paintStroke } from "../trace/inkPaint";
import { refreshPaintRegion } from "./layers/paint";
import { invalidate, say } from "./shell";

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
/**
 * The tool in hand, drawn into the **pinned head**.
 *
 * ## Why this is not in the Ink step any more — user, 2026-09-09
 *
 * It was, at the foot of the step body, and a room reported the brush width simply missing. Three
 * things had to be true at once for it to be on screen: the section expanded, a tool selected, and a
 * scroll past the sliders and the Linework group to the bottom. *"They can get lost in the scrolling
 * or a collapsed section."*
 *
 * The head is where a tool's things already lived — the hint sits there because a tool's controls
 * "may be collapsed while the tool is still in hand", which is the same argument one step short of
 * its conclusion. `accordion.ts` states the rule this settles: the body is about the map, the head
 * is about the hand.
 *
 * **Everything the tool owns comes**, the verb and the actions as well as the width, rather than
 * splitting the pair across two places — which is the thing being fixed rather than a shape to
 * reproduce. Discard confirms before it destroys anything, so a pinned button is not a new hazard.
 *
 * Empty when nothing is in hand: no heading, no "pick a tool" line. There is nothing to label when
 * there is nothing there, and the strip is what says a tool can be picked.
 */
export function renderToolControls(head: HTMLElement): void {
  const step = inkStep();
  if (!step) return;

  const active = currentPaintTool();
  const chosen = toolGroups(step).find((group) => group.tool === active);
  if (!chosen) return;

  /*
    The blurb is NOT drawn here, and that is the duplication this had before.

    `toolPalette` paints the same string into `#tool-hint`, immediately above this — its fallback for
    a tool with no hint of its own is exactly this group's blurb. Two copies, an inch apart.
  */
  const kind = brushKind(active);
  if (kind) head.append(verbRow(kind));

  for (const control of groupControls(chosen)) {
    head.append(settingRow(control));
  }

  head.append(kind ? brushActions(kind) : gapActions());
}

/**
 * Saving, which stays at the foot of the Ink step.
 *
 * **It did not go to the head with the rest**, and the split is the rule rather than an exception:
 * saving is one act for *both* layers, so it belongs to the step and not to whichever tool happens
 * to be in hand — including no tool at all. A GM who paints, puts the brush down and then wants the
 * work committed must still find it.
 */
export function renderInkSave(body: HTMLElement): void {
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
    button.textContent = verb === "paint" ? PAINT_VERB : ERASE_VERB;
    button.setAttribute("aria-pressed", String(verb === current));
    button.addEventListener("click", () => {
      setVerb(kind, verb);
      renderPanel();
    });
    row.append(button);
  }

  const note = document.createElement("p");
  note.className = "hint";
  // Kept, short. The tool's own blurb names what Shift does *from the default verb*; this is the
  // general statement, and it stays true when the GM flips the row.
  note.innerHTML = "<b>Shift</b> swaps these for one stroke.";

  wrapper.append(row, note);
  return wrapper;
}

/*
  One pair of verbs for both layers (user, 2026-09-09).

  It was **Cover / Uncover** on suppression and **Draw / Rub out** on added ink, and the trouble is
  that the two pairs were describing different things. Cover/Uncover names what the mask does to the
  pipeline; Draw/Rub out names what the GM's hand does. A GM is performing the same physical act on
  both layers — putting marks down and taking them off — and what actually differs is *which layer is
  in hand*, which the tool strip, the tool name and the colour of the marks all say already.

  Two vocabularies for one gesture made the layers read as different kinds of tool when they are the
  same tool pointed at different rasters.

  **The cost, stated:** "Cover" hinted that suppression is *additive* — you lay something over the
  map rather than deleting from it, and nothing of the map is lost. That hint is gone from the verb.
  What carries it now is the tool's own name, its blurb, and the amber the strokes are drawn in.
*/
const PAINT_VERB = "Draw";
const ERASE_VERB = "Erase";

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

/** The gap tool's one button, which is the reason the automatic search still earns its place. */
function gapActions(): HTMLElement {
  const row = document.createElement("div");
  row.className = "step-actions";

  const acceptAll = document.createElement("button");
  acceptAll.type = "button";
  acceptAll.className = "chip";
  acceptAll.textContent = "Close every gap shown";
  acceptAll.addEventListener("click", () => {
    acceptAllShownGaps();
  });

  row.append(acceptAll);
  return row;
}

/**
 * Save now, at the foot of the step, for both layers at once.
 *
 * **Not the only way work is kept**: putting the brush down or closing the workspace saves too. That
 * keeps the standing claim true — nothing on this surface is ever lost by navigating away — and it
 * makes the tools' own Discard the only control here that throws anything away, which is the right
 * shape for the one that does.
 *
 * ## It saves strokes and nothing else, and the name has to say so — room, 2026-09-09
 *
 * It was *Save the ink edits*, and a room adjusted *Smallest mark to keep*, pressed it, and was told
 * "nothing has changed since the ink edits were last saved" — which read as the slider change having
 * been lost. It had not: a slider writes itself to the scene on release, so by the time this button
 * is pressed there is nothing of the slider's left to save. The guard was right. **"Ink edits" was
 * the fault**, because on a step called Ink every control is an ink edit, and the button only ever
 * saved the two painted layers.
 *
 * So the label names what it saves, and the refusal says where the slider's change went — which is
 * the anxiety the old message produced, and the one thing a GM pressing this with nothing painted
 * needs to hear.
 */
function renderSave(body: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "step-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "chip";
  save.textContent = "Save painted strokes";
  save.addEventListener("click", () => {
    if (!anyUnsavedPaint()) {
      say("no painted strokes to save — sliders save themselves as you release them");
      return;
    }
    void finishPaint("save");
  });

  // No note: it said leaving does the same thing, which is reassurance about a button that cannot
  // lose anything. The two buttons beside it that *can* — Discard and Clear — confirm instead.
  row.append(save);
  body.append(row);
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
