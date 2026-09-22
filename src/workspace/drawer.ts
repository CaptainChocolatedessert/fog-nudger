/**
 * The drawer: the controls of whichever thing in the strip was last pressed.
 *
 * ## What it is
 *
 * One slot beside the tool strip, showing either a **group's settings** or **one tool's own
 * controls**, and level with the button that opened it. Pressing that button again closes it, which
 * leaves the map plain — on a surface whose whole job is looking at a map, that is the state it most
 * needs.
 *
 * ## Why it is not the accordion it replaced — 2026-09-14
 *
 * This file was a rail of expanded groups, and before that an *exclusive* accordion. Both shapes are
 * gone and the reasoning is worth keeping, because the exclusivity here looks like the old one and
 * is a different thing.
 *
 * The accordion was exclusive because **a step bound the drag**: two open steps would have been two
 * meanings for one press. That made it a navigator and a mode selector at once, which want opposite
 * behaviour — navigation cheap and non-exclusive, a mode exactly one thing — and every escape it
 * grew (the nothing-open state, the no-tool state, Ctrl-to-pan) was patching the seam between them.
 * The tool palette took the verb, so the rail stopped forcing anything shut.
 *
 * **The drawer is exclusive because there is one slot**, which costs nothing the rail was paying:
 * every group is one press away in the strip rather than a scroll away in a column, and what a drag
 * means is still chosen somewhere else entirely.
 *
 * **Two costs, stated.** Two groups cannot be read side by side — the live counts moved to the bar
 * to cover the main case. And a group's controls are behind a press rather than a scroll, which is
 * cheaper to reach and easier to forget is there.
 *
 * ## Only what is showing is built
 *
 * The rail built every group and hid the closed ones, so a reading that landed could refresh every
 * readout rather than only the visible ones. The drawer builds one, and the hint painters are reset
 * and re-registered with it — which is why `resetHints` runs at the top of every render here.
 *
 * ## What this file does not own
 *
 * **Which button is pressed**, which is the strip's; it is told to redraw through `onStepChange`.
 * And **the verb**, which is `toolPalette.ts`'s. Both were this file's once, and the whole point of
 * the redesign was that switching what you read and switching what your drag does stopped being the
 * same gesture.
 */

import {
  groupControls,
  headingGroups,
  isStepDefault,
  resetStep,
  STEPS,
  stepIsInkSide,
  stepParameters,
  TOOLS,
  toolHint,
  toolIsInkSide,
  ungroupedControls,
  type Step,
  type StepId,
} from "../steps";
import { forgetGraphScale } from "./graphScale";
import { recomputeFor } from "./recompute";
import { resetHints, settingRow } from "./settingRows";
import { currentSettings, persistSettings, setSettings } from "./settingsState";
import { renderLayerRow } from "./layerRow";
import { mapChosen } from "./mapSource";
import { invalidate, say } from "./shell";
import {
  COVER_ANCHOR,
  coverIsUp,
  keepWallChanges,
  onRegenerateReview,
  reviewBody,
  reviewIsUp,
} from "./regenerateGuard";
import { onStageChange } from "./stage";

/**
 * Which group is in the drawer, or `null` for none.
 *
 * Not stored in the scene: it is where the GM is looking, not a setting, and a workspace that
 * reopened where you left it last session would be guessing.
 *
 * One at a time; this module's header says why that is not the old exclusivity returning.
 */
/**
 * What the drawer is showing: a group's settings, or one tool's own controls.
 *
 * **Two kinds, never both** (user, 2026-09-14): *"We don't need to see the general ink parameters
 * with them; it's a drawer just for that tool."* Holding a brush and reading the threshold that
 * decided what the ink is are different moments, and a drawer serving both served neither.
 */
type Drawer =
  | { readonly kind: "params"; readonly step: StepId }
  | { readonly kind: "tool"; readonly tool: string }
  /**
   * The layer switches, which are a drawer of their own rather than a pinned row.
   *
   * They were pinned because a tool may turn a layer on and never off, so what was drawn
   * *accumulated* as the GM moved around and the switches had to be somewhere they would be
   * met. The picture is constant now, so nothing accumulates — and with four layers always on,
   * hiding one is a deliberate thing a GM goes looking for rather than a correction they need
   * to stumble on.
   */
  | { readonly kind: "layers" }
  /**
   * The regenerate question: what it would cost, and the two answers.
   *
   * **A drawer rather than a dialog, and rather than the bar.** It needs the map live behind it —
   * the price is drawn there and the GM has to pan around to judge it — and it needs to be where
   * the press was, which the bar was not (user, 2026-09-15: *"it's easy to miss those buttons
   * down on the bar"*). This is the one slot that is already both.
   *
   * **It carried an `anchor` until 2026-09-20**, because the question used to arrive from two
   * places: a marked tool named its own button, and a locked slider's key named nothing and kept
   * the group it was in. The cover is the only way here now, so the anchor is its stamp and the
   * field would be one value written twice.
   */
  | { readonly kind: "review" };

