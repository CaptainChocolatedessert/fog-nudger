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
 * Independence is asserted where the declarations actually disagree today: the Walls step holds a
 * reading-stage control beside a deriving one, and the Ink step spans both the kind and the
 * post-reading boundary. None of those is a rule about *which* step — what is pinned is only that
 * some step disagrees, so that no lookup from one axis to another can ever be written.
 *
 * What is deliberately *not* pinned is which step does the disagreeing. That moves whenever the
 * sections do — it was the View group in August and the Regions step until that step was dissolved
 * — and a test naming one would fail at the next rearrangement while teaching the wrong lesson when
 * it did. Each declaration is also pinned total on its own, which is what makes a step-driven UI
 * unable to leave a parameter unreachable.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { CONTROLS } from "./controls";
import {
  COLOUR_KEYS,
  groupControls,
  headingGroups,
  isStepDefault,
  ALWAYS_LAYERS,
  QUESTION_LAYERS,
  LAYERS,
  TOOL_LAYERS,
  PARAMETER_STEP,
  stepsOf,
  resetStep,
  STEPS,
  TOOLS,
  stepControls,
  stepParameters,
  stepRegeneratesWalls,
  toolGroups,
  ungroupedControls,
  workspaceSteps,
  type StepId,
} from "./steps";
import {
  DEFAULT_SETTINGS,
  isPostReading,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readParameter,
  regeneratesWalls,
  SETTING_LIMITS,
  writeParameter,
} from "./settings";
import type { SettingName } from "./settings";

const ALL_NAMES = Object.keys(SETTING_LIMITS) as SettingName[];
const DECLARED = new Set<StepId>(STEPS.map((step) => step.id));

/** A value for a parameter that is guaranteed to differ from its default. */
function otherValue(name: SettingName): number {
  const limits = SETTING_LIMITS[name];
  const current = readParameter(DEFAULT_SETTINGS, name);
  return current === limits.max ? limits.min : limits.max;
}

