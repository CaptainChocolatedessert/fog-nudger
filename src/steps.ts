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
 * They are *not* required to disagree everywhere. Every *sliding* parameter in the Ink step happens
 * to be a pipeline parameter today — the tools' own widths and gap settings are `tool`, and sit in
 * the pinned head — and that is a fact about today's parameters rather than a rule. Pinning it would
 * fail the day a step legitimately holds one of each, which is exactly what the independence is for.
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
  regeneratesWalls,
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
/*
  `edit` was here and is gone (user, 2026-09-14): *"Edit walls can disappear."*

  It emptied out rather than being cut. Its tool picker went to the strip, its straighten and prune
  buttons went when each became one live slider, and its push went to the bar — leaving a group
  whose entire content was one button that adds four walls. What a step owns is a set of layers and
  a meaning for a drag, and by the end it owned neither that Walls did not.
*/
export type StepId = "map" | "ink" | "walls" | "view";

/**
 * What the canvas can draw over the map.
 *
 * A group declares which of these it shows, and they legitimately differ: Ink paints the binary
 * mask, Walls paints coloured faces and the centrelines that bound them over it, and Map paints
 * nothing, because its question is which image rather than what was read from it. Nothing is drawn
 * "because it exists" — a layer is on screen because the drawer open over it is about it.
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
export const LAYERS = ["ink", "paint", "gaps", "mends", "regions", "graph", "delta"] as const;

/**
 * What the map shows from the moment one is chosen — user, 2026-09-14.
 *
 * Layers used to be declared per group and proposed by whichever was open, so the picture
 * changed as the GM moved around it. A room called that confusing, and it caused a real defect:
 * arming a wall tool cleared the drawer, and the drawer proposed the empty set on its way out.
 *
 * **What made the old arrangement necessary was that a group was a mode.** It is not; the tool
 * is. So the picture is constant and the only marks that come and go belong to the thing in your
 * hand — which today is exactly one layer, the gap finder's rings, and they mean nothing when it
 * is not running.
 */
export const ALWAYS_LAYERS = ["ink", "regions", "graph"] as const;

/**
 * Drawn only while the tool that owns them is in hand.
 *
 * **The GM's paint is one of these, and that is the point** (user, 2026-09-14): the ink layer
 * draws the *composite*, so what they suppressed and what they added are already in the picture
 * as ink. Drawing the two layers separately is a thing the **brush** needs — it is how you see
 * what you are editing — and putting the brush down is how you stop needing it.
 *
 * These get no switch of their own. A tool's own marks are part of the tool rather than part of
 * the resting picture, so the tool *is* the switch, and offering a second one would be two
 * handles on the same state.
 */
export const TOOL_LAYERS: Readonly<Record<string, LayerId>> = {
  suppress: "paint",
  ink: "paint",
  gaps: "gaps",
  // The proposed mends and their rings, which mean nothing while the mend tool is not in hand.
  mends: "mends",
};

/**
 * Drawn only while a question is on screen — the third and last way a layer can be asked for.
 *
 * `delta` is the whole list: the walls a regenerate would take and the ones it would bring
 * back, up for exactly as long as the dialog asking about them. That is the one moment *which
 * walls* is worth the whole map, and it is why this is not a tool layer — no tool is in hand,
 * and the thing that puts it up is a modal rather than a press.
 *
 * These get no switch either, for the tool layers' reason: what turns it on is the thing it is
 * about, so a second handle would be a way to answer the question by hiding it.
 *
 * **Declared rather than left as an exception**, because `steps.test.ts` asserts that every
 * layer is proposed by something — a painter nothing ever asks for is dead pixels with nothing
 * to say so — and a hard-coded excuse in the test would retire that guarantee for the next one
 * as well as this one.
 */
