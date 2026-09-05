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

/**
 * Every step that exists today.
 *
 * The A-plan designed six — map, ink, walls, edit walls, regions, doors — and five of them are built;
 * doors stay with Dynamic Fog entirely. `view` is not one of the six: it is the persistent group,
 * which is a step's shape without a mode.
 */
export type StepId =
  | "map"
  | "ink"
  | "suppress"
  | "addink"
  | "walls"
  | "edit"
  | "regions"
  | "view";

/**
 * What the canvas can draw over the map.
 *
 * A step declares which of these it shows, and they legitimately differ: Ink paints the binary mask,
 * Walls paints linework over it, and Regions paints coloured faces over a map with no mask at all.
 * Nothing is drawn "because it exists" — a layer is on screen because the step the GM is in is about
 * it.
 */
export const LAYERS = ["ink", "paint", "breaks", "skeleton", "regions", "graph"] as const;

/*
  One rule about `paint`, because it is the layer that does not follow the convention.

  Everything else here is drawn only in the step that is about it. The GM's two hand-made layers are
  drawn **wherever the ink is drawn** — Ink, both painting steps, and Walls — and the reason is that
  a picture of the ink that leaves out what the GM has done to it is a picture of something that no
  longer exists downstream. The concrete bite is the Walls step: its skeleton is thinned from the
  whole composite, so without both colours the centreline and the ink under it visibly disagree.

  `breaks` is drawn in exactly one step, Add ink, which is where its tool runs. It was in Ink and
  Walls while the search ran on every recompose and there was always something to show; on demand,
  those steps would carry an empty layer in the ordinary case.

  They do not compete for the ink's own channel. The mask is drawn in the GM's chosen colour and
  these two in fixed colours of their own, which is the same arrangement the break fill has and rests
  on the same rule: what the map said and what we did to it must never look alike (`DESIGN.md` §8).
*/

export type LayerId = (typeof LAYERS)[number];

/**
 * What a plain left-drag does while a step is open.
 *
 * `edit` is not a kind of painting: it hands the press to the step's tool, which decides by looking
 * whether there is anything under it. A drag beginning on a vertex moves it and one beginning on
 * empty map pans as usual, which is why this is a mode rather than a mouse button.
 *
 * `brush` is the one that takes **every** drag, because a stroke has to be able to start anywhere —
 * which is exactly why Ctrl-pans exists, and why the record's long-standing debt to a trackpad user
 * comes due in the steps that carry this. The shell has had the branch for it since before anything
 * used it.
 */
export type Drag = "pan" | "brush" | "edit";

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
    layers: ["ink", "paint"],
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
    ],
  },
  {
    id: "suppress",
    title: "Suppress ink",
    blurb:
      "Paint over marks the trace should <b>ignore</b> — meaningless crosshatching, a printed floor " +
      "grid, a compass rose. The controls above work on every mark at once and cannot tell " +
      "decoration from linework; you can, by looking. Painted areas are shown in " +
      "<b class='suppress-key'>amber</b>.",
    /*
      The base ink with the paint over it, which is the pairing this step is judged by.

      Suppression is meaningless without the ink it acts on — what a GM is deciding is which of
      *those* marks are not linework — so the ink is drawn under it and the paint over it in its own
      colour. The breaks are not here: their controls belong to Ink, and a ring appearing while an
      area is blocked out would be answering a question nobody is asking yet.
    */
    layers: ["ink", "paint"],
    drag: "brush",
  },
  {
    id: "addink",
    title: "Add ink",
    blurb:
      "Draw linework the map does not have, or does not have clearly: a wall the reading broke, a " +
      "doorway to close off, a boundary that was never drawn. This goes in <b>last of everything</b>, " +
      "so no filter above can take it away again. Drawn ink is shown in <b class='addink-key'>cyan</b>.",
    /*
      The same pairing as suppression, and for the same reason one question later.

      What is drawn here is judged against the linework it is joining — a wall added to close a break
      has to meet the ink at both ends — so the ink is underneath and both paint layers are over it,
      the suppression included: ink the GM has already taken out is not ink a new stroke should be
      aiming at.
    */
    layers: ["ink", "paint", "breaks"],
    drag: "brush",
    groups: [
      {
        title: "Finding breaks",
        blurb:
          "A wall with a section missing merges two rooms, which is the worst this can get wrong &mdash; " +
          "and a crack four pixels wide is not something anyone finds by scanning a map. The " +
          "<b>Breaks</b> tool searches for them and proposes each one in " +
          "<b class='gap-key'>purple</b>; nothing is added until you accept it, and what you accept " +
          "becomes ordinary added ink.",
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

      **The breaks were here too, and are not any more** (2026-09-05). That was the one argued
      exception to "each step shows its own layer", on the grounds that a severed wall becomes
      visible here — a gap in the ink is a gap in the skeleton, and the rings told a GM whether a
      break was a doorway or something their own filter had cut.

      What retired it is that the search is a **tool** now, run when the GM asks rather than on every
      recompose. There is nothing to draw here unless something ran it, so a layer declared here
      would be empty in the ordinary case and stale in every other. **The cost is real and is the one
      to watch in a room**: a wall this step's own filter severed no longer announces itself, and
      finding it means going to Add ink and running the search.
    */
    layers: ["ink", "paint", "skeleton"],
    drag: "pan",
  },
  {
    id: "edit",
    title: "Edit walls",
    blurb:
      "The walls as a <b>graph</b>: every wall a line, every corner a point. Generating it hands " +
      "them over to be edited by hand and closes the reading above — from then on this is what the " +
      "rooms are made of, and nothing recalculates it from the map.",
    /*
      The partition under the graph, which is the one pairing that answers this step's question.

      The convention is that each step draws its own thing, and the Regions step makes the strongest
      case for it — ink under a partition answers the previous question over the top of this one.
      This is the argued exception, and it is the same shape as the one Walls carries: what a GM is
      deciding here is not where a line *is* but what moving it would do, and what it does is change
      which rooms exist. The rooms are the consequence, so they are drawn under the cause.

      They also do not compete for the same ink. The partition is fills and outlines in six cycling
      colours; the graph is one colour and a handle at every point.
    */
    layers: ["regions", "graph"],
    /*
      The first step that takes the plain drag for something other than panning.

      It is not all-or-nothing, which is what makes it liveable: the tool takes the gesture only when
      the press lands on a vertex, so panning by dragging empty map still works and Ctrl still pans
      anywhere. That matters more here than in a painting step — editing a graph is mostly looking,
      and a mode that took every drag would make the looking part awkward to pay for the editing.
    */
    drag: "edit",
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

  // A brush each, in the step whose layer it paints. One shared width would make every switch
  // between the two tools a resize, and what they are for is an order of magnitude apart.
  suppressBrushPx: "suppress",
  inkBrushPx: "addink",
  // With the search that uses them, which is a tool inside Add ink. They were under Ink while the
  // repair was a stage of the pipeline; a control belongs to the step that runs it.
  gapFillPx: "addink",
  gapTravelPx: "addink",
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

/**
 * Every parameter belonging to one step, in `PARAMETER_STEP`'s declaration order.
 *
 * Named because `stageParameters` walks `SETTING_LIMITS` instead, and both docs used to say
 * "in declaration order" — which reads as one shared order and is two different ones. Nothing
 * depends on either: the UI takes its order from `CONTROLS`, and both callers here are
 * order-independent.
 */
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
