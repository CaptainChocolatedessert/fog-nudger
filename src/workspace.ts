/**
 * Stage one: reading the map, on a surface that owns itself.
 *
 * ## What this replaces, and why it is smaller than what it replaces
 *
 * The click-through ink overlay was transparent so that drags reached Owlbear, which meant it could
 * never know where the map was except by asking — a 40ms poll of two world points, a settle
 * interval, a blank-and-restore so it was never present-and-wrong, a reserved band down one side so
 * it did not paint over the popover, and a heartbeat from the popover so it knew when to reserve
 * one. Every one of those was machinery for not owning the transform (`DESIGN.md` §4).
 *
 * This surface draws the map itself. Map and mask go into one canvas under one transform, so they
 * agree **by construction** rather than by our arithmetic agreeing with Owlbear's, and a whole class
 * of registration failure stops existing. None of the machinery above is here.
 *
 * ## What it draws
 *
 * The map, and the **binary** ink mask over it. Ink or not ink, and nothing else — not a tri-state
 * including discarded floor, because "discarded" is a *smallest-room* verdict and the three-stage
 * split put that control in stage two. Drawing it here would put a stage-two outcome on a
 * stage-one surface and break the property that makes the split worth having.
 *
 * ## Blank rather than stale, and on release rather than live
 *
 * A stage-one control changes the mask and a mask costs about 690ms. Whenever the mask in hand is
 * not the mask for the settings that have been **applied**, nothing is painted: ink drawn for
 * settings the GM has moved past does not lag, it lies, and comparing ink against linework is the
 * whole of stage one. `maskRequest.ts` carries that rule and its tests.
 *
 * The re-read happens on **release**, not per drag frame — tried live, reported unusable from a
 * room, reverted 2026-08-23. The coalescing was never the problem and is still here: it blanks on
 * change, keeps only the latest value, and drops any answer a newer one supersedes. What defeats a
 * live drag is that the re-read is *synchronous*, so its 690ms is 690ms the slider cannot move, and
 * the cancel-and-retry can never fire because the work it would cancel holds the thread that would
 * cancel it. Live needs the work off the main thread or cropped to the visible region — measure
 * first, then choose.
 *
 * While a slider is moving the mask **stays up**, and that is not a violation of the rule above: it
 * is the last reading the GM *applied*, which is the thing they are dragging away from and so the
 * thing worth seeing. Blanking there would mean adjusting blind, which is the complaint that
 * produced this shape. The state line says the slider is ahead of the map.
 *
 * ## Getting out
 *
 * Escape, and a button that stays visible when the controls are hidden. **No dismissal timer**: the
 * probe had one because an opaque sheet that might swallow every click is a trap, and that risk was
 * real while input capture was unmeasured. Fifteen runs later it is measured, and a working surface
 * that evicts a GM mid-tuning would trade a certain cost against a retired risk.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { CONTROLS, type Control, type Measured } from "./controls";
import { lastInkWidth, lastPixelsPerSquare, maskForOverlay } from "./pipeline";
import { resolveTraceMap } from "./map/mapImage";
import { readSettings, writeSettings } from "./settingsStore";
import type { GapFinding, GapMark } from "./trace/gaps";
import {
  DEFAULT_SETTINGS,
  PARAMETER_KIND,
  PARAMETER_STAGE,
  readParameter,
  SETTING_LIMITS,
  writeParameter,
  normaliseColour,
  type Settings,
} from "./settings";
import { formatValue, fromSlider, SLIDER_STEPS, toSlider } from "./sliderScale";
import { paintGaps, paintMask, parseColour } from "./overlay/maskImage";
import { WORKSPACE_ID } from "./workspace/workspaceControl";
import { MaskRequests, shouldPaint } from "./workspace/maskRequest";
import {
  classifyWheel,
  fitToViewport,
  panBy,
  pinchFactor,
  viewFromScreenRect,
  wheelFactor,
  zoomAbout,
  type View,
} from "./probe/viewTransform";

installDevLog("workspace");

/**
 * The navigation constants, settled by the probe in a room (`DESIGN.md` §4).
 *
 * A mouse notch is discrete and its magnitude is a number the browser chose arbitrarily, so only
 * its sign is used. A pinch is continuous, delivered as a stream of small events, and its magnitude
 * is the fingers actually moving — applying a whole notch to each of those was what made trackpad
 * zoom unusable.
 */