export const QUESTION_LAYERS = ["delta"] as const;

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
    hint: "Drag to move the map. Click without dragging to ask what the trace made of that pixel.",
  },
  { id: "suppress", label: "Suppress", band: "ink", drag: "brush", hint: "" },
  { id: "ink", label: "Add ink", band: "ink", drag: "brush", hint: "" },
  { id: "gaps", label: "Gaps", band: "ink", drag: "brush", hint: "" },
  {
    id: "move",
    label: "Move",
    band: "walls",
    drag: "edit",
    hint: "Drag a point to move it. Drop it on another to join them; <b>Shift</b> keeps them apart.",
  },
  {
    id: "draw",
    label: "Draw",
    band: "walls",
    drag: "edit",
    hint:
      "Drag to draw a wall, or click both ends. An end turns <b class='join-key'>cyan</b> where it " +
      "would attach; <b>Shift</b> leaves it loose. <b>Ctrl</b> pans, Escape abandons.",
  },
  {
    id: "erase",
    label: "Erase",
    band: "walls",
    drag: "edit",
    hint: "Click a wall to remove it, <b>one segment at a time</b>. The highlight shows what would go.",
  },
  /*
    The graph's gap tool (user, 2026-09-16). `edit`, like the other three: it takes a press inside a
    ring and declines everything else, which falls through to a pan. Its hint is its group's blurb,
    because it has controls of its own and the blurb is the line above them.
  */
  { id: "mend", label: "Mend", band: "walls", drag: "edit", hint: "" },
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
  /**
   * Shown under the heading, or in the tool-hint slot for a group that belongs to a tool.
   *
   * Empty for an ordinary sub-heading, for the reason a step's is. A **tool's** group is the one
   * place a blurb is nearly always earned: a tool is a glyph in a strip with a tooltip, so this is
   * the only text saying what a press does and which modifier changes it.
   */
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
  /**
   * Shown under the title. May carry markup, and is **empty for all but one step**.
   *
   * The default is nothing (user, 2026-09-09): a heading plus the labels under it says what a step
   * is for, and a paragraph at the top of every section is prose a GM scrolls past to reach the
   * controls. A blurb has to earn its line by saying something no label in the step can — View's
   * does, because "Preview fill" cannot also say what the emitted shape looks like.
   */
  readonly blurb: string;
  /** What the canvas shows while this step is open. */
  /** Sub-headings, for controls that need their own explanation inside a step. */
  readonly groups?: readonly StepGroup[];
  /**
   * Kept out of the numbered cascade, because it is not a stage of the work.
   *
   * There is exactly one — View — and the flag meant more than this: a persistent group sat
   * outside the accordion and was always on screen, which was the answer to a control describing a
   * layer that two steps drew. **The drawer retired that half** (2026-09-14): every group is one
   * press away in the strip, so nothing is special about being reachable. What is left is the
   * ordering — Map, Ink and Walls are the cascade and View is not part of it.
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
 * The groups, in the order the GM meets them.
 *
 * **The order is the cascade made visible, and the tool strip is what makes it visible now** — one
 * column, each group's name above the tools that act on it, so where a group sits in the chain is
 * a shape rather than something to remember. That job belonged to an accordion of headers and then
 * to a scrolling rail; the drawer took both, and the ordering survived every change because it was
 * never really the accordion's doing. It is a column's.
 *
 * What the order *is*: read a map, decide what counts as ink on it, shape the walls that come out.
 * View is last and outside it, because it changes nothing about the document.
 */
