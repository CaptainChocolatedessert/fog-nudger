/**
 * The steps as an exclusive accordion, and the persistent View group under them.
 *
 * ## Why an accordion rather than a row of tabs — user, 2026-08-29
 *
 * The design record said tabs, on the argument that collapsing sections **imply two can be open at
 * once**, which would be a lie: you cannot paint suppression and place a door with the same gesture.
 * That objection is to a *non-exclusive* accordion. Enforce exclusivity and it evaporates, and two
 * advantages arrive with it:
 *
 * - **The ordering stays legible.** Every step's header is on screen in sequence, so where a step
 *   sits in the cascade is a shape rather than something to remember. A tab strip flattens the order
 *   into a row, and six tabs in a 22rem column would wrap or shrink to abbreviations.
 * - **A tall narrow column is what vertical stacking is good at.**
 *
 * The property the tab strip was chosen to guarantee is kept exactly: **at most** one open step, one
 * set of layers on the canvas, one meaning for a drag.
 *
 * ## Clicking the open header closes it — user, 2026-09-05
 *
 * "At most" rather than "exactly", which is the one thing an accordion can do that a tab strip
 * cannot. A tab strip has no closed state at all, and neither did this: some step was always open,
 * so its layers were always on the map and its controls always over part of it. On a surface whose
 * whole job is looking at a map, being unable to see the map plainly is the state it most needed and
 * did not have.
 *
 * Nothing open is a coherent mode rather than a gap: no layers, and a plain drag pans. Every listener
 * is told, which is also how a paint mode in progress is finished and written rather than abandoned.
 *
 * **The cost, stated rather than argued away:** an accordion header is a weaker "you are here" than
 * a selected tab, and a mis-click collapses what you were working in. The open header is styled
 * distinctly to answer the first; nothing answers the second except that reopening is one click.
 *
 * ## Everything is rendered, and the closed steps are hidden
 *
 * Rather than building only the open step. The rows of a closed step keep their hint painters, so a
 * reading that lands refreshes every readout rather than only the visible ones — and reopening a
 * step is a class change instead of a rebuild.
 */

