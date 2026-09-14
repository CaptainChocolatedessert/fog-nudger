/**
 * The five markup colours, together, at the foot of the persistent View group.
 *
 * ## The ink colour came back down here — user, 2026-09-09
 *
 * *"The ink color picker should move down with the others."* It had led the Ink step since
 * 2026-08-29, on the argument that a control deciding how a layer is *drawn* belongs beside the
 * controls deciding what is in it — and that the colour is the first thing a GM reaches for when the
 * overlay vanishes against a particular map.
 *
 * What overturned it is that there are five colours now, not one. Grouping them by what a colour
 * *means* is this module's whole design, and one of the five living in a different section was the
 * exception a GM had to remember. Here they are one list, and the View group is never entered, so
 * the colour is reachable from anywhere rather than only while Ink is open — which answers the
 * "first thing reached for" argument better than leading one step did.
 *
 * **The cost:** a GM tuning the ink sliders now scrolls to the foot of the rail to recolour the
 * overlay they are judging, where it used to be directly above them.
 *
 * None of these is a slider and none can be a `settingRow`: a colour is not a number, so it sits
 * outside the parameter machinery and needs its own row.
 */

import { colourFor, applyPalette, colourKey } from "./palette";
import { PALETTE_ROLES, ROLE_LABELS, type AdjustableRole } from "../palette";
import { recolourInk } from "./layers/ink";
import { controlsLive } from "./settingsState";
import { invalidate } from "./shell";
import { currentSettings, persistSettings, setSettings } from "./settingsState";

/*
  The seven ink presets were here, and they are gone (user, 2026-09-13): "Remove the ink presets. Ink
  should be just like all of the other categories with colors."

  **The cost, stated rather than argued away.** They existed because nothing makes a colour good here
  except contrast against a particular map — violet vanishes on violet stonework and shouts on a grey
  plan — and one click on a spread of hues found something workable on any map. Every colour change is
  now a trip through the operating system's colour picker, which is slower and is a worse place to
  compare two candidates.

  What is bought is that a category is a category: five rows, one shape, nothing to learn about why
  one of them is special. That was the argument for the presets in reverse — ink was singled out
  because it covers real area — and the room has decided the consistency is worth more than the click.
*/

/**
 * Set one role's colour and put it into effect everywhere at once.
 *
 * `applyPalette` republishes the custom properties so a blurb naming a colour keeps matching the mark
 * it describes, and `recolourInk` rebuilds the mask buffer — the one layer whose colour is baked into
 * pixels rather than read while drawing.
 */
function setRoleColour(role: AdjustableRole, colour: string): void {
  const settings = currentSettings();
  setSettings({
    ...settings,
    overlay: { ...settings.overlay, [colourKey(role)]: colour },
  });
  applyPalette();
  if (role === "ink") recolourInk();
  invalidate();
}

/**
 * One row per category, grouped by **what a colour means** rather than by which layer shows it.
 *
 * That grouping is the point. Adjusting for a map with an unusual tint should move one control and
 * have everything additive follow — the added ink, the gap rings, the end that would attach — rather
 * than hunting three layers for three hues that then have to agree with each other.
 *
 * The swatches are offered for ink alone. The other four are marks a few pixels wide whose meaning is
 * fixed, so a palette of alternatives would be inviting a GM to make *added* look like *going*; the
 * native picker is there for the one thing that matters, which is legibility on their own map.
 */
export function renderSwatches(body: HTMLElement): void {
  // In the palette's declared order, which puts ink first: it is the one covering real area and the
  // one most often changed, so it leads the list it has joined.
  for (const role of PALETTE_ROLES) {
    body.append(colourRow(role));
  }
}

/**
 * One row, for every colour, in the shape every other control on this rail has: the name on the
 * left, the thing you turn on the right.
 *
 * **Ink used to have a builder of its own** and wore a different shape for it — its picker sat under
 * the label in a strip of presets rather than beside it. That was invisible while it lived at the top
 * of the Ink step with nothing to be compared against; once it moved down among the other four
 * (2026-09-09) it was the odd one out, which a room said plainly: *"It should adopt that same format
 * as the others."*
 *
 * **There is no special case left at all** (2026-09-13). The presets went with the room's next
 * sentence — *"Ink should be just like all of the other categories with colors"* — so what was a
 * second builder, then one builder with an `if`, is now one builder with none.
 */
function colourRow(role: AdjustableRole): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";

  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.textContent = ROLE_LABELS[role].name;

  const picker = document.createElement("input");
  picker.type = "color";
  picker.disabled = !controlsLive();
  picker.value = colourFor(role);
  // Live on `input`, saved on `change`: a colour costs a buffer rewrite rather than a re-read, so
  // there is nothing to be gained by making the GM let go to see it.
  picker.addEventListener("input", () => setRoleColour(role, picker.value));
  picker.addEventListener("change", () => void persistSettings());

  top.append(label, picker);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = ROLE_LABELS[role].means;

  row.append(top, hint);
  return row;
}

