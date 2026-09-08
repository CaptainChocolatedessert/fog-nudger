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
import { lastInkWidth, lastPixelsPerSquare, lastRasterWidth } from "../pipeline";
import {
  isSkeletonOnly,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readParameter,
  SETTING_LIMITS,
  writeParameter,
} from "../settings";
import type { SettingName } from "../settings";
import {
  formatValue,
  fromSlider,
  positionReadout,
  SLIDER_STEPS,
  toSlider,
  type Scale,
  type ScaleLimits,
} from "../sliderScale";
import { graphScaleTop, onGraphScale } from "./graphScale";
import { refreshBreakSearch } from "./paintTool";
import { requestReread } from "./reading";
import { invalidateRegions, repruneRegions } from "./regions";
import { currentSettings, persistSettings, setSettings } from "./settingsState";
import { invalidate, say, setPendingEdit } from "./shell";

/**
 * The track a control's slider runs over.
 *
 * The declared limits for all but two, whose top end is measured off the graph. Falling back to the
 * declared maximum when there is no measurement yet is deliberate: it is a real ceiling rather than
 * a guess, and the handle moves to where the measurement puts it the moment one arrives.
 */
function trackFor(name: SettingName): ScaleLimits {
  const declared: ScaleLimits = SETTING_LIMITS[name];
  const top = graphScaleTop(name);
  /*
    **Never above the declared ceiling**, and this was a real defect for a day.

    `fromSlider` clamps to the track's own maximum, so a measured top above `declared.max` hands back
    a value the settings normaliser will silently clamp the next time the scene is read — a stored
    setting rewritten with nothing announced, which is the worst thing a control can do and the whole
    reason the round-trip tests exist. Seen in a room on 2026-09-07: a graph whose largest bend
    measured 0.707 of the map against a ceiling of 0.5, and 0.707 was written.
  */
  return top === null ? declared : { ...declared, max: Math.min(top, declared.max) };
}

/**
 * The number beside the label.
 *
 * A control may ask to report **where its handle is** rather than what its value is, because three of
 * them store a fraction of the map and neither that nor any spelling of it is a number a GM can hold
 * on to. Everything else takes the shared formatter, which knows about steps and off positions and
 * should not be bypassed for taste.
 */
function format(
  control: Control,
  value: number,
  position: number,
  limits: ScaleLimits,
  scale: Scale,
): string {
  if (control.readout !== "position") return formatValue(value, limits, scale);
  // Off is a state rather than a place on the track, and it is the one thing about these controls
  // that a number would obscure rather than convey.
  if (value <= 0) return "off";
  return String(positionReadout(position));
}

