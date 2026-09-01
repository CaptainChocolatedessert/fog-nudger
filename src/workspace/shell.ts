/**
 * The shell the workspace's steps are drawn on.
 *
 * ## What a shell owns, and what it must not
 *
 * The transform, the input, the canvas stack, and the way out. A **step** owns its controls, what
 * it paints, and what a drag means (`DESIGN.md` §4, "Six steps"). The division is not tidiness: it
 * is what lets a step be added without touching any of the above. There are four steps today — map,
 * ink, walls, regions — and two more expected, wall editing and doors, which are steps F and G.
 * This file is the part that is identical in all of them.
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

/**
 * The GM has asked to leave, so nothing new may start.
 *
 * Set the moment `close()` is entered, and read by every work cycle — the reading, the derive, the
 * skeleton — through `isClosing()`, so a recompute in flight abandons its result rather than
 * painting onto a surface that is going away. Also the re-entry guard: pressing Escape twice must
 * not start two pushes, and two concurrent pushes would each delete-then-write, which is the worst
 * state reachable in this code.
 */
let leaving = false;

/**
 * The modal is actually being dismissed, which is a later moment than `leaving`.
 *
 * These were one flag until the close started waiting for the push. Waiting wants the sheet to stay
 * *alive* while the write runs — repainting, resizing, showing a status line — and wants the work
 * cycles stopped. One flag could not express both: with it set, `frameLoop` returns and the canvas
 * holds its last frame, so the sheet would sit there frozen for the seconds the push takes, which is
 * indistinguishable from having crashed. Only `frameLoop` reads this narrower one.
 */
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