import {
  groupControls,
  headingGroups,
  isStepDefault,
  resetStep,
  STEPS,
  stepParameters,
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

/**
 * Which groups are expanded. Several may be, and none is a legitimate state.
 *
 * Not stored in the scene: it is where the GM is looking, not a setting, and a workspace that
 * reopened where you left it last session would be guessing.
 *
 * **Exclusivity went when the tool palette took the drag** (user, 2026-09-08). It was never wanted
 * for its own sake — it was there because a step bound the gesture, so two open steps would have
 * been two meanings for one press. With the verb chosen elsewhere a heading decides nothing but what
 * is on screen, and forcing one closed to open another was making the commonest move in the whole
 * job expensive: look at the rooms, spot a merged one, go back to the ink, look again.
 *
 * It starts with the first group expanded, which is the only honest place to be before anything is
 * known about the scene, and the one that can do something about there being no map.
 */
const open = new Set<StepId>();
{
  const first = workspaceSteps()[0]?.id;
  if (first) open.add(first);
}

/**
 * Whether a step can be entered at all yet.
 *
 * **The map gate** (user, 2026-09-05): stage one goes Map, then Ink, then Walls, and *"finishing
 * displays the map and unlocks the rest"*. Until an image is loaded every step below Map is about a
 * picture that is not there — the ink of nothing, the walls of nothing — so they are disabled rather
 * than opened onto a blank canvas with sliders over it.
 *
 * Disabled rather than hidden, so the shape of what is coming is visible from the first frame. That
 * is the same choice the accordion makes everywhere: the order is the cascade, and a cascade with
 * its later half missing does not teach it.
 *
 * **Edit walls is behind the gate too, since the merge.** It used to be on a page with no gate at
 * all, and its own body still says when there is no *graph* — a different sentence from "choose a
 * map", and the one that belongs once there is a picture to edit against.
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
 * Expand a group at start-up, unless the GM has already chosen for themselves.
 *
 * **`touched` covers collapsing as well as expanding**, which is what stops start-up reopening a
 * group the GM has just shut. It is set by any header click, and a click that closes is still a
 * choice about what to look at.
 *
 * It only ever *adds*, now that several groups can be expanded: moving the GM on when a map turns
 * out to be chosen should not take away whatever else they were reading.
 */
export function advanceTo(id: StepId): void {
  if (touched || open.has(id)) return;
  open.add(id);
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
const openListeners: { readonly id: StepId; readonly changed: (open: boolean) => void }[] = [];

export function onStepOpen(id: StepId, changed: (open: boolean) => void): void {
  openListeners.push({ id, changed });
}

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
function applyOpenStep(): void {
  const steps = workspaceSteps().filter((step) => open.has(step.id));
  // Proposed rather than set: the GM's own toggles subtract from this, and a tool may add to it.
  proposeLayers([...new Set(steps.flatMap((step) => step.layers))]);
  for (const listener of openListeners) listener.changed(open.has(listener.id));
  for (const listener of stepListeners) listener(steps[steps.length - 1]?.id ?? null);
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

  const container = document.getElementById("steps");
  if (container) {
    container.replaceChildren();
    /*
      A locked step cannot be the open one.

      Checked here rather than at the click, because the lock can arrive *after* the step was opened:
      nominating a different map drops the surface back to having no picture. Leaving the GM inside a
      step that has just become unreachable would show its layers over nothing and leave its header
      unable to close it.
    */
    for (const step of workspaceSteps()) {
      if (locked(step)) open.delete(step.id);
    }

    for (const step of workspaceSteps()) {
      const shut = locked(step);
      const section = document.createElement("section");
      section.className = "step";
      if (open.has(step.id)) section.classList.add("open");
      if (shut) section.classList.add("locked");

      const header = document.createElement("button");
      header.type = "button";
      header.className = "step-header";
      header.textContent = step.title;
      header.disabled = shut;
      if (shut) header.title = "Choose a map first";
      header.setAttribute("aria-expanded", String(open.has(step.id)));
      header.addEventListener("click", () => {
        // A plain toggle. Nothing else closes, which is the point: reading the ink controls and the
        // wall controls at the same time is the ordinary case rather than a thing to pay for.
        if (open.has(step.id)) open.delete(step.id);
        else open.add(step.id);
        touched = true;
        renderPanel();
      });

      section.append(header, stepBody(step));
      container.append(section);
    }
  }

  /*
    The persistent group, which is drawn whenever one is declared and is no longer empty.

    It held nothing between 2026-08-29 and the dissolving of the Regions step: every display
    parameter had moved to the step that draws its layer, and this rendered a heading over nothing.
    What refilled it is the partition acquiring a *second* step that draws it — the rule "a display
    control lives with its layer" cannot name one step when two show the same thing, and the group
    that is never entered is the answer rather than a tie-break between them.

    It gets a Defaults of its own for the same reason every step with controls does. It is the one
    place that rule could have been missed, because for a while there was nothing here to reset.
  */
  const view = document.getElementById("view-group");
  const persistent = STEPS.find((step) => step.persistent);
  if (view && persistent) {
    view.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = persistent.title;
    const blurb = document.createElement("p");
    blurb.className = "sub";
    blurb.innerHTML = persistent.blurb;
    view.append(heading, blurb);

    content.get(persistent.id)?.top?.(view);

    for (const control of ungroupedControls(persistent)) {
      view.append(settingRow(control));
    }

    /*
      The bottom slot, which this used to drop on the floor.

      Only the top one was rendered, so `registerStepContent("view", …, "bottom")` registered content
      nothing ever drew — silently, because a slot that is never read looks exactly like a slot with
      nothing in it. The step bodies have always honoured both.

      Before Defaults, for the reason the step bodies put it there: Defaults restores everything above
      it, so it is a footer rather than a divider, and content past it reads as furniture. A room
      found that once already, when the ink tools were rendered after it and a GM reported not being
      able to find them.
    */
    content.get(persistent.id)?.bottom?.(view);

    if (stepParameters(persistent.id).length > 0) view.append(defaultsButton(persistent));
  }

  applyOpenStep();
}