function measured(): Measured {
  return {
    pxPerSquare: lastPixelsPerSquare(),
    inkWidth: lastInkWidth(),
    rasterWidth: lastRasterWidth(),
  };
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
 * Recompute whatever a set of changed parameters invalidates, and nothing else.
 *
 * Shared by a slider's release and a step's Defaults, so the two cannot disagree about what a change
 * costs. A reading covers the partition as well — the regions subscribe to it — so the two cases are
 * exclusive rather than cumulative.
 */
export function recomputeFor(names: readonly SettingName[]): void {
  /*
    A `tool` parameter recomputes nothing and tells its tool instead.

    That is the whole of the third kind's behaviour on this side. A brush width has no one to tell —
    the next stroke simply reads it — but the break search is holding a set of marks that the numbers
    it was run with have just stopped describing, and marks on screen that no longer match the
    settings beside them are the stale-diagnostic failure in miniature. Re-running is cheap by
    comparison with a re-read and is what the GM is asking for by moving the slider at all.
  */
  if (names.some((name) => PARAMETER_KIND[name] === "tool")) refreshBreakSearch();

  const pipeline = names.filter((name) => PARAMETER_KIND[name] === "pipeline");
  /*
    Graph-only first, and it is now a third thing rather than a cheaper second.

    `GRAPH_ONLY` has exactly one member, the spur budget. It used to mean "skip the 690ms re-read but
    re-derive everything", because pruning happened between thinning and chaining. **Pruning moved
    past the freeze on 2026-09-06**, so it changes nothing the trace did — the graph is already
    fitted and stored, and re-pruning it is a run walk and a face traversal, single-digit
    milliseconds against the better part of a second.

    The weld radius was the other member and was deleted rather than defaulted to zero, after 459 of
    600 generated cases failed at its default.
  */
  const rest = pipeline.filter((name) => !isSkeletonOnly(name));
  const graphChanged = pipeline.some(isSkeletonOnly);

  if (rest.some((name) => PARAMETER_STAGE[name] === "read")) requestReread();
  // Ordered so the broadest wins: a Defaults reset changes both kinds at once, and a full derive
  // re-prunes on its way through where a re-prune would leave the trace stale.
  else if (rest.length > 0) invalidateRegions();
  else if (graphChanged) repruneRegions();
  invalidate();
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
export function settingRow(control: Control): HTMLElement {
  const scale = control.scale ?? "linear";
  const value = readParameter(currentSettings(), control.name);
  /*
    The track, which for two controls is not the declared one.

    Their top end is measured off the graph — the longest spur, the largest bend — so `SETTING_LIMITS`
    supplies only the storage bounds and the pinned floor. `graphScale.ts` carries the reasoning; what
    matters here is that this is a `let`, because the measurement can arrive after the row is built
    and the handlers below have to see the new track when it does.
  */
  let limits = trackFor(control.name);

  const row = document.createElement("div");
  row.className = "row";

  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.textContent = control.label;
  label.htmlFor = `control-${control.name}`;
  const readout = document.createElement("span");
  readout.className = "value";
  readout.textContent = format(control, value, toSlider(value, limits, scale), limits, scale);
  top.append(label, readout);

  const input = document.createElement("input");
  input.type = "range";
  input.id = `control-${control.name}`;
  input.min = "0";
  input.max = String(SLIDER_STEPS);
  input.step = "1";
  input.value = String(toSlider(value, limits, scale));
  /*
    The position the stored value put the handle at, so a release that moved nothing writes nothing.

    Without it, letting go of a slider the GM only brushed rewrites the setting to whatever value
    that position happens to mean — which on the two graph-scaled tracks is *not* the stored value,
    because the top moves and no number can land on its own step under every top. It is worth having
    on every control regardless: a drag away and back is a change of nothing, and re-deriving for it
    is a second of a GM's time spent arriving where they already were.
  */
  let placed = Number(input.value);

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
    Reposition when the measurement lands, which is after the first derive of an opening.

    **The value does not move; the handle does.** That is the whole shape of the decision — the
    stored setting is an absolute tolerance, so a re-measured top can only change where on the track
    it sits. Registered through `graphScale` rather than through a subscription of this row's own, so
    the list is cleared with the rows it belongs to.
  */
  if (graphScaleTop(control.name) === null) {
    onGraphScale(() => {
      limits = trackFor(control.name);
      const current = readParameter(currentSettings(), control.name);
      placed = toSlider(current, limits, scale);
      input.value = String(placed);
      readout.textContent = format(control, current, placed, limits, scale);
      paintHint(current);
    });
  }

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
    readout.textContent = format(control, current, Number(input.value), limits, scale);
    paintHint(current);

    if (kind === "display" || kind === "tool") {
      /*
        Costs nothing but a repaint, so there is no reason to make the GM let go to see it.

        **`tool` joined `display` here on 2026-09-07**, and only for what a repaint shows. Held in
        memory and not persisted — the scene write still waits for the release, so one sweep is still
        one write. What it buys is the prune preview: the editor draws the walls a budget would delete
        in red, and a budget is not a number anybody can picture on their own map, so seeing it follow
        the drag is the difference between choosing one and guessing.

        What a tool *recomputes* still waits for the release. The break search re-runs from
        `recomputeFor`, because that costs a composite and a closing rather than a repaint.

        **`pipeline` must never join them.** Its re-read is 690ms and synchronous, which is 690ms the
        slider cannot move — tried live, reported unusable from a room, reverted.
      */
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
    const position = Number(input.value);
    if (position === placed) {
      // Nothing moved. Say so and stop, rather than writing a value the track happens to mean here
      // and paying for a recompute that would arrive at the same picture.
      setPendingEdit(false);
      say("");
      return;
    }
    placed = position;
    const current = fromSlider(position, limits, scale);
    setSettings(writeParameter(currentSettings(), control.name, current));
    setPendingEdit(false);

    recomputeFor([control.name]);
    void persistSettings();
  });

  /*
    **No frozen state here any more**, and its removal is what the two modes bought.

    Every `pipeline` and `tool` control used to dim itself once a graph was frozen, with a line
    saying where to reopen the reading. The reason was sound while one accordion carried both stages:
    moving a reading slider would have re-derived the very graph the GM had been editing, and §8
    wants a boundary visible *before* it is crossed rather than confirmed after.

    Split into two modes, that boundary is the page. The editor does not declare the steps these
    controls live in, so there is nothing to disable there; and in the ink mode nothing is frozen --
    the graph is a derivation until the GM saves, and the save is the one place the replacement is
    named and confirmed. A control that is live in the only mode that draws it needs no notice.
  */
  input.disabled = !live;

  row.append(top, input, hint);
  return row;
}
