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
  normaliseSettings,
  PARAMETER_STAGE,
  readParameter,
  resetStage,
  SETTING_LIMITS,
  STAGES,
  stageParameters,
  writeParameter,
  type SettingName,
  type Stage,
} from "./settings";

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
  it("changes when any reading parameter changes", () => {
    const base = maskFingerprint(DEFAULT_SETTINGS);
    for (const name of stageParameters("read")) {
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(maskFingerprint(changed)).not.toBe(base);
    }
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
