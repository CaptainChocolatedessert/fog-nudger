/**
 * The shell the workspace's steps are drawn on.
 *
 * ## What a shell owns, and what it must not
 *
 * The transform, the input, the canvas stack, and the way out. A **step** owns its controls, what
 * it paints, and what a drag means (`DESIGN.md` §4, "Six steps"). The division is not tidiness: the
 * workspace is about to grow from three sections of sliders into six modes — map, ink, walls, edit
 * walls, regions, doors — and this file is the part that is identical in all of them. Splitting it
 * out before the growth is the whole of step A.1, and the refactor gets harder every session it is
 * deferred.
 *
 * **Nothing here knows what a mask is.** The shell draws the map and then hands the frame to
 * whatever painters were registered, in registration order. That is the canvas stack: an ordered
 * list of things drawn on top of the map under the *same* transform, which is the registration
 * argument the whole surface rests on — map and everything over it agree by construction rather
 * than by two pieces of arithmetic agreeing with each other.
 *
 * ## Wired at module load, deliberately
 *
 * Everything that does not need the SDK is attached when this module is imported, not inside a
 * function that waits for Owlbear. The probe learned that three times: a listener written inside
 * the `onReady` path is silently dead until Owlbear answers, which was two and a half seconds on a
 * cold dev server and could be forever outside a room.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import {
  classifyWheel,
  fitToViewport,
  panBy,
  pinchFactor,
  viewFromScreenRect,
  wheelFactor,
  zoomAbout,
  type View,
} from "../probe/viewTransform";
import type { Drag, LayerId } from "../steps";
import { WORKSPACE_ID } from "./workspaceControl";

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

const surface = document.getElementById("surface");
const canvas = document.getElementById("canvas");
const panel = document.getElementById("panel");
const stateLine = document.getElementById("state");
const mapNameLine = document.getElementById("map-name");

/**
 * One frame, handed to every painter.
 *
 * The map's draw rectangle is computed once and passed down rather than recomputed by each painter
 * from the view: two painters deriving the same rectangle by the same arithmetic is two chances to
 * write it differently, and a layer half a pixel out from the ink under it is exactly the class of
 * fault this surface exists to make impossible.
 */
export interface Frame {
  readonly context: CanvasRenderingContext2D;
  readonly view: View;
  /** The viewport, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Where the map was drawn, which is the rectangle every map-space layer draws into. */
  readonly drawWidth: number;
  readonly drawHeight: number;
}

/** Something drawn over the map, under the map's own transform. */
export type Painter = (frame: Frame) => void;

/**
 * Every layer that has registered, and the ones the open step asks for.
 *
 * A layer is drawn because **the step the GM is in is about it**, not because it exists: the ink
 * steps paint the mask, and the wall and region steps to come paint linework and coloured faces over
 * a map with no mask on it at all. Registration order is draw order, so what varies with the step is
 * which of them run rather than the order they run in.
 */
const painters: { readonly layer: LayerId; readonly paint: Painter }[] = [];
let activeLayers: readonly LayerId[] = [];

let view: View = { scale: 1, x: 0, y: 0 };
let mapImage: HTMLImageElement | null = null;
let dirty = true;
let closing = false;

/**
 * Whether a slider is mid-drag with its value not yet applied.
 *
 * It lives with the state line rather than with the controls because the state line is the only
 * thing that reads it: the mask on screen is the last *applied* reading, which is worth keeping
 * visible, but it must not be mistaken for the value the slider is now showing. This is what stops
 * a reading that lands mid-drag from quietly overwriting the message that says so.
 */
let pendingEdit = false;

/**
 * What a plain left-drag does, which the **open step** decides.
 *
 * Every step pans today, so this looks like ceremony — it is not. Painting is the next thing built
 * here, and when it arrives the steps that paint take the plain drag while the rest keep pan. That
 * is the whole reason a step is a mode rather than a heading, and it is what dissolves the problem
 * this surface was recorded as owing a trackpad user: **Ctrl** pans whatever the step says, and it
 * matters more on a trackpad than it looks — Firefox axis-locks a two-finger scroll begun along an
 * axis and Owlbear has the same limit, so the wheel gesture alone cannot pan freely and a drag is
 * the only unrestricted pan there is.
 */
let drag: Drag = "pan";

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

export function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Register a layer's painter. Draw order is registration order; whether it runs is the step's call. */
export function addPainter(layer: LayerId, paint: Painter): void {
  painters.push({ layer, paint });
}

/** Show exactly these layers, which is what opening a step does. */
export function setActiveLayers(layers: readonly LayerId[]): void {
  activeLayers = layers;
  dirty = true;
}

/** Ask for a repaint on the next frame. Cheap and idempotent — the frame loop coalesces. */
export function invalidate(): void {
  dirty = true;
}

export function currentView(): View {
  return view;
}

export function setView(next: View): void {
  view = next;
  dirty = true;
}

export function isClosing(): boolean {
  return closing;
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

  // Everything else, in the same call shape and therefore in the same place. This is the
  // registration argument in one line: there is no second transform to get wrong.
  const frame: Frame = { context, view, width, height, drawWidth, drawHeight };
  for (const painter of painters) {
    if (activeLayers.includes(painter.layer)) painter.paint(frame);
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

// ---------------------------------------------------------------------------------------------
// The state line
// ---------------------------------------------------------------------------------------------

export function say(text: string, tone: "" | "working" | "bad" = ""): void {
  if (!stateLine) return;
  stateLine.textContent = text;
  stateLine.className = tone;
}

/**
 * Report something finished, unless a slider has since been picked up.
 *
 * The race is real and reachable on the first open: a mask started at load can land while a slider
 * is already being dragged, and the plain success message would replace "release to re-read" with
 * "ink 7.2%" — announcing as current a figure for a value the GM is in the middle of moving away
 * from. The pending message wins, because it is the one that is still true.
 */
export function sayIfSettled(text: string, tone: "" | "working" | "bad" = ""): void {
  if (pendingEdit) return;
  say(text, tone);
}

export function setPendingEdit(pending: boolean): void {
  pendingEdit = pending;
}

/** The map's name, in the panel. Passes to the map step when step 1 is built. */
export function setMapName(text: string): void {
  if (mapNameLine) mapNameLine.textContent = text;
}

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

export function setMapImage(image: HTMLImageElement): void {
  mapImage = image;
  dirty = true;
}

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

/**
 * Open showing exactly what Owlbear was showing.
 *
 * Nothing appears to move at the moment the sheet goes up, which the probe confirmed by eye — and
 * which matters more here than it did there: a GM opening the workspace is continuing to look at
 * the same map, and a jump would cost them their place.
 */
export async function openOnOwlbearsView(bounds: {
  min: { x: number; y: number };
  max: { x: number; y: number };
}): Promise<void> {
  const image = mapImage;
  if (!image) return;
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

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

/** What a plain drag means from here on. Set by opening a step, and by nothing else. */
export function setDrag(next: Drag): void {
  drag = next;
}

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
    // Ctrl pans in any step, which is what keeps a pan available once the plain drag is a brush.
    if (drag !== "pan" && !event.ctrlKey) return;
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

/** Take the keyboard and start drawing. Depends on nothing outside this page. */
export function start(): void {
  claimKeyboard();
  window.requestAnimationFrame(frameLoop);
}
