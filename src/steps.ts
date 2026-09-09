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
 * The A-plan designed six — map, ink, walls, edit walls, regions, doors. Doors stay with Dynamic Fog
 * entirely, and **regions was dissolved on 2026-09-05** into the two steps that draw a graph, so the
 * partition is no longer somewhere a GM goes. `view` is not one of the six: it is the persistent
 * group, which is a step's shape without a mode.
 */
export type StepId = "map" | "ink" | "walls" | "edit" | "view";

/**
 * What the canvas can draw over the map.
 *
 * A step declares which of these it shows, and they legitimately differ: Ink paints the binary mask,
 * Walls paints coloured faces and the centrelines that bound them over it, and Edit walls paints the
 * same faces under the graph with no mask at all. Nothing is drawn "because it exists" — a layer is
 * on screen because the step the GM is in is about it.
 *
 * `regions` is the one drawn in **two** steps, which is what dissolving the Regions step means: the
 * partition is a consequence of a graph rather than a subject of its own, so it is drawn wherever a
 * graph is.
 */
/*
  `skeleton` was here, and went when the Walls step started drawing the fitted graph instead
  (2026-09-05). It was a one-pixel raster centreline and the graph is the polyline fitted to it, so
  drawing both would have put two answers to one question on the canvas -- and the graph is the
  honest one, because it is what gets stored.
*/
export const LAYERS = ["ink", "paint", "gaps", "regions", "graph"] as const;

/*
  One rule about `paint`, because it is the layer that does not follow the convention.

  Everything else here is drawn only in the step that is about it. The GM's two hand-made layers are
  drawn **wherever the ink is drawn** — Ink and Walls — and the reason is that a picture of the ink
  that leaves out what the GM has done to it is a picture of something that no longer exists
  downstream. The concrete bite is the Walls step: its skeleton is thinned from the whole composite,
  so without both colours the centreline and the ink under it visibly disagree.

  `gaps` is drawn in exactly one step, Ink, which is where its tool runs. It was in Walls too while
  the search ran on every recompose and there was always something to show; on demand, that step
  would carry an empty layer in the ordinary case.

  They do not compete for the ink's own channel. The mask is drawn in the GM's chosen colour and
  these two in fixed colours of their own, which is the same arrangement the gap fill has and rests
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

/*
  **A step no longer declares this.** It used to carry `drag`, which is what forced the accordion to
  be exclusive: two expanded steps would have been two meanings for one press. The verb moved to the
  tool palette, so a heading now decides only what is on screen and several can be expanded at once.

  The type stays because the shell still dispatches on it — it is how a press finds the handler that
  wants it — and `toolPalette.ts` is what maps a tool onto it now.
*/

/**
 * Every tool, and what a press means while it is in hand.
 *
 * **Declared here rather than in the palette that draws it**, for the reason everything else in this
 * file is: the palette imports the shell and the SDK, so it cannot be reached from a node test, and
 * a tool list nothing can check is one that drifts from the groups whose controls it reveals.
 *
 * `pan` is a tool rather than the absence of one. The surface used to reach the same state by
 * clicking the selected tool a second time to put it down, which is undiscoverable and looks exactly
 * like a tool that declined the press.
 */
export interface ToolChoice {
  readonly id: string;
  readonly label: string;
  /** The band it sits in, which is the same order the rail is numbered by. */
  readonly band: "navigate" | "ink" | "walls";
  /**
   * What a plain left-drag does while this tool is in hand.
   *
   * The gap tool takes `brush` and not `pan`, which looks wrong and is not: the brush branch is what
   * offers a press to the paint tool at all, and that tool declines a press outside every ring so it
   * falls through to a pan. Giving it `pan` would mean a click inside a ring never reached it.
   */
  readonly drag: Drag;
  /**
   * What a press does, shown while the tool is in hand. May carry markup.
   *
   * Empty for a tool whose controls carry their own blurb — the ink tools each have a step group,
   * and repeating its sentence here would be two copies to keep in step.
   */
  readonly hint: string;
}