export const STEPS: readonly Step[] = [
  {
    id: "map",
    title: "Map",
    // Nothing to say: the picker is the whole step, and the steps below being disabled until an
    // image is chosen says the rest without a sentence.
    blurb: "",
    /*
      Nothing over the map, deliberately.

      This step's question is *which image*, and the answer is the image itself — an ink mask drawn
      on top would be answering the next question over the top of this one. It is also what resolves
      the chicken-and-egg of a surface that needs a map to draw: with no map chosen there is nothing
      here but the picker, and that is a complete and honest state rather than an empty canvas.
    */
  },
  {
    id: "ink",
    title: "Ink",
    // The ninety words here listed the three tools and said what each was for. All three are buttons
    // in the strip with a blurb of their own, so this was a table of contents for a list one scroll
    // further down.
    blurb: "",
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
        blurb: "",
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
        // "Uncovers" became "erases" with the buttons (2026-09-09). The blurb has to name the same
        // verb the modifier actually performs, or Shift is documented as doing something the tool
        // no longer calls by that name.
        blurb:
          "Drag over marks the trace should <b>ignore</b> &mdash; hatching, a printed floor grid, " +
          "a compass rose. Your strokes show in <b class='suppress-key'>amber</b>, and none of the " +
          "map is lost. <b>Shift</b> erases, <b>Ctrl</b> pans.",
        parameters: ["suppressBrushPx"],
      },
      {
        tool: "ink",
        title: "Add ink",
        blurb:
          "Drag to draw linework the map lacks. Goes in <b>last of everything</b>, so no filter " +
          "above can take it away again. Shows in <b class='addink-key'>cyan</b>. <b>Shift</b> " +
          "erases, <b>Ctrl</b> pans.",
        parameters: ["inkBrushPx"],
      },
      {
        tool: "gaps",
        title: "Gaps",
        /*
          Mechanics only (user, 2026-09-09), and the teaching is the stated cost.

          The seventy words this replaces spent most of themselves on *why* a four-pixel crack
          matters — that a severed wall merges two rooms, which is the worst thing the tool can get
          wrong. That is the best argument in the product and a first-time GM no longer meets it.
          What is left says what a press does, which is what the slot is for.
        */
        blurb:
          "Searches for places a wall stops short and rings each in " +
          "<b class='gap-key'>cyan</b>. <b>Click inside a ring</b> to close that gap, or use the " +
          "button below for all of them. A <b>dashed</b> ring is not offered. Dragging pans.",
        parameters: ["gapFillPx", "gapTravelPx"],
      },
    ],
  },
  {
    id: "walls",
    title: "Walls",
    blurb: "",
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
    groups: [
      {
        tool: "mend",
        title: "Mend",
        /*
          Mechanics only, as the ink tool's is. It does not name a colour: the palette is retunable
          and a word for a hue is a copy nothing can keep honest.
        */
        blurb:
          "Looks for places the walls stop short and proposes a wall across each, ringed. " +
          "<b>Click inside a ring</b> to mend that gap, or use the button below for all of them. " +
          "Dragging pans.",
        parameters: ["mendReachGraphUnits", "mendTravelGraphUnits"],
      },
    ],
  },
  /*
    The Regions step was here, and it is GONE (user, 2026-09-05).

    Its question -- are these the rooms I would have drawn -- has not gone anywhere; what went is the
    idea that answering it is a place you travel to. The partition is drawn wherever a graph is
    drawn, so a step whose whole content was that one layer had nothing left that the groups either
    side of it were not already showing. (Edit walls went the same way on 2026-09-14, for the same
    reason one step further on.)

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
    /*
      The one step blurb kept, cut to the half a label cannot carry.

      "Preview fill" and "Preview outline" say these are local to this canvas. What they cannot say
      is what the *emitted* shape looks like instead \u2014 and a GM who assumes a tinted preview means a
      tinted fog shape has assumed something false about the thing this tool exists to produce.
    */
    blurb: "Preview only \u2014 an emitted room is fully opaque and has no outline.",
    /*
      No layers of its own, and that is what a persistent group means rather than an oversight.

      It is never entered, so it never decides what is on the canvas. What it holds are controls for
      a layer some *other* step has asked for, which is the whole reason a control ends up here
      rather than in a step: the partition has two homes now, and a control living in one of them is
      one the other home has to be left in order to reach.
    */
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
  // The ink's opacity led this list and is gone (user, 2026-09-09), along with the parameter —
  // see the tombstone in `settings.ts` for why the setting could not simply be hidden.
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
    One limit, one handle, in the group that says how the walls come out.

    It was declared in **both** wall groups while they were separate pages, on the argument that a GM
    should not have to find a limit twice — and that was safe precisely because only one mode was on
    screen at a time. On one page it would be two sliders writing one setting, which disagree the
    moment either moves.

    So it lives with the other derive-time control. Turning it up re-prunes on the next derive and
    turning it back down puts the walls back, because a derivation is not destroyed by being redone.
    There was a **button** in Edit walls spending the same number destructively, which is what you
    needed while the stored graph had nothing to re-derive it from. One live slider now: changing
    it regenerates the walls like any reading change, and the mark and the prompt price that.
  */
  spurPruneGraphUnits: "walls",
  simplifyGraphUnits: "walls",
  // The mend tool's own two, drawn in its drawer rather than in the group's.
  mendReachGraphUnits: "walls",
  mendTravelGraphUnits: "walls",
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
 * The step the markup colours belong to, and which of the settings they are.
 *
 * The same wart `settings.ts` carries one axis down, for the same reason: a colour is not a number,
 * so it sits outside `SETTING_LIMITS` and every function that walks a step's parameters has to
 * remember the colours separately. Named once here rather than in each of them.
 *
 * ## View, and all five — 2026-09-10
 *
 * It was `"ink"` and covered the ink colour alone, because the ink swatch sat at the top of the Ink
 * step. The swatch moved down to join the other four in View (user, 2026-09-09), and this had to
 * follow it — **left behind, Ink's Defaults would have reset a colour no longer shown in Ink**, while
 * View's Defaults, directly under the picker, left it alone.
 *
 * **The other four were never reset by anything**, which reads as a gap left when they became
 * adjustable rather than a decision. With all five in one group a Defaults that restored one and not
 * the other four would be the button and the section disagreeing, so it covers the lot.
 * `steps.test.ts` pins that the list names every colour the settings carry, so a sixth cannot join
 * the palette and be forgotten here.
 */
