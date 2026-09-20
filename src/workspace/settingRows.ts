/**
 * One slider, built from the shared control declaration.
 *
 * Every group with numbers to turn builds its rows here rather than each one growing its own,
 * because what a row *does* on release is a property of the parameter rather than of the group
 * drawing it — and a second implementation would be a second place for that to be decided
 * differently.
 *
 * **What a release costs is `recompute.ts`'s**, which is a separate question with separate callers:
 * a group's Defaults spends it too, and that is a button rather than a row.
 *
 * DOM, and the pipeline only for the measurements a readout reports against.
 */

import { type Control, type Measured } from "../controls";
import { lastPixelsPerSquare, lastRasterPerGraphUnit } from "../pipeline";
import {
  PARAMETER_KIND,
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
import { onInkProfiles, profileFor } from "./inkProfiles";
import { ghostPosition } from "./ghostMark";
import { recomputeFor } from "./recompute";
import {
  appliedSettings,
  controlsLive,
  currentSettings,
  persistSettings,
  setSettings,
} from "./settingsState";
import { invalidate, say, setPendingEdit } from "./shell";

/**
 * The track a control's slider runs over: its declared limits, and nothing else.
 *
 * **Two controls used to measure their top end off the graph**, and both stopped being settings on
 * 2026-09-18 — straightening and pruning are amounts pressed in the Walls drawer, which draws its own
 * tracks. What went with them is worth recording, because it was a real defect for a day: a measured
 * top had to be capped at the **declared ceiling**, since `fromSlider` clamps to the track's own
 * maximum and a higher one hands back a value the normaliser silently rewrites on the next read.
 * Seen in a room on 2026-09-07, where a largest bend of 0.707 was stored against a ceiling of 0.5.
 * Any future measured track has the same trap waiting.
 */
function trackFor(name: SettingName): ScaleLimits {
  return SETTING_LIMITS[name];
}

/**
 * The number beside the label.
 *
 * A control may ask to report **where its handle is** rather than what its value is, because two of
 * them store graph units and neither that nor any spelling of it is a number a GM can hold
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
  // A percentage of black-to-white, which is the only unit tone has that a GM can picture. One
  // decimal, because the step is half a percent and a whole number would make half the stops print
  // the same thing.
  if (control.readout === "percent") return `${(value * 100).toFixed(1)}%`;
  if (control.readout !== "position") return formatValue(value, limits, scale);
  // Off is a state rather than a place on the track, and it is the one thing about these controls
  // that a number would obscure rather than convey.
  if (value <= 0) return "off";
  return String(positionReadout(position));
}

/**
 * An empty shape, and the two paths that draw it.
 *
 * `preserveAspectRatio="none"` so the box stretches to whatever width the drawer is: the horizontal
 * axis **is** the track, and a shape that kept its aspect would put its bands somewhere other than
 * the stops they describe.
 */
function profileSvg(): { element: SVGSVGElement; fill: SVGPathElement; line: SVGPathElement } {
  const ns = "http://www.w3.org/2000/svg";
  const element = document.createElementNS(ns, "svg");
  element.setAttribute("class", "profile");
  element.setAttribute("viewBox", `0 0 ${PROFILE_WIDTH} ${PROFILE_HEIGHT}`);
  element.setAttribute("preserveAspectRatio", "none");
  element.setAttribute("aria-hidden", "true");
  const fill = document.createElementNS(ns, "path");
  fill.setAttribute("class", "profile-fill");
  const line = document.createElementNS(ns, "path");
  line.setAttribute("class", "profile-line");
  element.append(fill, line);
  return { element, fill, line };
}

/** The shape's own coordinate space. Stretched to the track, so these are proportions. */
const PROFILE_WIDTH = 100;
const PROFILE_HEIGHT = 20;

/**
 * Draw one control's distribution, or take it down.
 *
 * **It starts and ends on the rail**, which is honest either way round: at the far left nothing has
 * been removed, and past the last band there is nothing left to remove.
 */
function paintProfile(
  svg: { element: SVGSVGElement; fill: SVGPathElement; line: SVGPathElement },
  name: SettingName,
): void {
  const points = profileFor(name);
  // One point is a spike with no shape to it and no comparison to make, so it is not drawn.
  if (points.length < 2) {
    svg.element.classList.add("empty");
    return;
  }
  svg.element.classList.remove("empty");

  const steps = points.map(
    (point) =>
      `L${(point.at * PROFILE_WIDTH).toFixed(2)} ${((1 - point.ink) * PROFILE_HEIGHT).toFixed(2)}`,
  );
  const open = `M0 ${PROFILE_HEIGHT} ${steps.join(" ")} L${PROFILE_WIDTH} ${PROFILE_HEIGHT}`;
  svg.line.setAttribute("d", open);
  svg.fill.setAttribute("d", `${open} Z`);
}

/** Repainters for the rows on screen, cleared with them. */
const profilePainters: (() => void)[] = [];

function measured(): Measured {
  return {
    pxPerSquare: lastPixelsPerSquare(),
    rasterPerUnit: lastRasterPerGraphUnit(),
  };
}

/**
 * Repaint functions for the rows on screen: each row's derived readout, and each row's ghost.
 *
 * Several readouts report a setting against a **measurement** — the gap width and the brushes against
 * pixels per square, the two graph sliders against the raster — and before a first reading those
 * fall back to a shorter form. Without this they would stay in it until the row's own slider was
 * touched, which is a readout being quietly wrong about what it knows.
 *
 * **The ghosts joined on 2026-09-10**, because they have the same lifetime and the same problem.
 * They were each subscribed to the reading on build, and that list is never cleared, so every rebuild
 * of the rail stranded a row's worth of listeners on detached elements. Here they are reset with the
 * rows they belong to — and they are re-run whenever the picture catches up with any setting, not
 * only when a reading lands, which is what let a derive or a prune leave a ghost standing.
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
  profilePainters.length = 0;
}

/*
  Repaint every shape on screen when a new pair lands.

  Subscribed once at module load rather than per row, for `resetHints`' own reason: a subscription
  taken per row would outlive the row and grow the list on every rebuild. The painters list is what
  is cleared, and this only walks whatever is in it.
*/
onInkProfiles(() => {
  for (const painter of profilePainters) painter();
});


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
  /*
    **The per-row lock went on 2026-09-20**, with the rest of the per-control gate.

    A control that would rebuild the walls used to be locked here while they held hand edits: the
    slider inert, and a wall-graph mark beside its name acting as the key. The cover replaced it —
    every control that could be marked is on the ink side, so by the time one is at stake the whole
    drawer is behind a lid and this row cannot be reached to lock.

    One thing it knew is worth keeping wherever a lock is built again: the key was a **button**
    rather than a glyph on the row, because a disabled input cannot be tabbed to, and a lock with no
    key for one input method is a wall rather than a gate. The lid is a button for the same reason.
  */
  const name = document.createElement("span");
  name.className = "row-name";
  name.append(label);
  top.append(name, readout);

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
    /*
      Joined rather than interpolated, because most controls now have no hint at all.

      The old form put the readout after `control.hint` unconditionally, which on an empty hint left
      a leading space — enough to stop `:empty` matching, so the row kept a blank line where the
      stylesheet was trying to collapse one.
    */
    hint.innerHTML = [control.hint, derived && `<b>${derived}</b>`].filter(Boolean).join(" ");
  };
  paintHint(value);
  // Registered so a change to one control can refresh the readouts of the others.
  hintPainters.push(() => paintHint(fromSlider(Number(input.value), limits, scale)));

  /*
    The reposition-on-measurement subscription was here and went with the two graph-derived tracks on
    2026-09-18. It moved the *handle* when a measurement landed, never the value — the stored setting
    was an absolute tolerance, so a re-measured top could only change where on the track it sat.

    Kept as a shape rather than a fact: any control whose track is measured rather than declared needs
    this, and needs it registered through `graphScale` rather than through a subscription of its own,
    so the list is cleared with the rows it belongs to.
  */

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
        one write. What it buys is the prune preview: the editor draws the walls a limit would delete
        in red, and a limit is not a number anybody can picture on their own map, so seeing it follow
        the drag is the difference between choosing one and guessing.

        What a tool *recomputes* still waits for the release. The gap search re-runs from
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
    /*
      The one place the irreversibility is priced, and it is priced only when it costs something.

      A `read` change re-derives the graph, which replaces whatever the GM edited into it by hand.
      That used to be prevented by the modes: the ink controls simply were not on the same page as
      the editing tools. With one surface they are, so the guard has to be the *count* — and at zero,
      which is most of the time, nothing interrupts.
    */
    placed = position;
    /*
      Nothing is asked here any more.

      A control that would rebuild the walls is **locked** while they hold hand edits, so a release
      can only happen once the GM has already agreed — see `regenerateGuard.ts`. Asking on the
      release meant asking after the handle had moved, and declining then had to restore the input
      *and* this row's own idea of where it sat, or the next release would think nothing had changed
      and write the discarded value silently. That whole dance is gone with the question's timing.
    */
    const current = fromSlider(position, limits, scale);
    setSettings(writeParameter(currentSettings(), control.name, current));
    setPendingEdit(false);

    recomputeFor([control.name]);
    void persistSettings();
    showGhost();
  });

  /*
    **No saved state here any more**, and its removal is what the two modes bought.

    Every `pipeline` and `tool` control used to dim itself once a graph was saved, with a line
    saying where to reopen the reading. The reason was sound while one accordion carried both stages:
    moving a reading slider would have re-derived the very graph the GM had been editing, and §8
    wants a boundary visible *before* it is crossed rather than confirmed after.

    Split into two modes, that boundary is the page. The editor does not declare the steps these
    controls live in, so there is nothing to disable there; and in the ink mode nothing is saved --
    the graph is a derivation until the GM saves, and the save is the one place the replacement is
    named and confirmed. A control that is live in the only mode that draws it needs no notice.
  */
  input.disabled = !controlsLive();

  /*
    The track wraps the input so the ghost can be positioned against it.

    A wrapper rather than marking the input itself, because a range input's own track is not
    addressable from CSS in a way that works across browsers — and the mark has to sit at a
    *fraction* of the track, which needs a positioned box the same width.
  */
  const track = document.createElement("div");
  track.className = "track";
  const ghost = document.createElement("div");
  ghost.className = "ghost";
  ghost.hidden = true;

  /*
    The distribution, for the two controls that have one, drawn **first** so it sits under the rail.

    Its baseline is the rail's own centre line, which is what makes it read as a shape rising off the
    track rather than as a chart placed above one. The stylesheet pins it there; the drawing here only
    has to fill its box.
  */
  const profile = control.profile ? profileSvg() : null;
  if (profile) {
    track.classList.add("with-profile");
    track.append(profile.element);
    paintProfile(profile, control.name);
    // Repainted rather than rebuilt: a new reading replaces the shape, and the row it belongs to is
    // still the row on screen.
    profilePainters.push(() => paintProfile(profile, control.name));
  }
  track.append(input, ghost);

  /**
   * Show where the picture actually is, when that is not where the handle is.
   *
   * Hidden whenever they agree, which is the ordinary case — a permanent mark is one nobody reads.
   * **Whether** to show it is decided in `ghostMark.ts`, which carries the five faults a room found
   * behind "it jumps near the new value and never disappears"; this only draws.
   *
   * **Positioned where the thumb would sit**, not at a bare fraction of the track. A range input's
   * thumb does not travel the full width: its centre runs from half a thumb in from the left to half
   * a thumb in from the right. A mark at a plain percentage is off by up to half a thumb at either
   * end and right only in the middle — close enough for a hairline, and visibly wrong for a circle
   * the size of the thumb, which is what the room asked for so the handle could be put back on it.
   */
  const showGhost = (): void => {
    const at = ghostPosition({
      lags: PARAMETER_KIND[control.name] === "pipeline",
      applied: readParameter(appliedSettings(), control.name),
      current: readParameter(currentSettings(), control.name),
      handle: Number(input.value),
      placed,
      positionOf: (value) => toSlider(value, limits, scale),
    });
    ghost.hidden = at === null;
    if (at !== null) {
      ghost.style.left = `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${at / SLIDER_STEPS})`;
    }
  };

  input.addEventListener("input", showGhost);
  /*
    Re-asked through the row painters rather than a subscription of the row's own.

    It was `onReading(showGhost)`, and the reading's listener list is never cleared — so every
    rebuild of the rail left the old row's closure subscribed, holding a detached element, and added
    a new one beside it. The rail rebuilds on every accordion click and, since the tool strip began
    redrawing it, on every tool change. The painters are reset with the rows they belong to, and
    `onApplied` in the composition root re-runs them whenever the picture catches up with anything.
  */
  hintPainters.push(showGhost);
  /*
    `onGraphScale(showGhost)` stood here and went on 2026-09-18 with the graph-derived tracks.

    It repositioned the ghost when a measurement landed, because a moving track top moves every mark on
    it. No setting's track is measured any more — both that were are amounts in the Walls drawer, which
    draws its own — so a measurement changes nothing about a row, and a subscription that fires to
    recompute an unchanged position is the kind of thing a later reader has to disprove.
  */
  showGhost();

  row.append(top, track, hint);
  return row;
}
