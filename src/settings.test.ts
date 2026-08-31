import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  describeSettings,
  isDefault,
  normaliseSettings,
  SETTING_LIMITS,
} from "./settings";

describe("normaliseSettings", () => {
  it("returns the defaults for nothing at all", () => {
    // Scene metadata is empty before a GM ever opens the panel, and every call goes through here.
    for (const nothing of [undefined, null, {}, { trace: {}, review: {} }]) {
      expect(normaliseSettings(nothing)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps a value that is inside its range", () => {
    const settings = normaliseSettings({ trace: { sauvolaK: 0.5 } });
    expect(settings.trace.sauvolaK).toBe(0.5);
  });

  it("clamps rather than rejecting", () => {
    // A number input can be typed into, and a stored value can come from an older version. Clamping
    // keeps the pipeline runnable; rejecting would throw away the GM's other four settings.
    const high = normaliseSettings({
      trace: { blurSigma: 999, sauvolaK: -4 },
      review: { fillOpacity: 8 },
    });
    expect(high.trace.blurSigma).toBe(SETTING_LIMITS.blurSigma.max);
    expect(high.trace.sauvolaK).toBe(SETTING_LIMITS.sauvolaK.min);
    expect(high.review.fillOpacity).toBe(1);
  });

  it("caps simplification below the bound that stops a boundary crossing a wall", () => {
    // Half an ink width is where Douglas-Peucker stops being provably unable to carry a room's edge
    // into the room next door. A control whose top end silently merges rooms is not a control.
    expect(SETTING_LIMITS.simplifyInkWidths.max).toBeLessThan(0.5);
    expect(normaliseSettings({ trace: { simplifyInkWidths: 5 } }).trace.simplifyInkWidths).toBe(
      SETTING_LIMITS.simplifyInkWidths.max,
    );
  });

  it("falls back per field, not wholesale", () => {
    // One unusable value must not discard the rest. The failure this prevents is a GM's tuning
    // vanishing because a single key in stored metadata was a string.
    const mixed = normaliseSettings({
      trace: { sauvolaK: "not a number", blurSigma: 2 },
    });
    expect(mixed.trace.sauvolaK).toBe(DEFAULT_SETTINGS.trace.sauvolaK);
    expect(mixed.trace.blurSigma).toBe(2);
  });

  it("survives anything at all", () => {
    for (const junk of [42, "settings", [], true, { trace: 7 }, { trace: null }]) {
      expect(() => normaliseSettings(junk)).not.toThrow();
      expect(normaliseSettings(junk).trace.sauvolaK).toBe(DEFAULT_SETTINGS.trace.sauvolaK);
    }
  });

  it("rejects NaN and Infinity, which a number input can produce", () => {
    const bad = normaliseSettings({ trace: { blurSigma: NaN, sauvolaK: Infinity } });
    expect(bad.trace.blurSigma).toBe(DEFAULT_SETTINGS.trace.blurSigma);
    expect(bad.trace.sauvolaK).toBe(DEFAULT_SETTINGS.trace.sauvolaK);
  });

  it("is idempotent, so saving what was loaded changes nothing", () => {
    const once = normaliseSettings({ trace: { blurSigma: 1.5 } });
    expect(normaliseSettings(once)).toEqual(once);
  });

  it("keeps every default inside its own limits", () => {
    // A default outside its control's range would be silently rewritten the first time the panel
    // saved, which reads as the extension changing a setting nobody touched.
    expect(normaliseSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("isDefault and describeSettings", () => {
  it("recognises the untouched case", () => {
    expect(isDefault(DEFAULT_SETTINGS)).toBe(true);
    expect(describeSettings(DEFAULT_SETTINGS)).toContain("all defaults");
  });

  it("notices a single changed value", () => {
    const edited = normaliseSettings({ trace: { blurSigma: 2 } });
    expect(isDefault(edited)).toBe(false);
    expect(describeSettings(edited)).toContain("edited");
  });

  it("names every trace parameter, so a run can be read beside its settings", () => {
    const line = describeSettings(DEFAULT_SETTINGS);
    for (const part of ["blur", "k ", "window", "min stroke", "simplify"]) {
      expect(line).toContain(part);
    }
  });
});
