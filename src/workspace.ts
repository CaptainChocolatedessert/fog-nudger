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
 * ## Blank rather than stale
 *
 * A stage-one control changes the mask and a mask costs about 690ms, so a slider produces values
 * faster than masks can be made for them. Whenever the mask in hand is not the mask for the
 * settings on screen, **nothing is painted**. Ink drawn for settings the GM has moved past does not
 * lag, it lies — and comparing ink against linework is the whole of stage one. `maskRequest.ts`
 * carries that rule and its tests.
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
import {
  DEFAULT_SETTINGS,
  PARAMETER_STAGE,
  readParameter,
  SETTING_LIMITS,
  writeParameter,
  normaliseColour,
  type Settings,
} from "./settings";
import { formatValue, fromSlider, SLIDER_STEPS, toSlider } from "./sliderScale";
import { paintMask, parseColour } from "./overlay/maskImage";
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

const surface = document.getElementById("surface");
const canvas = document.getElementById("canvas");
const panel = document.getElementById("panel");
const stateLine = document.getElementById("state");
const mapNameLine = document.getElementById("map-name");

let settings: Settings = DEFAULT_SETTINGS;
let view: View = { scale: 1, x: 0, y: 0 };
let mapImage: HTMLImageElement | null = null;

/** The mask rasterised into RGBA once, so a view change is a `drawImage` rather than a repaint. */
let painted: { canvas: HTMLCanvasElement; buffer: Uint8ClampedArray<ArrayBuffer> } | null = null;

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
  if (painted && shouldPaint(requests.current())) {
    context.globalAlpha = settings.overlay.inkOpacity;
    context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);
    context.globalAlpha = 1;
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
 * Rasterise the mask into an offscreen canvas at the map's own resolution.
 *
 * Once per mask, not once per frame: every subsequent view change is a `drawImage` with a different
 * transform, which the probe measured at a tenth of a millisecond.
 */
