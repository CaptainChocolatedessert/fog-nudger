/**
 * The tool picker at the top of the Edit walls step.
 *
 * **A step is still the mode; the tool says which verb within it** (user, 2026-09-05). Three verbs
 * cannot share one drag, and the alternative — hiding draw and erase behind modifier keys — would
 * have put a destructive action on an unannounced click and left both undiscoverable. This surface
 * has had that weakness since the point probe arrived: nothing on it says the map is interactive.
 *
 * Drawn rather than described, for the reason the map picker and the ink swatches are: a native
 * control opened from a sandboxed third-party iframe paints against the *system* background, and the
 * first version of the map picker rendered white on white and looked empty.
 *
 * It sits at the **top** of the step, above the button that writes to the scene. What you do comes
 * before what it produces.
 *
 * ## With no graph saved there is nothing to pick a tool for
 *
 * The editor opens from the panel, so a GM can reach it on a map that has never been through the ink
 * mode. That is not an error and must not read as one: the answer is a sentence saying where the
 * walls come from, in place of three buttons that would do nothing.
 */

import { currentTool, setTool, type WallTool } from "./wallEdit";
import { frozenGraph } from "./stage";
import { invalidate } from "./shell";

interface ToolChoice {
  readonly id: WallTool;
  readonly label: string;
  /** What the gesture is, in the fewest words that still say what a press does. */
  readonly hint: string;
}

const TOOLS: readonly ToolChoice[] = [
  {
    id: "move",
    label: "Move",
    hint: "Drag a point to move it. Drop it on another to join them — hold Shift to keep them apart.",
  },
  {
    id: "draw",
    label: "Draw",
    hint:
      "Drag to draw a wall, or click both ends. An end turns <b class='join-key'>green</b> where it " +
      "would attach to an existing point, which is how you close a gap — hold Shift to leave it " +
      "loose. Ctrl-drag pans. Escape or right-click abandons a wall part-drawn.",
  },
  {
    id: "erase",
    label: "Erase",
    hint:
      "Click a wall to remove it. <b>One segment at a time</b>, so a long wall drawn as many " +
      "segments takes a click each — the highlight shows exactly what would go.",
  },
];

/**
 * The picker, rebuilt with the rest of the step.
 *
 * No subscription: the accordion rebuilds every step body on every header click, so a listener here
 * would leak one per click. The buttons repaint themselves on the click that changes the tool, which
 * is the only thing that can change it.
 */
export function renderWallTools(body: HTMLElement): void {
  if (!frozenGraph()) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.innerHTML =
      "No walls are saved for this map yet. They are made by reading the map: close this, open " +
      "<b>Read the map</b> from the panel, and the last step there puts a graph here.";
    body.append(empty);
    return;
  }

  const row = document.createElement("div");
  row.className = "step-actions";

  const hint = document.createElement("p");
  hint.className = "sub";

  const buttons = TOOLS.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.addEventListener("click", () => {
      setTool(choice.id);
      paint();
      invalidate();
    });
    row.append(button);
    return { choice, button };
  });

  function paint(): void {
    const active = currentTool();
    for (const { choice, button } of buttons) {
      // `aria-pressed` is the selected style already, so it carries the look and the meaning
      // together rather than a class saying the same thing beside it.
      button.className = "chip";
      button.setAttribute("aria-pressed", String(choice.id === active));
    }
    hint.innerHTML = TOOLS.find((choice) => choice.id === active)?.hint ?? "";
  }

  paint();
  body.append(row, hint);
}