/**
 * Nothing open, and the surface opens on the plain map.
 *
 * **It was the picker, unconditionally**, which was right only while `advanceTo` moved the GM off it
 * the moment a map turned out to be chosen. Deleting the advance on 2026-09-20 left the picker
 * showing on every map that had already been nominated — the drawer asking a question that had been
 * answered — and a room found it the same evening.
 *
 * **The picker is opened by the one case that needs it**: a load that finishes with no map, where
 * `mapSource` opens it because that is the only thing a GM can do anything about. It needs no guard
 * against stealing a drawer the GM opened in the meantime, unlike the advance it replaces, because
 * with no map every other opener in the strip is disabled — so the only drawer they could have
 * opened is the picker itself, and opening it twice is opening it once.
 */
let drawer: Drawer | null = null;

/** Whether the drawer is showing the layer switches. */
export function showingLayers(): boolean {
  return drawer?.kind === "layers";
}

/** Whether the drawer is showing the regenerate question. */
export function showingReview(): boolean {
  return drawer?.kind === "review";
}

/**
 * The `data-opens` stamp of the strip button this drawer belongs to.
 *
 * **A fact about the drawer, so it is computed here**, and the strip reads it to decide both what
 * to anchor and what to draw pressed. It lived in the strip's own `place`, which meant the two
 * questions were answered twice — and the anchoring one broke silently, twice in one afternoon,
 * each time by naming markup the other module owned.
 */
export function drawerAnchor(): string {
  if (!drawer) return "";
  switch (drawer.kind) {
    case "layers":
      return "layers";
    case "params":
      return `params:${drawer.step}`;
    case "tool":
      return `tool:${drawer.tool}`;
    case "review":
      return COVER_ANCHOR;
  }
}

/*
  The question opens and closes its own drawer.

  Subscribed rather than called, so the guard never has to know there is a drawer — it owns whether
  the question is up, and this file owns where a thing raised by a press is shown. The import runs
  one way, which is what keeps that true.
*/
onRegenerateReview(() => {
  if (reviewIsUp()) {
    drawer = { kind: "review" };
  } else if (showingReview()) {
    /*
      Answered, so the drawer closes.

      **It used to reopen what the anchor described**, on the argument that the GM pressed something
      to get here and a bare map would make answering feel like a dismissal. That held while the
      question came from a marked tool or a locked slider, both of which have a drawer behind them.
      The cover has none — it is a lid, not an opener — so there is nothing to go back to, and
      whichever way the question was answered the map is the thing to look at next: the walls have
      either just been rebuilt or just been kept.
    */
    drawer = null;
  }
  renderPanel();
});

/*
  The cover closes an ink-side drawer as it raises (user, 2026-09-20).

  **It is reachable**, by the one pair of controls that ignores everything else on the surface: undo
  and redo sit in the bar and are pressed with any drawer open, so redoing a wall edit while the Ink
  settings are on screen locks that side — leaving live sliders behind a lid that exists to be in
  front of them. One rule and no second cover, which was the alternative: a lid over the drawer as
  well, in a different box, placed by different arithmetic.

  **Only what the lid covers goes, and a review never does.** A review is neither a `params` nor a
  `tool` drawer, so it cannot match here — and closing the question the cover exists to ask would be
  the worst possible reading of "as it raises".

  Here rather than in the strip because this file owns what the drawer is showing, and the strip's
  `render` may not reach across and shut it: `renderPanel` announces, which is what redraws the
  strip, so closing from inside a render is a render inside a render.
*/
onStageChange(() => {
  if (!coverIsUp()) return;
  const covered =
    (drawer?.kind === "params" && stepIsInkSide(drawer.step)) ||
    (drawer?.kind === "tool" && toolIsInkSide(drawer.tool));
  if (!covered) return;
  drawer = null;
  renderPanel();
});

