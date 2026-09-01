/**
 * The steps: what the GM is doing, and what the surface shows while they do it.
 *
 * ## The fourth axis, and why it is declared apart from the other three
 *
 * A parameter is filed four independent ways, and conflating any two of them has already cost this
 * project something:
 *
 * - **`PARAMETER_STAGE`** — the cascade. What a change *destroys*, and what cache invalidation reads.
 * - **`PARAMETER_KIND`** — what a change *recomputes*. The mask fingerprint reads `pipeline` alone;
 *   file a display parameter as pipeline and every opacity nudge re-binarises the map.
 * - **`POST_READING`** — which half of the reading cache a pipeline parameter touches, declared by
 *   exclusion so that anything new invalidates rather than silently reusing.
 * - **`PARAMETER_STEP`**, here — which step a control appears in.
 *
 * The step used to be a free-form `section` string on each control, declared "presentation only,
 * nothing may switch on it" precisely because a control moved between headings for tidiness must
 * not change what it recomputes. **That rule is now replaced rather than kept**, because a step
 * carries real behaviour: it decides which layers the canvas shows and what a plain drag means. The
 * protection that replaces it is that the four declarations stay separate, with a test pinning that
 * none is read from another.
 *
 * They are *not* required to disagree everywhere. Every parameter in the ink step happens to be a
 * pipeline parameter today, and that is a fact about these twelve parameters rather than a rule —
 * pinning it would fail the day a step legitimately holds one of each, which is exactly what the
 * independence is for.
 *
 * ## What a step is
 *
 * A mode, not a group of sliders. A step may have no parameters at all — picking the map, placing a
 * door — and it still owns what is painted and what a drag does. That is why the list below is not
 * derived from the parameters.
 *
 * Pure: no DOM, no SDK.
 */

import { CONTROLS, type Control } from "./controls";
import {
  DEFAULT_SETTINGS,
  readParameter,
  writeParameter,
  type SettingName,
  type Settings,
} from "./settings";

/** Every step that exists today. Six are designed; the rest arrive with the code that needs them. */
export type StepId = "map" | "ink" | "walls" | "regions" | "view";

/**
 * What the canvas can draw over the map.
 *
 * A step declares which of these it shows, and they legitimately differ: the ink steps paint the
 * binary mask, and the wall and region steps to come will paint linework and coloured faces over a
 * map with no mask on it at all. Nothing is drawn "because it exists" — a layer is on screen because
 * the step the GM is in is about it.
 */
export const LAYERS = ["ink", "breaks", "skeleton", "regions"] as const;

export type LayerId = (typeof LAYERS)[number];

/** What a plain left-drag does while a step is open. */
export type Drag = "pan" | "brush";

/** A sub-heading within a step, for a handful of controls that want their own explanation. */
export interface StepGroup {
  readonly title: string;
  /** Shown under the heading. May carry markup. */
  readonly blurb: string;
  readonly parameters: readonly SettingName[];
}

export interface Step {
  readonly id: StepId;
  readonly title: string;
  /** Shown under the title, saying what the step is for. May carry markup. */
  readonly blurb: string;
  /** What the canvas shows while this step is open. */
  readonly layers: readonly LayerId[];
  /** What a plain left-drag does while this step is open. */
  readonly drag: Drag;
  /** Sub-headings, for controls that need their own explanation inside a step. */
  readonly groups?: readonly StepGroup[];
  /**
   * A persistent group is never *entered*: it sits outside the accordion and is always available.
   *
   * There is exactly one, and the argument for it is the one already made for putting the overlay's
   * opacity beside the reading controls: navigating away from the thing you are tuning in order to
   * recolour it is absurd, so view controls must never be somewhere you go. It carries a step's
   * shape because the rendering is identical; what makes it different is that it has no mode.
   */
  readonly persistent?: true;
  /*
    `pending` was here: a flag for a step whose controls the panel still drew. Its doc gave it an end
    date — "it goes when region derivation moves across" — and A.5 did that. No step ever carried it
    again, so `workspaceSteps` filtered on a field nobody set and its test's loop body never ran.
    Deleted 2026-08-31.
  */
}

