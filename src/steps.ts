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
import type { SettingName } from "./settings";

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
export const LAYERS = ["ink", "breaks"] as const;

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
  /**
   * Declared, but its section is not on this surface yet — the panel still draws its controls.
   *
   * An explicit flag rather than "skip a step that would render empty", because the derived version
   * would silently hide a step that legitimately has neither controls nor layers, and picking the map
   * is exactly that. This one is loud and it has an end date: it goes when region derivation moves
   * across and the panel shrinks to the actions that need the real scene in view.
   */
  readonly pending?: true;
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
    blurb: "Separating marks from paper, shading and background.",
    // The breaks ride here rather than in a step of their own, because a repair *invents ink* and so
    // belongs to the ink picture — and because this control is provisional: the repair moves onto the
    // wall graph and this version retires with it, so nothing should be arranged around it.
    layers: ["ink", "breaks"],
    drag: "pan",
    groups: [
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
    blurb: "Filtering those marks down to linework.",
    /*
      Shows the breaks as well as the ink, which is a deliberate exception to "each step shows its
      own thing".

      The minimum stroke width is the one control here that can **sever a wall**, and a severed wall
      is a break. So this step is the likeliest manufacturer of the very thing the rings warn about,
      and hiding them here would remove the warning from exactly the place it is earned. It stops
      being an exception the moment this step paints a skeleton instead.
    */
    layers: ["ink", "breaks"],
    drag: "pan",
  },
  {
    id: "regions",
    title: "Regions",
    blurb: "Abstracting the ink into the areas that will become fog.",
    // Declared because its parameters need a home and because it is the design's step 5, but the
    // panel still draws them — so it is `pending` and the accordion leaves it out. Its layers are
    // empty for the same reason: there is nothing to paint until the partition moves across.
    layers: [],
    drag: "pan",
    pending: true,
  },
  {
    id: "view",
    title: "View",
    blurb: "How the overlay is drawn. Changes nothing the pipeline computes.",
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
  sauvolaK: "ink",
  blurSigma: "ink",
  sauvolaRadiusPx: "ink",
  gapFillPx: "ink",
  gapTravelPx: "ink",
  minStrokeInkWidths: "walls",
  minIslandPx: "walls",
  minRoomSquares: "regions",
  simplifyInkWidths: "regions",
  inkOpacity: "view",
  fillOpacity: "view",
  strokeSquares: "view",
};

export function findStep(id: StepId): Step | undefined {
  return STEPS.find((step) => step.id === id);
}

/** The steps that are modes on the workspace: neither persistent nor still drawn by the panel. */
export function workspaceSteps(): readonly Step[] {
  return STEPS.filter((step) => !step.persistent && !step.pending);
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