function rasterise(mask: Parameters<typeof paintMask>[0], colour: string): boolean {
  const rgb = parseColour(colour) ?? parseColour(DEFAULT_SETTINGS.overlay.inkColour);
  if (!rgb) return false;

  const buffer = paintMask(mask, rgb, painted?.buffer);
  const target = painted?.canvas ?? document.createElement("canvas");
  target.width = mask.width;
  target.height = mask.height;
  const context = target.getContext("2d");
  if (!context) return false;

  context.putImageData(new ImageData(buffer, mask.width, mask.height), 0, 0);
  painted = { canvas: target, buffer };
  return true;
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
    if (!rasterise(result.mask, wanted.overlay.inkColour)) {
      requests.fail(generation);
      say("could not allocate the mask image", "bad");
      return;
    }

    const share = shareOfInk(result.mask);
    say(`ink ${(share * 100).toFixed(1)}% ${result.reused ? "(cached)" : ""}`.trim());
    devLog(
      "info",
      `workspace: mask ${generation} painted for "${result.mapName}" — ` +
        `${result.mask.width}x${result.mask.height}, ink ${(share * 100).toFixed(1)}%, ` +
        `${result.reused ? "reused from cache" : "recomputed"}`,
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

// ---------------------------------------------------------------------------------------------
// The controls
// ---------------------------------------------------------------------------------------------

function measured(): Measured {
  return { pxPerSquare: lastPixelsPerSquare(), inkWidth: lastInkWidth() };
}

/**
 * Build one slider.
 *
 * Two events, and the split is the point of using a slider. `input` fires continuously while
 * dragging and drives the readout, the derived figure and — for a pipeline control — a blank sheet
 * plus a fresh request. `change` fires once on release and is the only thing that **writes**:
 * committing mid-drag would put a hundred values through scene metadata to reach one.
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
  const facts = measured();
  const paintHint = (current: number): void => {
    const derived = control.derive ? control.derive(current, facts) : "";
    hint.innerHTML = derived ? `${control.hint} <b>${derived}</b>` : control.hint;
  };
  paintHint(value);

  input.addEventListener("input", () => {
    const current = fromSlider(Number(input.value), limits, scale);
    readout.textContent = formatValue(current, limits, scale);
    paintHint(current);
    settings = writeParameter(settings, control.name, current);
    // Blank immediately. Not when the recomputation starts — the gap between the two is a window in
    // which the previous mask is on screen under the new settings.
    requests.request();
    dirty = true;
    void refreshMask();
  });

  input.addEventListener("change", () => {
    const current = fromSlider(Number(input.value), limits, scale);
    settings = writeParameter(settings, control.name, current);
    void persist();
  });

  input.disabled = !controlsLive;
  row.append(top, input, hint);
  return row;
}

/**
 * A display control, which changes how the mask is drawn rather than what it is.
 *
 * Separated from the pipeline path because it must **not** blank the sheet or recompute anything —
 * filing a display parameter as pipeline would re-binarise on every opacity nudge, which is the
 * mistake `PARAMETER_KIND` exists to prevent.
 */
function displayRow(control: Control): HTMLElement {
  const row = settingRow(control);
  const input = row.querySelector("input");
  if (!(input instanceof HTMLInputElement)) return row;

  const limits = SETTING_LIMITS[control.name];
  const scale = control.scale ?? "linear";
  const fresh = input.cloneNode(true) as HTMLInputElement;
  input.replaceWith(fresh);

  const readout = row.querySelector(".value");
  fresh.addEventListener("input", () => {
    const current = fromSlider(Number(fresh.value), limits, scale);
    if (readout) readout.textContent = formatValue(current, limits, scale);
    settings = writeParameter(settings, control.name, current);
    dirty = true;
  });
  fresh.addEventListener("change", () => void persist());
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

function renderControls(): void {
  for (const section of ["ink", "walls", "display"]) {
    const container = document.getElementById(`section-${section}`);
    if (!container) continue;
    container.replaceChildren();
    for (const control of CONTROLS) {
      if (control.section !== section) continue;
      // Stage two and three's controls stay in the popover: this surface is stage one, and the
      // representation that explains it is the mask. `PARAMETER_STAGE` is the same declaration the
      // cache invalidation reads, so the two cannot drift apart.
      if (PARAMETER_STAGE[control.name] !== "read") continue;
      container.append(section === "display" ? displayRow(control) : settingRow(control));
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
  if (mask && rasterise(mask, settings.overlay.inkColour)) dirty = true;
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

if (surface instanceof HTMLElement) {
  let panning = false;
  let last: { x: number; y: number } | null = null;

  surface.addEventListener("pointerdown", (event) => {
    // Ctrl pans with any tool, which is what keeps a pan available once the plain drag is a brush.
    if (tool !== "hand" && !event.ctrlKey) return;
    panning = true;
    last = { x: event.clientX, y: event.clientY };
    surface.classList.add("dragging");
    try {
      surface.setPointerCapture(event.pointerId);
    } catch (error) {
      devLog("warn", "workspace: could not capture the pointer", describeError(error));
    }
  });

  surface.addEventListener("pointermove", (event) => {
    if (!panning || !last) return;
    setView(panBy(view, event.clientX - last.x, event.clientY - last.y));
    last = { x: event.clientX, y: event.clientY };
  });

  const endPan = (): void => {
    panning = false;
    last = null;
    surface.classList.remove("dragging");
  };
  surface.addEventListener("pointerup", endPan);
  surface.addEventListener("pointercancel", endPan);

  surface.addEventListener(
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
  if (requests.fulfil(generation) && rasterise(result.mask, settings.overlay.inkColour)) {
    const share = shareOfInk(result.mask);
    say(`ink ${(share * 100).toFixed(1)}% ${result.reused ? "(cached)" : ""}`.trim());
    devLog(
      "info",
      `workspace: opened on "${result.mapName}" — mask ${result.mask.width}x${result.mask.height}, ` +
        `ink ${(share * 100).toFixed(1)}%, ${result.reused ? "reused from cache" : "recomputed"}`,
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