/**
 * Reaching for anything else answers the question with "keep".
 *
 * **Every opener goes through this**, because the review is the one drawer that owns something
 * outside itself: the marks on the map. A press that replaced it silently would leave those marks up
 * with nothing on screen able to take them down or act on them — a question still being asked after
 * its own answers have been thrown away.
 *
 * This is also what makes the header's claim true rather than aspirational: *wandering off and arming
 * some other tool is a perfectly good answer*.
 */
function leaveReview(): void {
  if (showingReview()) keepWallChanges();
}

/** Show the layer switches, or close the drawer if they are already showing. */
export function openLayersDrawer(): void {
  leaveReview();
  drawer = showingLayers() ? null : { kind: "layers" };
  renderPanel();
}

/** Which tool's controls the drawer is showing, if it is showing a tool's at all. */
export function currentToolDrawer(): string | null {
  return drawer?.kind === "tool" ? drawer.tool : null;
}

/**
 * Show one tool's own controls, or close the drawer if they are already showing.
 *
 * **Only tools that have controls call this.** A verb with nothing to show — Move, Draw, Erase,
 * Pan — leaves the drawer exactly as it found it, which is what lets a GM read the wall settings
 * while drawing walls. Taking the drawer away in order to say nothing would be worse than not
 * taking it.
 */
export function openToolDrawer(tool: string): void {
  leaveReview();
  drawer = currentToolDrawer() === tool ? null : { kind: "tool", tool };
  renderPanel();
}

/**
 * Put the drawer's top at a given y, in window coordinates.
 *
 * **The strip works this out, not this module.** The drawer sits level with the button that opened
 * it, and *where that button is* is a fact about the strip's own layout — the bands have rules
 * between them, groups carry different numbers of verbs, and a locked group still takes its row.
 *
 * It used to reach across and find the button itself, with a CSS selector naming markup another
 * module writes. That is a contract nothing typechecks, and it broke twice in one afternoon: once
 * when a class it named stopped existing, and once when it matched the armed verb instead of the
 * open group. Neither threw — the drawer just fell silently to the top of the window. Being *told* a
 * number cannot fail that way.
 *
 * Every drawer change reaches the strip already: `renderPanel` announces, the strip redraws, and it
 * sets this on the way past. So nothing here has to ask, and there is no second path to keep in step.
 */
export function setDrawerTop(top: number): void {
  document.getElementById("panel")?.style.setProperty("--drawer-top", `${Math.round(top)}px`);
}

/** Which group's settings the drawer is showing, if it is showing settings at all. */
export function currentPanel(): StepId | null {
  return drawer?.kind === "params" ? drawer.step : null;
}

/**
 * Show a group in the drawer, or close it with `null`.
 *
 * **Closing is a state the surface needs, not an accident.** On a surface whose whole job is
 * looking at a map, being unable to see the map plainly was the thing it most needed and did not
 * have — so pressing the open group's own button in the strip shuts the drawer and leaves the
 * canvas clear.
 */
export function openPanel(id: StepId | null): void {
  leaveReview();
  drawer = id === null ? null : { kind: "params", step: id };
  renderPanel();
}

/*
  `togglePanel` was here and is gone. Its one caller decides the toggle itself now, because the press
  that opens a group also puts the verb down, and it reads "is this already open" before anything
  moves. **`setTool` does not touch the drawer** — only `armTool`, a press on the strip, moves it.
*/

/**
 * Whether a step can be entered at all yet.
 *
 * **The map gate** (user, 2026-09-05): stage one goes Map, then Ink, then Walls, and *"finishing
 * displays the map and unlocks the rest"*. Until an image is loaded every step below Map is about a
 * picture that is not there — the ink of nothing, the walls of nothing — so they are disabled rather
 * than opened onto a blank canvas with sliders over it.
 *
 * Disabled rather than hidden, so the shape of what is coming is visible from the first frame — the
 * order is the cascade, and a cascade with its later half missing does not teach it. The strip
 * states the same gate on the same groups, because that is where the press lands.
 */
function locked(step: Step): boolean {
  return step.id !== "map" && !mapChosen();
}

/**
 * Anything a step draws in its body beyond the rows built from its parameters.
 *
 * Two places, because the two things that exist want opposite ends. The map picker and the colour
 * swatches are *what you look at first* in their steps; an action that writes to the scene belongs
 * after the controls that decide what it would write. One slot would have put "Stage these" above
 * the sliders that shape the thing being staged.
 */