const ZOOM_STEP_PERCENT = 12;
const PINCH_SENSITIVITY = 1;

/**
 * Preset overlay colours.
 *
 * A spread of hues plus both extremes of neutral, because the only thing that makes a colour good
 * here is contrast against a particular map — red vanishes on red stonework and shouts on a grey
 * plan, and only the GM can see which they have. Six is enough to find something workable on any
 * map in one click, with the picker there for the rest.
 */
const INK_SWATCHES: readonly { readonly value: string; readonly name: string }[] = [
  { value: "#ff2020", name: "Red" },
  { value: "#ff20d0", name: "Magenta" },
  { value: "#00c8ff", name: "Cyan" },
  { value: "#ffd000", name: "Yellow" },
  { value: "#00e070", name: "Green" },
  { value: "#ffffff", name: "White" },
  { value: "#000000", name: "Black" },
];

/**
 * The colour a repaired break is drawn in — and it is the only ink on this surface the map does not
 * contain.
 *
 * `DESIGN.md` §8 requires that invented ink never be indistinguishable from read ink, and this is
 * that rule met: a different colour from the ink, drawn at full alpha on its own layer, with a ring
 * round it. A GM who has tinted the ink down to look at the linework underneath has not also turned
 * the repair down.
 *
 * There were briefly two colours — purple for a break found, green for one repaired — when finding
 * and repairing were separate controls. With one control everything found is repaired, so there is
 * one state and one colour. The **second** colour survives only for the one case that is genuinely
 * different: a break the search could not finish examining is ringed and *not* filled, so it shows
 * as an empty ring. Marking on a guess is a warning; inventing ink on a guess is not.
 *
 * **Fixed rather than a swatch row**, unlike the ink colour, and the reason the ink colour is
 * adjustable applies here too: no colour is readable on every map. The ring is what carries the
 * identification when a colour collides — drawn dark-then-bright over the same path, so it reads
 * against anything underneath, and it is a shape nothing on a map looks like. If a room reports the
 * marks vanishing into the paper anyway, a picker is the answer.
 *
 * Kept in step with the `.gap-key` colour in the page's own stylesheet by hand.
 */
const GAP_COLOUR = "#a855f7";

/**
 * The ring is drawn in **screen** pixels, which is the whole point of it.
 *
 * A break is a handful of raster pixels. With a whole map on screen those pixels are smaller than
 * one screen pixel, so a mark that scaled with the view would be invisible in exactly the situation
 * it exists for — a GM scanning the map for something they do not already know about. It grows to
 * enclose the break once the view is zoomed in past the ring's own size.
 */
const RING_MIN_RADIUS = 11;
const RING_PADDING = 6;

const surface = document.getElementById("surface");
const canvas = document.getElementById("canvas");
const panel = document.getElementById("panel");
const stateLine = document.getElementById("state");
const mapNameLine = document.getElementById("map-name");

let settings: Settings = DEFAULT_SETTINGS;
let view: View = { scale: 1, x: 0, y: 0 };
let mapImage: HTMLImageElement | null = null;

/** A mask rasterised into RGBA once, so a view change is a `drawImage` rather than a repaint. */
interface Layer {
  readonly canvas: HTMLCanvasElement;
  readonly buffer: Uint8ClampedArray<ArrayBuffer>;
}

let painted: Layer | null = null;

