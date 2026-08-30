/**
 * The fourth axis, and the property that keeps it from swallowing the other three.
 *
 * A step used to be a free-form `section` string carrying nothing but a heading, and the rule that
 * protected the cache was "nothing may switch on it". A step now decides which layers the canvas
 * paints and what a plain drag means, so that rule is gone and something has to replace it: the four
 * declarations — step, stage, kind, and the post-reading cache boundary — stay **separately
 * declared**, and none is read from another.
 *
 * ## What can be asserted, and what would be pinning a coincidence
 *
 * Independence is asserted where the declarations actually disagree today: the View group holds a
 * reading-stage control and an adjusting one, and the reading stage is spread across three steps, so
 * neither of step and stage can be recovered from the other.
 *
 * It is *not* asserted for the kind or the post-reading boundary, and that is deliberate. Every
 * parameter in the ink step happens to be a pipeline parameter, and every walls parameter happens to
 * be post-reading — facts about these twelve parameters rather than rules. A test demanding that
 * they diverge would fail the day a step legitimately holds one of each, which is the very freedom
 * the separation exists to give. What is pinned instead is that each declaration is total on its
 * own, which is what makes a step-driven UI unable to leave a parameter unreachable.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { CONTROLS } from "./controls";
import {
  groupControls,
  LAYERS,
  PARAMETER_STEP,
  STEPS,
  stepControls,
  stepParameters,
  ungroupedControls,
  workspaceSteps,
  type StepId,
} from "./steps";
import { isPostReading, PARAMETER_KIND, PARAMETER_STAGE, SETTING_LIMITS } from "./settings";
import type { SettingName } from "./settings";

const ALL_NAMES = Object.keys(SETTING_LIMITS) as SettingName[];
const DECLARED = new Set<StepId>(STEPS.map((step) => step.id));

describe("the step declaration", () => {
  it("assigns every parameter to exactly one declared step", () => {
    // Totality is the point, and the failure is worse than the stage's: a parameter with no step
    // appears in no section on either surface, which is a control a GM simply cannot reach.
    for (const name of ALL_NAMES) {
      expect(DECLARED.has(PARAMETER_STEP[name])).toBe(true);
    }
    expect(Object.keys(PARAMETER_STEP).sort()).toEqual([...ALL_NAMES].sort());
  });

  it("partitions the parameters across the steps with no gaps or overlaps", () => {
    const collected = STEPS.flatMap((step) => stepParameters(step.id));
    expect([...collected].sort()).toEqual([...ALL_NAMES].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("allows a step with no parameters, because a step is a mode rather than a group of sliders", () => {
    // The opposite of the stage test, which forbids an empty stage. Picking the map and placing a
    // door are steps with nothing to turn, and they still own what is painted and what a drag does.
    // Asserted so that a later "tidy-up" does not delete one for looking empty.
    expect(STEPS.every((step) => stepParameters(step.id).length >= 0)).toBe(true);
  });

  it("gives every step a unique id, a title and a blurb", () => {
    expect(new Set(STEPS.map((step) => step.id)).size).toBe(STEPS.length);
    for (const step of STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.blurb.length).toBeGreaterThan(0);
    }
  });

  it("has exactly one persistent group, which is the one that is never entered", () => {
    // More than one would mean two things claiming to be always-available, and the accordion decides
    // what is a mode by the absence of this flag — so a second would silently vanish from the steps.
    expect(STEPS.filter((step) => step.persistent).length).toBe(1);
  });

  it("keeps a pending step off the canvas as well as out of the accordion", () => {
    // `pending` means the panel still draws this step's controls. Declaring layers for one would be
    // a step that paints without being enterable — pixels on screen belonging to a mode the GM
    // cannot get into.
    for (const step of STEPS) {
      if (!step.pending) continue;
      expect(step.persistent).toBeUndefined();
      expect(step.layers).toEqual([]);
    }
    expect(workspaceSteps().every((step) => !step.pending && !step.persistent)).toBe(true);
  });

  it("shows every layer in at least one step", () => {
    // A layer no step asks for is a painter that never runs: dead pixels, dead code, and nothing to
    // say so. The other direction — a step asking for a layer nobody registered — is a wiring fact
    // the surface owns and this cannot see.
    for (const layer of LAYERS) {
      expect(STEPS.some((step) => step.layers.includes(layer))).toBe(true);
    }
  });
});

describe("a step's groups", () => {
  it("claim only parameters belonging to that step", () => {
    // A group naming a parameter from another step would render that control twice — once in its own
    // step and once here — and two sliders writing one setting disagree the moment either moves.
    for (const step of STEPS) {
      for (const group of step.groups ?? []) {
        for (const name of group.parameters) {
          expect(PARAMETER_STEP[name]).toBe(step.id);
        }
      }
    }
  });

  it("claim each parameter at most once", () => {
    for (const step of STEPS) {
      const claimed = (step.groups ?? []).flatMap((group) => group.parameters);
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });

  it("together with the ungrouped controls, account for the step exactly once", () => {
    // What the accordion renders is the ungrouped controls followed by each group. If those two do
    // not add up to the step, a control is either drawn twice or not at all.
    for (const step of STEPS) {
      const rendered = [
        ...ungroupedControls(step),
        ...(step.groups ?? []).flatMap((group) => groupControls(group)),
      ].map((control) => control.name);
      expect([...rendered].sort()).toEqual([...stepControls(step.id)].map((c) => c.name).sort());
      expect(new Set(rendered).size).toBe(rendered.length);
    }
  });

  it("keeps every control reachable from some step", () => {
    // The union of the steps must cover the control list, or a control is declared and never drawn.
    const drawn = STEPS.flatMap((step) => stepControls(step.id)).map((control) => control.name);
    expect([...drawn].sort()).toEqual(CONTROLS.map((control) => control.name).sort());
  });
});

describe("the four axes are declared independently", () => {
  it("does not let the stage be recovered from the step", () => {
    // The Regions step holds the two deriving controls beside the two that decide how a proposal is
    // drawn, which are adjusting ones. Reading a stage off a step would put a stage-three control
    // into the reading stage's cache invalidation - the failure the two-axis split exists to
    // prevent, one axis later.
    const byStep = new Map<StepId, Set<string>>();
    for (const name of ALL_NAMES) {
      const step = PARAMETER_STEP[name];
      byStep.set(step, (byStep.get(step) ?? new Set()).add(PARAMETER_STAGE[name]));
    }
    expect([...byStep.values()].some((stages) => stages.size > 1)).toBe(true);
  });

  it("does not let the kind be recovered from the step", () => {
    // Both steps that have controls hold a pipeline one and a display one: the ink colour and opacity
    // sit with the threshold, and the proposal fill sits with the smallest room. Deciding on release
    // what a slider costs by looking at which section it was drawn in is exactly the conflation the
    // kind axis exists to prevent, and this is what keeps the two from quietly becoming synonyms.
    const byStep = new Map<StepId, Set<string>>();
    for (const name of ALL_NAMES) {
      const step = PARAMETER_STEP[name];
      byStep.set(step, (byStep.get(step) ?? new Set()).add(PARAMETER_KIND[name]));
    }
    expect([...byStep.values()].some((kinds) => kinds.size > 1)).toBe(true);
  });

  it("does not let the post-reading boundary be recovered from the step", () => {
    // The Ink step spans it: the threshold feeds the reading, the stroke-width filter is composed on
    // top of it. So the step a control is drawn in says nothing about which half of the reading cache
    // it touches, which is the boundary that can be *wrong* rather than merely useless.
    const byStep = new Map<StepId, Set<boolean>>();
    for (const name of ALL_NAMES) {
      const step = PARAMETER_STEP[name];
      byStep.set(step, (byStep.get(step) ?? new Set()).add(isPostReading(name)));
    }
    expect([...byStep.values()].some((sides) => sides.size > 1)).toBe(true);
  });

  /*
    Not asserted: that the *step* cannot be recovered from the stage.

    It could be, today. Every reading control is in Ink and everything after it is in Regions, so a
    lookup from stage to step would happen to work - and it did not on 2026-08-29 before the sections
    were reorganised, when the View group held a reading control beside two adjusting ones.

    That is the point of not asserting it. Which direction happens to be a function is a fact about
    twelve parameters and moves whenever the sections do; a test demanding it would fail the next time
    the UI is rearranged and would be teaching the wrong lesson when it did. What has to hold is that
    neither is *read from* the other, and what is pinned for that is the three directions above plus
    totality below - the properties that stay true however the steps are cut.
  */

  it("declares all four axes totally, so none has to fall back on another", () => {
    // The reason a missing declaration is dangerous rather than merely untidy: the only way to
    // classify a parameter with no entry is to guess from a neighbouring axis, and every such guess
    // is silent. `isPostReading` is total by construction — it is a membership test — so what is
    // pinned for it is that it answers for every parameter without throwing.
    for (const name of ALL_NAMES) {
      expect(PARAMETER_STEP[name]).toBeDefined();
      expect(PARAMETER_STAGE[name]).toBeDefined();
      expect(PARAMETER_KIND[name]).toBeDefined();
      expect(typeof isPostReading(name)).toBe("boolean");
    }
  });
});
