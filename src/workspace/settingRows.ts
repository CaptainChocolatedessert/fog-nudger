/**
 * One slider, built from the shared control declaration.
 *
 * Every step that has numbers to turn builds its rows here rather than each one growing its own,
 * because what a row *does* on release is a property of the parameter rather than of the step
 * drawing it — and a second implementation would be a second place for that to be decided
 * differently.
 *
 * DOM, and the pipeline only for the measurements a readout reports against.
 */

import { type Control, type Measured } from "../controls";
import { lastInkWidth, lastPixelsPerSquare } from "../pipeline";
import {
  isSkeletonOnly,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readParameter,
  SETTING_LIMITS,
  writeParameter,
} from "../settings";
import type { SettingName } from "../settings";
import { formatValue, fromSlider, SLIDER_STEPS, toSlider } from "../sliderScale";
import { requestReread } from "./reading";
import { invalidateRegions } from "./regions";
import { invalidateSkeleton } from "./skeleton";
import { currentSettings, persistSettings, setSettings } from "./settingsState";
import { invalidate, say, setPendingEdit } from "./shell";

function measured(): Measured {
  return { pxPerSquare: lastPixelsPerSquare(), inkWidth: lastInkWidth() };
}

/**
 * One repaint function per row, so every derived readout can be refreshed when a reading lands.
 *
 * Several readouts report a setting against a **measurement** — the minimum stroke width against the
 * measured ink width, the break widths against pixels per square — and before a first trace those
 * say "trace once for a figure". Without this they would go on saying it until the row's own slider
 * was touched, which is a readout being quietly wrong about what it knows.
 *
 * It arrived for a different reason: the repair width was briefly a share of a separate marking
 * width, so moving one changed what the other's readout meant. That coupling is gone and this is
 * not — the measurement case was always the stronger one.
 */
let hintPainters: (() => void)[] = [];

export function refreshHints(): void {
  for (const paint of hintPainters) paint();
}

/**
 * Forget the painters, which the caller must do before rebuilding the rows.
 *
 * Cleared with the rows they belong to, or a rebuild would leave painters pointing at detached
 * elements and grow the list every time the settings arrive.
 */
export function resetHints(): void {
  hintPainters = [];
}

/**
 * Whether the controls may be touched yet.
 *
 * They are drawn from `DEFAULT_SETTINGS` at module load so the surface looks like itself from the
 * first frame rather than after an SDK round trip — but they are **disabled** until the stored
 * settings arrive, because a slider dragged in that window would be moving a default that is about
 * to be overwritten by the GM's own saved value. Rendering them only when the SDK answers was the
 * first version, and it is the same mistake the probe made three times: gating on Owlbear something
 * that does not depend on Owlbear.
 */
let live = false;

export function controlsLive(): boolean {
  return live;
}

export function setControlsLive(next: boolean): void {
  live = next;
}

/**
 * Build one slider.
 *
 * Two events, and the split is the point of using a slider. `input` fires continuously while
 * dragging and drives the readout and the derived figure. `change` fires once on release and is
 * what commits: writing mid-drag would put a hundred values through scene metadata to reach one.
 *
 * ## What release actually does depends on the kind, and nothing else
 *
 * Two behaviours, taken from `PARAMETER_KIND` — the one declaration that answers "what does
 * changing this recompute", and the same one the mask cache reads. An earlier version of this
 * decided by which *section* the control was drawn in, which conflated presentation with cost: a
 * control moved between headings for tidiness would have silently changed what it recomputed.
 *
 * - **pipeline** — recomputes something. Blanks what it invalidates, on release.
 * - **display** — free, so it applies live on `input` and blanks nothing.
 *
 * ## And *what* it recomputes is the stage, which is the cascade
 *
 * A reading parameter re-reads the map, about 690ms, and that invalidates the partition with
 * it. A deriving parameter leaves the mask alone and rebuilds the partition from it. Both facts
 * are already declared — the stage *is* the cascade, and the same declaration decides what a
 * cached mask may be reused for — so this reads them rather than keeping a third list of which
 * slider does what.
 */
/**
 * Recompute whatever a set of changed parameters invalidates, and nothing else.
 *
 * Shared by a slider's release and a step's Defaults, so the two cannot disagree about what a change
 * costs. A reading covers the partition as well — the regions subscribe to it — so the two cases are
 * exclusive rather than cumulative.
 */
