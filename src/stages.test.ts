/**
 * The three stages, and the one property the cache boundary rests on.
 *
 * The stage declaration is read by two things that must not disagree: the workspace's accordion,
 * which decides what a slider release recomputes, and the pipeline, which decides whether a cached
 * mask may be reused. If they ever diverged the symptom would be a stage-two tweak silently deriving regions
 * from a stale reading and reporting them as current — a diagnostic that lies, which is the
 * failure this project has already paid for once.
 *
 * So the invalidation rule is stated here as a property rather than left implicit in two call
 * sites. Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  maskFingerprint,
  normaliseColour,
  normaliseSettings,
  isPostReading,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readingFingerprint,
  readParameter,
  rereadsTheMap,
  SETTING_LIMITS,
  STAGES,
  stageParameters,
  writeParameter,
  type SettingName,
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
    // An empty stage would be a step in the cascade with nothing in it, which is a structure
    // claiming an ordering it does not have.
    for (const stage of STAGES) {
      expect(stageParameters(stage).length).toBeGreaterThan(0);
    }
  });

  it("keeps the stages in cascade order", () => {
    // The order is the cascade: reading destroys adjusting. The cache invalidation and the
    // workspace's recompute-on-release both read this array, so reversing it would change what a
    // slider destroys without changing what it says.
    //
    // "derive" sat between the two until 2026-09-18. It meant abstracting the ink into shapes, and it
    // went when its last member did: the simplification tolerance is computed from the measured ink
    // width inside the derive now, not set. Every setting left either changes what the ink is or
    // destroys nothing.
    expect(STAGES).toEqual(["read", "adjust"]);
  });
});

describe("what re-reads the map", () => {
  /*
    Named, not derived from the declarations, because deriving it would only restate the predicate
    and pass whatever it said.

    This is the list the discard prompt fires for. It used to fire for every reading-stage parameter
    whatever its kind, which put a "this decides what counts as ink" warning in front of five controls
    that re-read nothing — the two brush widths, the two gap sliders and the editor's straighten
    slider — and a GM with wall edits outstanding met it every time they painted.

    Mutation-tested: four mutations, four caught — among them the old test itself, the stage read
    alone with the kind ignored.
  */
  it("is exactly the ink-reading sliders, and nothing a tool or a display setting owns", () => {
    const rereading = ALL_NAMES.filter(rereadsTheMap).sort();
    expect(rereading).toEqual(
      ["blurSigma", "minIslandPx", "minStrokeInkWidths", "sauvolaK", "sauvolaRadiusPx"].sort(),
    );
  });

  /*
    **The pruning-exclusion test went on 2026-09-18 with the setting.**

    It pinned that the spur limit was a `pipeline` parameter of the `read` stage that still did *not*
    re-read — the whole reason the graph-only list existed — after its own prompt had wrongly claimed
    it "decides what counts as ink". Pruning is an amount pressed in the Walls drawer now, so nothing
    is filed that way and the list is gone. `settings.ts` carries the full note.
  */

  it("excludes every tool control, whatever stage it is filed under", () => {
    // The five the prompt wrongly fired for are all filed `read`, which is the whole trap.
    for (const name of ALL_NAMES.filter((n) => PARAMETER_KIND[n] === "tool")) {
      expect(PARAMETER_STAGE[name], name).toBe("read");
      expect(rereadsTheMap(name), name).toBe(false);
    }
  });
});