/**
 * The breaks, on their own layer.
 *
 * Separate from the ink rather than mixed into it, for two reasons that will both matter more
 * later. It is drawn at full alpha whatever the ink opacity is set to, so a GM who has tinted the
 * ink down to look at the linework underneath has not also turned the warning down. And invented
 * pixels must never be indistinguishable from read ones — which is a `DESIGN.md` §8 rule about the
 * bridging control that has not been built yet, satisfied here before the control that needs it
 * exists rather than bolted on afterwards.
 *
 * The cost is a second full-resolution RGBA buffer, about 34MB on this project's test map. It is
 * allocated only when there is something to draw in it.
 */
let paintedGaps: Layer | null = null;
let gapMarks: readonly GapMark[] = [];

const requests = new MaskRequests();
let inFlight = false;
let dirty = true;
let closing = false;

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function draw(): void {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const { width, height } = viewportSize();
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#0e1020";
  context.fillRect(0, 0, width, height);
  if (!mapImage) return;

  /*
    Smoothing off above 1:1.

    Zoomed past one screen pixel per image pixel, the GM is looking at individual ink pixels — which
    is a thing this surface exists for — and an interpolated blur there is the browser inventing
    detail the trace never saw. Below 1:1 smoothing is what keeps thin linework from vanishing
    between samples.
  */
  context.imageSmoothingEnabled = view.scale < 1;

  const drawWidth = mapImage.naturalWidth * view.scale;
  const drawHeight = mapImage.naturalHeight * view.scale;
  context.drawImage(mapImage, view.x, view.y, drawWidth, drawHeight);

  // The mask, in the same call shape and therefore in the same place. This is the registration
  // argument in one line: there is no second transform to get wrong.
  const showing = shouldPaint(requests.current());
  if (painted && showing) {
    context.globalAlpha = settings.overlay.inkOpacity;
    context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
    context.globalAlpha = 1;
  }

  // The breaks, over the ink and at full alpha — so a GM who has tinted the ink down to look at the
  // linework underneath has not also turned the warning down. They come from the same reading as the
  // ink, so the mask's own freshness gate covers them.
  if (paintedGaps && showing) {
    context.drawImage(paintedGaps.canvas, view.x, view.y, drawWidth, drawHeight);
    drawGapRings(context, width, height);
  }
}

/**
 * A ring round each break, in screen space.
 *
 * Two strokes over one path — a dark halo, then the gap colour inside it — so the ring reads
 * against pale paper and dark stonework alike without anyone choosing a colour for the map in hand.
 *
 * Culled against the viewport, which is what keeps this cheap when zoomed in. Zoomed out every ring
 * is on screen at once, and a map with hundreds of breaks pays for all of them every frame; that is
 * the case to watch if the surface ever feels heavy, and it is also a map telling the GM something.
 */
function drawGapRings(context: CanvasRenderingContext2D, viewWidth: number, viewHeight: number): void {
  for (const mark of gapMarks) {
    const cx = view.x + mark.x * view.scale;
    const cy = view.y + mark.y * view.scale;
    const radius = Math.max(RING_MIN_RADIUS, (mark.span * view.scale) / 2 + RING_PADDING);
    if (cx + radius < 0 || cy + radius < 0 || cx - radius > viewWidth || cy - radius > viewHeight) {
      continue;
    }

    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.lineWidth = 4;
    context.strokeStyle = "rgba(6, 4, 12, 0.7)";
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = GAP_COLOUR;
    context.stroke();
  }
}

function frameLoop(): void {
  if (closing) return;
  if (dirty) {
    dirty = false;
    draw();
  }
  window.requestAnimationFrame(frameLoop);
}

function setView(next: View): void {
  view = next;
  dirty = true;
}

// ---------------------------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------------------------

function say(text: string, tone: "" | "working" | "bad" = ""): void {
  if (!stateLine) return;
  stateLine.textContent = text;
  stateLine.className = tone;
}

/**
 * Report a finished reading, unless a slider has since been picked up.
 *
 * The race is real and reachable on the first open: a mask started at load can land while a slider
 * is already being dragged, and the plain success message would replace "release to re-read" with
 * "ink 7.2%" — announcing as current a figure for a value the GM is in the middle of moving away
 * from. The pending message wins, because it is the one that is still true.
 */
