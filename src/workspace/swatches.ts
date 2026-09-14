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
import { PALETTE_ROLES, PALETTE_DEFAULTS, ROLE_LABELS, type AdjustableRole } from "../palette";
import { recolourInk } from "./layers/ink";
import { controlsLive } from "./settingRows";
import { invalidate } from "./shell";
import { currentSettings, persistSettings, setSettings } from "./settingsState";

/**
 * Preset overlay colours.
 *
 * A spread of hues plus both extremes of neutral, because the only thing that makes a colour good
 * here is contrast against a particular map — red vanishes on red stonework and shouts on a grey
 * plan, and only the GM can see which they have. Seven is enough to find something workable on any
 * map in one click, with the picker there for the rest. The count is the argument, so it has to
 * match the list: this said six while declaring seven, and the paragraph appeared twice.
 */
/*
  Violet leads, because it is the default and the first thing a GM sees on the map.

  Cyan and amber are **not** offered, which is the change worth knowing about: they mean *added ink*
  and *suppressed ink* everywhere else on this canvas, and a mask wearing one of them would make the
  GM's own corrections indistinguishable from what the trace read. Red is gone for the same reason —
  it is reserved for what an action would remove.
*/
const INK_SWATCHES: readonly { readonly value: string; readonly name: string }[] = [
  { value: PALETTE_DEFAULTS.ink, name: "Violet" },
  { value: "#ff20d0", name: "Magenta" },
  { value: "#2b6bff", name: "Blue" },
  { value: "#ffd000", name: "Yellow" },
  { value: "#00e070", name: "Green" },
  { value: "#ffffff", name: "White" },
  { value: "#000000", name: "Black" },
];

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
 * the label in the swatch strip rather than beside it. That was invisible while it lived at the top
 * of the Ink step with nothing to be compared against; once it moved down among the other four
 * (2026-09-09) it was the odd one out, which a room said plainly: *"It should adopt that same format
 * as the others."*
 *
 * So there is one builder, and ink's presets are an **addition** to the shared row rather than a
 * replacement for it. The special-casing that survives is one `if`, where it used to be a second
 * function that had drifted: the old one read the stored colour by hand with its own normalising
 * call, which is precisely what `colourFor` already does for every role.
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

  row.append(top);
  // Ink alone gets presets, because it is the one colour covering real area — a palette of
  // alternatives is worth a click there and would be inviting a mistake on the four marks, whose
  // meanings are fixed.
  if (role === "ink") row.append(swatchStrip(picker));
  row.append(hint);
  return row;
}

/**
 * The preset strip, under the row it belongs to.
 *
 * Takes the row's own picker because the picker is the **readout** of the current colour as well as a
 * way to set one: a swatch that left it showing the previous colour made the row disagree with
 * itself until the next rebuild of the panel.
 */
function swatchStrip(picker: HTMLInputElement): HTMLElement {
  const container = document.createElement("div");
  container.className = "swatches";

  for (const swatch of INK_SWATCHES) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.background = swatch.value;
    button.title = swatch.name;
    button.disabled = !controlsLive();
    button.addEventListener("click", () => {
      setRoleColour("ink", swatch.value);
      picker.value = swatch.value;
      void persistSettings();
    });
    container.append(button);
  }

  return container;
}
