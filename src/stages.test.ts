/**
 * The three stages, and the one property the cache boundary rests on.
 *
 * The stage declaration is read by two things that must not disagree: the panel, which decides
 * which tab a control appears on, and the pipeline, which decides whether a cached mask may be
 * reused. If they ever diverged the symptom would be a stage-two tweak silently deriving regions
 * from a stale reading and reporting them as current — a diagnostic that lies, which is the
 * failure this project has already paid for once.
 *
 * So the invalidation rule is stated here as a property rather than left implicit in two call
 * sites. Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  isStageDefault,
  maskFingerprint,
  normaliseColour,
  normaliseSettings,
  isPostReading,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readingFingerprint,
  readParameter,
  resetStage,
  SETTING_LIMITS,
  STAGES,
  stageParameters,
  writeParameter,
  type SettingName,
  type Stage,
} from "./settings";
import { fromSlider, SLIDER_STEPS } from "./sliderScale";

const ALL_NAMES = Object.keys(SETTING_LIMITS) as SettingName[];

/** A value for a parameter that is guaranteed to differ from its default. */
function otherValue(name: SettingName): number {
  const limits = SETTING_LIMITS[name];
  const current = readParameter(DEFAULT_SETTINGS, name);
  return current === limits.max ? limits.min : limits.max;
}