const content = new Map<StepId, { readonly top?: Render; readonly bottom?: Render }>();

type Render = (body: HTMLElement) => void;

export function registerStepContent(
  id: StepId,
  render: Render,
  place: "top" | "bottom" = "top",
): void {
  content.set(id, { ...content.get(id), [place]: render });
}

/**
 * Whether a group has anything to open, which is what decides if it gets a button in the strip.
 *
 * **A group offered where its drawer would be empty is a control that lies**, which is this
 * surface's own rule about a press that does nothing. Walls is the case: its two amounts became
 * tools with drawers of their own and its one button became an act, so nothing is left to show and
 * its opener goes.
 *
 * Asked of the same three things the body draws — the ungrouped rows, the heading groups, and
 * whatever registered itself — rather than of `stepParameters`, which counts a tool group's
 * controls and would keep the opener for a drawer that draws none of them.
 */
export function stepHasDrawer(id: StepId): boolean {
  const step = STEPS.find((candidate) => candidate.id === id);
  if (!step) return false;
  const registered = content.get(id);
  return (
    ungroupedControls(step).length > 0 ||
    headingGroups(step).length > 0 ||
    registered?.top !== undefined ||
    registered?.bottom !== undefined
  );
}

/**
 * Anything drawn into the **pinned head**, which does not scroll and cannot be collapsed.
 *
 * ## Why a control lives here rather than in a step — user, 2026-09-09
 *
 * The rail body holds settings **about the map**: what counts as ink, how hard to straighten. The
 * head holds the state of **what is in your hand**: which tool, what a press does, how wide the
 * brush is, paint or erase. A control's home follows from which of those it is, not from which
 * heading it seems tidiest under — a brush width is not a property of the map.
 *
 * The argument was already made here for the tool *hint*, and stopped half way: the hint sits in the
 * head precisely because a tool's controls "may be collapsed while the tool is still in hand", and
 * then the controls themselves were left in the collapsible body. A room found it immediately —
 * they were reported missing, and turned out to be behind an expanded section, a selected tool and a
 * scroll to the bottom of it.
 *
 * **The cost, stated:** the head grows while a tool is armed, and that space comes off the
 * scrollable rail. On a short window the ink sliders are what get pushed down.
 *
 * Drawn from inside `renderPanel` rather than on its own, which is not a detail: `resetHints` clears
 * every readout painter on each rebuild, so a row built outside that pass would keep its element and
 * lose its painter — a slider whose number silently stops moving.
 */
const toolContent: Render[] = [];

/**
 * Register what the tool in hand draws, which the drawer shows in place of a group's controls.
 *
 * **Registered rather than imported**, because the module that draws it imports this one and a
 * direct call would be a cycle. One caller, and avoiding that cycle is the whole reason it exists.
 */
export function registerToolContent(render: Render): void {
  toolContent.push(render);
}

/*
  `advanceTo` was here and went on 2026-09-20, with the dimming that replaced it.

  It opened a group at start-up unless the GM had already chosen for themselves — in practice, the
  Ink parameters the moment a map loaded. **It was the only route to an open drawer that was not a
  press**, which is why it needed a guard against opening one under the cover, added that same
  morning and deleted with it.

  What replaces it is not another drawer: `subject.ts` lights the half of the map the document says
  is available, and opening nothing is the honest answer to *which controls does this GM want*,
  which start-up cannot know.

  **`touched` went with it**, and that is worth noticing rather than tidying past: it recorded
  whether the GM had opened a step themselves, and it existed so that start-up would not relocate
  somebody who had already chosen. Five presses wrote it and `advanceTo` was the only thing that
  ever read it, so once that went it was **write-only state** — five assignments keeping a variable
  nothing consults in step. That is the reachability question this project asks of every export,
  one scope down.
*/

/**
 * A step's rows, in declaration order, with its groups after them under their own headings.
 *
 * **Every stage is drawn here now.** It was stage one only while the panel still owned deriving; the
 * partition moving onto this canvas ended that, and the two appearance controls came with it because
 * what they describe is drawn here rather than only in the scene. Which stage a control belongs
 * to still decides what changing it destroys — that is the cascade, and `settingRows` reads it — but
 * it no longer decides which surface draws it.
 */
