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
  stepParameters,
  TOOLS,
  ungroupedControls,
  workspaceSteps,
  type Step,
  type StepId,
} from "../steps";
import { forgetGraphScale } from "./graphScale";
import { recomputeFor, resetHints, settingRow } from "./settingRows";
import { currentSettings, persistSettings, setSettings } from "./settingsState";
import { mapChosen } from "./mapSource";
import { invalidate, say } from "./shell";
import { proposeLayers } from "./layerToggles";
import { stepIsMarked, wallsNotice } from "./wallsMark";

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
  | { readonly kind: "tool"; readonly tool: string };

let drawer: Drawer | null = { kind: "params", step: workspaceSteps()[0]?.id ?? "map" };

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
  drawer = currentToolDrawer() === tool ? null : { kind: "tool", tool };
  touched = true;
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
  drawer = id === null ? null : { kind: "params", step: id };
  touched = true;
  renderPanel();
}

/*
  `togglePanel` was here and is gone. Its one caller decides the toggle itself now, because the press
  that opens a group also puts the verb down — and `setTool` clears the drawer on its way past, so a
  toggle that asked "is this already open" *after* that would always be told no and would never
  close. The caller reads the answer before anything moves.
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
 * Whether the GM has opened a step themselves.
 *
 * Start-up may move them on once, from Map to Ink, when the scene turns out to already have a map
 * chosen — which is the common case, and where they were going anyway. After a deliberate click it
 * must never move again: a surface that relocates the GM because something finished loading is a
 * surface that takes the page away mid-sentence.
 */
let touched = false;

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

/**
 * Open a group at start-up, unless the GM has already chosen for themselves.
 *
 * **`touched` covers closing as well as opening**, which is what stops start-up reopening a drawer
 * the GM has just shut. Any press in the strip sets it, and a press that closes is still a choice
 * about what to look at.
 *
 * It **replaces** what is showing rather than adding to it, which is the drawer's doing: there is
 * one slot, so moving the GM on from Map when a map turns out to be chosen is the whole of what this
 * can mean.
 */
export function advanceTo(id: StepId): void {
  if (touched || currentPanel() === id) return;
  drawer = { kind: "params", step: id };
  renderPanel();
}

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

  // Above everything the group holds, including its tool picker: it is about all of them.
  if (stepIsMarked(step.id)) body.append(wallsNotice());

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

  if (stepParameters(step.id).length > 0) body.append(defaultsButton(step));

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

/** The group a tool belongs to, which is the group whose layers it wants drawn. */
function bandOf(tool: string): StepId | null {
  const band = TOOLS.find((choice) => choice.id === tool)?.band;
  return band === undefined || band === "navigate" ? null : (band as StepId);
}

function applyOpenStep(): void {
  /*
    A tool's drawer proposes **its group's** layers rather than none.

    What a brush acts on is the same picture the group describes, so taking the layers away the
    moment the GM picked the brush up would blank the thing they are about to paint on. The tool also
    asks for its own layer in `apply`, and the two compose: the group proposes, the tool adds, and
    the GM's switches subtract.
  */
  const owner =
    drawer === null ? null : drawer.kind === "params" ? drawer.step : bandOf(drawer.tool);
  const step = panelSteps().find((candidate) => candidate.id === owner) ?? null;
  // Proposed rather than set: the GM's own toggles subtract from this, and a tool may add to it.
  proposeLayers([...(step?.layers ?? [])]);
  for (const listener of stepListeners) listener(step?.id ?? null);
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

  // The tool in hand, inside this pass so its rows get their painters from the same `resetHints`
  // above. Empty whenever nothing is in hand, and hidden below whenever a group has the drawer.
  const toolBody = document.getElementById("tool-controls");
  if (toolBody) {
    toolBody.replaceChildren();
    for (const render of toolContent) render(toolBody);
  }

  /*
    The drawer: the open group's body, and nothing else.

    The headers went to the strip, where they are the group's own button. A header here *and* a
    button there would be two handles on one piece of state, which is the shape of defect this
    project keeps finding; and the strip is where the GM already is, because it is where the verbs
    are.
  */
  const title = document.getElementById("mode-name");
  const container = document.getElementById("steps");
  const hint = document.getElementById("tool-hint");
  const toolRows = document.getElementById("tool-controls");

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

  if (title) title.textContent = step?.title ?? tool?.label ?? "";

  /*
    One of the two, never both.

    The drawer held a tool's controls *and* the open group's settings, which was the in-between state
    a room reported. What is in your hand and what decided the ink underneath it are different
    subjects, and showing them together meant neither got the drawer to itself.
  */
  if (container) {
    container.replaceChildren();
    if (step) container.append(stepBody(step));
    container.hidden = step === null;
  }
  if (hint) hint.hidden = tool === null;
  if (toolRows) toolRows.hidden = tool === null;

  document.getElementById("panel")?.classList.toggle("shut", drawer === null);

  applyOpenStep();
}
