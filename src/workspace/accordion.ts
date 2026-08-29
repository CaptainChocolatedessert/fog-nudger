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
 * The property the tab strip was chosen to guarantee is kept exactly: one open step, one set of
 * layers on the canvas, one meaning for a drag.
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
  STEPS,
  ungroupedControls,
  workspaceSteps,
  type Step,
  type StepId,
} from "../steps";
import { PARAMETER_STAGE } from "../settings";
import { resetHints, settingRow } from "./settingRows";
import { invalidate, setActiveLayers, setDrag } from "./shell";
import { renderSwatches } from "./view";

/**
 * Which step is open. Not stored in the scene: it is where the GM is looking, not a setting, and a
 * workspace that reopened in the step you left last session would be guessing.
 *
 * It starts at the first step — Map — because that is the only honest place to be before anything is
 * known about the scene, and the one step that can do something about there being no map.
 */
let open: StepId = workspaceSteps()[0]?.id ?? "ink";

/**
 * Whether the GM has opened a step themselves.
 *
 * Start-up may move them on once, from Map to Ink, when the scene turns out to already have a map
 * chosen — which is the common case, and where they were going anyway. After a deliberate click it
 * must never move again: a surface that relocates the GM because something finished loading is a
 * surface that takes the page away mid-sentence.
 */
let touched = false;

/** Anything a step draws in its body beyond the rows built from its parameters. */
const content = new Map<StepId, (body: HTMLElement) => void>();

export function registerStepContent(id: StepId, render: (body: HTMLElement) => void): void {
  content.set(id, render);
}

/** Move to a step, unless the GM has already chosen one. */
export function advanceTo(id: StepId): void {
  if (touched || open === id) return;
  open = id;
  renderPanel();
}

/**
 * A step's rows, in declaration order, with its groups after them under their own headings.
 *
 * Stage two and three's controls stay in the popover for now: this surface is stage one, and
 * `PARAMETER_STAGE` is the same declaration the cache invalidation reads, so the two cannot drift
 * apart. It is why the regions step has a declaration here but no section on screen yet.
 */
function stepBody(step: Step): HTMLElement {
  const body = document.createElement("div");
  body.className = "step-body";

  const blurb = document.createElement("p");
  blurb.className = "sub";
  blurb.innerHTML = step.blurb;
  body.append(blurb);

  content.get(step.id)?.(body);

  for (const control of ungroupedControls(step)) {
    if (PARAMETER_STAGE[control.name] !== "read") continue;
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
      if (PARAMETER_STAGE[control.name] !== "read") continue;
      body.append(settingRow(control));
    }
  }

  return body;
}

/** Tell the canvas what the open step wants. The one place a step's declaration becomes behaviour. */
function applyOpenStep(): void {
  const step = workspaceSteps().find((candidate) => candidate.id === open);
  if (!step) return;
  setActiveLayers(step.layers);
  setDrag(step.drag);
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
        open = step.id;
        touched = true;
        renderPanel();
      });

      section.append(header, stepBody(step));
      container.append(section);
    }
  }

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

    // The swatches sit above the rows, because the colour is the thing a GM reaches for first when
    // the ink is invisible against the map.
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    swatches.id = "swatches";
    view.append(swatches);
    renderSwatches();

    for (const control of ungroupedControls(persistent)) {
      if (PARAMETER_STAGE[control.name] !== "read") continue;
      view.append(settingRow(control));
    }
  }

  applyOpenStep();
}