function sayIfSettled(text: string, tone: "" | "working" | "bad" = ""): void {
  if (pendingEdit) return;
  say(text, tone);
}

/**
 * Rasterise the mask into an offscreen canvas at the map's own resolution.
 *
 * Once per mask, not once per frame: every subsequent view change is a `drawImage` with a different
 * transform, which the probe measured at a tenth of a millisecond.
 */
function rasterise(
  mask: Parameters<typeof paintMask>[0],
  colour: string,
  reusing: Layer | null,
): Layer | null {
  const rgb = parseColour(colour) ?? parseColour(DEFAULT_SETTINGS.overlay.inkColour);
  if (!rgb) return null;

  const buffer = paintMask(mask, rgb, reusing?.buffer);
  const target = reusing?.canvas ?? document.createElement("canvas");
  target.width = mask.width;
  target.height = mask.height;
  const context = target.getContext("2d");
  if (!context) return null;

  context.putImageData(new ImageData(buffer, mask.width, mask.height), 0, 0);
  return { canvas: target, buffer };
}

/**
 * Ask for a mask for the settings as they now are, and paint it if it is still wanted when it lands.
 *
 * **Nothing queues.** A request made while one is in flight only bumps the generation; the reply
 * that eventually arrives is checked against the latest stamp and dropped if it has been
 * superseded, and then this runs again for whatever is current. A queue would work through every
 * intermediate position of a drag to reach somewhere the GM left seconds ago.
 */
async function refreshMask(): Promise<void> {
  if (inFlight || closing) return;

  // Whatever is outstanding, not a new stamp: the caller already registered the change, and asking
  // again here would blank the sheet a second time for the same edit.
  const generation = requests.latest();
  inFlight = true;
  dirty = true;
  say("reading the map…", "working");

  const wanted = { ...settings };
  try {
    const result = await maskForOverlay(wanted);
    if (closing) return;

    if (!result) {
      if (requests.fail(generation)) say("no map nominated — choose one in the panel", "bad");
      return;
    }

    if (!requests.fulfil(generation)) {
      // Superseded while it computed. The sheet is already blank for the newer generation, so
      // there is nothing to undo — only something not to draw.
      devLog("info", `workspace: mask ${generation} superseded before it landed`);
      return;
    }

    // Kept before rasterising, so a later colour change repaints *this* mask rather than whichever
    // one happened to be current when the workspace opened.
    lastMask = result.mask;
    const layer = rasterise(result.mask, wanted.overlay.inkColour, painted);
    if (!layer) {
      requests.fail(generation);
      say("could not allocate the mask image", "bad");
      return;
    }
    painted = layer;

    lastInkShare = shareOfInk(result.mask);
    lastReused = result.reused;
    paintBreaks(result.gaps);
    gapTotal = result.gaps.marks.length;
    gapFilled = result.gaps.filled;
    sayReading();
    // The measurements a readout reports against only exist once a reading has landed.
    refreshHints();
    devLog(
      "info",
      `workspace: mask ${generation} painted for "${result.mapName}" — ` +
        `${result.mask.width}x${result.mask.height}, ink ${(lastInkShare * 100).toFixed(1)}%, ` +
        `${gapTotal} breaks of which ${gapFilled} repaired, ` +
        `${
          result.reused
            ? "reused whole"
            : result.readingReused
              ? "reading reused, ink recomposed"
              : "read from the map"
        }`,
    );
  } catch (error) {
    if (requests.fail(generation)) {
      const detail = describeError(error);
      say(`reading failed: ${detail}`, "bad");
      devLog("error", "workspace: reading the map failed", detail);
      console.error("Fog Nudger — workspace could not read the map", error);
    }
  } finally {
    inFlight = false;
    dirty = true;
    // Anything that arrived while this was running is now the current generation, and nothing has
    // been computed for it. Run again rather than leaving the sheet blank with no work in flight.
    if (!closing && requests.waiting()) void refreshMask();
  }
}