export const TOOLS: readonly ToolChoice[] = [
  {
    id: "pan",
    label: "Pan",
    band: "navigate",
    drag: "pan",
    hint:
      "Drag to move the map, and nothing here changes it. Click once without dragging to ask what " +
      "the trace made of that pixel.",
  },
  { id: "suppress", label: "Suppress", band: "ink", drag: "brush", hint: "" },
  { id: "ink", label: "Add ink", band: "ink", drag: "brush", hint: "" },
  { id: "gaps", label: "Gaps", band: "ink", drag: "brush", hint: "" },
  {
    id: "move",
    label: "Move",
    band: "walls",
    drag: "edit",
    hint:
      "Drag a point to move it. Drop it on another to join them — hold <b>Shift</b> to keep them " +
      "apart.",
  },
  {
    id: "draw",
    label: "Draw",
    band: "walls",
    drag: "edit",
    hint:
      "Drag to draw a wall, or click both ends. An end turns <b class='join-key'>green</b> where " +
      "it would attach to an existing point, which is how you close a gap — hold <b>Shift</b> to " +
      "leave it loose. <b>Ctrl</b>-drag pans. Escape or right-click abandons a wall part-drawn.",
  },
  {
    id: "erase",
    label: "Erase",
    band: "walls",
    drag: "edit",
    hint:
      "Click a wall to remove it. <b>One segment at a time</b>, so a long wall drawn as many " +
      "segments takes a click each — the highlight shows exactly what would go.",
  },
];



/*
  `WorkspaceMode` was here, and the two modes went with it (2026-09-08).

  Stage one and the wall editor were separate pages, and a step declared which it belonged to. The
  split was across the grain of the job: the work loop is look at the rooms, spot a merged one, go
  back to the ink, look again, and that crossed the boundary twice per iteration.

  What the boundary was protecting is real — re-deriving destroys hand edits — but it is a property
  of the document rather than a place, and `stage.ts` counts it now. One page, one list of groups,
  and the price is named when there is a price to name.
*/

/** A sub-heading within a step, for a handful of controls that want their own explanation. */
export interface StepGroup {
  readonly title: string;
  /** Shown under the heading. May carry markup. */
  readonly blurb: string;
  readonly parameters: readonly SettingName[];
  /**
   * The tool inside the step that owns these controls, if one does.
   *
   * A group with this set is **not** rendered by the step's body: the step's tool picker draws the
   * button from `title`, the line under the row from `blurb`, and the rows only while that tool is
   * the one in hand. Without it the controls would appear twice — once in the disclosure and once as
   * an ordinary sub-heading — and two sliders writing one setting disagree the moment either moves.
   *
   * It is declared here rather than in the picker so that a step's parameters are all in one place,
   * which is what `PARAMETER_STEP`'s totality test and the per-step Defaults both walk. The id is a
   * plain string because a step's tools are the step's own vocabulary; the one step that has them
   * matches these against its `PaintTool` union.
   */
  readonly tool?: string;
}

