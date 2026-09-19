import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  describeSettings,
  isDefault,
  normaliseSettings,
  SETTING_LIMITS,
  seededGraphUnitsFromPixels,
} from "./settings";

describe("normaliseSettings", () => {
  it("returns the defaults for nothing at all", () => {
    // Scene metadata is empty before a GM ever opens the workspace, and every call goes through here.
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

  /*
    The half-ink-width cap was pinned here and is **retired** (user, 2026-09-06).

    Region-first, half an ink width was where Douglas–Peucker stopped being provably unable to carry
    a room's edge into the room next door. Under the wall graph that cannot happen: the boundary *is*
    the wall's centreline, both faces are assembled from the same fitted edge, and they move
    together. What replaces the cap is the same argument the two ink filters rest on — the top of the
    track should reach obviously useless values, and it is visible when it does.

    What still has to hold is the **off state**, which the prune limit gained when it moved onto a
    log scale: it has a real zero, and a log scale cannot start at one. Straightening was the second
    control here until 2026-09-18, when it stopped being a stored setting at all.
  */
  /*
    **The off-state test went on 2026-09-18, with the last setting it applied to.**

    It pinned that a stored zero survives a read on a log control with a real off position — the floor
    being declared beside `min` rather than as it, because this normaliser clamps into `[min, max]` and
    a positive `min` would raise a stored zero to the floor on every read, destroying the off state at
    the one moment nothing is watching.

    Straightening and pruning are amounts pressed in the Walls drawer now and nothing stores them, so
    no setting is left with an off position to guard. **The rule is not dead** — it belongs to any
    future log-scaled setting with a real zero, and `SETTING_LIMITS` still carries `floor` for exactly
    that shape.
  */

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
    // A default outside its control's range would be silently rewritten the first time the workspace
    // saved, which reads as the extension changing a setting nobody touched.
    expect(normaliseSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("seededGraphUnitsFromPixels", () => {
  /*
    The mend tool's starting distances: a pixel figure turned into graph units by the raster's own
    pixels per unit, so 20 pixels is 20 pixels of wall on any map.

    Two mutations on 2026-09-16 — multiplying where it divides, and no floor — two caught.
  */
  it("turns raster pixels into graph units at the raster's own scale", () => {
    // To three significant figures, as the straightening seed rounds, so a slider lands on a value it
    // can show rather than on a long tail of digits.
    expect(seededGraphUnitsFromPixels("mendReachGraphUnits", 20, 3300)).toBeCloseTo(20 / 3300, 4);
    expect(seededGraphUnitsFromPixels("mendReachGraphUnits", 20, 751)).toBeCloseTo(20 / 751, 4);
    expect(seededGraphUnitsFromPixels("mendTravelGraphUnits", 40, 3300)).toBeCloseTo(40 / 3300, 4);
  });

  it("stays inside the control's track, and never on its off position", () => {
    const { floor, max } = SETTING_LIMITS.mendReachGraphUnits;
    expect(seededGraphUnitsFromPixels("mendReachGraphUnits", 0.001, 100000)).toBe(floor);
    expect(seededGraphUnitsFromPixels("mendReachGraphUnits", 20, 10)).toBe(max);
  });

  it("falls back to the static default with nothing to convert by", () => {
    expect(seededGraphUnitsFromPixels("mendReachGraphUnits", 20, 0)).toBe(
      DEFAULT_SETTINGS.trace.mendReachGraphUnits,
    );
  });

  it("has static defaults that are the seeds on the test map, so the fallback is the same stretch", () => {
    // Before a reading lands the static figure stands; on the 3300px test map it is what a seed gives.
    expect(DEFAULT_SETTINGS.trace.mendReachGraphUnits).toBeCloseTo(20 / 3300, 3);
    expect(DEFAULT_SETTINGS.trace.mendTravelGraphUnits).toBeCloseTo(40 / 3300, 3);
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
    /*
      The list is every key of `TraceSettings`, and it is checked twice over.

      This test was named "every" while checking five of the nine, which is how spur pruning went
      missing from the summary: the `minRoomSquares` term was removed when that control was deleted
      and `spurPrunePx` was never added in its place, so the one control that can erode the whole
      graph at its top end was absent from the line a log reader sees, with nothing failing.

      The value check is what makes a *missing* term fail rather than only a renamed one. A term
      dropped from the string takes its number with it, and a number that appears nowhere in the
      summary is a setting the log cannot report.
    */
    const line = describeSettings(DEFAULT_SETTINGS);
    for (const part of ["blur", "k ", "window", "min stroke", "min island"]) {
      expect(line, `no "${part}" in: ${line}`).toContain(part);
    }
    /*
      The gaps term is one phrase covering two settings, and the **default now reports both**.

      It collapsed to "off" while zero was the default, because a travel distance for a repair that
      was not running was noise. Zero stopped being the default on 2026-09-05: the search proposes
      rather than writes, so nothing needed protecting from a nonzero value, and a tool that shows
      nothing until a slider is found is one nobody finds.
    */
    expect(line).toContain("gaps up to 12px");
    expect(line).toContain("travel 40px");
  });

  it("collapses the gap settings to off when the search is switched off", () => {
    // The other half of the conditional, which the default line no longer reaches. Zero is a
    // legitimate setting — it is how a GM silences the search — and reporting a travel distance
    // beside it would describe a search that is not looking for anything.
    const off = normaliseSettings({ trace: { gapFillPx: 0, gapTravelPx: 40 } });
    const line = describeSettings(off);

    expect(line).toContain("gaps off");
    expect(line).not.toContain("travel 40px");
  });
});
