/**
 * The palette as the GM has it, and publishing it where the stylesheet can see it.
 *
 * `src/palette.ts` holds the values and the reasoning; this reads whichever of them is current. Split
 * because `settings.ts` takes its defaults from that half and is node-tested, so it cannot import
 * anything that touches the DOM.
 *
 * ## Read live rather than captured
 *
 * The layers call `colourFor` while drawing rather than holding a constant, because these are now
 * adjustable and a captured value would leave the canvas showing the colour that was current when the
 * module loaded. A canvas redraws constantly; a property lookup per draw is not worth avoiding.
 */

import { normaliseColour } from "../settings";
import { PALETTE_DEFAULTS, type PaletteRole } from "../palette";
import { currentSettings } from "./settingsState";

/** The colour a role is drawn in right now. */
export function colourFor(role: PaletteRole): string {
  if (role === "casing") return PALETTE_DEFAULTS.casing;
  const stored = (currentSettings().overlay as unknown as Record<string, unknown>)[colourKey(role)];
  return normaliseColour(stored, PALETTE_DEFAULTS[role]);
}

/**
 * The settings key a role is stored under.
 *
 * `inkColour` predates the palette and keeps its name: renaming a stored key means the old one is
 * ignored and the default applies, which would silently reset the one colour a GM is most likely to
 * have already chosen.
 */
export function colourKey(role: PaletteRole): string {
  return role === "ink" ? "inkColour" : `${role}Colour`;
}

/**
 * Publish the palette as custom properties, so the stylesheet and the canvas agree by construction.
 *
 * The blurbs name colours — "covered areas show in amber" — and those words have to match the marks
 * they describe. Re-published whenever a colour changes, which is why this takes no arguments and
 * reads everything: a caller passing only what it changed would leave the rest to drift.
 */
export function applyPalette(): void {
  const root = document.documentElement;
  for (const role of Object.keys(PALETTE_DEFAULTS) as PaletteRole[]) {
    root.style.setProperty(`--${role}`, colourFor(role));
  }
}
