/**
 * The sentences a GM reads beside every slider.
 *
 * This module had no test file at all until 2026-09-01, and it is the one place in `src/` where
 * that is indefensible: it imports two *types* and nothing else — no SDK, no DOM — and being
 * reachable from a headless test is the stated reason `derive` is handed its measurements rather
 * than fetching them.
 *
 * It has produced two defects of exactly the kind these catch. A readout once multiplied by
 * `0.111` — one map's ink width, hardcoded into a control meant for any map. And a `pxPerSquare` of
 * zero slipped past a `=== null` guard and divided, putting the literal string `Infinity` beside a
 * slider: a guess in the voice of a measurement, which is what the nullability exists to prevent.
 *
 * The sweeps below are deliberately about **shapes of output**, not about wording. A test that
 * pinned the sentences would fail on every rephrasing and teach nobody anything.
 */

import { describe, expect, it } from "vitest";

import { CONTROLS, type Measured } from "./controls";
import { readParameter, SETTING_LIMITS, DEFAULT_SETTINGS } from "./settings";

/** Every value a slider can be at, plus the two ends and the default. */
function sampleValues(name: (typeof CONTROLS)[number]["name"]): number[] {
  const limits = SETTING_LIMITS[name];
  const middle = (limits.min + limits.max) / 2;
  return [limits.min, middle, limits.max, readParameter(DEFAULT_SETTINGS, name)];
}

const NONSENSE = ["NaN", "Infinity", "undefined", "null", "[object"];

/** Nothing read yet — the state a workspace opens in, and the only state the editor is ever in. */
const MEASURED_NONE: Measured = { pxPerSquare: null, inkWidth: null, rasterWidth: null };

/** The test map's own figures, so a passing sweep is about a plausible map. */
const MEASURED_MAP: Measured = { pxPerSquare: 51, inkWidth: 5.7, rasterWidth: 3300 };

function sweep(measured: Measured, label: string): void {
  for (const control of CONTROLS) {
    if (!control.derive) continue;
    for (const value of sampleValues(control.name)) {
      const said = control.derive(value, measured);
      for (const bad of NONSENSE) {
        expect(said.includes(bad), `${control.name} at ${value}, ${label}: "${said}"`).toBe(false);
      }
    }
  }
}

describe("every control's readout", () => {
  it("says nothing nonsensical before anything has been measured", () => {
    // The state a workspace opens in. Every readout that needs a measurement has to drop its clause
    // rather than reach for a number that does not exist yet.
    sweep(MEASURED_NONE, "nothing measured");
  });

  it("says nothing nonsensical on a zero measurement, which survives a null guard", () => {
    // The bug this is the regression for. `pxPerSquare` is computed as 0 when the map spans no grid
    // squares, and `=== null` does not catch a zero — so the division that followed printed
    // "Infinity". `lastPixelsPerSquare` nulls a zero at source now; this is the type's own contract
    // holding rather than one caller remembering to.
    sweep({ pxPerSquare: 0, inkWidth: 0, rasterWidth: 0 }, "zero measurements");
  });

  it("says nothing nonsensical on a real measurement", () => {
    // The test map's own figures, so a passing sweep is about a plausible map rather than about a
    // number chosen to be easy.
    sweep(MEASURED_MAP, "measured");
  });

  it("says nothing nonsensical on a negative measurement either", () => {
    // Not reachable from the pipeline, and asserted because `Measured` permits it: a readout is a
    // pure function of what it is handed, and it should not be the caller's job to know that.
    sweep({ pxPerSquare: -1, inkWidth: -1, rasterWidth: -1 }, "negative measurements");
  });
});

