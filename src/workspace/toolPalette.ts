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

import { STEPS, TOOLS, type Drag, type ToolChoice } from "../steps";
import { requestPaintMode, setPaintTool } from "./paintTool";
import { mapChosen } from "./mapSource";
import { setTool as setWallTool, type WallTool } from "./wallEdit";
import { invalidate, setDrag } from "./shell";
import { requireLayer } from "./layerToggles";
import { toolIcon } from "./toolIcons";
import { handEdits, onStageChange, wallGraph } from "./stage";

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
 * The tool in hand. **Held here, not recovered from the modules underneath.**
 *
 * The first version derived it — the paint tool in the ink mode, the wall tool in the editor — on the
 * reasoning that a third copy would be a third thing to keep in step. That derivation is *lossy*, and
 * it showed the moment the editor was opened: `wallEdit` has no idle state, so panning there had to
 * leave `move` selected with the drag bound to `pan`, and the strip then drew Move as pressed while a
 * press actually panned. **The palette said one thing and the surface did another**, which is the
 * exact failure the derivation was supposed to prevent.
 *
 * So this owns the answer and `apply` pushes it down. The modules underneath keep whatever they need
 * to represent, and what a press does is decided by the drag binding rather than by either of them.
 */
let tool: Tool = "pan";

export function currentTool(): Tool {
  return tool;
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
  return TOOLS.find((choice) => choice.id === tool)?.drag ?? "pan";
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
function apply(next: Tool): void {
  tool = next;
  const band = TOOLS.find((choice) => choice.id === next)?.band;
  if (band === "walls") {
    setWallTool(next as WallTool);
    // The paint tool is put down whenever a wall tool is picked up, or a brush would still be armed
    // underneath and the press would reach whichever handler the drag binding names first.
    setPaintTool("none");
  } else {
    /*
      `wallEdit` keeps whatever verb it had. That is harmless *because the drag binding decides*:
      with `pan` or `brush` bound the wall handler is never offered the press, so which verb it would
      have used cannot matter. What must not happen is the strip reading its answer back — see
      `currentTool`.
    */
    setPaintTool(next === "pan" ? "none" : (next as "suppress" | "ink" | "gaps"));
  }
  setDrag(dragFor(next));
  requestPaintMode(next === "suppress" || next === "ink" || next === "gaps");
  /*
    A tool brings its own layer up, and never takes one down.

    You cannot edit what you cannot see, so picking a wall tool has to guarantee the graph is drawn.
    Adding only is what keeps this from re-creating the coupling the strip was built to remove: the
    tool nudges, and whatever the GM switched on stays on.
  */
  if (band === "walls") requireLayer("graph");
  if (next === "suppress" || next === "ink") requireLayer("paint");
  if (next === "gaps") requireLayer("gaps");
}

/**
 * Whether a tool can do anything yet.
 *
 * Per tool rather than per surface, now that all of them are on one strip. Pan always works; the ink
 * tools need a map to paint onto; the wall tools need walls to change. A tool offered in a state
 * where its presses do nothing is a button that lies.
 */
function usable(choice: ToolChoice): boolean {
  if (choice.band === "navigate") return true;
  if (choice.band === "walls") return wallGraph() !== null;
  return mapChosen();
}

export function setTool(next: Tool): void {
  apply(next);
  render();
  for (const listener of listeners) listener(next);
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
    /*
      A tool that has become unavailable cannot stay in hand. Removing the walls from the panel is
      one way there and nominating a different map is another, and leaving Erase selected over a map
      with no graph would show a pressed button whose presses do nothing.
    */
    const inHand = TOOLS.find((choice) => choice.id === tool);
    if (inHand && !usable(inHand)) apply("pan");
    const active = currentTool();
    let band: ToolChoice["band"] | null = null;

    for (const choice of TOOLS) {
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
      /*
        Glyph and name together, rather than either alone.

        The name stays because discoverability is this surface's oldest weakness — nothing on it says
        the map is interactive at all — and an unlabelled picture is a thing to learn rather than a
        thing to read. The glyph is what makes the strip scannable once it *has* been learned, which
        is the state a GM spends almost all of their time in.
      */
      const glyph = toolIcon(choice.id);
      if (glyph) button.append(glyph);
      const name = document.createElement("span");
      name.textContent = choice.label;
      button.append(name);
      // `aria-pressed` carries the selected look and the meaning together, rather than a class
      // saying the same thing beside it.
      button.setAttribute("aria-pressed", String(choice.id === active));
      button.disabled = !usable(choice);
      button.addEventListener("click", () => setTool(choice.id as Tool));
      strip.append(button);
    }
  }

  /*
    Drawn here because this already redraws on a stage change and owns the head's other dynamic
    line. It is not a property of the tool — it belongs to the document — and when the two modes
    merge into one page it should move to whatever owns that.
  */
  const count = document.getElementById("edit-count");
  if (count) {
    const n = handEdits();
    count.textContent = n === 0 ? "" : `${n} hand ${n === 1 ? "edit" : "edits"} — re-reading the map discards ${n === 1 ? "it" : "them"}`;
  }

  const hint = document.getElementById("tool-hint");
  if (hint) {
    const chosen = TOOLS.find((choice) => choice.id === currentTool());
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