describe("the stage declaration", () => {
  it("assigns every parameter to exactly one stage", () => {
    // Totality is the point. A parameter with no stage would vanish from the panel entirely, and
    // one that the pipeline could not classify would have to be treated as invalidating
    // everything — silently making the cache useless rather than wrong, which is harder to notice.
    for (const name of ALL_NAMES) {
      expect(STAGES).toContain(PARAMETER_STAGE[name]);
    }
  });

  it("partitions the parameters across the three stages with no gaps or overlaps", () => {
    const collected = STAGES.flatMap((stage) => stageParameters(stage));
    expect([...collected].sort()).toEqual([...ALL_NAMES].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("puts every stage to work", () => {
    // An empty stage would be a tab with no controls on it, which is a structure claiming an
    // ordering it does not have.
    for (const stage of STAGES) {
      expect(stageParameters(stage).length).toBeGreaterThan(0);
    }
  });

  it("keeps the stages in cascade order", () => {
    // The order is the cascade: reading destroys deriving and adjusting, deriving destroys
    // adjusting. Everything numbered in the panel reads this array, so reversing it would renumber
    // the tabs without changing what they do.
    expect(STAGES).toEqual(["read", "derive", "adjust"]);
  });
});

describe("maskFingerprint", () => {
  it("changes when any reading PIPELINE parameter changes", () => {
    const base = maskFingerprint(DEFAULT_SETTINGS);
    for (const name of stageParameters("read")) {
      if (PARAMETER_KIND[name] !== "pipeline") continue;
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(maskFingerprint(changed)).not.toBe(base);
    }
  });

  it("does NOT change for a reading-stage DISPLAY parameter", () => {
    // The reason the two axes exist. The overlay's opacity sits on the reading tab because that is
    // where the overlay is looked at, but it changes nothing the pipeline computes. Filing it as a
    // reading parameter would throw away the cached mask and force a full re-binarisation every
    // time the GM nudged the slider — a second of work to arrive at an identical image.
    const base = maskFingerprint(DEFAULT_SETTINGS);
    for (const name of stageParameters("read")) {
      if (PARAMETER_KIND[name] !== "display") continue;
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(maskFingerprint(changed)).toBe(base);
    }
  });

  it("has at least one parameter of each kind, so neither test above is vacuous", () => {
    // Every test in this block is a loop with a filter, and a filter that matches nothing passes.
    // A rename that emptied one of them would leave a green suite asserting nothing — which is how
    // the short-lived `gaps` kind would have gone unnoticed after its last member became pipeline.
    for (const kind of ["pipeline", "display"] as const) {
      expect(ALL_NAMES.filter((name) => PARAMETER_KIND[name] === kind).length).toBeGreaterThan(0);
    }
  });

  it("does NOT change when the overlay colour changes", () => {
    // The colour is not a number, so it lives outside the numeric machinery entirely and could not
    // reach the fingerprint even by accident today. Pinned anyway, because "could not reach it"
    // is a property of the current implementation rather than of the design.
    const recoloured: typeof DEFAULT_SETTINGS = {
      ...DEFAULT_SETTINGS,
      overlay: { ...DEFAULT_SETTINGS.overlay, inkColour: "#00ff00" },
    };
    expect(maskFingerprint(recoloured)).toBe(maskFingerprint(DEFAULT_SETTINGS));
  });

  it("does NOT change when a deriving or adjusting parameter changes", () => {
    // This is the property the whole cache rests on. If it failed in this direction the cache would
    // merely be useless; the test exists because a later edit could just as easily break it in the
    // *other* direction, and that one is silent.
    const base = maskFingerprint(DEFAULT_SETTINGS);
    for (const stage of ["derive", "adjust"] as const) {
      for (const name of stageParameters(stage)) {
        const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
        expect(maskFingerprint(changed)).toBe(base);
      }
    }
  });

  it("distinguishes two different readings rather than merely differing from the default", () => {
    const a = writeParameter(DEFAULT_SETTINGS, "sauvolaK", 0.2);
    const b = writeParameter(DEFAULT_SETTINGS, "sauvolaK", 0.4);
    expect(maskFingerprint(a)).not.toBe(maskFingerprint(b));
  });
});

/**
 * The second cache boundary, and the one that can be wrong rather than merely useless.
 *
 * The reading is reused whenever this fingerprint is unchanged, so a parameter that feeds
 * binarisation and is *not* covered here would be a stale mask reported as current — the failure
 * this project has already paid for once. The declaration is written by exclusion so that the
 * default for anything new is to invalidate; these tests pin that polarity.
 */
describe("readingFingerprint", () => {
  it("changes for every reading parameter that is not declared post-reading", () => {
    const base = readingFingerprint(DEFAULT_SETTINGS);
    for (const name of stageParameters("read")) {
      if (PARAMETER_KIND[name] !== "pipeline" || isPostReading(name)) continue;
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(readingFingerprint(changed)).not.toBe(base);
    }
  });

  it("does NOT change for a parameter composed on top of the reading", () => {
    // The whole point: sweeping a 1b filter or a gap slider must not re-binarise a map that has not
    // changed. This is what turns a 1.4s notch into a 0.7s one.
    const base = readingFingerprint(DEFAULT_SETTINGS);
    for (const name of ALL_NAMES) {
      if (!isPostReading(name)) continue;
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(readingFingerprint(changed)).toBe(base);
    }
  });

  it("covers strictly less than the mask fingerprint, and every post-reading parameter is in it", () => {
    // A post-reading parameter that the *mask* fingerprint also ignored would be a setting the GM
    // could change with no effect at all, silently.
    for (const name of ALL_NAMES) {
      if (!isPostReading(name)) continue;
      expect(PARAMETER_KIND[name]).toBe("pipeline");
      expect(PARAMETER_STAGE[name]).toBe("read");
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(maskFingerprint(changed)).not.toBe(maskFingerprint(DEFAULT_SETTINGS));
    }
  });

  it("declares at least one parameter on each side of the boundary", () => {
    const post = ALL_NAMES.filter(isPostReading);
    const reading = stageParameters("read").filter(
      (name) => PARAMETER_KIND[name] === "pipeline" && !isPostReading(name),
    );
    expect(post.length).toBeGreaterThan(0);
    expect(reading.length).toBeGreaterThan(0);
  });
});

/**
 * The one place two controls are related to each other rather than independent.
 *
 * Filling selects from among the breaks marking has found, so a fill wider than the mark would be
 * repairing something the GM was never shown — which is the failure the marks exist to prevent. The
 * relationship is enforced by expressing the fill as a *share*, and these pin that there is no
 * position on its track that can break it.
 */
describe("the fill is a share of the mark", () => {
  it("cannot exceed the marking width anywhere on its track", () => {
    const limits = SETTING_LIMITS.gapFillShare;
    for (let position = 0; position <= SLIDER_STEPS; position += 25) {
      const share = fromSlider(position, limits, "linear");
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
      // Which is the whole guarantee, since the pipeline's fill width is the product of the two.
      for (const marked of [0, 1, 12, 80]) {
        expect(share * marked).toBeLessThanOrEqual(marked);
      }
    }
  });

  it("reaches all of the marked breaks at the top of its track, and none at the bottom", () => {
    const limits = SETTING_LIMITS.gapFillShare;
    expect(fromSlider(0, limits, "linear")).toBe(0);
    expect(fromSlider(SLIDER_STEPS, limits, "linear")).toBe(1);
  });

  it("fills nothing when nothing is marked", () => {
    // Marking off means the fill has an empty set to select from, whatever it is set to. Zero times
    // anything is zero, so this is arithmetic rather than a special case — pinned because a later
    // change to either control could quietly introduce one.
    const off = writeParameter(DEFAULT_SETTINGS, "gapWidthPx", 0);
    const eager = writeParameter(off, "gapFillShare", 1);
    expect(readParameter(eager, "gapWidthPx") * readParameter(eager, "gapFillShare")).toBe(0);
  });
});

describe("readParameter and writeParameter", () => {
  it("round-trip every parameter, whichever group it is stored in", () => {
    // The stored shape keeps its two groups while the UI shows three stages, so these accessors are
    // the only thing bridging them. A parameter written to the wrong group would read back as its
    // default and the panel would snap the slider back on the next repaint.
    for (const name of ALL_NAMES) {
      const value = otherValue(name);
      const written = writeParameter(DEFAULT_SETTINGS, name, value);
      expect(readParameter(written, name)).toBe(value);
    }
  });

  it("leaves every other parameter alone", () => {
    for (const name of ALL_NAMES) {
      const written = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      for (const other of ALL_NAMES) {
        if (other === name) continue;
        expect(readParameter(written, other)).toBe(readParameter(DEFAULT_SETTINGS, other));
      }
    }
  });

  it("survives the normaliser, so nothing written here is rejected on the way back", () => {
    for (const name of ALL_NAMES) {
      const value = otherValue(name);
      const written = writeParameter(DEFAULT_SETTINGS, name, value);
      expect(readParameter(normaliseSettings(written), name)).toBe(value);
    }
  });
});

describe("isStageDefault and resetStage", () => {
  it("judges one stage without regard to the others", () => {
    // The two-tab version judged both reset buttons against the whole settings object, so editing
    // the appearance left the reading's button live with nothing for it to do.
    for (const stage of STAGES) {
      const edited = stageParameters(stage).reduce(
        (settings, name) => writeParameter(settings, name, otherValue(name)),
        DEFAULT_SETTINGS,
      );
      expect(isStageDefault(edited, stage)).toBe(false);
      for (const other of STAGES) {
        if (other === stage) continue;
        expect(isStageDefault(edited, other)).toBe(true);
      }
    }
  });

  it("puts one stage back without touching the rest", () => {
    const everything = ALL_NAMES.reduce(
      (settings, name) => writeParameter(settings, name, otherValue(name)),
      DEFAULT_SETTINGS,
    );

    for (const stage of STAGES) {
      const reset = resetStage(everything, stage);
      for (const name of stageParameters(stage)) {
        expect(readParameter(reset, name)).toBe(readParameter(DEFAULT_SETTINGS, name));
      }
      for (const name of ALL_NAMES) {
        if (PARAMETER_STAGE[name] === stage) continue;
        expect(readParameter(reset, name)).toBe(readParameter(everything, name));
      }
    }
  });

  it("recognises the untouched case for every stage", () => {
    for (const stage of STAGES) {
      expect(isStageDefault(DEFAULT_SETTINGS, stage)).toBe(true);
    }
  });

  it("resetting the reading stage leaves the mask fingerprint at its default", () => {
    // Stated as a tie between the two mechanisms rather than as two separate facts: whatever the
    // reset does must be exactly what the cache considers a return to the default reading.
    const edited = stageParameters("read").reduce(
      (settings: typeof DEFAULT_SETTINGS, name) => writeParameter(settings, name, otherValue(name)),
      DEFAULT_SETTINGS,
    );
    expect(maskFingerprint(edited)).not.toBe(maskFingerprint(DEFAULT_SETTINGS));
    expect(maskFingerprint(resetStage(edited, "read" as Stage))).toBe(
      maskFingerprint(DEFAULT_SETTINGS),
    );
  });
});

describe("the overlay colour", () => {
  it("survives a round trip through the normaliser unchanged", () => {
    // The failure this is aimed at is silent: if the stored form and the panel's form differ, then
    // merely opening the panel rewrites the setting and marks it edited. The colour input reports
    // lower case, so the store must too.
    for (const colour of ["#ff2020", "#000000", "#ffffff", "#00c8ff"]) {
      const stored = normaliseSettings({ overlay: { inkColour: colour } });
      expect(stored.overlay.inkColour).toBe(colour);
      expect(normaliseSettings(stored).overlay.inkColour).toBe(colour);
    }
  });

  it("lower-cases what it accepts, so the panel cannot disagree with the store", () => {
    expect(normaliseColour("#FF2020", "#000000")).toBe("#ff2020");
  });

  it("falls back for anything malformed rather than storing it", () => {
    for (const bad of [undefined, null, 42, "", "#fff", "red", "#ggg000", { r: 1 }]) {
      expect(normaliseColour(bad, "#ff2020")).toBe("#ff2020");
    }
  });

  it("falls back per field, so a bad colour does not discard the opacity beside it", () => {
    const mixed = normaliseSettings({ overlay: { inkColour: "nonsense", inkOpacity: 0.5 } });
    expect(mixed.overlay.inkColour).toBe(DEFAULT_SETTINGS.overlay.inkColour);
    expect(mixed.overlay.inkOpacity).toBe(0.5);
  });

  it("is put back by resetting the reading stage, being a reading-tab control", () => {
    // The colour is not in SETTING_LIMITS, so every function that walks a stage's parameters has to
    // remember it separately. This is the one that would be forgotten.
    const edited = { ...DEFAULT_SETTINGS, overlay: { ...DEFAULT_SETTINGS.overlay, inkColour: "#00ff00" } };
    expect(isStageDefault(edited, "read")).toBe(false);
    expect(resetStage(edited, "read").overlay.inkColour).toBe(DEFAULT_SETTINGS.overlay.inkColour);
  });

  it("is left alone by resetting the other stages", () => {
    const edited = { ...DEFAULT_SETTINGS, overlay: { ...DEFAULT_SETTINGS.overlay, inkColour: "#00ff00" } };
    for (const stage of ["derive", "adjust"] as const) {
      expect(isStageDefault(edited, stage)).toBe(true);
      expect(resetStage(edited, stage).overlay.inkColour).toBe("#00ff00");
    }
  });
});