/** Not exported: `workspaceProbe.ts` has its own copy, which is what makes this look used. */
function viewportSize(): { width: number; height: number } {
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

export function setView(next: View): void {
  view = next;
  dirty = true;
}

/**
 * Whether the GM has asked to leave, for the work cycles.
 *
 * Deliberately reports `leaving` rather than `closing`: a cycle that started before the close and
 * lands during the push must still abandon its result, even though the sheet is still on screen.
 */
export function isClosing(): boolean {
  return leaving;
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

/** The map's name, at the top of the workspace's controls. Set by the map source when one loads. */
export function setMapName(text: string): void {
  if (mapNameLine) mapNameLine.textContent = text;
}

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

/** The map to draw, or `null` for none — which is a real state, not a failure: see the Map step. */
export function setMapImage(image: HTMLImageElement | null): void {
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

/**
 * A click on the map, reported as a fraction of the map image.
 *
 * A fraction rather than pixels, because what is on the other side of this is the pipeline, whose
 * raster may have been reduced by the memory cap. The shell knows where the map is drawn and nothing
 * about what was made of it, which is the division this file exists to keep.
 *
 * **A click means a press and a release that did not move.** Drag is already taken — it pans, and it
 * will paint — so the inspector rides on the gesture neither of them uses. When a step takes the
 * drag for a brush this needs revisiting: the same press will start a stroke, and a stroke that
 * happens to end where it began is not a request for information.
 */
const clickListeners: ((u: number, v: number) => void)[] = [];

export function onMapClick(listener: (u: number, v: number) => void): void {
  clickListeners.push(listener);
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

  // Where the press landed and whether it has moved since, which is what separates a click from a
  // drag. Four pixels of slop, because a mouse moves a little under a finger and a click that only
  // counts when nothing moved at all is a click most people cannot make.
  let pressed: { x: number; y: number } | null = null;
  let moved = false;

  canvas.addEventListener("pointerdown", (event) => {
    pressed = { x: event.clientX, y: event.clientY };
    moved = false;
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
    if (pressed && (Math.abs(event.clientX - pressed.x) > 4 || Math.abs(event.clientY - pressed.y) > 4)) {
      moved = true;
    }
    if (!panning || !last) return;
    setView(panBy(view, event.clientX - last.x, event.clientY - last.y));
    last = { x: event.clientX, y: event.clientY };
  });

  const endPan = (): void => {
    panning = false;
    last = null;
    pressed = null;
    canvas.classList.remove("dragging");
  };

  canvas.addEventListener("pointerup", (event) => {
    const wasClick = pressed !== null && !moved;
    endPan();
    if (!wasClick || !mapImage) return;
    const u = (event.clientX - view.x) / (mapImage.naturalWidth * view.scale);
    const v = (event.clientY - view.y) / (mapImage.naturalHeight * view.scale);
    // Outside the map is not a question about the map, and the pipeline's own "outside the raster"
    // answer would be a stranger reading of a click on the surrounding dark.
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    for (const listener of clickListeners) listener(u, v);
  });

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

/**
 * What to do on the way out, registered by the composition root.
 *
 * The shell knows the workspace is closing; it does not know that closing means writing the result
 * to the scene. Kept as a hook so nothing here has to import the emit path.
 */
let onClose: (() => Promise<void>) | null = null;

/**
 * How to ask that action to give up, for the escape hatch below.
 *
 * Registered rather than imported, for the same reason as `onClose` itself: the shell must not know
 * that leaving means writing to the scene, so it certainly must not know how to stop a scene write.
 * What it knows is that the way out may be waiting on something, and that the something can be asked
 * to stop. Optional — a close action with no way to give up is a legitimate one, and then the button
 * simply never has anything to call.
 */
let onCloseStop: (() => void) | null = null;

export function setCloseAction(action: () => Promise<void>, stop?: () => void): void {
  onClose = action;
  onCloseStop = stop ?? null;
}

/**
 * How long a scene write may run before the sheet offers a way out of it.
 *
 * A full push on the test map is a couple of seconds, which reads as working. Past this it reads as
 * a hang, so the sheet says what is happening and reveals **Exit anyway** — the fourth exit, and the
 * reason the wait needs no arbitrary cap.
 *
 * **An earlier version dismissed automatically at twelve seconds.** That decides for the GM, and it
 * decides wrong in both directions: it gives up on a write that was about to land, and it makes a
 * GM who wants out wait twelve seconds for it. A button they can see is the same guarantee — the
 * probe's rule is that this surface must never become a cell — without either.
 */
const SLOW_PUSH_NOTICE_MS = 4_000;

/**
 * How long to let a stopped push unwind before going anyway.
 *
 * The stop is cooperative: the batch loops check it *between* chunks, so a stop lands at the next
 * boundary rather than at once, and an `addItems` call already in flight runs to completion. That
 * is normally one call. If the connection is the thing that is stuck, waiting for it would make the
 * escape hatch stall too — which is the one thing it must not do.
 */
const STOP_GRACE_MS = 2_000;

/**
 * Leave, after the scene write finishes.
 *
 * **The order used to be the other way round** — dismiss the modal, then start the push — on the
 * reasoning that a GM should not be left staring at a sheet that has stopped responding. The
 * comment claimed "the iframe survives long enough to finish", which was an assumption and never a
 * measurement. It matters because `pushToFog` deletes our existing fog items *before* it writes the
 * replacements: right for a push that completes, since a fog layer holding nothing fogs everything,
 * and a half-written layer if the iframe goes first. Worse, `pushOnClose` never rethrows and logs
 * through a fire-and-forget shim, so a push killed by teardown left no trace distinguishable from
 * one that never started.
 *
 * So the sheet stays up, says what it is doing, and dismisses when the write lands. Decided by the
 * user (2026-08-30): a visibly slow close is preferred over any risk of a half-written fog layer.
 * The status line is not shown here — `pushOnClose` decides whether there is anything to push and
 * says so itself, so glancing and closing stays instant with no spurious flicker.
 *
 * **The cost, and it is the one to watch in a room.** For as long as the write runs, Escape and the
 * close button do nothing: the `leaving` guard swallows them, deliberately, because two concurrent
 * pushes would each delete-then-write. So the GM cannot abandon a slow push, and the timeout below
 * is the only thing that ends it. `#state` is a sibling of `#panel` rather than a child, so the
 * message stays visible even with the controls hidden — which is what keeps the wait legible rather
 * than looking like a hang.
 */
async function close(): Promise<void> {
  if (leaving) return;
  leaving = true;
  devLog("info", "workspace: closing");

  if (onClose) {
    // Caught rather than trusted. `pushOnClose` does not reject today, but the way out of an opaque
    // sheet must not depend on that staying true of whatever is registered here.
    const pushing = onClose().catch((error: unknown) => {
      devLog("error", "workspace: the close action threw", describeError(error));
    });

    let bailed = false;
    const bailedOut = new Promise<"bailed">((resolve) => {
      exitAnyway = () => {
        bailed = true;
        onCloseStop?.();
        say("stopping the write…", "working");
        resolve("bailed");
      };
    });

    const notice = window.setTimeout(() => {
      say("still writing to the scene — Exit anyway leaves it partly done", "working");
      offerExitAnyway();
    }, SLOW_PUSH_NOTICE_MS);

    await Promise.race([pushing, bailedOut]);
    window.clearTimeout(notice);
    // Disarmed whatever happened, so the button cannot reach a push that is no longer running. It
    // stays visible for the instant before the modal goes, which is correct: it *was* available.
    exitAnyway = null;

    if (bailed) {
      /*
        Give the stop a moment to land, then go regardless.

        Waiting for `pushing` outright would hand the stall back the power to trap the sheet, which
        is what this button exists to take away. Not waiting at all would tear the iframe down
        mid-call, which is the fault the whole close-time wait was built to fix. A short grace is the
        honest middle: normally the loop returns at the next batch boundary well inside it.
      */
      const unwound = await Promise.race([
        pushing.then(() => true),
        new Promise<false>((resolve) => window.setTimeout(() => resolve(false), STOP_GRACE_MS)),
      ]);
      devLog(
        unwound ? "info" : "warn",
        unwound
          ? "workspace: the push stopped cleanly at the GM's request"
          : `workspace: the push had not stopped ${STOP_GRACE_MS}ms after being asked — leaving ` +
            "with a write still in flight, so the fog layer may be incomplete",
      );
    }
  }

  closing = true;
  void OBR.modal.close(WORKSPACE_ID).catch((error: unknown) => {
    devLog("error", "workspace: could not close itself", describeError(error));
  });
}

/**
 * The escape hatch, armed only while a close is waiting on a write.
 *
 * Null the rest of the time so the button cannot be pressed into a push that is not running — it is
 * hidden then too, but a hidden button and a dead one are different guarantees.
 */
let exitAnyway: (() => void) | null = null;

function offerExitAnyway(): void {
  const button = document.getElementById("exit-anyway");
  if (button instanceof HTMLButtonElement) button.hidden = false;
}

document.getElementById("exit-anyway")?.addEventListener("click", () => exitAnyway?.());

document.getElementById("close")?.addEventListener("click", () => void close());
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
    void close();
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
  // `leaving`, not `closing`: once the GM has asked to go there is nothing left to claim the
  // keyboard for, even though the sheet stays up while the push runs.
  if (leaving || document.hasFocus() || attempt > 30) return;
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