describe("maskFingerprint", () => {
  it("changes when any reading PIPELINE parameter changes", () => {
    // "bar the skeleton-only ones" was the rest of this name until 2026-09-18; nothing is excluded now.
    const base = maskFingerprint(DEFAULT_SETTINGS);
    for (const name of stageParameters("read")) {
      if (PARAMETER_KIND[name] !== "pipeline") continue;
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      expect(maskFingerprint(changed)).not.toBe(base);
    }
  });

  /*
    **Two graph-only tests went on 2026-09-18, and what they pinned is worth keeping in words.**

    One asserted that a graph-only parameter leaves `maskFingerprint` untouched — the exclusion that
    stopped a prune throwing away a cached mask and spending 690ms arriving at a byte-identical one.
    The other asserted every such parameter was filed `read`, `pipeline` and post-reading, since filed
    anywhere else it would be reached by a different recompute path and the exclusion would be
    silently wrong.

    The first of those was written expecting to be deleted when faces started coming from the graph,
    and it was not — the record had conflated *decides what is emitted* with *changes the mask*, and
    what had to change was the dispatch rather than the exclusion. **It is deleted now for a different
    reason**: its only subject stopped being a setting, so the list is empty and both assertions are
    about nothing.
  */

  it("does NOT change for a reading-stage DISPLAY parameter", () => {
    // The reason the two axes exist. The ink opacity sits in the Ink step because that is where the
    // ink is looked at, but it changes nothing the pipeline computes. Filing it as a
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

  it("does NOT change when an adjusting parameter changes", () => {
    // This is the property the whole cache rests on. If it failed in this direction the cache would
    // merely be useless; the test exists because a later edit could just as easily break it in the
    // *other* direction, and that one is silent.
    const base = maskFingerprint(DEFAULT_SETTINGS);
    // "derive" stood beside this until 2026-09-18, when that stage went for having no members left.
    for (const stage of ["adjust"] as const) {
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

  it("covers strictly less than the mask fingerprint, and every post-reading parameter is in one of them", () => {
    /*
      A post-reading parameter that *nothing* noticed would be a setting the GM could change with no
      effect at all, silently. There were two ways to be noticed: the mask fingerprint, for everything
      the ink is composed from, or the graph-only declaration, for the ones that changed the graph the
      faces come from. **The second went on 2026-09-18 with the list**, so the fingerprint is now the
      whole of it — every post-reading parameter has to move the mask.
    */
    for (const name of ALL_NAMES) {
      if (!isPostReading(name)) continue;
      expect(PARAMETER_KIND[name]).toBe("pipeline");
      expect(PARAMETER_STAGE[name]).toBe("read");
      const changed = writeParameter(DEFAULT_SETTINGS, name, otherValue(name));
      const movesTheMask = maskFingerprint(changed) !== maskFingerprint(DEFAULT_SETTINGS);
      expect(movesTheMask, name).toBe(true);
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

describe("readParameter and writeParameter", () => {
  it("round-trip every parameter, whichever group it is stored in", () => {
    // The stored shape keeps its two groups while the UI shows three stages, so these accessors are
    // the only thing bridging them. A parameter written to the wrong group would read back as its
    // default and the workspace would snap the slider back on the next repaint.
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

describe("putting the reading stage back", () => {
  /**
   * The one assertion that survived the deletion of `isStageDefault` and `resetStage`.
   *
   * Those two had no production caller — the per-*step* versions replaced them at A.6 — and went with
   * pass 2's item 3.1. Their tests went with them, except this: it is a property of the **mask
   * fingerprint**, which is live, that merely happened to be expressed through a dead helper. Whatever
   * counts as putting the reading stage back must be exactly what the cache considers a return to the
   * default reading, or a GM who resets lands on a fingerprint that reuses nothing.
   *
   * Built inline from `stageParameters("read")` rather than through a helper, so it tests the
   * fingerprint rather than testing something else's idea of a reset.
   */
  it("leaves the mask fingerprint at its default", () => {
    const reading = stageParameters("read");
    const edited = reading.reduce(
      (settings: typeof DEFAULT_SETTINGS, name) => writeParameter(settings, name, otherValue(name)),
      DEFAULT_SETTINGS,
    );
    expect(maskFingerprint(edited)).not.toBe(maskFingerprint(DEFAULT_SETTINGS));

    const restored = reading.reduce(
      (settings: typeof DEFAULT_SETTINGS, name) =>
        writeParameter(settings, name, readParameter(DEFAULT_SETTINGS, name)),
      edited,
    );
    expect(maskFingerprint(restored)).toBe(maskFingerprint(DEFAULT_SETTINGS));
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

  it("falls back per field, so a bad colour does not discard the number beside it", () => {
    // The neighbour was the ink opacity until that parameter was removed (2026-09-09). What is
    // being pinned is that one malformed field does not take the rest of its group down with it, so
    // any numeric field in the same group carries it; the brush width is the nearest.
    const width = DEFAULT_SETTINGS.overlay.suppressBrushPx + 2;
    const mixed = normaliseSettings({ overlay: { inkColour: "nonsense", suppressBrushPx: width } });
    expect(mixed.overlay.inkColour).toBe(DEFAULT_SETTINGS.overlay.inkColour);
    expect(mixed.overlay.suppressBrushPx).toBe(width);
  });

  it("drops a stored ink opacity rather than carrying it", () => {
    /*
      The reason the parameter was removed instead of its slider being hidden: a GM who had lowered
      it would otherwise have a faded overlay forever and nothing left to raise it with. A scene saved
      before the removal still holds the key, and it has to be discarded on the way in.

      Mutation-tested with the fallback test above it: two mutations, two caught — the stored value
      carried through again, and the brush width lost to a bad neighbouring colour.
    */
    const stale = normaliseSettings({ overlay: { inkOpacity: 0.2 } });
    expect("inkOpacity" in stale.overlay).toBe(false);
  });

  // Two tests about the colour surviving a per-STAGE reset lived here. They moved to
  // `steps.test.ts` when `isStageDefault` and `resetStage` were deleted for having no production
  // caller: the live reset is per *step*, and the hazard they guard — the colour being the one
  // setting outside `SETTING_LIMITS`, so a parameter-walking function forgets it — is identical
  // there. What stays here is the normaliser's own behaviour, which is this file's business.
});