function shareOfInk(mask: { data: Uint8Array; width: number; height: number }): number {
  let ink = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) ink += 1;
  return mask.data.length === 0 ? 0 : ink / mask.data.length;
}

/** The last reading's headline figures, so the two paths that report them cannot word it differently. */
let lastInkShare: number | null = null;
let lastReused = false;
/** How many breaks the last reading found, and how many of them it repaired. */
let gapTotal = 0;
let gapFilled = 0;

function sayReading(): void {
  if (lastInkShare === null) return;
  const ink = `ink ${(lastInkShare * 100).toFixed(1)}%${lastReused ? " (cached)" : ""}`;
  if (gapTotal === 0) {
    sayIfSettled(ink);
    return;
  }
  /*
    Reported in the neutral tone, not as an error.

    A found break is a finding rather than a fault — most maps will have a few, and a status line
    that is permanently red is a status line nobody reads, which is the failure §8 is about. The
    rings are the channel that has to be noticed; this is the count that tells a GM whether the
    ones they can see are all of them.

    The count is deliberately not offered as a tally of distinct faults. Channels merge as the
    repair width grows, so it moves around for reasons that have nothing to do with the map getting
    better or worse — which is the fact that collapsed the two-slider design.
  */
  const breaks = gapTotal === 1 ? "1 break" : `${gapTotal} breaks`;
  const unrepaired = gapTotal - gapFilled;
  sayIfSettled(
    unrepaired > 0
      ? `${ink} · ${breaks} repaired, ${unrepaired} not examined`
      : `${ink} · ${breaks} repaired`,
  );
}

// ---------------------------------------------------------------------------------------------
// The breaks
// ---------------------------------------------------------------------------------------------

/**
 * Paint the breaks that arrived with the mask.
 *
 * **The search itself is not here any more.** It moved into the pipeline the moment the fill became
 * real: the fill invents ink that the regions are derived from, so the search and the repair have to
 * be the same computation that produces the mask, not a second copy of it living on a surface. This
 * side now only draws what it was handed, which is the shape the rest of stage one already has.
 *
 * The layer is allocated lazily. A map with no breaks — or a GM who has turned the marks off — does
 * not pay for a second full-resolution RGBA buffer, which is about 34MB on this project's test map.
 */
function paintBreaks(gaps: GapFinding): void {
  gapMarks = gaps.marks;
  if (gaps.marks.length === 0) {
    // Cleared rather than left stale. A repaint that kept the previous reading's layer would draw
    // breaks the current settings do not have, which is the blanking rule one derivation down.
    paintedGaps = null;
    return;
  }

  const colour = parseColour(GAP_COLOUR);
  if (!colour) return;

  // Both states get the same colour: an unrepaired break has no pixels to paint, only a ring.
  const buffer = paintGaps(gaps.labels, colour, colour, paintedGaps?.buffer);
  const target = paintedGaps?.canvas ?? document.createElement("canvas");
  target.width = gaps.labels.width;
  target.height = gaps.labels.height;
  const context = target.getContext("2d");
  if (!context) {
    paintedGaps = null;
    devLog("error", "workspace: could not allocate the break overlay");
    return;
  }

  context.putImageData(new ImageData(buffer, gaps.labels.width, gaps.labels.height), 0, 0);
  paintedGaps = { canvas: target, buffer };
}

// ---------------------------------------------------------------------------------------------
// The controls
// ---------------------------------------------------------------------------------------------

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