function stepBody(step: Step): HTMLElement {
  const body = document.createElement("div");
  body.className = "step-body";

  const blurb = document.createElement("p");
  blurb.className = "sub";
  blurb.innerHTML = step.blurb;
  body.append(blurb);

  content.get(step.id)?.top?.(body);

  for (const control of ungroupedControls(step)) {
    body.append(settingRow(control));
  }

  /*
    Sub-headings only. A group belonging to a **tool** is drawn by that step's picker instead, which
    shows it while the tool is in hand and hides it otherwise — so rendering it here as well would
    put two sliders on one setting.
  */
  for (const group of headingGroups(step)) {
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    const note = document.createElement("p");
    note.className = "sub";
    note.innerHTML = group.blurb;
    body.append(heading, note);
    for (const control of groupControls(group)) {
      body.append(settingRow(control));
    }
  }

  /*
    The bottom slot comes BEFORE Defaults, and that ordering was a real discoverability failure.

    It was the other way round until 2026-09-07, which put the Ink step's three tools — Suppress, Add
    ink and **Gaps** — underneath a button labelled *Defaults*. A reset button reads as the end of a
    section, so everything past it is furniture: a room went looking for the gap tool and reported
    *"I don't see a gap tool"* while all three buttons were on screen the whole time.

    Defaults belongs last on its own terms as well. It restores every control in the step, tool
    widths and gap numbers included, so it is a footer rather than a divider.
  */
  content.get(step.id)?.bottom?.(body);

  /*
    **Defaults follows what this body actually drew**, not what the step declares.

    It was `stepParameters(step.id).length > 0`, and Walls made that wrong: its two parameters are
    the Mend tool's, so they are drawn in *Mend's* drawer and never here — leaving a Defaults button
    in a drawer holding none of what it resets. A room called it orphaned (2026-09-21) and it was.

    The rows this body draws are the ungrouped controls plus the heading groups; a tool group's
    controls belong to the tool's own drawer, which draws its own. So the question is what is
    on screen here, and the answer is the same list the loop above walked.
  */
  if (ungroupedControls(step).length > 0 || headingGroups(step).length > 0) {
    body.append(defaultsButton(step));
  }

  return body;
}

/**
 * One step's way back.
 *
 * Deliberately **not disabled when the step is already at its defaults**, which is what the panel's
 * per-stage version did. That state went stale here the moment a slider moved, because the rows are
 * not rebuilt on every release — and a button that is sometimes wrong about whether it would do
 * anything is worse than one that always says what it did.
 */
function defaultsButton(step: Step): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip quiet";
  button.textContent = "Defaults";
  button.addEventListener("click", () => {
    if (isStepDefault(currentSettings(), step.id)) {
      say(`${step.title} is already at its defaults.`);
      return;
    }
    setSettings(resetStep(currentSettings(), step.id));
    recomputeFor(stepParameters(step.id));
    void persistSettings();
    // Wholesale, because every row in this step is now showing a value it does not hold.
    renderPanel();
    say(`${step.title} back to defaults.`);
  });

  const row = document.createElement("div");
  row.className = "step-actions";
  row.append(button);
  return row;
}

/**
 * Told whenever the open step changes, with whether it is now the open one.
 *
 * For work a step should only pay for while it is being looked at. Deriving the partition is the
 * case: it costs the better part of a second and is visible in exactly one step, so it runs on entry
 * rather than on every change everywhere.
 */
/*
  `onStepOpen` was here and is gone (review, 2026-09-14).

  It told one subscriber when one *named* group opened or closed, and it existed because several
  groups could be open at once — so "is Walls showing" could not be read off a single value and had
  to be tracked per group. With one drawer there is a single value, and `onStepChange` carries it.
  The one caller asks the question it actually has: is the group that draws the partition the one
  open.
*/

/**
 * Told which step is open, rather than whether one particular step is.
 *
 * `onStepOpen` is per step, which suits anything whose answer is independent of what the *other*
 * steps are doing — a derive that entering pays for, a watcher that stops watching. It is the wrong
 * shape when two steps share one piece of state, because the transition between them arrives as two
 * separate calls whose order is registration order rather than anything meaningful: an arrival can
 * be announced before the departure, and a listener acting on each in turn then closes the thing it
 * has just opened. That was a live defect while suppression and added ink were steps of their own.
 *
 * So a listener that owns something shared subscribes here and is told the *destination*, once.
 */