export interface Step {
  readonly id: StepId;
  readonly title: string;
  /** Shown under the title, saying what the step is for. May carry markup. */
  readonly blurb: string;
  /** What the canvas shows while this step is open. */
  readonly layers: readonly LayerId[];
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
    blurb:
      "Which image the trace reads. Everything below is about this one picture, and stays closed " +
      "until one is chosen.",
    /*
      Nothing over the map, deliberately.

      This step's question is *which image*, and the answer is the image itself — an ink mask drawn
      on top would be answering the next question over the top of this one. It is also what resolves
      the chicken-and-egg of a surface that needs a map to draw: with no map chosen there is nothing
      here but the picker, and that is a complete and honest state rather than an empty canvas.
    */
    layers: [],
  },
  {
    id: "ink",
    title: "Ink",
    blurb:
      "What the trace calls a mark, which marks it keeps, and the tools for correcting that by hand. " +
      "The sliders decide what counts as ink everywhere at once; below them are three tools that " +
      "work on one spot &mdash; <b>Suppress</b> to cover marks the trace should ignore, <b>Add " +
      "ink</b> to draw linework the map lacks, and <b>Gaps</b> to hunt for places a wall stops " +
      "short, which are the faults that merge two rooms and are far too small to spot by eye. " +
      "Everything the " +
      "tools write goes into a layer of your own that no slider here can undo.",
    /*
      One step, and it took two others into itself on 2026-09-05 (user).

      Suppress ink and Add ink were steps of their own for a day. The objection is that they are not
      *modes* in the sense a step is: they look at the same picture, judged the same way, and a GM
      correcting a map moves between the threshold, the amber and the cyan constantly. Making each of
      them a place to travel to put a scene write between every switch, because a painting step
      committed its layer on the way out.

      > *"You're in the Ink workspace, and there's a special effect of leaving it. But within that
      > workspace you can jump between tools freely."*

      So the mode is this step and the picker says which verb inside it. **Both paint layers are
      opened as working copies when the step opens and both are written when it closes**, which is
      less machinery than the two steps needed rather than more: the write-then-open serialisation
      existed only because switching between them was a write.

      Walls was here too, and left on 2026-08-29 (user) when it had a skeleton to paint. Its two
      controls stayed, under the Linework sub-heading: they are ink *filters*, deciding which marks
      survive rather than what a wall is.
    */
    layers: ["ink", "paint", "gaps"],
    /*
      A brush takes every press, which is what `brush` means -- and here it is qualified by the tool.

      With no tool chosen the handler declines and the press pans, which is the path the shell has
      always had for a brush opened before the map has been read. That is what makes the sliders
      usable without a modifier: this step is a brush only once you have said which brush.
    */
    groups: [
      {
        // Called "Walls" until the skeleton arrived and took the name back: these two decide which
        // marks are *linework*, which is a question about ink. A wall is what the step below makes
        // of the linework.
        title: "Linework",
        blurb: "Filtering those marks down to linework. Both go far past useful, so the edge is findable.",
        parameters: ["minStrokeInkWidths", "minIslandPx"],
      },
      /*
        The three tools, declared here so their controls sit with everything else the step owns --
        and rendered by the picker rather than by the step body, which is what `tool` means.

        Each carries a title and a blurb because the picker uses both: the title is the button, and
        the blurb is the line under the row saying what a press does. A tool with no parameters would
        still be declared here; these three happen to have some.
      */
      {
        tool: "suppress",
        title: "Suppress",
        blurb:
          "Drag to cover marks the trace should <b>ignore</b> &mdash; meaningless crosshatching, a " +
          "printed floor grid, a compass rose. The sliders above work on every mark at once and " +
          "cannot tell decoration from linework; you can, by looking. Covered areas show in " +
          "<b class='suppress-key'>amber</b>. Hold <b>Shift</b> to uncover while you drag, " +
          "<b>Ctrl</b> to pan.",
        parameters: ["suppressBrushPx"],
      },
      {
        tool: "ink",
        title: "Add ink",
        blurb:
          "Drag to draw linework the map does not have, or does not have clearly: a wall the reading " +
          "broke, a doorway to close off, a boundary that was never drawn. This goes in <b>last of " +
          "everything</b>, so no filter above can take it away again. Drawn ink shows in " +
          "<b class='addink-key'>cyan</b>. Hold <b>Shift</b> to erase while you drag, <b>Ctrl</b> " +
          "to pan.",
        parameters: ["inkBrushPx"],
      },
      {
        tool: "gaps",
        title: "Gaps",
        blurb:
          "A wall with a section missing merges two rooms, which is the worst this can get wrong " +
          "&mdash; and a crack four pixels wide is not something anyone finds by scanning a map. " +
          "This searches for them and rings each one in <b class='gap-key'>purple</b>. <b>Click " +
          "inside a ring</b> to close that gap, or close them all with the button below. " +
          "<b>Nothing is added until you accept it</b>, and what you accept becomes ordinary added " +
          "ink. A <b>dashed</b> ring is a channel the search could not finish examining and will " +
          "not offer. Dragging pans.",
        parameters: ["gapFillPx", "gapTravelPx"],
      },
    ],
  },
  {
    id: "walls",
    title: "Walls",
    blurb:
      "The <b>graph</b> the reading arrives at, over the rooms it encloses: every wall a line, every " +
      "corner a point. <b>A face boundary is a wall's centreline</b>, so both controls here change " +
      "which rooms exist and what shape they are. <b>This is what goes on the map</b>, and it is the " +
      "same picture the wall editor opens on.",
    /*
      The graph over the partition over the ink: three layers, and each earns its place.

      **It draws the graph after simplification, not the pixel skeleton** (user, 2026-09-05): *"the
      last step of the ink mode displays the graph, post simplification. Saving out of ink mode
      pushes that graph."* That makes the last thing stage one shows and the first thing the editor
      shows one picture, which is what a hand-off between two modes has to be — and it is the honest
      one, because the fitted polyline is what gets stored and the one-pixel skeleton never was.

      **The skeleton layer went with that change**, rather than being drawn beside it. It showed a
      coarser version of the same centreline, and drawing both would put two answers to one question
      on the canvas. Everything it was for survives: whether the line runs down the middle of the
      wall is still a comparison against the ink underneath, and a pruned spur is as absent from the
      fitted graph as it was from the skeleton.

      **The Regions step was dissolved into this one** (user, 2026-09-05): *"'regions' as a separate
      step isn't needed anymore. We can always display colored regions when we display the graph."*
      So the partition stopped being somewhere to go, and is drawn wherever a graph is drawn.

      The ink stays under both for the reason it always did: a centreline on its own says nothing,
      and what a GM is judging is whether it runs down the middle of the wall it came from.

      **The cost is that this step carries a lot at once**, which is the opposite of the reason the
      dissolved step showed the partition on bare map. The lever for it is the ink opacity, one step
      up rather than here.

      **The gaps were here too, and are not any more** (2026-09-05). That was the one argued
      exception to "each step shows its own layer", on the grounds that a severed wall becomes
      visible here. What retired it is that the search is a **tool** now, run when the GM asks rather
      than on every recompose: there is nothing to draw here unless something ran it. **The cost is
      real and is the one to watch in a room** -- a wall this step's own filter severed no longer
      announces itself, and finding it means running the Gaps tool one step up.
    */
    layers: ["ink", "paint", "regions", "graph"],
  },
  {
    id: "edit",
    title: "Edit walls",
    blurb:
      "The walls as they were saved, and yours to move. Every wall is a line and every corner a " +
      "point; joining two points makes them one for ever, so the rooms either side of a wall follow " +
      "it when it moves. Nothing here recalculates anything from the map.",
    /*
      The partition under the graph, which is the one pairing that answers this step's question.

      Same pairing as the Walls step in the other mode, and for the same reason: what a GM is
      deciding here is not where a line *is* but what moving it would do, and what it does is change
      which rooms exist. The rooms are the consequence, so they are drawn under the cause. What
      differs is that here the graph carries a handle at every point, because here it can be grabbed.

      **What is NOT here is the ink.** This mode never reads the map, so a mask drawn underneath
      would invite a comparison against a picture that is not the source of anything on screen.

      They do not compete for the same ink either. The partition is fills and outlines in six cycling
      colours; the graph is one colour and a dot at every point.
    */
    layers: ["regions", "graph"],
    /*
      The one step that takes the plain drag for something other than panning without being a brush.

      It is not all-or-nothing, which is what makes it liveable: two of the three tools take the
      gesture only when there is something under the press, so panning by dragging empty map still
      works and Ctrl still pans anywhere. That matters more here than under a brush -- editing a
      graph is mostly looking, and a mode that took every drag would make the looking part awkward to
      pay for the editing.
    */
  },
  /*
    The Regions step was here, and it is GONE (user, 2026-09-05).

    Its question -- are these the rooms I would have drawn -- has not gone anywhere; what went is the
    idea that answering it is a place you travel to. The partition is drawn wherever a graph is
    drawn, which is Walls and Edit walls, so a step whose whole content was that one layer had
    nothing left the two steps either side of it were not already showing.

    Where its three controls went, and why each landed where it did:

    - **Edge smoothing to Walls**, because it shapes the graph rather than the picture of it, and
      Walls is where the other control that does that already sits.
    - **Preview fill and outline to the View group**, which is the persistent one. They describe a
      layer that two steps now draw, so filing them under either would make recolouring it from the
      other a journey -- which is the exact objection that moved them *out* of View in the first
      place, one axis over. A persistent group is never navigated to, so it answers that objection
      rather than reintroducing it.
    - **"Put on the map" to the end of Walls**, which is now the step that shows what it writes.
  */
  {
    id: "view",
    title: "View",
    /*
      The only thing in both modes, which is what a persistent group is.

      Its controls describe the partition, and the partition is drawn in each mode's last step. A
      group that is never entered is the one place a control can sit and be reachable from both
      without either mode claiming it.
    */
    blurb:
      "How the rooms are drawn, wherever they are drawn \u2014 which is <b>Walls</b> and <b>Edit " +
      "walls</b>. Neither of these changes what goes on the map: an emitted room is fully opaque " +
      "and carries no outline at all.",
    /*
      No layers of its own, and that is what a persistent group means rather than an oversight.

      It is never entered, so it never decides what is on the canvas. What it holds are controls for
      a layer some *other* step has asked for, which is the whole reason a control ends up here
      rather than in a step: the partition has two homes now, and a control living in one of them is
      one the other home has to be left in order to reach.
    */
    layers: [],
    persistent: true,
  },
];