function refreshHints(): void {
  for (const paint of hintPainters) paint();
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
 * Three behaviours, taken from `PARAMETER_KIND` — the one declaration that answers "what does
 * changing this recompute", and the same one the mask cache reads. An earlier version of this
 * decided by which *section* the control was drawn in, which conflated presentation with cost: a
 * control moved between headings for tidiness would have silently changed what it recomputed.
 *
 * - **pipeline** — re-reads the map, about 690ms. Blanks the sheet on release.
 * - **gaps** — re-derives the breaks from the mask in hand, about half that. Blanks the marks.
 * - **display** — free, so it applies live on `input` and blanks nothing.
 */
function settingRow(control: Control): HTMLElement {
  const limits = SETTING_LIMITS[control.name];
  const scale = control.scale ?? "linear";
  const value = readParameter(settings, control.name);

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
      settings = writeParameter(settings, control.name, current);
      dirty = true;
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
    pendingEdit = true;
    say("slider moved — release to re-read", "working");
  });

  input.addEventListener("change", () => {
    const current = fromSlider(Number(input.value), limits, scale);
    settings = writeParameter(settings, control.name, current);
    pendingEdit = false;

    if (kind === "pipeline") {
      // Blank now, at the moment the change is applied, rather than when the recomputation starts:
      // the gap between the two is a window in which the old mask sits under the new settings.
      requests.request();
      dirty = true;
      void refreshMask();
    }
    void persist();
  });

  input.disabled = !controlsLive;
  row.append(top, input, hint);
  return row;
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
let controlsLive = false;

/**
 * Whether a slider is mid-drag with its value not yet applied.
 *
 * The mask on screen is the last *applied* reading, which is worth keeping visible — but it must
 * not be mistaken for the value the slider is now showing. This is what the state line reads to say
 * so, and what stops a repaint from quietly overwriting that message.
 */
let pendingEdit = false;

function renderControls(): void {
  // Cleared with the rows they belong to, or a rebuild would leave painters pointing at detached
  // elements and grow the list every time the settings arrive.
  hintPainters = [];
  for (const section of ["ink", "walls", "gaps", "display"]) {
    const container = document.getElementById(`section-${section}`);
    if (!container) continue;
    container.replaceChildren();
    for (const control of CONTROLS) {
      if (control.section !== section) continue;
      // Stage two and three's controls stay in the popover: this surface is stage one, and the
      // representation that explains it is the mask. `PARAMETER_STAGE` is the same declaration the
      // cache invalidation reads, so the two cannot drift apart.
      if (PARAMETER_STAGE[control.name] !== "read") continue;
      container.append(settingRow(control));
    }
  }
  renderSwatches();
}

function renderSwatches(): void {
  const container = document.getElementById("swatches");
  if (!container) return;
  container.replaceChildren();

  for (const swatch of INK_SWATCHES) {
    const button = document.createElement("button");
    button.style.background = swatch.value;
    button.title = swatch.name;
    button.addEventListener("click", () => {
      settings = { ...settings, overlay: { ...settings.overlay, inkColour: swatch.value } };
      recolour();
      void persist();
    });
    container.append(button);
  }

  for (const button of container.querySelectorAll("button")) button.disabled = !controlsLive;

  const picker = document.createElement("input");
  picker.type = "color";
  picker.disabled = !controlsLive;
  picker.value = normaliseColour(settings.overlay.inkColour, DEFAULT_SETTINGS.overlay.inkColour);
  picker.addEventListener("input", () => {
    settings = { ...settings, overlay: { ...settings.overlay, inkColour: picker.value } };
    recolour();
  });
  picker.addEventListener("change", () => void persist());
  container.append(picker);
}

/**
 * Repaint the mask in a new colour without recomputing it.
 *
 * The expensive half is already done — the mask has not changed, only how it is drawn — so this is
 * a rewrite of an RGBA buffer rather than a re-read of the map.
 */
function recolour(): void {
  const mask = lastMask;
  if (!mask) return;
  const layer = rasterise(mask, settings.overlay.inkColour, painted);
  if (!layer) return;
  painted = layer;
  dirty = true;
}

/** The last mask painted, kept so a colour change can rewrite it without asking the pipeline. */
let lastMask: Parameters<typeof paintMask>[0] | null = null;

