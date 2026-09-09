/**
 * What a drag means, chosen once and for the whole surface.
 *
 * ## Why this exists at all
 *
 * A step used to be the mode: opening one set the layers *and* bound the drag, which is why the
 * accordion had to be exclusive — two open steps would have been two meanings for one gesture. That
 * made the accordion serve two jobs at once, a navigator and a mode selector, and those want
 * opposite behaviour. Navigation wants to be cheap and non-exclusive; a mode wants to be exactly one
 * thing. Every escape the old design grew — the nothing-open state, the no-tool state, Ctrl-to-pan —
 * was patching the seam between them.
 *
 * **So the mode half moves here.** The palette owns the verb, the rail owns what you are reading,
 * and switching one no longer disturbs the other. That is the whole of the change: picking a wall
 * tool while the ink sliders are on screen is now an ordinary thing to do.
 *
 * ## It drives the existing tool state rather than replacing it
 *
 * `paintTool.ts` and `wallEdit.ts` already hold a selected tool each, and the pure functions that
 * decide what a press *means* — `paintGesture`, `dragGesture`, `gapGesture` — are tested and take
 * that state as an input. None of that is worth disturbing to move a picker, so this is a layer
 * above them: one union spanning both, and a setter that fans out.
 *
 * The cost of driving rather than owning, stated: the selected tool is held in two places and this
 * has to keep them agreeing. `apply` is the single point where that happens, and every entry to it
 * goes through `setTool`.
 *
 * ## Pan is a tool, not the absence of one
 *
 * The old surface reached the same state by clicking the selected tool a second time to put it down,
 * which is undiscoverable and looks identical to a tool that declined the press. Naming it and
 * giving it a button costs one row and removes a piece of folklore.
 */

import { STEPS, toolsOf, type Drag, type ToolChoice } from "../steps";
import { currentPaintTool, requestPaintMode, setPaintTool } from "./paintTool";
import { workspaceMode } from "./mode";
import { currentTool as currentWallTool, setTool as setWallTool, type WallTool } from "./wallEdit";
import { invalidate, setDrag } from "./shell";
import { onStageChange, wallGraph } from "./stage";

export type Tool = "pan" | "suppress" | "ink" | "gaps" | WallTool;

/**
 * The line under a tool, which is its own hint or the blurb of the group it reveals.
 *
 * The ink tools each have a step group carrying the sentence that explains them, and that sentence
 * is already shown beside their controls. Reading it rather than repeating it keeps one copy.
 */
function hintFor(choice: ToolChoice): string {
  if (choice.hint) return choice.hint;
  const groups = STEPS.flatMap((step) => step.groups ?? []);
  return groups.find((group) => group.tool === choice.id)?.blurb ?? "";
}

/**
 * The tool in hand, recovered from the two modules that hold it rather than duplicated here.
 *
 * A third copy would be a third thing to keep in step, and the failure would be silent: the palette
 * showing one tool pressed while a press did something else.
 */
export function currentTool(): Tool {
  if (workspaceMode() === "edit") return currentWallTool();
  const paint = currentPaintTool();
  return paint === "none" ? "pan" : paint;
}

const listeners: ((tool: Tool) => void)[] = [];

/** Told after the tool changes, with what it is now. */
export function onToolChange(listener: (tool: Tool) => void): void {
  listeners.push(listener);
}

/**
 * What a plain left-drag does, derived from the tool rather than declared by a step.
 *
 * The gap tool takes `brush` and not `pan`, which looks wrong and is not: the brush branch is what
 * offers the press to the paint tool at all, and that tool declines a press outside every ring so it
 * falls through to a pan. Giving it `pan` here would mean a click inside a ring never reached it.
 */
function dragFor(tool: Tool): Drag {
  return toolsOf(workspaceMode()).find((choice) => choice.id === tool)?.drag ?? "pan";
}

/**
 * Put the choice into effect, in the one place both halves of the state are set.
 *
 * The paint mode follows the **tool** now rather than whether a step is open, which is what the
 * non-exclusive rail forces and what should always have been true: the working copies exist because
 * a brush is in hand, not because a heading is expanded. `requestPaintMode` still serialises, for the
 * reason it always did — leaving a brush and coming back inside the second a write takes is a write
 * and then an open.
 */
function apply(tool: Tool): void {
  if (workspaceMode() === "edit") {
    setWallTool(tool === "pan" ? "move" : (tool as WallTool));
    // Pan in the editor is the absence of a wall tool, and the wall modules have no such state —
    // the drag binding is what actually decides, so it is enough to leave `move` selected and not
    // hand it the press.
  } else {
    setPaintTool(tool === "pan" ? "none" : (tool as "suppress" | "ink" | "gaps"));
  }
  setDrag(dragFor(tool));
  requestPaintMode(tool === "suppress" || tool === "ink" || tool === "gaps");
}

export function setTool(tool: Tool): void {
  apply(tool);
  render();
  for (const listener of listeners) listener(tool);
  invalidate();
}

const BAND_LABELS: Readonly<Record<ToolChoice["band"], string>> = {
  navigate: "Look",
  ink: "Ink",
  walls: "Walls",
};

/**
 * Draw the strip, and the hint that says what the tool in hand does.
 *
 * The hint lives at the top of the rail rather than beside the tool's own controls, because under a
 * non-exclusive rail those controls may be collapsed while the tool is still in hand. What a press
 * will do must not depend on which headings happen to be expanded.
 */
export function render(): void {
  const strip = document.getElementById("tools");
  if (strip) {
    strip.replaceChildren();
    const active = currentTool();
    const usable = workspaceMode() === "edit" ? wallGraph() !== null : true;
    let band: ToolChoice["band"] | null = null;

    for (const choice of toolsOf(workspaceMode())) {
      if (band !== null && choice.band !== band) {
        const rule = document.createElement("div");
        rule.className = "tool-rule";
        strip.append(rule);
      }
      if (choice.band !== band) {
        const caption = document.createElement("p");
        caption.className = "tool-band";
        caption.textContent = BAND_LABELS[choice.band];
        strip.append(caption);
        band = choice.band;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool";
      button.textContent = choice.label;
      // `aria-pressed` carries the selected look and the meaning together, rather than a class
      // saying the same thing beside it.
      button.setAttribute("aria-pressed", String(choice.id === active));
      button.disabled = !usable && choice.id !== "pan";
      button.addEventListener("click", () => setTool(choice.id as Tool));
      strip.append(button);
    }
  }

  const hint = document.getElementById("tool-hint");
  if (hint) {
    const chosen = toolsOf(workspaceMode()).find((choice) => choice.id === currentTool());
    hint.innerHTML = chosen ? hintFor(chosen) : "";
  }
}

/** Bind the palette to the surface, and put the starting tool into effect. */
export function registerToolPalette(): void {
  /*
    Redrawn when a graph arrives or goes, because that is what decides whether the wall tools can do
    anything. Saving from the ink mode, or *Remove ours* from the panel, both move it — and a strip
    left showing three live buttons over a map with no walls would be offering a press that silently
    does nothing.
  */
  onStageChange(render);
  apply("pan");
  render();
}
