/**
 * The mend tool's own drawer: its two sliders and the button that accepts every mend on offer.
 *
 * Registered with the drawer as tool content, as the brushes' controls are, and drawn only while the
 * mend tool's drawer is the one open. The line above the sliders is the tool's group blurb, which
 * the drawer paints into the hint slot — so it is not drawn here a second time.
 *
 * DOM only. What the button does is `wallEdit`'s, because accepting is an edit and every edit saves
 * through the one path.
 */

import { STEPS, groupControls, toolGroups } from "../steps";
import { currentToolDrawer } from "./drawer";
import { settingRow } from "./settingRows";
import { mendEveryGapShown } from "./wallEdit";

export function renderMendControls(rows: HTMLElement): void {
  if (currentToolDrawer() !== "mend") return;
  const walls = STEPS.find((step) => step.id === "walls");
  const group = walls ? toolGroups(walls).find((candidate) => candidate.tool === "mend") : undefined;
  if (!group) return;

  for (const control of groupControls(group)) {
    rows.append(settingRow(control));
  }

  const actions = document.createElement("div");
  actions.className = "step-actions";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip";
  all.textContent = "Mend every gap shown";
  all.addEventListener("click", () => {
    mendEveryGapShown();
  });
  actions.append(all);
  rows.append(actions);
}
