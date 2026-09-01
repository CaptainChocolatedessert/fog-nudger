import { describe, expect, it } from "vitest";

import { formatValue, fromSlider, SLIDER_STEPS, toSlider } from "./sliderScale";
import { DEFAULT_SETTINGS, readParameter, SETTING_LIMITS, type SettingName } from "./settings";

const linear = { min: 0, max: 1, step: 0.02 };
/**
 * A log-scaled range: three orders of magnitude with every useful value near the bottom.
 *
 * Declared here rather than taken from `SETTING_LIMITS` because no shipping control is log-scaled
 * any more — the smallest-room threshold was the only one, and it was removed. The scale itself is
 * still worth keeping tested: it is pure, round-tripping is what stops a setting being rewritten
 * merely by opening a panel, and the next control that needs it should find it working.
 */
const log = { min: 0.002, max: 6, step: 0.01 };

describe("toSlider", () => {
  it("puts the ends at the ends", () => {
    expect(toSlider(linear.min, linear, "linear")).toBe(0);
    expect(toSlider(linear.max, linear, "linear")).toBe(SLIDER_STEPS);
    expect(toSlider(log.min, log, "log")).toBe(0);
    expect(toSlider(log.max, log, "log")).toBe(SLIDER_STEPS);
  });

  it("puts the geometric middle of a log range at the middle of the track", () => {
    // The whole point. On a linear track the geometric mean of 0.002 and 6 sits at 1.8% — three
    // pixels in — and everything a GM would ever choose is crushed against the left stop.
    const geometric = Math.sqrt(log.min * log.max);
    expect(toSlider(geometric, log, "log")).toBe(SLIDER_STEPS / 2);

    const linearPosition = ((geometric - log.min) / (log.max - log.min)) * SLIDER_STEPS;
    expect(linearPosition).toBeLessThan(SLIDER_STEPS * 0.05);
  });

  it("gives the default a reachable position rather than one against the stop", () => {
    // The failure this guards against is shipping a slider whose default sits at 1.6% of the track,
    // where it cannot be nudged and reads as broken.
    const at = toSlider(0.1, log, "log");
    expect(at).toBeGreaterThan(SLIDER_STEPS * 0.2);
    expect(at).toBeLessThan(SLIDER_STEPS * 0.8);
  });

  it("clamps a value from outside the range instead of running off the track", () => {
    expect(toSlider(-5, linear, "linear")).toBe(0);
    expect(toSlider(99, linear, "linear")).toBe(SLIDER_STEPS);
  });

  it("survives a degenerate range and a value that is not a number", () => {
    expect(toSlider(1, { min: 5, max: 5, step: 1 }, "linear")).toBe(0);
    expect(toSlider(NaN, linear, "linear")).toBe(0);
  });
});

describe("fromSlider", () => {
  it("snaps a linear value to the setting's own step", () => {
    // Otherwise every drag stores something like 0.30000000000000004, which is then what the GM
    // reads back in the run log.
    for (let position = 0; position <= SLIDER_STEPS; position += 37) {
      const value = fromSlider(position, linear, "linear");
      expect(Math.round(value / linear.step) * linear.step).toBeCloseTo(value, 10);
      expect(String(value)).not.toMatch(/\d{6,}/);
    }
  });

  it("keeps a log value to three significant figures", () => {
    for (let position = 0; position <= SLIDER_STEPS; position += 53) {
      expect(String(fromSlider(position, log, "log"))).not.toMatch(/\d{6,}/);
    }
  });

  it("stays inside the range at both ends", () => {
    for (const scale of ["linear", "log"] as const) {
      const limits = scale === "log" ? log : linear;
      for (const position of [-10, 0, SLIDER_STEPS, SLIDER_STEPS + 10]) {
        const value = fromSlider(position, limits, scale);
        expect(value).toBeGreaterThanOrEqual(limits.min);
        expect(value).toBeLessThanOrEqual(limits.max);
      }
    }
  });
});

describe("round-tripping", () => {
  /**
   * The property that matters most. A value arrives from scene metadata, positions the slider, and
   * the slider must reproduce it — otherwise merely *opening the panel* rewrites a GM's setting,
   * which is the worst failure a control can have because nothing announces it.
   */
  it("returns every default EXACTLY unchanged", () => {
    /*
      Tightened from "within one step" on 2026-08-31, and the loosening it replaces is worth
      recording. `strokeSquares` defaulted to 1/12 against a hundredth-step track, so it was the one
      default that could not land on its own slider — nudging it and putting it back gave 0.08, after
      which `isDefault` was false permanently and every log line said "(edited)" for a scene the GM
      considers untouched. The default is 0.08 now and the tolerance is gone with it.

      Every default landing on its own step is the property worth having, because the failure it
      prevents is the worst a control can have: merely opening a surface rewrites a GM's setting, and
      nothing announces it.

      No shipping control is log-scaled — the smallest-room threshold was the only one and was
      deleted — so this walks the linear scale. The log path is covered against a locally declared
      range in the tests above; a ternary here naming `minRoomSquares` outlived the setting and always
      chose "linear" anyway.
    */
    for (const [name, limits] of Object.entries(SETTING_LIMITS)) {
      // Read from the real defaults rather than a copy of them. A hand-maintained list here went
      // stale the moment a setting was added, and failed as `NaN` — which reads as a scaling bug
      // rather than as a missing entry.
      const value = readParameter(DEFAULT_SETTINGS, name as SettingName);
      expect(fromSlider(toSlider(value, limits, "linear"), limits, "linear"), name).toBe(value);
    }
  });

  it("is stable once a value has been through the slider", () => {
    // The stronger claim: whatever the first round trip produces must survive every later one, or a
    // setting would drift a little each time the panel opened.
    for (const scale of ["linear", "log"] as const) {
      const limits = scale === "log" ? log : linear;
      for (let position = 0; position <= SLIDER_STEPS; position += 41) {
        const once = fromSlider(position, limits, scale);
        const twice = fromSlider(toSlider(once, limits, scale), limits, scale);
        expect(twice).toBe(once);
      }
    }
  });
});

describe("formatValue", () => {
  it("shows a linear value at its step's precision", () => {
    expect(formatValue(0.3, linear, "linear")).toBe("0.30");
    expect(formatValue(1, linear, "linear")).toBe("1.00");
  });

  it("does not pad a log value with meaningless zeroes", () => {
    expect(formatValue(0.1, log, "log")).toBe("0.1");
    expect(formatValue(2.5, log, "log")).toBe("2.5");
  });
});
