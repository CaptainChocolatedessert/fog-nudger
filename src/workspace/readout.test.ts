/**
 * The number beside a slider's label, against the text rules of 2026-09-29 (DESIGN.md §7a): the
 * slider's one unit with a space before it, `off` at the bottom of a track that starts at zero, and
 * no space before `%`.
 *
 * Run over the real declarations rather than fixtures, because what a GM reads is the declaration
 * and the formatter together, and a fixture control could agree with the formatter while the
 * declarations drifted.
 *
 * **Six mutations, six caught** (2026-09-29, run before this was written): the space before the unit
 * dropped, the off state removed, off tied to the track's floor instead of to zero, `shown` ignored,
 * the percentage given back its decimal, and a space put before the percent sign. **Five more, five
 * caught**, on the pixel readout added the same day: the raster ignored, the decimal under ten
 * dropped, off at zero removed, a zero raster accepted, and nothing in place of the pixels before a
 * reading.
 */

import { describe, expect, it } from "vitest";

import { CONTROLS, type Control } from "../controls";
import { DEFAULT_SETTINGS, readParameter, SETTING_LIMITS } from "../settings";
import { toSlider } from "../sliderScale";
import { graphUnitsInPixels, readoutText } from "./readout";

function control(name: Control["name"]): Control {
  const found = CONTROLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no control ${name}`);
  return found;
}

/** What the row would print for this control at this value. */
function printed(which: Control, value: number): string {
  const limits = SETTING_LIMITS[which.name];
  const scale = which.scale ?? "linear";
  return readoutText(which, value, toSlider(value, limits, scale), limits, scale);
}

describe("the number beside a slider", () => {
  it("prints a unit with a space before it", () => {
    expect(printed(control("gapFillPx"), 12)).toBe("12 px");
    expect(printed(control("suppressBrushPx"), 24)).toBe("24 px");
    expect(printed(control("blurSigma"), 1)).toBe("1.00 px");
  });

  it("says off at zero on a track that starts there", () => {
    for (const name of ["minIslandPx", "gapFillPx", "gapTravelPx", "blurSigma"] as const) {
      expect(SETTING_LIMITS[name].min, name).toBe(0);
      expect(printed(control(name), 0), name).toBe("off");
    }
  });

  it("never says off on a track that cannot reach zero", () => {
    // The window's floor is a radius of 2, a real window; its bottom is a size, not a switch.
    const window = control("sauvolaRadiusPx");
    expect(SETTING_LIMITS.sauvolaRadiusPx.min).toBeGreaterThan(0);
    expect(printed(window, SETTING_LIMITS.sauvolaRadiusPx.min)).toBe("5 px");
  });

  it("shows the window's width, which is what a GM can picture, rather than the radius it stores", () => {
    expect(printed(control("sauvolaRadiusPx"), 13)).toBe("27 px");
  });

  it("prints the region opacity as a whole percentage, with no space before the sign", () => {
    expect(printed(control("fillOpacity"), 0.22)).toBe("22%");
    expect(printed(control("fillOpacity"), 1)).toBe("100%");
  });

  it("prints a length stored in graph units as pixels, against the raster it is handed", () => {
    // Mend's two (user, 2026-09-29). Two rasters, two answers: the number has to come from the
    // raster, which is the regression the hardcoded-ink-width bug left behind as a principle.
    const reach = control("mendReachGraphUnits");
    const limits = SETTING_LIMITS.mendReachGraphUnits;
    const at = (raster: number | null): string =>
      readoutText(reach, 4e-3, toSlider(4e-3, limits, "log"), limits, "log", raster);
    expect(at(3300)).toBe("13 px");
    expect(at(1600)).toBe("6.4 px");
    expect(at(null)).toMatch(/^\d+$/);
    expect(readoutText(reach, 0, 0, limits, "log", 3300)).toBe("off");
  });

  it("gives one decimal under ten pixels and none above", () => {
    expect(graphUnitsInPixels(1e-3, 3300)).toBe("3.3 px");
    expect(graphUnitsInPixels(1e-2, 3300)).toBe("33 px");
    expect(graphUnitsInPixels(1e-2, null)).toBeNull();
    expect(graphUnitsInPixels(1e-2, 0)).toBeNull();
  });

  it("prints every control's default as a number and a unit, a place, a percentage or off", () => {
    // The shapes a GM can meet, and nothing else: a stray unit with no number, a doubled space or a
    // raw float would all fail here.
    const shape = /^(off|\d+(\.\d+)? px|\d+%|\d+(\.\d+)?)$/;
    for (const each of CONTROLS) {
      const value = readParameter(DEFAULT_SETTINGS, each.name);
      expect(printed(each, value), each.name).toMatch(shape);
    }
  });
});