async function persist(): Promise<void> {
  try {
    await writeSettings(settings);
  } catch (error) {
    devLog("error", "workspace: could not save settings", describeError(error));
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

/**
 * Which tool has the plain drag.
 *
 * Only one exists today and it pans, so this looks like ceremony — it is not. Painting is the next
 * thing built here, and when it arrives it takes the plain drag; the hand tool and **Ctrl** are how
 * a GM pans once that has happened. Ctrl matters more on a trackpad than it looks: Firefox
 * axis-locks a two-finger scroll begun along an axis and Owlbear has the same limit, so the wheel
 * gesture alone cannot pan freely and a drag is the only unrestricted pan there is.
 */
type Tool = "hand";
let tool: Tool = "hand";

/*
  The navigation listens on the **canvas**, not on the surface that contains everything.

  The first version listened on the surface, which covers the whole viewport with the controls drawn
  on top of it — so a press on a button bubbled up, started a pan, and `setPointerCapture` then
  redirected the rest of the gesture to the surface. The button never saw its click, and every
  control on the page was dead: reported from a room as "Hand always interacts with the map".

  Listening on the canvas fixes it structurally rather than by filtering event targets. The canvas
  is *behind* the controls, so a press meant for a button never reaches it at all, and there is no
  list of exceptions to keep in step with the markup. The wheel comes right for free too —
  scrolling over the controls scrolls the controls, because the canvas is not under the pointer.
*/
if (canvas instanceof HTMLCanvasElement) {
  let panning = false;
  let last: { x: number; y: number } | null = null;

  canvas.addEventListener("pointerdown", (event) => {
    // Ctrl pans with any tool, which is what keeps a pan available once the plain drag is a brush.
    if (tool !== "hand" && !event.ctrlKey) return;
    panning = true;
    last = { x: event.clientX, y: event.clientY };
    canvas.classList.add("dragging");
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      devLog("warn", "workspace: could not capture the pointer", describeError(error));
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!panning || !last) return;
    setView(panBy(view, event.clientX - last.x, event.clientY - last.y));
    last = { x: event.clientX, y: event.clientY };
  });

  const endPan = (): void => {
    panning = false;
    last = null;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (event.cancelable) event.preventDefault();

      const intent = classifyWheel(event);
      const anchor = { x: event.clientX, y: event.clientY };
      if (intent === "pan") {
        setView(panBy(view, -event.deltaX, -event.deltaY));
      } else if (intent === "zoom-pinch") {
        const zoomed = zoomAbout(view, anchor, pinchFactor(event.deltaY, PINCH_SENSITIVITY));
        setView(event.deltaX !== 0 ? panBy(zoomed, -event.deltaX, 0) : zoomed);
      } else {
        setView(zoomAbout(view, anchor, wheelFactor(event.deltaY, ZOOM_STEP_PERCENT)));
      }
    },
    // The root defaults to passive in Chrome and Firefox, where `preventDefault` is ignored and a
    // warning logged instead.
    { passive: false },
  );
}

window.addEventListener("resize", () => {
  dirty = true;
});

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------

function fitMap(): void {
  if (!mapImage) return;
  const { width, height } = viewportSize();
  // Fitted into the space left of the controls, so "fit" means what a GM can actually see rather
  // than what is nominally on screen.
  const panelWidth = panel && !panel.classList.contains("hidden") ? panel.getBoundingClientRect().width : 0;
  const fitted = fitToViewport(
    { width: mapImage.naturalWidth, height: mapImage.naturalHeight },
    { width: Math.max(1, width - panelWidth), height },
    24,
  );
  setView({ ...fitted, x: fitted.x + panelWidth });
}

function close(): void {
  if (closing) return;
  closing = true;
  devLog("info", "workspace: closing");
  void OBR.modal.close(WORKSPACE_ID).catch((error: unknown) => {
    devLog("error", "workspace: could not close itself", describeError(error));
  });
}

document.getElementById("close")?.addEventListener("click", close);
document.getElementById("fit")?.addEventListener("click", fitMap);
document.getElementById("toggle-panel")?.addEventListener("click", (event) => {
  panel?.classList.toggle("hidden");
  const button = event.currentTarget;
  if (button instanceof HTMLButtonElement) {
    button.setAttribute("aria-pressed", String(!panel?.classList.contains("hidden")));
  }
  dirty = true;
});
document.getElementById("tool-hand")?.addEventListener("click", () => {
  tool = "hand";
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
});