/**
 * The single declaration of which step owns which parameter.
 *
 * Total over every parameter, and asserted so: a parameter with no step would simply vanish from
 * both surfaces, which is a control a GM cannot reach and nothing to say it is missing.
 */
export const PARAMETER_STEP: Readonly<Record<SettingName, StepId | readonly StepId[]>> = {
  // How the ink is drawn sits with the ink, and how a proposal is drawn sits with the proposals
  // (user, 2026-08-29). They were a View group of their own while the partition existed only in the
  // scene; now that both are drawn on this canvas, a control that changes one belongs beside it.
  inkOpacity: "ink",
  sauvolaK: "ink",
  blurSigma: "ink",
  sauvolaRadiusPx: "ink",
  minStrokeInkWidths: "ink",
  minIslandPx: "ink",

  /*
    The three tools' own controls, in the step that holds all three.

    A brush width each rather than one shared: what the two brushes are for is an order of magnitude
    apart, so a single width would make every switch between them a resize. They sit under their own
    tool in the picker, which is what keeps a step holding nine controls from reading as nine.
  */
  suppressBrushPx: "ink",
  inkBrushPx: "ink",
  gapFillPx: "ink",
  gapTravelPx: "ink",
  // Both of the controls that shape the graph, together. Pruning decides which walls survive and
  // smoothing decides what shape they are, and the step draws the result of both.
  /*
    One budget, one handle, in the group that says how the walls come out.

    It was declared in **both** wall groups while they were separate pages, on the argument that a GM
    should not have to find a budget twice — and that was safe precisely because only one mode was on
    screen at a time. On one page it would be two sliders writing one setting, which disagree the
    moment either moves.

    So it lives with the other derive-time control. Turning it up re-prunes on the next derive and
    turning it back down puts the walls back, because a derivation is not destroyed by being redone.
    The **button** in Edit walls spends the same number destructively, which is what you need once
    there are hand edits and re-deriving is no longer free.
  */
  spurPruneFraction: "walls",
  simplifyFraction: "walls",
  // The editor's own, and a second key rather than a second home for the one above: the two need
  // different defaults, which is what says they are different settings. `settings.ts` carries why.
  editSimplifyFraction: "edit",
  /*
    How the partition is drawn, in the group that is never entered.

    These followed the partition out of the deleted Regions step, and the persistent group is where
    they land rather than either step that draws it. The 2026-08-29 rule was that a display control
    belongs in the step that draws its layer, on the argument that navigating away from a thing to
    recolour it is absurd — and that argument now points *here*, because there are two such steps
    and filing them under one would mean leaving the other to reach them.
  */
  fillOpacity: "view",
  strokeSquares: "view",
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

/**
 * The steps this mode puts in its accordion: its own, minus the persistent View group.
 *
 * Two filters rather than one, and they mean different things. `persistent` is about *how* a group
 * is rendered — outside the accordion, never entered. `modes` is about which surface it is on at
 * all. A step could in principle be persistent in one mode and absent from the other; nothing is
 * today, and the two are kept separate so that stays possible.
 */
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
  return (Object.keys(PARAMETER_STEP) as SettingName[]).filter((name) => stepsOf(name).includes(step));
}

