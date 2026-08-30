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
 *
 * ## Why a spread of hues plus both extremes of neutral
 *
 * The only thing that makes a colour good here is contrast against a particular map — red vanishes
 * on red stonework and shouts on a grey plan, and only the GM can see which they have. Six is enough
 * to find something workable on any map in one click, with the picker there for the rest.
 */

import { DEFAULT_SETTINGS, normaliseColour } from "../settings";
import { recolourInk } from "./layers/ink";
import { controlsLive } from "./settingRows";
import { currentSettings, persistSettings, setSettings } from "./settingsState";

/**
 * Preset overlay colours.
 *
 * A spread of hues plus both extremes of neutral, because the only thing that makes a colour good
 * here is contrast against a particular map — red vanishes on red stonework and shouts on a grey
 * plan, and only the GM can see which they have. Six is enough to find something workable on any
 * map in one click, with the picker there for the rest.
 */
const INK_SWATCHES: readonly { readonly value: string; readonly name: string }[] = [
  { value: "#ff2020", name: "Red" },
  { value: "#ff20d0", name: "Magenta" },
  { value: "#00c8ff", name: "Cyan" },
  { value: "#ffd000", name: "Yellow" },
  { value: "#00e070", name: "Green" },
  { value: "#ffffff", name: "White" },
  { value: "#000000", name: "Black" },
];

function setInkColour(colour: string): void {
  const settings = currentSettings();
  setSettings({ ...settings, overlay: { ...settings.overlay, inkColour: colour } });
  recolourInk();
}

export function renderSwatches(body: HTMLElement): void {
  const container = document.createElement("div");
  container.className = "swatches";

  for (const swatch of INK_SWATCHES) {
    const button = document.createElement("button");
    button.style.background = swatch.value;
    button.title = swatch.name;
    button.addEventListener("click", () => {
      setInkColour(swatch.value);
      void persistSettings();
    });
    container.append(button);
  }

  for (const button of container.querySelectorAll("button")) button.disabled = !controlsLive();

  const picker = document.createElement("input");
  picker.type = "color";
  picker.disabled = !controlsLive();
  picker.value = normaliseColour(currentSettings().overlay.inkColour, DEFAULT_SETTINGS.overlay.inkColour);
  // Live on `input`, saved on `change`: a colour costs a buffer rewrite rather than a re-read, so
  // there is nothing to be gained by making the GM let go to see it.
  picker.addEventListener("input", () => setInkColour(picker.value));
  picker.addEventListener("change", () => void persistSettings());
  container.append(picker);
  body.append(container);
}