/**
 * Claim the keyboard, immediately and then until it sticks.
 *
 * Measured: this modal is given no keyboard at all until it asks, and every keystroke before that
 * reaches Owlbear's page and does whatever it does there. Asking succeeds on the first try about
 * 150ms in, and one attempt is not enough because a frame not yet ready to take focus refuses it
 * silently.
 */
function claimKeyboard(attempt = 0): void {
  if (closing || document.hasFocus() || attempt > 30) return;
  try {
    window.focus();
    if (surface instanceof HTMLElement) surface.focus({ preventScroll: true });
  } catch {
    // A refusal here is not worth a line of its own; the retry below is the response either way.
  }
  window.setTimeout(() => claimKeyboard(attempt + 1), 100);
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

claimKeyboard();
window.requestAnimationFrame(frameLoop);
// Drawn now, disabled, from the defaults — see `controlsLive`.
renderControls();
say("waiting for Owlbear…", "working");

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "workspace"));
  } catch (error) {
    devLog("warn", "workspace: could not read player role", describeError(error));
  }

  settings = await readSettings();
  controlsLive = true;
  // Repainted wholesale rather than patched, so there is no path by which a row keeps a value from
  // the defaults it was first drawn with.
  renderControls();

  const result = await maskForOverlay(settings);
  if (!result) {
    say("no map nominated — choose one in the panel", "bad");
    if (mapNameLine) mapNameLine.textContent = "No map nominated.";
    return;
  }

  if (mapNameLine) mapNameLine.textContent = result.mapName;

  // The map image, drawn by us rather than by Owlbear. `crossOrigin` matches the pipeline's loader:
  // it proves the CDN sends the headers, and matching it means this cannot succeed where a trace
  // would fail.
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    mapImage = image;
    void openOnOwlbearsView(result.bounds, image);
  };
  image.onerror = () => {
    say("the map image would not load", "bad");
    devLog("error", "workspace: the map image failed to load");
  };
  image.src = (await resolveTraceMap())?.image.url ?? "";

  const generation = requests.request();
  lastMask = result.mask;
  const layer = requests.fulfil(generation)
    ? rasterise(result.mask, settings.overlay.inkColour, painted)
    : null;
  if (layer) {
    painted = layer;
    lastInkShare = shareOfInk(result.mask);
    lastReused = result.reused;
    paintBreaks(result.gaps);
    gapTotal = result.gaps.marks.length;
    gapFilled = result.gaps.filled;
    sayReading();
    // The measurements a readout reports against only exist once a reading has landed.
    refreshHints();
    devLog(
      "info",
      `workspace: opened on "${result.mapName}" — mask ${result.mask.width}x${result.mask.height}, ` +
        `ink ${(lastInkShare * 100).toFixed(1)}%, ${gapTotal} breaks of which ${gapFilled} repaired, ` +
        `${result.reused ? "reused from cache" : "recomputed"}`,
    );
  }
  dirty = true;
}

/**
 * Open showing exactly what Owlbear was showing.
 *
 * Nothing appears to move at the moment the sheet goes up, which the probe confirmed by eye — and
 * which matters more here than it did there: a GM opening the workspace is continuing to look at
 * the same map, and a jump would cost them their place.
 */
async function openOnOwlbearsView(
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } },
  image: HTMLImageElement,
): Promise<void> {
  try {
    const [a, b] = await Promise.all([
      OBR.viewport.transformPoint(bounds.min),
      OBR.viewport.transformPoint(bounds.max),
    ]);
    setView(viewFromScreenRect(a, b, { width: image.naturalWidth, height: image.naturalHeight }));
  } catch (error) {
    devLog("warn", "workspace: could not inherit Owlbear's view, fitting instead", describeError(error));
    fitMap();
  }
}

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces no Owlbear activity. That silence is correct rather than a failure.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    say(`Workspace failed: ${detail}`, "bad");
    devLog("error", "workspace: failed to start", detail);
  });
});
