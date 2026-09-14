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

import { STEPS, TOOLS, toolGroups, type Drag, type ToolChoice } from "../steps";
import { anchorDrawer, currentPanel, openPanel, openToolDrawer } from "./accordion";
import { stepIsMarked, wallsMark } from "./wallsMark";
import { requestPaintMode, setPaintTool } from "./paintTool";
import { mapChosen } from "./mapSource";
import { setTool as setWallTool, type WallTool } from "./wallEdit";
import { invalidate, setDrag } from "./shell";
import { requireLayer } from "./layerToggles";
import { toolIcon } from "./toolIcons";
import { editableGraph } from "./regions";
import { onStageChange } from "./stage";

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
  // Whatever is **drawn**, not whatever is stored. A map that has been read but never edited has
  // walls on screen and every one of them is editable; asking for a stored graph greyed all three
  // tools out in exactly that state.
  if (choice.band === "walls") return editableGraph() !== null;
  return mapChosen();
}

/**
 * Whether a tool has controls of its own, and therefore a drawer of its own.
 *
 * Asked of the declarations rather than listed here, so a tool acquiring its first setting gets a
 * drawer without anything else being told. `steps.ts` is where a group names the tool it belongs to.
 */
function toolHasControls(id: Tool): boolean {
  return STEPS.some((step) => toolGroups(step).some((group) => group.tool === id));
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
/**
 * The strip: one column holding both kinds of button, in two exclusion groups.
 *
 * ## Why two kinds in one column
 *
 * Borrowed from Procreate, which mixes drag-modes with panel-openers in one strip and is not read as
 * a category error — because tapping *Adjustments* does not put your brush down. That is the whole
 * of what makes it work, and it is a rule rather than an accident: **a panel and a verb are selected
 * independently.** One drawer is open at a time and one verb is armed at a time, and neither
 * selection disturbs the other.
 *
 * With one exception, and it is the user's (2026-09-14): **opening a panel puts the verb back to
 * Pan.** The verbs here are little fixes rather than the main event — the parameters are — so a GM
 * who has gone to read a group is almost certainly about to look around rather than to keep
 * painting, and an armed brush under a panel is a press waiting to happen. It also settles the
 * collision cleanly: a tool's own controls and a group's controls can never both want the drawer.
 *
 * ## The two kinds have to look different
 *
 * Two things highlighted at once is the cost of one column, and it is paid by shape rather than by
 * colour: a panel is its group's **name**, a verb is a **glyph**. There is never a question which
 * highlight means what, and the strip stays readable as *what is armed* at a glance.
 *
 * ## The order is the pipeline
 *
 * Look, then Map, Ink, Walls, View — the same order the rail taught by being a numbered column, now
 * taught by being a column. Each group's verbs sit under its own name, so what a tool acts on is
 * said by where it is.
 */
export function render(): void {
  const strip = document.getElementById("tools");
  if (strip) {
    strip.replaceChildren();
    /*
      A tool that has become unavailable cannot stay in hand. Nominating a different map is one way
      there, and leaving Erase selected over a map with no graph would show a pressed button whose
      presses do nothing.
    */
    const inHand = TOOLS.find((choice) => choice.id === tool);
    if (inHand && !usable(inHand)) apply("pan");
    const active = currentTool();

    const addTools = (band: ToolChoice["band"]): void => {
      for (const choice of TOOLS.filter((candidate) => candidate.band === band)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tool";
        /*
          The glyph alone, with the name in the tooltip.

          The words were there because discoverability is this surface's oldest weakness, and
          dropping them is a real trade rather than a tidy-up: an unlabelled picture is a thing to
          learn where a word is a thing to read. Three things carry the cost. The **tooltip** names
          it on hover; the **hint at the top of the drawer** says in full what the tool in hand does;
          and the **group names** keep the strip's order legible.

          `aria-label` rather than the text it replaces, because the button has no text content at
          all and a screen reader would otherwise announce nothing.
        */
        const glyph = toolIcon(choice.id);
        if (glyph) button.append(glyph);
        button.title = choice.label;
        button.setAttribute("aria-label", choice.label);
        // `aria-pressed` carries the selected look and the meaning together, rather than a class
        // saying the same thing beside it.
        button.setAttribute("aria-pressed", String(choice.id === active));
        // What this button opens, so the drawer can find the button it belongs to without
        // guessing from the pressed state — which two buttons carry at once.
        button.dataset.opens = `tool:${choice.id}`;
        button.disabled = !usable(choice);
        button.addEventListener("click", () => {
          setTool(choice.id as Tool);
          /*
            The drawer follows the press, including when the answer is "nothing".

            A tool with controls shows exactly those; one without **clears** the drawer (user,
            2026-09-14). Leaving it was the earlier rule and it produced a state that lied: with Add
            ink's drawer open, arming Move left the drawer titled *Add ink* while the hint inside it
            had already become Move's, because the hint follows the armed tool and the drawer did
            not. Clearing removes the disagreement rather than papering over it, and it makes the
            whole strip one rule — every press shows that button's own thing.
          */
          if (toolHasControls(choice.id as Tool)) openToolDrawer(choice.id as Tool);
          else openPanel(null);
        });
        strip.append(button);
      }
    };

    /*
      A group is a **label** and a row of glyphs, and every button in the column is a glyph.

      The group's name was the button that opened its settings, and it should not have been (user,
      2026-09-14): *"The text label 'Ink' can just be a label, not a button."* A name is what the band
      **is**; the settings behind it are one of the things in it, beside the tools. So the name went
      back to being a caption and the settings got a glyph of their own — sliders, because that is
      what is behind it.

      What that buys beyond tidiness: every press in this column now opens a drawer belonging to the
      thing pressed. There is no press that means "show me several things at once".
    */
    const caption = (text: string): void => {
      const label = document.createElement("p");
      label.className = "tool-band";
      label.textContent = text;
      strip.append(label);
    };

    const rule = (): void => {
      const line = document.createElement("div");
      line.className = "tool-rule";
      strip.append(line);
    };

    caption(BAND_LABELS.navigate);
    addTools("navigate");

    for (const step of STEPS) {
      rule();
      caption(step.title);

      /*
        The group's own settings.

        Gated exactly as its tools are, and for the same reason: a group offered over a map that does
        not exist is a control that lies. Map is the one that is never gated, because choosing a map
        is how the gate opens.
      */
      const shut = step.id !== "map" && !mapChosen();
      const opener = document.createElement("button");
      opener.type = "button";
      opener.className = "tool params";
      const glyph = toolIcon(step.id === "ink" || step.id === "walls" ? "params" : step.id);
      if (glyph) opener.append(glyph);
      const name = step.id === "map" ? "Choose the map" : `${step.title} settings`;
      opener.title = shut ? "Choose a map first" : name;
      opener.setAttribute("aria-label", name);
      opener.setAttribute("aria-pressed", String(currentPanel() === step.id));
      opener.dataset.opens = `params:${step.id}`;
      opener.disabled = shut;
      /*
        The mark rides here, on the settings that would do the destroying, rather than on the group's
        name — a caption cannot be pressed, and what the mark is warning about is a press.
      */
      if (stepIsMarked(step.id)) {
        opener.append(wallsMark());
        opener.classList.add("marked");
        opener.title = "These walls hold changes of yours";
      }
      opener.addEventListener("click", () => {
        /*
          Decided before anything moves, because `setTool` clears the drawer on its way past: asking
          `currentPanel()` afterwards would always say "not open" and this would never close.
        */
        const wasOpen = currentPanel() === step.id;
        // The user's rule: reading a group's settings puts the verb down. See this module's notes.
        setTool("pan");
        openPanel(wasOpen ? null : step.id);
      });
      strip.append(opener);

      addTools(step.id as ToolChoice["band"]);
    }

    // The buttons have just moved, so whatever the drawer was level with may not be there any
    // more -- a group becoming locked or usable changes the height of the column above it.
    anchorDrawer();
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