/**
 * The steps, in the order the GM meets them.
 *
 * The order is the cascade made visible — which is the whole reason these are an **exclusive
 * accordion** rather than a row of tabs (user, 2026-08-29). Every header stays on screen in
 * sequence, so where a step sits in the chain is a shape rather than something to remember, and a
 * tall narrow column is what vertical stacking is good at. The recorded objection to collapsing
 * sections was that they *imply* two can be open at once, which would be a lie — you cannot paint
 * suppression and place a door with the same gesture. Enforcing exclusivity removes the implication
 * and keeps the property the tab strip was chosen to guarantee: one open step, one set of layers,
 * one meaning for a drag.
 */
export const STEPS: readonly Step[] = [
  {
    id: "map",
    title: "Map",
    blurb: "Which image the trace reads. Everything below is about this one picture.",
    /*
      Nothing over the map, deliberately.

      This step's question is *which image*, and the answer is the image itself — an ink mask drawn
      on top would be answering the next question over the top of this one. It is also what resolves
      the chicken-and-egg of a surface that needs a map to draw: with no map chosen there is nothing
      here but the picker, and that is a complete and honest state rather than an empty canvas.
    */
    layers: [],
    drag: "pan",
  },
  {
    id: "ink",
    title: "Ink",
    blurb: "What the trace calls a mark, and which marks it keeps.",
    /*
      One step, three questions in series, and the ink layer answers all three.

      Walls was a step of its own until 2026-08-29 (user). Its two controls are ink *filters* \u2014 they
      decide which marks survive, not what a wall is \u2014 so what they change is the same picture the
      threshold changes, judged the same way. A step is a mode, and there was never a mode here: the
      canvas, the drag and the layers were identical. The name returns as a step when it has a
      skeleton to paint, which is what a wall actually is.
    */
    layers: ["ink", "breaks"],
    drag: "pan",
    groups: [
      {
        // Called "Walls" until the skeleton arrived and took the name back — these two decide which
        // marks are *linework*, which is a question about ink. A wall is what the step below makes
        // of the linework.
        title: "Linework",
        blurb: "Filtering those marks down to linework. Both go far past useful, so the edge is findable.",
        parameters: ["minStrokeInkWidths", "minIslandPx"],
      },
      {
        title: "Breaks in the linework",
        blurb:
          "A wall with a section missing merges two rooms, which is the worst this can get wrong. " +
          "Breaks up to the width below are filled in <b class='gap-key'>purple</b> and ringed. " +
          "Purple is ink that is not on the map.",
        parameters: ["gapFillPx", "gapTravelPx"],
      },
    ],
  },
  {
    id: "walls",
    title: "Walls",
    blurb:
      "The <b class='skeleton-key'>centreline</b> of every piece of linework, one pixel wide. " +
      "<b>This is the graph the regions below are made of</b> \u2014 a face boundary is a centreline, so " +
      "pruning here changes the partition.",
    /*
      The skeleton over the ink, which is the only pairing that answers the question.

      A centreline on its own says nothing: what a GM is judging is whether it runs down the middle
      of the wall it came from, and whether the hairs on it are artefacts of a ragged edge or stubs
      that are really there. Both are comparisons against the ink, so the ink is drawn under it.

      **The breaks are here too, which is the one argued exception to "each step shows its own
      layer".** The minimum stroke width can sever a wall, and a severed wall IS a break — so this
      step is the likeliest manufacturer of the very thing the break rings warn about, and hiding
      them here would take the warning away from the place it is earned. The operating notes recorded
      this as the intent before the code did.
    */
    layers: ["ink", "skeleton", "breaks"],
    drag: "pan",
  },
  {
    id: "regions",
    title: "Regions",
    blurb:
      "Every enclosed area, in six colours so neighbours differ. This is what goes on the map. " +
      "The top two only change how it is drawn here; the third smooths the outlines. None of them " +
      "can split or join a region — the ink and the walls above already decided which rooms exist.",
    /*
      The partition alone, with no ink under it.

      Deliberate, and the clearest case yet for the convention that a step shows its own thing: the
      question here is whether these areas are the rooms a GM would have drawn, and ink drawn under
      them would answer the previous question over the top of this one. The map is still there to
      judge against, which is the comparison that matters at this point.
    */
    layers: ["regions"],
    drag: "pan",
  },
  {
    id: "view",
    title: "View",
    blurb:
      "Empty, for now. What was here \u2014 the ink colour and opacity, the proposal fill and outline \u2014 " +
      "went to the steps that draw the thing each one describes. This is where a control that is " +
      "genuinely about the whole surface would go.",
    layers: [],
    drag: "pan",
    persistent: true,
  },
];