export function recomputeFor(names: readonly SettingName[]): void {
  const pipeline = names.filter((name) => PARAMETER_KIND[name] === "pipeline");
  // Graph-only first: pruning a spur or welding a junction costs a branch walk and a face traversal
  // where a re-read costs 690ms and would produce an identical mask. `GRAPH_ONLY` is what makes that
  // safe.
  const rest = pipeline.filter((name) => !isSkeletonOnly(name));
  const graphChanged = pipeline.some(isSkeletonOnly);
  if (graphChanged) invalidateSkeleton();

  if (rest.some((name) => PARAMETER_STAGE[name] === "read")) requestReread();
  // A graph change now invalidates the partition as well, because the faces *are* the graph's
  // (step D). It did not have to before, when the skeleton was a view that emitted nothing — and
  // that is the whole of what step D changed here.
  else if (rest.length > 0 || graphChanged) invalidateRegions();
  invalidate();
}

export function settingRow(control: Control): HTMLElement {
  const limits = SETTING_LIMITS[control.name];
  const scale = control.scale ?? "linear";
  const value = readParameter(currentSettings(), control.name);

  const row = document.createElement("div");
  row.className = "row";

  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.textContent = control.label;
  label.htmlFor = `control-${control.name}`;
  const readout = document.createElement("span");
  readout.className = "value";
  readout.textContent = formatValue(value, limits, scale);
  top.append(label, readout);

  const input = document.createElement("input");
  input.type = "range";
  input.id = `control-${control.name}`;
  input.min = "0";
  input.max = String(SLIDER_STEPS);
  input.step = "1";
  input.value = String(toSlider(value, limits, scale));

  const hint = document.createElement("p");
  hint.className = "hint";
  const paintHint = (current: number): void => {
    // Measurements are read at paint time rather than captured when the row was built: the first
    // trace of a session lands after these exist, and a figure fixed here would go on reporting
    // "trace once for a figure" for the rest of the session.
    const derived = control.derive ? control.derive(current, measured()) : "";
    hint.innerHTML = derived ? `${control.hint} <b>${derived}</b>` : control.hint;
  };
  paintHint(value);
  // Registered so a change to one control can refresh the readouts of the others.
  hintPainters.push(() => paintHint(fromSlider(Number(input.value), limits, scale)));

  /*
    Re-reads on **release**, not while dragging — reverted 2026-08-23 after a room reported the
    sliders as unusable.

    Recomputing per drag frame was the intent, and the machinery for it is still here and still
    correct: `maskRequest.ts` blanks on change, keeps only the latest value, and drops any answer a
    newer one has superseded. What defeats it is that the re-read is *synchronous*, so the 690ms it
    takes is 690ms the slider itself cannot move. The cancel-and-retry can never fire, because the
    thing it would cancel is holding the thread that would cancel it. Making it live needs the work
    off the main thread, or cropped to the visible region — measured first, then chosen.

    So `input` moves only the readout and the hint, and `change` is what re-reads.
  */
  const kind = PARAMETER_KIND[control.name];

  input.addEventListener("input", () => {
    const current = fromSlider(Number(input.value), limits, scale);
    readout.textContent = formatValue(current, limits, scale);
    paintHint(current);

    if (kind === "display") {
      // Costs nothing but a repaint, so there is no reason to make the GM let go to see it.
      setSettings(writeParameter(currentSettings(), control.name, current));
      invalidate();
      return;
    }

    /*
      The mask **stays up** while the slider moves, and it is not stale in the sense the blanking
      rule is about. That rule guards against ink drawn for settings the GM has *applied* and moved
      past; this is ink for the last reading they applied, which is the thing they are dragging
      away from and therefore the thing worth seeing. Blanking here would mean adjusting blind,
      which is the complaint that produced this shape.

      What it must not do is look current, so the state line says the slider is ahead of the map.
    */
    setPendingEdit(true);
    say("slider moved — release to re-read", "working");
  });

  input.addEventListener("change", () => {
    const current = fromSlider(Number(input.value), limits, scale);
    setSettings(writeParameter(currentSettings(), control.name, current));
    setPendingEdit(false);

    recomputeFor([control.name]);
    void persistSettings();
  });

  input.disabled = !live;
  row.append(top, input, hint);
  return row;
}