const stepListeners: ((step: StepId | null) => void)[] = [];

export function onStepChange(listener: (step: StepId | null) => void): void {
  stepListeners.push(listener);
}

/**
 * Tell the canvas what the expanded groups want.
 *
 * **The union, because several may be expanded.** Each group still declares the layers it is about,
 * and what changed is only that more than one can be asking at once — which is what a GM comparing
 * the ink against the rooms it produced is doing on purpose.
 *
 * **It no longer binds the drag.** That moved to the tool palette, and this is the seam that made
 * exclusivity necessary: while a heading chose the verb, two expanded headings were two meanings for
 * one press. With nothing expanded there are simply no layers, which stays a coherent state — the
 * map, and nothing of ours on top of it.
 */
/**
 * Every group the strip can open, **including View**.
 *
 * View was a persistent group rendered on its own below the rail and never entered, which was the
 * answer to a control describing a layer that two steps drew. Under the drawer there is nothing for
 * it to be persistent *against*: every group is one click away in the strip, so the thing that made
 * View special is now true of all of them.
 */
function panelSteps(): readonly Step[] {
  return STEPS;
}


function applyOpenStep(): void {
  /*
    **The drawer no longer decides what is drawn** (user, 2026-09-14). Layers were the open group's,
    which made the picture change as the GM moved around it — and the tool strip owns the proposal
    now, because the tool is the mode and a group is not. What is left here is telling whoever cares
    which group is showing.
  */
  for (const listener of stepListeners) listener(currentPanel());
  invalidate();
}

/**
 * Draw the panel.
 *
 * Repeatable, and repeated: built once from the defaults so the surface looks like itself from the
 * first frame, then rebuilt wholesale when the stored settings arrive. Wholesale rather than
 * patched, so there is no path by which a row keeps a value from the defaults it was first drawn
 * with — and the open step survives, because it is held here rather than in the markup.
 */
export function renderPanel(): void {
  // Cleared with the rows they belong to, or a rebuild would leave painters pointing at detached
  // elements and grow the list every time the settings arrive.
  resetHints();
  /*
    And the graph-derived slider tops with them, which is what makes them "measured when the tool
    opens": this runs on every header click, so opening a step re-measures and everything in between
    holds still. A top re-measured on every derive would chase the slider that caused the derive.
  */
  forgetGraphScale();

  const title = document.getElementById("mode-name");
  const body = document.getElementById("drawer-body");

  /*
    A locked group cannot be the open one.

    Checked here rather than at the press, because the lock can arrive *after* it was opened:
    nominating a different map drops the surface back to having no picture.
  */
  const opened = currentPanel();
  if (opened) {
    const step = panelSteps().find((candidate) => candidate.id === opened);
    if (step && locked(step)) drawer = { kind: "params", step: "map" };
  }

  const step = panelSteps().find((candidate) => candidate.id === currentPanel()) ?? null;
  const tool = TOOLS.find((choice) => choice.id === currentToolDrawer()) ?? null;

  if (title) {
    title.textContent = showingReview()
      ? "Rebuild these walls?"
      : showingLayers()
        ? "Show"
        : (step?.title ?? tool?.label ?? "");
  }

  /*
    **One slot, filled with exactly one thing.**

    It was four fixed children with three hidden, which was the pinned head's shape surviving into a
    drawer that shows one thing at a time — and it bit: `#layer-row` set a `display` of its own, which
    outranks the user agent's `[hidden]` rule, so the switches appeared inside every drawer with
    nothing to say why. Building only what is showing removes the question rather than answering it.

    Everything is built inside this pass, because `resetHints` above clears every readout painter on
    each rebuild: a row built outside it would keep its element and lose its painter, which is a
    slider whose number silently stops moving.
  */
  if (body) {
    body.replaceChildren();
    if (showingReview()) body.append(reviewBody());
    else if (step) body.append(stepBody(step));
    else if (tool) {
      const hint = document.createElement("p");
      hint.id = "tool-hint";
      hint.innerHTML = toolHint(tool.id);
      body.append(hint);
      const rows = document.createElement("div");
      rows.id = "tool-controls";
      body.append(rows);
      for (const render of toolContent) render(rows);
    } else if (showingLayers()) renderLayerRow(body);
  }

  document.getElementById("panel")?.classList.toggle("shut", drawer === null);

  applyOpenStep();
}
