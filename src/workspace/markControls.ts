/**
 * *Suppress region*'s own drawer: the one button that takes every mark off the map.
 *
 * Registered as tool content, as the brushes' and Mend's controls are, and drawn only while this
 * tool's drawer is the one open. The line above it is the tool's own hint, which the drawer paints
 * into the hint slot — so it is not repeated here.
 *
 * ## The tool had no drawer at all until this
 *
 * `toolHasControls` asks the declarations — *"a tool acquiring its first setting gets a drawer
 * without anything else being told"* — so the group in `steps.ts` is what opens this one, and it
 * carries no parameters because the tool has none. That is deliberately the same hook rather than a
 * second list: a list of "tools with actions" beside the list of "tools with settings" is two facts
 * about one thing, and they drift.
 *
 * **What it changes for a GM:** arming *Suppress region* now opens a drawer where it used to clear
 * the drawer, exactly as Mend and the brushes do.
 *
 * ## Why here and not in the Walls band
 *
 * The marks are this tool's document and nothing else places or removes one. `DESIGN.md`'s clear
 * family puts the tool-level tier in the tool's own drawer for that reason, and *Clear wall edits*
 * at the foot of the band deliberately leaves the marks alone — a mark already survives the walls
 * being rebuilt, which is far more violent than that button.
 *
 * DOM only. What the button does is `clearActions.ts`'s.
 */

import { clearAllMarks } from "./clearActions";
import { currentToolDrawer } from "./drawer";

export function renderMarkControls(rows: HTMLElement): void {
  if (currentToolDrawer() !== "suppressRegion") return;

  const actions = document.createElement("div");
  actions.className = "step-actions";

  const clear = document.createElement("button");
  clear.type = "button";
  // `quiet` is what *Clear layer* wears, which is the tier above this one in the same family: a
  // destructive press that confirms should not be the loudest thing in its own drawer.
  clear.className = "chip quiet";
  clear.textContent = "Clear all marks";
  clear.addEventListener("click", () => {
    void clearAllMarks();
  });

  actions.append(clear);
  rows.append(actions);
}
