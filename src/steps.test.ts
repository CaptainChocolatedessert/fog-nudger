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
  stepIsInkSide,
  stepParameters,
  toolGroups,
  toolIsInkSide,
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

  it("gives every tool that draws its own actions a group, since that is what opens its drawer", () => {
    /*
      **The contract behind `toolHasControls`**, which asks these declarations and nothing else.

      A tool whose drawer holds an *action* rather than a setting has nothing in `parameters` to
      declare it, so the group is the only thing saying the drawer exists — and without it the
      button is not merely misplaced, it is unreachable, with the press that should open it clearing
      the drawer instead. That is the silent kind: no error, no failing test, a control that is
      simply not there. It is the same failure `elementIds.test.ts` exists for, one layer up.

      Listed by name rather than derived, because deriving it would mean asking the modules that draw
      the buttons — which import the SDK and cannot be reached from here. A tool joining this list
      is a deliberate act, and so is leaving it.

      **Two mutations, two caught**: deleting the group from `steps.ts`, and emptying the list so the
      loop below has nothing to walk. A third — relaxing the guard to `>= 0` — survives and is
      equivalent, since it can only differ when the list is empty and the second mutation is that.
    */
    const drawsActions = ["suppressRegion"];
    // Or the loop below is satisfied by having nothing to check, which is the shape of failure this
    // suite has already been bitten by twice.
    expect(drawsActions.length).toBeGreaterThan(0);
    const declared = new Set(
      STEPS.flatMap((step) => toolGroups(step)).map((group) => group.tool),
    );
    for (const tool of drawsActions) {
      expect(declared, `${tool} has no group, so its drawer never opens`).toContain(tool);
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
  /*
    **The stage-versus-step assertion is gone (2026-09-18), and it pinned a coincidence.**

    It asserted that some step mixes two stages, so that nobody could read a stage off a step — and its
    own example was *"the Walls step holds spur pruning, which is a reading control, beside edge
    smoothing, which is a deriving one."* Edge smoothing stopped being a setting, the `derive` stage
    went with it, and no step mixes stages any more.

    Deleted rather than inverted, because this record already said which direction happens to be a
    function *"is a fact about today's parameters and moves whenever the sections do"*. Keeping it would
    force every future layout to preserve a coincidence. What actually guards the conflation is the
    totality assertion below: every parameter declares its own stage, so nothing has to be guessed from
    a neighbour.
  */

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

describe("what rebuilds the walls, now that no function is left to answer it", () => {
  /*
    `stepRegeneratesWalls` and `regeneratesWalls` were both deleted on 2026-09-20, with the
    per-control gate that was their only caller. **The claim they guarded is the rework's central
    one and is still worth pinning**, so it is asked of `PARAMETER_KIND` directly — which is all
    `regeneratesWalls` ever was. A `pipeline` parameter is one whose change recomputes the mask, so
    the graph, being a pure function of the ink and those numbers, is a new one afterwards and the
    old one's hand edits are not in it.

    **Four mutations, four caught**: Walls admitting a pipeline parameter, Ink holding none, Ink
    holding nothing else, and the Walls list being empty so that `every` passes over nothing.
  */
  it("leaves nothing under Walls that would rebuild them", () => {
    /*
      **Walls stopped regenerating on 2026-09-18, and that is the rework arriving rather than a
      regression.**

      It carried the two settings the derive read — straightening and the spur limit — so opening it
      to move either meant rebuilding the walls and losing every hand edit. Both are *amounts*
      pressed in this group now, applied to the walls in front of the GM, and its only other control
      adds four walls at the map's edge.

      What that buys is the point of the whole rework: **the set of things that rebuild the walls is
      exactly the map and the ink**, which is a cause a GM already holds rather than a list they have
      to be told — and it is what lets one lid cover the ink side and nothing else. If this ever
      fails, something has put a derive-time parameter back into the group that edits the document,
      and the cover is covering the wrong half.

      The list is asserted non-empty first, or the check is satisfied by Walls having no parameters
      to look at.
    */
    const inWalls = stepParameters("walls");
    expect(inWalls.length).toBeGreaterThan(0);
    expect(inWalls.filter((name) => PARAMETER_KIND[name] === "pipeline")).toEqual([]);
  });

  it("keeps Ink a mixture, which is why a group was never the right subject", () => {
    /*
      **The over-marking that the per-control gate fixed and the cover made moot** (user,
      2026-09-14). Ink holds nine controls and only five rebuild the walls: the two brush widths and
      the two gap settings recompute nothing at all. Marking the *group* told a GM the brush width
      was dangerous, and a mark that is wrong about half of what it covers stops being believed
      about the other half.

      The cover answers it a third way — the whole side goes under one lid, so no control is asked
      about itself and the inaccuracy has nothing to attach to. This stays because the mixture is the
      reason that move was necessary, and a later reader meeting a lid over nine controls should be
      able to see that five of them are the ones it is really for.

      A strict inequality rather than the numbers, so adding a control to Ink does not fail it.
    */
    const inInk = stepParameters("ink");
    const rebuild = inInk.filter((name) => PARAMETER_KIND[name] === "pipeline");
    expect(rebuild.length).toBeGreaterThan(0);
    expect(rebuild.length).toBeLessThan(inInk.length);
  });
});

/*
  The cover's membership, which is the one part of it a desk can check.

  Almost nothing else about the lid is testable: it is markup in a module that imports the SDK, so
  no node test can reach it, and whether it reads as a lid at 52px is a room's question. What *is* a
  contract is which groups and which tools fall under it — and getting that wrong is the quiet kind
  of failure, since a control left outside the cover simply goes on working with nothing to say it
  should not have.

  **Four mutations, four caught**: the map dropped from the ink side, every step admitted to it, the
  tool test reading the walls band instead, and a tool that does not exist counting as ink side.
*/
describe("the ink side, which is what the cover covers", () => {
  it("is the map and the ink, and nothing else", () => {
    const inside = workspaceSteps()
      .map((step) => step.id)
      .filter(stepIsInkSide);
    expect(inside).toEqual(["map", "ink"]);
  });

  /*
    **The reason this is not `stepRegeneratesWalls`**, pinned so the two are never collapsed.

    That question is asked of a step's *parameters*, and the map picker declares none — so the most
    destructive control on the surface answered `false` and sat outside the lock for as long as the
    lock was organised around which controls regenerate. Nominating a different map discards the
    graph outright: a graph is stored in graph units of *a* map, and the marks record their map too.

    If this ever starts agreeing, someone has filed a parameter under Map, and the cover's membership
    should be re-derived rather than left as a coincidence.
  */
  it("holds the map picker, which declares no parameter at all", () => {
    expect(stepIsInkSide("map")).toBe(true);
    expect(stepParameters("map")).toEqual([]);
  });

  it("leaves the walls and the view outside it", () => {
    expect(stepIsInkSide("walls")).toBe(false);
    expect(stepIsInkSide("view")).toBe(false);
  });

  /*
    Asserted as a non-empty list before it is asserted to match, because a check satisfied by having
    nothing to check is the failure `steps.test.ts` already exists to prevent one layer up: delete
    the ink band and this would pass by agreeing that no tool is on the ink side.
  */
  it("holds exactly the tools of the ink band, and there are some", () => {
    const inkBand = TOOLS.filter((choice) => choice.band === "ink").map((choice) => choice.id);
    expect(inkBand.length).toBeGreaterThan(0);
    expect(TOOLS.filter((choice) => toolIsInkSide(choice.id)).map((choice) => choice.id)).toEqual(
      inkBand,
    );
  });

  it("says no to a tool that does not exist, rather than guessing", () => {
    // The strip asks this of whatever is in hand, and "pan" is a real tool that is not on the ink
    // side. A lookup miss must answer the same way, or a renamed tool would arrive under the cover.
    expect(toolIsInkSide("pan")).toBe(false);
    expect(toolIsInkSide("no-such-tool")).toBe(false);
  });
});
