/**
 * The Undo button, and the keystroke that does the same thing.
 *
 * ## Why this exists now and did not before
 *
 * While the reading controls and the editing tools were separate pages, wall edits could not be
 * destroyed by accident — the boundary was in the way. On one surface they can be, and the hand-edit
 * count and its warning only help a GM *predict*: they say what a re-read would cost before it
 * happens. Neither does anything for a judgement that looked right and was not, which is the ordinary
 * case. Pruning at a budget that seemed sensible and taking a wall you wanted had no route back but
 * regenerating the whole graph and losing every other edit with it.
 *
 * ## In the bar, not in a group
 *
 * It undoes changes to the document rather than to whatever section happens to be expanded, and the
 * bar is the one piece of chrome that is always there and survives hiding the controls. Undo behind a
 * heading would be undo you have to go and find.
 *
 * ## What it does not cover, stated
 *
 * **The graph only.** Settings are not destructive — turning a slider back puts the walls back,
 * because a derivation is not spent by being redone — and the paint layers are a raster document with
 * their own Discard and Clear. A stroke-level undo for those is a different mechanism against a
 * different document, and pretending one button did both would be the more confusing offer.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { invalidate, say } from "./shell";
import { onStageChange, undoEdit, undoLabel } from "./stage";

let button: HTMLButtonElement | null = null;
let running = false;

/**
 * Keep the button saying what it would take back.
 *
 * Named rather than bare, because "Undo pruning the dead ends" says what you are about to get back
 * where "Undo" asks you to remember what you last did — and the whole reason this is needed is that
 * a GM has just done something whose effect they misjudged.
 */
function paint(): void {
  if (!button) return;
  const label = undoLabel();
  button.disabled = label === null || running;
  button.title = label === null ? "Nothing to undo" : `Undo ${label}`;
}

async function run(): Promise<void> {
  if (running || undoLabel() === null) return;
  running = true;
  paint();
  say("undoing…", "working");
  try {
    const label = await undoEdit();
    say(label === null ? "nothing to undo" : `undid ${label}`);
  } catch (error) {
    const detail = describeError(error);
    say(`could not undo: ${detail}`, "bad");
    devLog("error", "workspace: undo failed", detail);
    console.error("Fog Nudger — undo failed", error);
  } finally {
    running = false;
    paint();
    invalidate();
  }
}

export function registerUndoAction(): void {
  const found = document.getElementById("undo");
  button = found instanceof HTMLButtonElement ? found : null;
  button?.addEventListener("click", () => void run());

  // Every edit and every derive moves what there is to undo, and both announce here.
  onStageChange(paint);

  /*
    Ctrl+Z as well as the button, because the surface owns its keyboard.

    Not Cmd+Z: the probe measured this running in Firefox on Windows, and adding a modifier nobody
    here presses would be guessing at a platform rather than serving one. The button is the
    discoverable route and the keystroke is the fast one.
  */
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.key !== "z" || event.shiftKey || event.altKey) return;
    // Not while typing into something — the number inputs on the sliders take a caret.
    if (document.activeElement instanceof HTMLInputElement) return;
    event.preventDefault();
    void run();
  });

  paint();
}