const COLOUR_STEP: StepId = "view";

export const COLOUR_KEYS = [
  "inkColour",
  "structureColour",
  "additiveColour",
  "subtractiveColour",
  "destructiveColour",
] as const satisfies readonly (keyof Settings["overlay"])[];

/** Whether a step's controls are all at their defaults. */
export function isStepDefault(settings: Settings, id: StepId): boolean {
  const numbers = stepParameters(id).every(
    (name) => readParameter(settings, name) === readParameter(DEFAULT_SETTINGS, name),
  );
  if (id !== COLOUR_STEP) return numbers;
  return numbers && COLOUR_KEYS.every((key) => settings.overlay[key] === DEFAULT_SETTINGS.overlay[key]);
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
  const colours = Object.fromEntries(COLOUR_KEYS.map((key) => [key, DEFAULT_SETTINGS.overlay[key]]));
  return { ...numbers, overlay: { ...numbers.overlay, ...colours } };
}

/**
 * The groups of the cascade: everything but View.
 *
 * **Not the same list the strip draws**, which is every group including View — `panelSteps` in
 * `drawer.ts` is that one. What this answers is *where does the work start*, which is why the
 * drawer opens on the first of these and why the map gate is stated against them.
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

/**
 * Whether a step holds any control that would rebuild the wall graph.
 *
 * **What the strip's mark is hung on**, and it is asked of the parameters rather than hardcoded to
 * Ink and Walls — so a control moving between groups carries its consequences with it rather than
 * leaving the mark behind on the group it left. `regeneratesWalls` is the per-parameter half;
 * `workspace/regenerateGuard.ts` is the drawing.
 */
export function stepRegeneratesWalls(step: StepId): boolean {
  return stepParameters(step).some(regeneratesWalls);
}

/**
 * The line shown under a tool: its own hint, or the blurb of the group it belongs to.
 *
 * Pure, and here rather than in the tool strip, because the drawer needs the same answer — it draws
 * the hint now that a tool's controls are its own drawer rather than a pinned strip. Two copies of
 * "what does this tool say" is the kind of pair this project keeps paying for.
 */
export function toolHint(id: string): string {
  const choice = TOOLS.find((candidate) => candidate.id === id);
  if (!choice) return "";
  if (choice.hint) return choice.hint;
  return STEPS.flatMap((step) => step.groups ?? []).find((group) => group.tool === id)?.blurb ?? "";
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
