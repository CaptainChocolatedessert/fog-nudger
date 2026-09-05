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
  isStepDefault,
  resetStep,
  STEPS,
  stepParameters,
  ungroupedControls,
  workspaceSteps,
  type Step,
  type StepId,
} from "../steps";
import { recomputeFor, resetHints, settingRow } from "./settingRows";
import { currentSettings, persistSettings, setSettings } from "./settingsState";
import { invalidate, say, setActiveLayers, setDrag } from "./shell";

/**
 * Which step is open, or `null` for none.
 *
 * Not stored in the scene: it is where the GM is looking, not a setting, and a workspace that
 * reopened in the step you left last session would be guessing.
 *
 * It starts at the first step — Map — because that is the only honest place to be before anything is
 * known about the scene, and the one step that can do something about there being no map.
 *
 * **`null` became reachable 2026-09-05** (user): clicking an open header closes it. The accordion
 * was exclusive-open with no way to shut, so the whole map could never be seen without the controls
 * over part of it — and on a surface whose entire job is looking at a map, that is the one state it
 * could not reach. Nothing open means no layers and a plain pan, which is a coherent mode rather
 * than a gap: the map, and nothing of ours on top of it.
 */
let open: StepId | null = workspaceSteps()[0]?.id ?? null;

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
 * Move to a step, unless the GM has already chosen one.
 *
 * **`touched` covers closing as well as opening**, which is what stops start-up reopening a step the
 * GM has just shut. It is set by any header click, and a click that closes is still a choice about
 * where to be.
 */
export function advanceTo(id: StepId): void {
  if (touched || open === id) return;
  open = id;
  renderPanel();
}

/**
 * A step's rows, in declaration order, with its groups after them under their own headings.
 *
 * **Every stage is drawn here now.** It was stage one only while the panel still owned deriving; the
 * Regions step ended that, and the two appearance controls came with it because the partition they
 * describe is now drawn on this canvas rather than only in the scene. Which stage a control belongs
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

  for (const group of step.groups ?? []) {
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

  if (stepParameters(step.id).length > 0) body.append(defaultsButton(step));

  content.get(step.id)?.bottom?.(body);

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
 * separate calls whose order is registration order rather than anything meaningful: moving from one
 * painting step to the other can announce the arrival before the departure, and a listener acting on
 * each in turn then closes the mode it has just opened.
 *
 * So a listener that owns something shared subscribes here and is told the *destination*, once.
 */
const stepListeners: ((step: StepId | null) => void)[] = [];

export function onStepChange(listener: (step: StepId | null) => void): void {
  stepListeners.push(listener);
}

/**
 * Tell the canvas what the open step wants. The one place a step's declaration becomes behaviour.
 *
 * **With nothing open it says so rather than returning early**, which is the whole of what makes
 * closing a step safe. An early return would leave the last step's layers drawn and its drag bound,
 * so a closed accordion would show a mode the GM had just left and hand a brush every press with no
 * tool picker on screen to say so. Nothing open is no layers and a plain pan, told to everyone who
 * subscribes — which is also how a paint mode gets finished and its work saved.
 */
function applyOpenStep(): void {
  const step = workspaceSteps().find((candidate) => candidate.id === open);
  setActiveLayers(step?.layers ?? []);
  setDrag(step?.drag ?? "pan");
  for (const listener of openListeners) listener.changed(listener.id === open);
  for (const listener of stepListeners) listener(open);
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

  const container = document.getElementById("steps");
  if (container) {
    container.replaceChildren();
    for (const step of workspaceSteps()) {
      const section = document.createElement("section");
      section.className = "step";
      if (step.id === open) section.classList.add("open");

      const header = document.createElement("button");
      header.type = "button";
      header.className = "step-header";
      header.textContent = step.title;
      header.setAttribute("aria-expanded", String(step.id === open));
      header.addEventListener("click", () => {
        // Clicking the open one closes it. Exclusivity is unchanged — there is still never more than
        // one open — and what this adds is the state where there is none.
        open = open === step.id ? null : step.id;
        touched = true;
        renderPanel();
      });

      section.append(header, stepBody(step));
      container.append(section);
    }
  }

  // The persistent group is drawn whenever one is declared, and today it holds **no controls at
  // all**: every display parameter moved to the step that draws its layer, which is what emptied it.
  // So this renders a heading and a blurb over nothing. Left as it is on purpose — the group is
  // where a genuinely cross-step display control would go — and said here so the next reader does
  // not go looking for a control that failed to render.
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
  }

  applyOpenStep();
}
