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

/** Nothing read yet — the state a workspace opens in. */
const MEASURED_NONE: Measured = { pxPerSquare: null, rasterWidth: null };

/** The test map's own figures, so a passing sweep is about a plausible map. */
const MEASURED_MAP: Measured = { pxPerSquare: 51, rasterWidth: 3300 };

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
    sweep({ pxPerSquare: 0, rasterWidth: 0 }, "zero measurements");
  });

  it("says nothing nonsensical on a real measurement", () => {
    // The test map's own figures, so a passing sweep is about a plausible map rather than about a
    // number chosen to be easy.
    sweep(MEASURED_MAP, "measured");
  });

  it("says nothing nonsensical on a negative measurement either", () => {
    // Not reachable from the pipeline, and asserted because `Measured` permits it: a readout is a
    // pure function of what it is handed, and it should not be the caller's job to know that.
    sweep({ pxPerSquare: -1, rasterWidth: -1 }, "negative measurements");
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
    The two graph-derived controls say nothing at all without a raster.

    They are stored as a fraction of the map, and turning that back into pixels needs the raster the
    last reading used. Until one lands the readout goes quiet rather than inventing one. Both are
    checked, because two controls sharing a formatter is exactly where one of them gets left behind.
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

  /*
    These three ask to report where the handle is rather than what the value is.

    Their stored unit is a fraction of the map, which is the only one both modes can speak and not one
    a GM can hold on to — and neither was the per-ten-thousand spelling that came before it. What the
    readout is for is remembering a setting and coming back to it, which a position on the track
    serves. The rendering itself is `settingRows`; what belongs here is that the declaration asks.
  */
  it("asks for a position readout on every control stored as a map fraction", () => {
    for (const control of [spurs, simplify]) {
      expect(control.readout, control.name).toBe("position");
    }
  });

  it("leaves every other control to the shared formatter", () => {
    const byPosition = new Set(["spurPruneFraction", "simplifyFraction"]);
    for (const control of CONTROLS) {
      if (byPosition.has(control.name)) continue;
      expect(control.readout, control.name).toBeUndefined();
    }
  });

  it("gives the stroke filter no derived line, because every figure it could give is a guess", () => {
    /*
      **Removed on 2026-09-16, and pinned so it is not quietly put back.** The stroke filter is stored
      in measured ink widths, so any pixel figure beside it is the setting times an erosion estimate
      — biased thin and unrepresentative on a hatched map — stated as though it were a fact. Its
      readout said *"under ~4px goes (ink is 3.2px)"*, and nobody looked at it while tuning.

      `Measured` no longer carries the ink width at all, so no readout can quote it without `tsc`
      refusing. This covers the one control whose line was *made* of it rather than decorated by it.

      Mutation-tested with the rest of this block on 2026-09-16: six mutations, six caught — five
      here, and one by `tsc` alone (a readout destructuring `inkWidth` from `Measured` fails TS2339,
      which is the guard for the three lines that only quoted it).
    */
    expect(stroke.derive).toBeUndefined();
  });

  it("uses the measurement it is handed rather than a constant", () => {
    /*
      The regression for the hardcoded-`0.111` bug: a readout that multiplied by one map's measured
      ink width, inside a control meant for any map. That readout is gone, and the principle is not:
      two different measurements must produce two different sentences, or the number in them is not
      coming from the measurement.
    */
    // The two stored as a fraction of the map report against the raster.
    for (const control of [spurs, simplify]) {
      const small = control.derive!(4e-4, { pxPerSquare: 51, rasterWidth: 1600 });
      const large = control.derive!(4e-4, { pxPerSquare: 51, rasterWidth: 3300 });
      expect(small, control.name).not.toBe(large);
    }
    for (const control of [gapFill]) {
      const coarse = control.derive!(12, { pxPerSquare: 20, rasterWidth: 3300 });
      const fine = control.derive!(12, { pxPerSquare: 80, rasterWidth: 3300 });
      expect(coarse, control.name).not.toBe(fine);
    }
  });

  it("says a control that is off is off, whatever has been measured", () => {
    // Zero is off, and it has to read as off rather than as "0px, 0.00 of a square" — a GM scanning
    // for which controls are doing something reads the readout, not the slider position.
    // Not the two stored as a map fraction: they say "off" through `format` instead, which the
    // raster test above pins. A control cannot be in both lists without saying it twice.
    for (const control of [gapFill]) {
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

  it("gives every control a label, and leans on it rather than on a hint", () => {
    /*
      **The hint assertion was inverted on 2026-09-09**, and this is the point of the change rather
      than a relaxation to let one through. It used to demand a non-empty hint from every control,
      which is a test enforcing a paragraph under every slider — so the label was allowed to be
      whatever it liked as long as prose underneath explained it.

      What the surface needs is the opposite: a label that carries the control on its own, and a
      hint only where nothing else can say the thing. Two qualify today, and they are named.

      **Named rather than counted, and the cap was tried first.** A `<= 3` against two hints passed a
      mutation that added a third, which is precisely the change this exists to stop: one free slot
      is a slot something slips into. Naming them means adding a hint fails here and the author has
      to come and argue for it, which is the whole intent.

      Mutation-tested with the two below in `steps.test.ts`: six mutations, six caught — but only
      after the cap became a list. The `<= 3` form scored four of six.
    */
    for (const control of CONTROLS) {
      expect(control.label.length, control.name).toBeGreaterThan(0);
    }
    const hinted = CONTROLS.filter((control) => control.hint.length > 0).map((it) => it.name);
    expect(hinted).toEqual(["gapFillPx", "gapTravelPx"]);
  });

  it("names each parameter at most once", () => {
    const names = CONTROLS.map((control) => control.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