describe("the step declaration", () => {
  it("assigns every parameter to exactly one declared step", () => {
    // Totality is the point, and the failure is worse than the stage's: a parameter with no step
    // appears in no section on either surface, which is a control a GM simply cannot reach.
    for (const name of ALL_NAMES) {
      for (const step of stepsOf(name)) expect(DECLARED.has(step)).toBe(true);
    }
    expect(Object.keys(PARAMETER_STEP).sort()).toEqual([...ALL_NAMES].sort());
  });

  /*
    A **cover**, not a partition, and that changed on 2026-09-06.

    Every parameter has to be reachable from some step, or a control is declared and never drawn.
    What is no longer true is that it appears in exactly one: spur pruning is in each mode's last
    step, because the operation is the same and the two modes want it on different terms — a slider
    re-applied on every derive in the ink mode, a number a button applies once in the editor.

    What is still asserted is that any repeat is **across modes rather than within one**. A control
    drawn twice in one accordion would be two handles on one setting, which is a different thing
    entirely and is a mistake.
  */
  it("covers every parameter exactly once", () => {
    /*
      Once, not merely at least once. `PARAMETER_STEP` still admits a list, and the spur limit used
      it while the wall groups were separate pages — safe then, because only one was ever on screen.
      On one page a repeat is two sliders writing one setting, which disagree the moment either moves.
    */
    const collected = STEPS.flatMap((step) => stepParameters(step.id));
    expect([...new Set(collected)].sort()).toEqual([...ALL_NAMES].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("allows a step with no parameters, because a step is a mode rather than a group of sliders", () => {
    /*
      The opposite of the stage test, which forbids an empty stage. Picking the map and placing a
      door are steps with nothing to turn, and they still own what is painted and what a drag does.
      Asserted so that a later "tidy-up" does not delete one for looking empty.

      **This used to assert `length >= 0`**, which is true of every array — it passed on an empty
      `STEPS`, and on a `stepParameters` that always returned nothing. What it has to say is that an
      empty step *exists* and is a real step, which is the thing a tidy-up would remove.
    */
    const empty = STEPS.filter((step) => stepParameters(step.id).length === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const step of empty) {
      expect(step.title.length, `step ${step.id} has no title`).toBeGreaterThan(0);
    }
  });

  it("gives every step a unique id and a title, and almost none of them a blurb", () => {
    /*
      **The blurb assertion was inverted on 2026-09-09**, the same way the control hint's was, and
      for the same reason: demanding a paragraph under every heading is a test that makes the prose
      mandatory and the naming optional.

      The rule now is that a title carries the step, and a blurb has to say something no label in the
      step can. Exactly one does — View, because "Preview fill" cannot also state what the emitted
      shape looks like. Pinned at one rather than a cap: a second would mean the argument was made
      twice, and it should have to be made here first.

      Mutation-tested with the control-hint test: six mutations, six caught.
    */
    expect(new Set(STEPS.map((step) => step.id)).size).toBe(STEPS.length);
    for (const step of STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
    }
    expect(STEPS.filter((step) => step.blurb.length > 0).map((step) => step.id)).toEqual(["view"]);
  });

  it("has exactly one persistent group, which is the one that is never entered", () => {
    // More than one would mean two things claiming to be always-available, and the accordion decides
    // what is a mode by the absence of this flag — so a second would silently vanish from the steps.
    expect(STEPS.filter((step) => step.persistent).length).toBe(1);
  });

  it("puts every step but the persistent one in the rail", () => {
    // Replaces a test of the deleted `pending` flag, whose loop body never executed because no step
    // ever carried it — it passed vacuously and would have kept passing with the flag inverted.
    expect(workspaceSteps().every((step) => !step.persistent)).toBe(true);
    expect(workspaceSteps()).toHaveLength(STEPS.length - 1);
  });

  it("gives the rail a first group to expand on", () => {
    // The rail expands `workspaceSteps()[0]` at start-up. With none it would open on nothing and
    // leave the surface with no way in beyond the persistent group.
    expect(workspaceSteps().length).toBeGreaterThan(0);
  });

  it("shows every layer always, or with the tool that owns it, or with a question", () => {
    /*
      A layer nothing ever proposes is a painter that never runs: dead pixels, dead code, and
      nothing to say so. Groups used to declare which layers they showed and this walked them;
      the picture is constant now, so the sources are the always-on set, the handful belonging
      to a tool, and the one that belongs to a dialog.

      The other direction — something proposing a layer nobody registered a painter for — is a
      wiring fact the surface owns and this cannot see.
    */
    const shown = new Set<string>([
      ...ALWAYS_LAYERS,
      // Flattened: a tool may own more than one layer, and Suppress blob owns two — what a click
      // would take and what previous clicks already took.
      ...Object.values(TOOL_LAYERS).flatMap((owned) =>
        typeof owned === "string" ? [owned] : [...owned],
      ),
      ...QUESTION_LAYERS,
    ]);
    for (const layer of LAYERS) {
      expect(shown.has(layer), layer).toBe(true);
    }
  });

  it("keys every tool layer by a tool that exists, since the strip looks it up by tool id", () => {
    /*
      The regression for 2026-09-16. The mend tool's layer went in keyed `mends` — the layer's name —
      where the strip looks the table up by the tool in hand, whose id is `mend`. The test above
      passed, because it reads only the values, and picking up the tool would have drawn no rings.
      One mutation, the key restored to the layer's name: caught.
    */
    const toolIds = new Set(TOOLS.map((tool) => tool.id));
    for (const key of Object.keys(TOOL_LAYERS)) {
      expect(toolIds.has(key), key).toBe(true);
    }
  });

  it("keeps the question layers out of the other two sources", () => {
    /*
      A layer that is always on cannot also be a question's: the question would be answered
      before it was asked, and the marks would be on the map at moments nothing is at stake.
      The same for a tool's, which would put them up whenever that tool was picked.

      Five mutations tried, five caught: delta added to the always-on set, delta added to the tool
      layers, the coverage test no longer reading `QUESTION_LAYERS`, a layer declared and proposed
      by nothing, and `QUESTION_LAYERS` emptied.
    */
    for (const layer of QUESTION_LAYERS) {
      expect(ALWAYS_LAYERS.includes(layer as never), layer).toBe(false);
      expect(Object.values(TOOL_LAYERS).includes(layer), layer).toBe(false);
    }
  });

  it("keeps the two sources apart, so a layer is not both always on and tool-specific", () => {
    // Overlap would make the tool's own mark indistinguishable from the resting picture, which is
    // the whole distinction the constant set is for.
    for (const layer of Object.values(TOOL_LAYERS)) {
      expect(ALWAYS_LAYERS).not.toContain(layer);
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

  it("splits into heading groups and tool groups with nothing in both and nothing in neither", () => {
    /*
      The split is what stops a tool's controls being drawn twice.

      A step's body renders `headingGroups`; its picker renders whichever `toolGroups` entry is in
      hand. If a group could land in both, two sliders would write one setting and disagree the
      moment either moved — and if one could land in neither, its control would simply never appear.
    */
    for (const step of STEPS) {
      const all = step.groups ?? [];
      const heading = headingGroups(step);
      const tools = toolGroups(step);
      expect(heading.length + tools.length, step.id).toBe(all.length);
      for (const group of heading) expect(tools).not.toContain(group);
    }
  });

  it("gives a step's tools distinct ids, since that is what the picker addresses them by", () => {
    // Two tools sharing an id would make the picker's lookup return the first for both, so choosing
    // the second would disclose the first's controls while a press wrote into the second's layer.
    for (const step of STEPS) {
      const ids = toolGroups(step).map((group) => group.tool);
      expect(new Set(ids).size, step.id).toBe(ids.length);
    }
  });

  it("offers a tool for every group of tool controls", () => {
    /*
      The coupling that replaced `Step.drag`.

      A group naming a tool is drawn only while that tool is in hand, so a group whose tool the
      palette does not offer declares controls nothing can ever reveal. This is the check that was
      free while a step declared its own drag and had to be written down once the verb moved out.
    */
    const offered = new Set(TOOLS.map((tool) => tool.id));
    for (const step of STEPS) {
      for (const group of toolGroups(step)) {
        expect(offered, `${step.id}/${group.tool}`).toContain(group.tool);
      }
    }
  });

  it("explains every tool, either by its own hint or by the blurb of the group it reveals", () => {
    /*
      The one place the 2026-09-09 prose cull could take away something nothing replaces.

      Steps lost their blurbs and controls lost their hints because a heading and a label were
      already saying it. **A tool has neither.** It is an inline glyph in a strip with an
      `aria-label` and a `title` tooltip, so the sentence in `#tool-hint` is the only thing on screen
      that says what a press will do and which modifier changes it — and `toolPalette` composes that
      slot exactly the way this walks it: the tool's own hint, or failing that the blurb of the
      group it reveals.

      Emptying both would leave a picture with no explanation anywhere, silently, because an empty
      hint slot collapses and looks like a tool that simply has nothing to say.
    */
    for (const tool of TOOLS) {
      const group = STEPS.flatMap((step) => toolGroups(step)).find((it) => it.tool === tool.id);
      const explained = tool.hint.length > 0 || (group?.blurb.length ?? 0) > 0;
      expect(explained, `tool ${tool.id} has no hint and no group blurb`).toBe(true);
    }
  });

  it("gives every band a tool and every tool a band the rail also has", () => {
    /*
      Replaces a per-mode membership check, which had no subject once there was one page.

      What survives is the ordering claim the bands make: reading down the strip and reading down
      the rail meet the same subjects in the same sequence, so a band naming nothing — or naming
      something the rail has no group for — is a strip that teaches an order the rail does not have.
    */
    const bands = new Set(TOOLS.map((tool) => tool.band));
    expect([...bands]).toEqual(["navigate", "ink", "walls"]);
    for (const band of ["ink", "walls"] as const) {
      expect(DECLARED, band).toContain(band === "walls" ? "walls" : "ink");
    }
  });

  it("only lets `pan` mean a plain pan", () => {
    // Any other tool taking `pan` would be a button that changes nothing about a press — the same
    // defect the old per-step assertion guarded, one level down.
    for (const tool of TOOLS) {
      if (tool.id === "pan") continue;
      expect(tool.drag, tool.id).not.toBe("pan");
    }
  });

  it("keeps every control reachable from some step", () => {
    // The union of the steps must cover the control list, or a control is declared and never drawn.
    // A set, because one control is declared in both modes — see the cover test above.
    const drawn = STEPS.flatMap((step) => stepControls(step.id)).map((control) => control.name);
    expect([...new Set(drawn)].sort()).toEqual(CONTROLS.map((control) => control.name).sort());
  });
});

/**
 * Per-step Defaults, ported from `stages.test.ts` when the stage-level twins were deleted.
 *
 * Those twins — `isStageDefault` and `resetStage` — had no production caller and went with pass 2's
 * item 3.1. They were also the **only** coverage this logic had anywhere: the live per-step versions,
 * which the accordion actually calls, were untested. Deleting the tests with the dead code would have
 * left the working helpers with nothing.
 *
 * The colour case is the one that earns its place. `overlay.inkColour` is the single setting that is
 * not a number, so it sits outside `SETTING_LIMITS` and every function walking a step's parameters
 * has to remember it separately — which is exactly the kind of thing that gets forgotten.
 */
describe("per-step defaults", () => {
  it("judges one step without regard to the others", () => {
    for (const step of STEPS) {
      const parameters = stepParameters(step.id);
      if (parameters.length === 0) continue;

      const edited = parameters.reduce(
        (settings, name) => writeParameter(settings, name, otherValue(name)),
        DEFAULT_SETTINGS,
      );
      expect(isStepDefault(edited, step.id), `${step.id} is edited`).toBe(false);
      for (const other of STEPS) {
        if (other.id === step.id) continue;
        // A step sharing a parameter with the edited one is *not* untouched, and should not claim to
        // be: its own Defaults button restores that parameter, so saying otherwise would be the
        // button and its label disagreeing.
        const shared = stepParameters(other.id).some((name) => parameters.includes(name));
        expect(isStepDefault(edited, other.id), `${other.id} is untouched`).toBe(!shared);
      }
    }
  });

  it("puts one step back without touching the rest", () => {
    const everything = ALL_NAMES.reduce(
      (settings, name) => writeParameter(settings, name, otherValue(name)),
      DEFAULT_SETTINGS,
    );

    for (const step of STEPS) {
      const reset = resetStep(everything, step.id);
      for (const name of stepParameters(step.id)) {
        expect(readParameter(reset, name), `${step.id}: ${name} restored`).toBe(
          readParameter(DEFAULT_SETTINGS, name),
        );
      }
      for (const name of ALL_NAMES) {
        if (stepsOf(name).includes(step.id)) continue;
        expect(readParameter(reset, name), `${step.id}: ${name} untouched`).toBe(
          readParameter(everything, name),
        );
      }
    }
  });

  it("recognises the untouched case for every step", () => {
    for (const step of STEPS) {
      expect(isStepDefault(DEFAULT_SETTINGS, step.id), step.id).toBe(true);
    }
  });

  /*
    The colours moved to View on 2026-09-10 and the reset went with them — see `COLOUR_STEP`. Each
    colour is edited on its own, so a reset that restored only the ink one (which is what it did for
    the whole of its life) fails for the four others by name rather than passing on the first.

    Mutation-tested: four mutations, four caught — the reset left on Ink as before the move, the
    reset and the default check each narrowed back to the ink colour alone, and a colour dropped
    from the list.
  */
  it("counts every markup colour as part of View, since nothing else would", () => {
    // Not in SETTING_LIMITS, so a step-walking function that only looked at numbers would report View
    // as untouched with a changed colour, and its Defaults button would do nothing to it.
    for (const key of COLOUR_KEYS) {
      const edited = { ...DEFAULT_SETTINGS, overlay: { ...DEFAULT_SETTINGS.overlay, [key]: "#00ff00" } };
      expect(isStepDefault(edited, "view"), key).toBe(false);
      expect(resetStep(edited, "view").overlay[key], key).toBe(DEFAULT_SETTINGS.overlay[key]);
    }
  });

  it("leaves every colour alone when another step is reset", () => {
    // Ink especially, which is where the ink colour's reset used to live: it would now be restoring
    // a colour that is not shown in its section.
    for (const key of COLOUR_KEYS) {
      const edited = { ...DEFAULT_SETTINGS, overlay: { ...DEFAULT_SETTINGS.overlay, [key]: "#00ff00" } };
      for (const step of STEPS) {
        if (step.id === "view") continue;
        expect(isStepDefault(edited, step.id), `${step.id}/${key}`).toBe(true);
        expect(resetStep(edited, step.id).overlay[key], `${step.id}/${key}`).toBe("#00ff00");
      }
    }
  });

  it("names every colour the settings carry, so a new one cannot be missed by the reset", () => {
    const carried = Object.keys(DEFAULT_SETTINGS.overlay).filter((key) => key.endsWith("Colour"));
    expect([...COLOUR_KEYS].sort()).toEqual(carried.sort());
  });
});

describe("the four axes are declared independently", () => {
  it("does not let the stage be recovered from the step", () => {
    // The Walls step holds spur pruning, which is a reading control, beside edge smoothing, which is
    // a deriving one. Reading a stage off a step would put a later-stage control into the reading
    // stage's cache invalidation - the failure the two-axis split exists to prevent, one axis on.
    const byStep = new Map<StepId, Set<string>>();
    for (const name of ALL_NAMES) {
      // Through `stepsOf`, because a control may name more than one step — spur pruning is in both
      // modes' last step. Every step it names has to carry the same conclusion.
      for (const step of stepsOf(name))
      byStep.set(step, (byStep.get(step) ?? new Set()).add(PARAMETER_STAGE[name]));
    }
    expect([...byStep.values()].some((stages) => stages.size > 1)).toBe(true);
  });

  it("does not let the kind be recovered from the step", () => {
    // The Ink step holds the ink opacity, which recomputes nothing, beside the threshold, which
    // re-reads the whole map. Deciding on release what a slider costs by looking at which section it
    // was drawn in is exactly the conflation the kind axis exists to prevent, and this is what keeps
    // the two from quietly becoming synonyms.
    const byStep = new Map<StepId, Set<string>>();
    for (const name of ALL_NAMES) {
      // Through `stepsOf`, because a control may name more than one step — spur pruning is in both
      // modes' last step. Every step it names has to carry the same conclusion.
      for (const step of stepsOf(name))
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
      // Through `stepsOf`, because a control may name more than one step — spur pruning is in both
      // modes' last step. Every step it names has to carry the same conclusion.
      for (const step of stepsOf(name))
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

describe("stepRegeneratesWalls", () => {
  /*
    What the rail's mark is hung on.

    Five mutations tried, five caught: a step that never regenerates, one that always does, `every`
    in place of `some`, `regeneratesWalls` admitting the display kinds, and it admitting nothing.

    Asked of a step's parameters rather than hardcoded, so that a control moving between groups takes
    its consequences with it. What these pin is the *shape* of the answer rather than today's list:
    the groups that build the walls carry it, and the groups that only decide what is drawn do not.
  */
  it("marks the groups whose controls rebuild the walls", () => {
    expect(stepRegeneratesWalls("ink")).toBe(true);
    expect(stepRegeneratesWalls("walls")).toBe(true);
  });

  it("leaves alone the groups that change nothing about the walls", () => {
    // View is preview fill and outline: appearance, recomputing nothing. Map has no parameters at
    // all, and nominating an image is destructive by a different route that has its own handling.
    expect(stepRegeneratesWalls("view")).toBe(false);
    expect(stepRegeneratesWalls("map")).toBe(false);
  });

  it("marks fewer controls than the group it sits in, which is the point of moving the gate", () => {
    /*
      **The over-marking the per-control gate fixes** (user, 2026-09-14). Ink holds nine controls and
      only five rebuild the walls: the two brush widths and the two gap settings recompute nothing at
      all. Marking the *group* therefore told a GM the brush width was dangerous, and a mark that is
      wrong about half of what it covers stops being believed about the other half.

      Pinned as a strict inequality rather than as the numbers, so adding a control to Ink does not
      fail this — what has to stay true is that the group is not a proxy for its parts.

      Two mutations tried, two caught: `regeneratesWalls` admitting everything, and admitting nothing.
    */
    const inInk = stepParameters("ink");
    const rebuild = inInk.filter(regeneratesWalls);
    expect(rebuild.length).toBeGreaterThan(0);
    expect(rebuild.length).toBeLessThan(inInk.length);
  });

  it("agrees with the per-parameter question for every step", () => {
    // The two must not drift: the mark says a press here would destroy, and the dialog fires on the
    // press. If a step could be unmarked while holding a control that confirms, the dialog would be
    // the first a GM heard of it.
    for (const step of workspaceSteps()) {
      const any = stepParameters(step.id).some(regeneratesWalls);
      expect(stepRegeneratesWalls(step.id), step.id).toBe(any);
    }
  });
});