/**
 * The single declaration of which step owns which parameter.
 *
 * Total over every parameter, and asserted so: a parameter with no step would simply vanish from
 * both surfaces, which is a control a GM cannot reach and nothing to say it is missing.
 */
export const PARAMETER_STEP: Readonly<Record<SettingName, StepId>> = {
  // How the ink is drawn sits with the ink, and how a proposal is drawn sits with the proposals
  // (user, 2026-08-29). They were a View group of their own while the partition existed only in the
  // scene; now that both are drawn on this canvas, a control that changes one belongs beside it.
  inkOpacity: "ink",
  sauvolaK: "ink",
  blurSigma: "ink",
  sauvolaRadiusPx: "ink",
  minStrokeInkWidths: "ink",
  minIslandPx: "ink",
  gapFillPx: "ink",
  gapTravelPx: "ink",
  spurPrunePx: "walls",
  fillOpacity: "regions",
  strokeSquares: "regions",
  simplifyInkWidths: "regions",
};

/**
 * The step the overlay's colour belongs to.
 *
 * The same wart `settings.ts` carries one axis down, for the same reason: the colour is the one
 * setting that is not a number, so it sits outside `SETTING_LIMITS` and every function that walks a
 * step's parameters has to remember it separately. Named once here rather than in each of them.
 */
const COLOUR_STEP: StepId = "ink";

/** Whether a step's controls are all at their defaults. */
export function isStepDefault(settings: Settings, id: StepId): boolean {
  const numbers = stepParameters(id).every(
    (name) => readParameter(settings, name) === readParameter(DEFAULT_SETTINGS, name),
  );
  if (id !== COLOUR_STEP) return numbers;
  return numbers && settings.overlay.inkColour === DEFAULT_SETTINGS.overlay.inkColour;
}

/**
 * Put one step's controls back, leaving every other step alone.
 *
 * Per step rather than per stage, which is what the panel offered (user, 2026-08-29). A GM who has
 * just wrecked the ink wants the ink back — "the reading stage" is a phrase about cache invalidation,
 * and it stopped naming anything they can see the moment the sections were cut differently from the
 * stages.
 */
export function resetStep(settings: Settings, id: StepId): Settings {
  const numbers = stepParameters(id).reduce(
    (accumulated, name) => writeParameter(accumulated, name, readParameter(DEFAULT_SETTINGS, name)),
    settings,
  );
  if (id !== COLOUR_STEP) return numbers;
  return {
    ...numbers,
    overlay: { ...numbers.overlay, inkColour: DEFAULT_SETTINGS.overlay.inkColour },
  };
}

/** The steps that are modes on the workspace: everything but the persistent View group. */
export function workspaceSteps(): readonly Step[] {
  return STEPS.filter((step) => !step.persistent);
}

/** Every parameter belonging to one step, in declaration order. */
export function stepParameters(step: StepId): readonly SettingName[] {
  return (Object.keys(PARAMETER_STEP) as SettingName[]).filter(
    (name) => PARAMETER_STEP[name] === step,
  );
}

/** The controls belonging to one step, in declaration order. */
export function stepControls(step: StepId): readonly Control[] {
  return CONTROLS.filter((control) => PARAMETER_STEP[control.name] === step);
}

/** The controls of a step that no group claims, which is what a step renders before its groups. */
export function ungroupedControls(step: Step): readonly Control[] {
  const grouped = new Set((step.groups ?? []).flatMap((group) => group.parameters));
  return stepControls(step.id).filter((control) => !grouped.has(control.name));
}

/** The controls of one group, in declaration order. */
export function groupControls(group: StepGroup): readonly Control[] {
  return CONTROLS.filter((control) => group.parameters.includes(control.name));
}
