/**
 * The ink colour: a row of swatches and a picker, at the top of the Ink step.
 *
 * It sat in a View group of its own until 2026-08-29, and moved for the reason that emptied that
 * group: a control that decides how a layer is *drawn* belongs beside the controls that decide what
 * is in it. The colour is the first thing a GM reaches for when the overlay is invisible against a
 * particular map, which is why it leads the step rather than trailing it.
 *
 * It is not a slider and cannot be a `settingRow`: the colour is the one setting that is not a
 * number, so it sits outside the parameter machinery entirely and needs its own row of buttons.
 */

import { colourFor, applyPalette, colourKey } from "./palette";
import { normaliseColour } from "../settings";
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
  for (const role of PALETTE_ROLES) {
    if (role === "ink") continue;
    body.append(colourRow(role));
  }
}

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
  picker.addEventListener("input", () => setRoleColour(role, picker.value));
  picker.addEventListener("change", () => void persistSettings());

  top.append(label, picker);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = ROLE_LABELS[role].means;

  row.append(top, hint);
  return row;
}

/** The ink row, which keeps its swatches because it is the one colour covering real area. */
export function renderInkSwatches(body: HTMLElement): void {
  const container = document.createElement("div");
  container.className = "swatches";

  // Built before the swatches so they can write into it, appended after so it still sits at the end
  // of the row.
  const picker = document.createElement("input");
  picker.type = "color";
  picker.disabled = !controlsLive();
  picker.value = normaliseColour(currentSettings().overlay.inkColour, PALETTE_DEFAULTS.ink);

  for (const swatch of INK_SWATCHES) {
    const button = document.createElement("button");
    button.style.background = swatch.value;
    button.title = swatch.name;
    button.addEventListener("click", () => {
      setRoleColour("ink", swatch.value);
      // The picker is the readout of the current colour as well as a way to set one, so a swatch
      // that left it showing the previous colour made the row disagree with itself until the next
      // rebuild of the panel.
      picker.value = swatch.value;
      void persistSettings();
    });
    container.append(button);
  }

  for (const button of container.querySelectorAll("button")) button.disabled = !controlsLive();

  // Live on `input`, saved on `change`: a colour costs a buffer rewrite rather than a re-read, so
  // there is nothing to be gained by making the GM let go to see it.
  picker.addEventListener("input", () => setRoleColour("ink", picker.value));
  picker.addEventListener("change", () => void persistSettings());
  container.append(picker);
  body.append(container);
}