/** The controls belonging to one step, in declaration order. */
export function stepControls(step: StepId): readonly Control[] {
  return CONTROLS.filter((control) => stepsOf(control.name).includes(step));
}

/**
 * Which steps a parameter appears in.
 *
 * Almost always one, and the declaration says so by naming it plainly; a list is how a control that
 * genuinely belongs to both modes says so. Read through here rather than off the map, so a future
 * second member cannot be missed by one of the two callers above.
 */
export function stepsOf(name: SettingName): readonly StepId[] {
  const where = PARAMETER_STEP[name];
  return typeof where === "string" ? [where] : where;
}

/** The controls of a step that no group claims, which is what a step renders before its groups. */
export function ungroupedControls(step: Step): readonly Control[] {
  const grouped = new Set((step.groups ?? []).flatMap((group) => group.parameters));
  return stepControls(step.id).filter((control) => !grouped.has(control.name));
}

/**
 * The groups a step draws as sub-headings, which is every group that is not a tool's.
 *
 * The split is what stops a tool's controls being rendered twice. A tool group belongs to the
 * picker, which shows it only while that tool is in hand; drawing it here as well would put two
 * sliders on one setting, and two sliders on one setting disagree the moment either moves.
 */
export function headingGroups(step: Step): readonly StepGroup[] {
  return (step.groups ?? []).filter((group) => group.tool === undefined);
}

/** Every tool a step declares, in declaration order. Empty for a step with no picker. */
export function toolGroups(step: Step): readonly StepGroup[] {
  return (step.groups ?? []).filter((group) => group.tool !== undefined);
}

/** The controls of one group, in declaration order. */
export function groupControls(group: StepGroup): readonly Control[] {
  return CONTROLS.filter((control) => group.parameters.includes(control.name));
}
