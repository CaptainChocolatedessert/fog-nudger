/**
 * The View group: how the overlay is drawn, not what it says.
 *
 * **Persistent rather than a step.** Navigating away from the thing you are tuning in order to
 * recolour it is absurd, so the view controls must never be somewhere you go — which is why they sit
 * beside the reading controls rather than behind a tab of their own. It carries a `Step`'s shape
 * because the rendering is identical; what makes it different is that it is never *entered*.
 *
 * Nothing here changes a single pixel of what the pipeline computed, which is why every control in
 * it is declared `display` and none of them touch the mask cache. The swatches are the one piece of
 * the group that is not a slider: the ink colour is the only setting that is not a number, so it
 * sits outside the parameter machinery entirely and needs its own row of buttons.
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

export function renderSwatches(): void {
  const container = document.getElementById("swatches");
  if (!container) return;
  container.replaceChildren();

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
}