describe("readouts that depend on a measurement", () => {
  const gapFill = CONTROLS.find((control) => control.name === "gapFillPx")!;
  const spurs = CONTROLS.find((control) => control.name === "spurPruneFraction")!;
  const stroke = CONTROLS.find((control) => control.name === "minStrokeInkWidths")!;
  const simplify = CONTROLS.find((control) => control.name === "simplifyFraction")!;

  it("drops the grid-square clause when there is no pixel density", () => {
    expect(gapFill.derive!(12, MEASURED_NONE)).not.toContain("of a square");
    expect(gapFill.derive!(12, { ...MEASURED_NONE, pxPerSquare: 0 })).not.toContain("of a square");
    expect(gapFill.derive!(12, MEASURED_MAP)).toContain("of a square");
  });

  /*
    The two graph-derived controls say nothing at all without a raster, and that is the case the
    editor is always in.

    They are stored as a fraction of the map because that is the only unit both modes can speak. The
    ink mode can turn it back into pixels; the editor never ran a reading and cannot, so the readout
    goes quiet rather than inventing one. Both are checked, because a readout that is right only in
    the mode it was written in is the failure this file exists to catch.
  */
  it("says nothing in pixels when no raster has been read", () => {
    for (const control of [spurs, simplify]) {
      expect(control.derive!(4e-4, MEASURED_NONE)).toBe("");
      expect(control.derive!(4e-4, MEASURED_MAP)).toContain("px");
      // Empty rather than "off": their own `format` says so beside the label, and a hint that
      // repeated it would print "off" twice in one row.
      expect(control.derive!(0, MEASURED_MAP)).toBe("");
    }
  });

  it("writes a map fraction as something a GM can read", () => {
    for (const control of [spurs, simplify]) {
      expect(control.format!(4e-4)).toBe("4/10k");
      expect(control.format!(0)).toBe("off");
    }
  });

  it("says so plainly when an ink width is wanted and has not been measured", () => {
    // Only the stroke filter is denominated in ink widths now. The simplification tolerance was,
    // and moved to a fraction of the map on 2026-09-06 so that both modes could speak it — it
    // reports *against* an ink width where one exists, which the raster test above covers.
    expect(stroke.derive!(0.5, { pxPerSquare: 51, inkWidth: null, rasterWidth: 3300 })).toBe(
      "trace once for a figure",
    );
  });

  it("uses the measurement it is handed rather than a constant", () => {
    /*
      The direct regression for the hardcoded-`0.111` bug: a readout that multiplied by one map's
      ink width, inside a control meant for any map. Two different measurements must produce two
      different sentences, or the number in them is not coming from the measurement.
    */
    for (const control of [stroke, simplify]) {
      const thin = control.derive!(0.5, { pxPerSquare: 51, inkWidth: 3, rasterWidth: 3300 });
      const thick = control.derive!(0.5, { pxPerSquare: 51, inkWidth: 9, rasterWidth: 3300 });
      expect(thin, control.name).not.toBe(thick);
    }
    // The two stored as a fraction of the map report against the raster instead, so that is the
    // measurement their sentence has to come from.
    for (const control of [spurs, simplify]) {
      const small = control.derive!(4e-4, { pxPerSquare: 51, inkWidth: 5.7, rasterWidth: 1600 });
      const large = control.derive!(4e-4, { pxPerSquare: 51, inkWidth: 5.7, rasterWidth: 3300 });
      expect(small, control.name).not.toBe(large);
    }
    for (const control of [gapFill]) {
      const coarse = control.derive!(12, { pxPerSquare: 20, inkWidth: 5.7, rasterWidth: 3300 });
      const fine = control.derive!(12, { pxPerSquare: 80, inkWidth: 5.7, rasterWidth: 3300 });
      expect(coarse, control.name).not.toBe(fine);
    }
  });

  it("says a control that is off is off, whatever has been measured", () => {
    // Zero is off for all four of these, and it has to read as off rather than as "0px, 0.00 of a
    // square" — a GM scanning for which controls are doing something reads the readout, not the
    // slider position.
    // Not the two stored as a map fraction: they say "off" through `format` instead, which the
    // raster test above pins. A control cannot be in both lists without saying it twice.
    for (const control of [gapFill, stroke]) {
      for (const measured of [MEASURED_NONE, MEASURED_MAP]) {
        expect(control.derive!(0, measured), control.name).toBe("off");
      }
    }
  });
});

describe("the control declaration", () => {
  it("gives every control a range to move over", () => {
    // `steps.test.ts` pins that every control is reachable from a step; nothing pinned that every
    // control has limits, and a control without them cannot be rendered as a slider at all.
    for (const control of CONTROLS) {
      const limits = SETTING_LIMITS[control.name];
      expect(limits, control.name).toBeDefined();
      expect(limits.max, control.name).toBeGreaterThan(limits.min);
      expect(limits.step, control.name).toBeGreaterThan(0);
    }
  });

  it("gives every control a label and a hint", () => {
    for (const control of CONTROLS) {
      expect(control.label.length, control.name).toBeGreaterThan(0);
      expect(control.hint.length, control.name).toBeGreaterThan(0);
    }
  });

  it("names each parameter at most once", () => {
    const names = CONTROLS.map((control) => control.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
