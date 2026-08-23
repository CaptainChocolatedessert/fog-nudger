/**
 * The workspace probe — an opaque modal that draws the map and navigates it.
 *
 * ## What it has already answered
 *
 * The input half, settled 2026-08-23 over fifteen runs and written up in `DESIGN.md` §4. A
 * `fullScreen` modal *without* `disablePointerEvents` owns pointer, wheel and right-click
 * completely, and Owlbear's viewport never moves underneath. The keyboard is **taken rather than
 * given** — nothing arrives unasked, and until it is claimed every keystroke reaches Owlbear's page
 * and does whatever it does there.
 *
 * The drag pad and the text box that established that are gone. They were superseded by the map:
 * panning it is a better drag test than a scratch canvas, because it is the actual gesture.
 *
 * ## What it is for now
 *
 * **Does pan and zoom feel right beside Owlbear's own?** That is the question nothing but a human's
 * hands can answer, and it is the one the whole surface rests on — if the navigation jars, the
 * workspace is worse than the click-through overlay it would replace, whatever else it can do.
 *
 * Two things make the answer sharper than "yes" or "no":
 *
 * - **It opens on exactly the view Owlbear was showing.** Nothing appears to jump when the sheet
 *   goes up, and the two navigations start from the same place, which is what makes comparing them
 *   fair rather than a comparison of two different framings.
 * - **The feel constants are adjustable from the keyboard, and logged.** "Too fast" is a complaint.
 *   "22% a notch" is a number the workspace can be built with, and finding it takes one run.
 *
 * ## And the other unknown
 *
 * **Frame cost**, with a map-sized image drawn every frame *plus a second one standing in for the
 * mask* — which is the real workload, and the reason a single-layer measurement would flatter it.
 * Reported as the time in the draw call and the interval between frames, during motion only, since
 * a still view redraws nothing and would report a beautiful zero.
 *
 * ## Still three ways out, sharing no mechanism
 *
 * The timer armed at module load, the close button, and Escape. An opaque sheet that swallows input
 * is a worse trap than a click-through one, and the timer is the one that has to work: it depends
 * on nothing, not even the SDK becoming ready.
 *
 * Development only. Draws nothing into the scene and writes nothing anywhere.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { resolveTraceMap } from "./map/mapImage";
import { WORKSPACE_PROBE_ID } from "./probe/workspaceProbeControl";
import { attributeMovement, pointMoved, type InputChannel } from "./probe/workspaceInput";
import {
  MAX_SCALE,
  MIN_SCALE,
  classifyWheel,
  fitToViewport,
  panBy,
  pinchFactor,
  viewFromScreenRect,
  wheelFactor,
  zoomAbout,
  type View,
  type WheelIntent,
} from "./probe/viewTransform";
import type { ScreenPoint } from "./probe/viewportSettle";

installDevLog("workspace");

/**
 * How long the probe stays up.
 *
 * Longer than the overlay probe's 25 seconds. Judging navigation is not a glance — it wants a pan,
 * a zoom in, a zoom out, a comparison against Owlbear's, and a sweep of the step constant.
 */
const LIFETIME_MS = 90_000;

/** How often Owlbear is asked where our two fixed world points are. */
const POLL_MS = 150;

/** How often to ask again while the keyboard is still not ours. */
const FOCUS_RETRY_MS = 100;

/** How long to keep asking before giving up and saying so. */
const FOCUS_RETRY_LIMIT_MS = 3_000;

/** How long after asking before the result is read, letting the focus change settle. */
const FOCUS_SETTLE_MS = 150;

/** When the leak detector's control experiment runs. */
const SELF_TEST_AT_MS = 2_000;

/** How far the viewport is deliberately moved, in its own position units. */
const SELF_TEST_NUDGE = 60;

/** How long to hold each end of the nudge, comfortably more than one poll interval. */
const SELF_TEST_SETTLE_MS = 500;

/** How many movements to narrate per channel before falling silent and merely counting. */
const MOVEMENTS_LOGGED_PER_CHANNEL = 3;

/**
 * How much one wheel notch changes the zoom, as a percentage — **the feel knob**.
 *
 * A first guess and nothing more. It is adjustable from the keyboard precisely because no value
 * written here can be right: the whole point of the run is to find out what matches Owlbear, and a
 * constant nobody can move during the run turns that into a second session.
 */
const DEFAULT_ZOOM_STEP_PERCENT = 12;

/**
 * How hard a trackpad pinch zooms, per pixel of finger movement — **the second feel knob**.
 *
 * Separate from the notch step because a pinch is a different gesture, not a different device
 * sending the same one. A notch is discrete and its magnitude is an arbitrary number the browser
 * chose; a pinch is continuous and its magnitude is the fingers actually moving. Applying a whole
 * notch to each event of a pinch's stream is what made trackpad zoom unusably fast — dozens of 12%
 * steps for one gesture.
 */
const DEFAULT_PINCH_SENSITIVITY = 1;

/**
 * How far one press moves the pinch sensitivity, and the range it may be swept over.
 *
 * The units are **percent of zoom per pixel of finger movement**, which is what makes them
 * meaningful to sweep — 1 means a hundred pixels of pinch roughly doubles the scale. The first
 * draft of this had the default at 100 and one synthetic event took the zoom from 112% to the
 * 3200% ceiling, because at that value the factor is `exp(-deltaY)` outright. Worth recording that
 * the sensible-looking number was the wrong one by two orders of magnitude.
 */
const PINCH_NUDGE = 0.1;
const MIN_PINCH = 0.1;
const MAX_PINCH = 4;

/** How far one press of the step keys moves it, and the range it may be swept over. */
const ZOOM_STEP_NUDGE = 2;
const MIN_ZOOM_STEP = 2;
const MAX_ZOOM_STEP = 60;

/** How many frames of timing to keep. About two seconds of motion at 60Hz. */
const FRAME_WINDOW = 120;

const sheet = document.getElementById("sheet");
const canvas = document.getElementById("canvas");
const hud = document.getElementById("hud");
const closeButton = document.getElementById("close");

/** Which chrome variant the opener asked for, purely so the readout can name it. */
const variant = new URLSearchParams(window.location.search).get("variant") ?? "unknown";

/**
 * When the sheet went up — the single origin for the countdown, the dismissal timer and the
 * keyboard claim's timing. Set at module load and never reassigned.
 */
const opened = performance.now();

let stopped = false;

// ---------------------------------------------------------------------------------------------
// What the run measures
// ---------------------------------------------------------------------------------------------

/** Input counts, kept because a navigation gesture is still an input gesture. */
const tally = {
  pointerDown: 0,
  pointerMove: 0,
  pointerUp: 0,
  wheel: 0,
  wheelCancelable: 0,
  contextMenu: 0,
  keyDown: 0,
  keysBeforeAnyPointer: 0,
  blamed: { drag: 0, wheel: 0, key: 0, other: 0 } as Record<InputChannel, number>,
  polls: 0,
  worstPollMs: 0,
  totalPollMs: 0,
};

/**
 * What the wheel actually reports on this machine.
 *
 * Not used to decide anything — recorded because trackpad handling is the device quirk most likely
 * to bite, and the sensible way to find out what a trackpad sends here is to look rather than to
 * reason about `deltaMode` from the specification. A mouse notch and a two-finger scroll are
 * indistinguishable in principle and often distinguishable in practice by exactly these numbers.
 */
const wheelShape = {
  /** What each event was taken to mean — the heuristic made visible. */
  intents: { "zoom-notch": 0, "zoom-pinch": 0, pan: 0 } as Record<WheelIntent, number>,
  lastIntent: "nothing yet" as WheelIntent | "nothing yet",
  modes: new Set<number>(),
  smallestAbsDelta: Infinity,
  largestAbsDelta: 0,
  fractional: 0,
  withCtrl: 0,

  /*
    Whether a two-finger drag can be diagonal at all, and whether a pinch can carry a pan.

    Reported from a room: the pan goes in pure X or pure Y and never a diagonal, and a pinch cannot
    be combined with a drag. Neither is necessarily ours to fix — a browser is free to lock a
    trackpad gesture to its dominant axis, and to decide that a gesture is a pinch *or* a scroll and
    not both, in which case no code here can recover an axis that never arrived.

    So this counts what actually shows up, and the difference is decisive: events carrying both
    deltas mean the diagonal reached us and we dropped it, while none ever carrying both means the
    browser locked the axis before we saw it. Same for a pinch — `pinchWithX` is whether the zoom
    events carry any sideways movement, and `interleaved` is whether pinch and scroll events
    alternate inside one gesture, which is the other way a platform can deliver "both at once".
  */
  bothAxes: 0,
  xOnly: 0,
  yOnly: 0,
  pinchWithX: 0,
  interleaved: 0,
  lastWasCtrl: null as boolean | null,
  lastAt: 0,
};

/**
 * How close two wheel events must be to count as part of one gesture.
 *
 * Only used for `interleaved`. Generous, because the question is whether the browser mixes pinch
 * and scroll events inside a single continuous gesture at all — not where its exact boundaries are.
 */
const GESTURE_GAP_MS = 200;

/** When each channel last fired, feeding the attribution of an observed movement. */
const lastEventAt: Record<InputChannel, number | null> = {
  drag: null,
  wheel: null,
  key: null,
  other: null,
};

/** The leak detector's own control experiment. */
const selfTest = { active: false, ran: false, movementsSeen: 0, note: "not run yet" };

/** What happened when the page asked for the keyboard. */
const focusAttempt = {
  made: false,
  held: false,
  tries: 0,
  claimedAtMs: 0,
  losses: 0,
  gaveUp: false,
  before: false,
  note: "asking for the keyboard…",
};

/**
 * Frame timing, gathered only while the view is moving.
 *
 * A still view redraws nothing, so including idle frames would report a beautiful number about a
 * canvas that was not being drawn. `drawMs` is the time inside the draw call; `frameMs` is the gap
 * between consecutive drawn frames, which is what a stutter actually is — a draw can be fast and
 * the frame still late.
 */
const frames = {
  drawMs: [] as number[],
  frameMs: [] as number[],
  lastFrameAt: 0,
  drawn: 0,
};

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

let view: View = { scale: 1, x: 0, y: 0 };
/** The view Owlbear was showing when the sheet went up, so `r` can return to it. */
let openingView: View | null = null;
let zoomStepPercent = DEFAULT_ZOOM_STEP_PERCENT;
let pinchSensitivity = DEFAULT_PINCH_SENSITIVITY;
let wheelInverted = false;
let panInverted = false;
let showMaskLayer = true;
let dirty = true;

/** The map image, and a synthetic second layer standing in for the mask. */
let mapImage: HTMLImageElement | null = null;
let maskLayer: HTMLCanvasElement | null = null;
let mapNote = "no map yet";

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function worst(values: readonly number[]): number {
  let highest = 0;
  for (const value of values) if (value > highest) highest = value;
  return highest;
}

function record(into: number[], value: number): void {
  into.push(value);
  if (into.length > FRAME_WINDOW) into.shift();
}

function noteEvent(channel: Exclude<InputChannel, "other">): void {
  lastEventAt[channel] = performance.now();
}

// ---------------------------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------------------------

function dismiss(why: string): void {
  if (stopped) return;
  stopped = true;

  const pollMean = tally.totalPollMs / Math.max(1, tally.polls);
  const frameMean = average(frames.frameMs);

  devLog(
    "info",
    `workspace probe (${variant}): closing — ${why}. ` +
      `NAVIGATION: notch ${zoomStepPercent}% per wheel step, pinch ${pinchSensitivity.toFixed(2)}% per ` +
      `trackpad pixel${wheelInverted ? ", zoom INVERTED" : ""}` +
      `${panInverted ? ", pan INVERTED" : ""}, final scale ${view.scale.toFixed(3)}, ` +
      `mask layer ${showMaskLayer ? "on" : "off"}. ` +
      `INTENTS: ${wheelShape.intents["zoom-notch"]} notch, ${wheelShape.intents["zoom-pinch"]} ` +
      `pinch, ${wheelShape.intents.pan} pan. ` +
      `AXES: ${wheelShape.bothAxes} diagonal, ${wheelShape.xOnly} x-only, ${wheelShape.yOnly} ` +
      `y-only, ${wheelShape.pinchWithX} pinches carried x, ${wheelShape.interleaved} pinch/scroll ` +
      `transitions within ${GESTURE_GAP_MS}ms. ` +
      `FRAMES: ${frames.drawn} drawn, draw ${average(frames.drawMs).toFixed(1)}ms mean / ` +
      `${worst(frames.drawMs).toFixed(1)}ms worst, frame ${frameMean.toFixed(1)}ms mean / ` +
      `${worst(frames.frameMs).toFixed(1)}ms worst` +
      `${frameMean > 0 ? ` (${(1000 / frameMean).toFixed(0)}fps while moving)` : ""}. ` +
      `WHEEL: deltaMode ${[...wheelShape.modes].join("/") || "—"}, |deltaY| ` +
      `${Number.isFinite(wheelShape.smallestAbsDelta) ? wheelShape.smallestAbsDelta.toFixed(1) : "—"}` +
      `–${wheelShape.largestAbsDelta.toFixed(1)}, ${wheelShape.fractional} fractional, ` +
      `${wheelShape.withCtrl} with ctrl. ` +
      `INPUT: pointer ${tally.pointerDown}/${tally.pointerMove}/${tally.pointerUp}, ` +
      `wheel ${tally.wheel} (${tally.wheelCancelable} cancelable), context ${tally.contextMenu}, ` +
      `keys ${tally.keyDown} (${tally.keysBeforeAnyPointer} before any click). ` +
      `KEYBOARD: ${focusAttempt.held ? `claimed at ${focusAttempt.claimedAtMs.toFixed(0)}ms` : focusAttempt.note}` +
      `${focusAttempt.losses > 0 ? `, lost ${focusAttempt.losses}x` : ""}. ` +
      `OWLBEAR moved ${tally.blamed.drag + tally.blamed.wheel + tally.blamed.key + tally.blamed.other} ` +
      `times: drag ${tally.blamed.drag}, wheel ${tally.blamed.wheel}, key ${tally.blamed.key}, ` +
      `unattributed ${tally.blamed.other}. Detector self-test: ${selfTest.note}. ` +
      `Poll ${pollMean.toFixed(0)}ms mean over ${tally.polls}. ` +
      `iframe ${window.innerWidth}x${window.innerHeight}. Map: ${mapNote}.`,
  );

  void OBR.modal.close(WORKSPACE_PROBE_ID).catch((error: unknown) => {
    devLog("error", "workspace probe: could not close itself", describeError(error));
  });
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

function draw(): void {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const started = performance.now();
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

  if (mapImage) {
    /*
      Smoothing off above 1:1.

      Zoomed in past one screen pixel per image pixel, the GM is looking at individual ink pixels —
      which is a thing this surface exists for — and an interpolated blur there is the browser
      inventing detail the trace does not see. Below 1:1 smoothing is what keeps thin linework from
      disappearing between samples.
    */
    context.imageSmoothingEnabled = view.scale < 1;

    const width_ = mapImage.naturalWidth * view.scale;
    const height_ = mapImage.naturalHeight * view.scale;
    context.drawImage(mapImage, view.x, view.y, width_, height_);

    // The stand-in for stage one's mask. Same size and transform, because the real workload is two
    // map-sized layers per frame and measuring one would flatter it.
    if (showMaskLayer && maskLayer) {
      context.globalAlpha = 0.5;
      context.drawImage(maskLayer, view.x, view.y, width_, height_);
      context.globalAlpha = 1;
    }
  }

  const now = performance.now();
  record(frames.drawMs, now - started);
  if (frames.lastFrameAt > 0) record(frames.frameMs, now - frames.lastFrameAt);
  frames.lastFrameAt = now;
  frames.drawn += 1;
}

/**
 * Redraw only when the view has changed.
 *
 * A still surface costs nothing, which is both correct and the reason the frame numbers are honest:
 * they come from frames that actually drew, during motion, rather than being diluted by idle ones.
 * `lastFrameAt` is cleared when the view settles, so the gap across a pause is not later recorded
 * as one enormous frame.
 */
function frameLoop(): void {
  if (stopped) return;
  if (dirty) {
    dirty = false;
    draw();
  } else {
    frames.lastFrameAt = 0;
  }
  window.requestAnimationFrame(frameLoop);
}

function setView(next: View): void {
  view = next;
  dirty = true;
}

// ---------------------------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------------------------

function render(): void {
  if (!hud) return;

  const remaining = Math.max(0, LIFETIME_MS - (performance.now() - opened));
  const frameMean = average(frames.frameMs);
  const leaks = tally.blamed.drag + tally.blamed.wheel + tally.blamed.key;

  hud.innerHTML =
    `<b>Fog Nudger — workspace probe · ${variant}</b>\n` +
    `Does this feel like Owlbear's? Drag to pan, wheel to zoom.\n` +
    `\n` +
    `zoom      ${(view.scale * 100).toFixed(0)}% of image pixels` +
    `${view.scale >= MAX_SCALE ? " (at maximum)" : view.scale <= MIN_SCALE ? " (at minimum)" : ""}\n` +
    `notch     <b>${zoomStepPercent}%</b> per wheel step${wheelInverted ? " · <b>zoom inverted</b>" : ""}\n` +
    `pinch     <b>${pinchSensitivity.toFixed(2)}%</b> per trackpad pixel${panInverted ? " · <b>pan inverted</b>" : ""}\n` +
    // The heuristic, made checkable. If a two-finger scroll shows up as a notch, or a mouse wheel
    // as a pan, this line says so while the hand that made the gesture is still on the device.
    `wheel     last <b>${wheelShape.lastIntent}</b> · ` +
    `${wheelShape.intents["zoom-notch"]} notch / ${wheelShape.intents["zoom-pinch"]} pinch / ` +
    `${wheelShape.intents.pan} pan\n` +
    // Decides whether a missing diagonal is ours or the browser's: events carrying both deltas mean
    // it reached us, none ever doing so means the axis was locked before we saw it.
    `axes      <b>${wheelShape.bothAxes}</b> diagonal · ${wheelShape.xOnly} x-only · ` +
    `${wheelShape.yOnly} y-only · pinch+x ${wheelShape.pinchWithX} · ` +
    `mixed ${wheelShape.interleaved}\n` +
    `frames    ${frames.drawn} drawn · draw ${average(frames.drawMs).toFixed(1)}ms mean, ` +
    `${worst(frames.drawMs).toFixed(1)}ms worst · ` +
    `${frameMean > 0 ? `${(1000 / frameMean).toFixed(0)}fps` : "—"} while moving\n` +
    `layers    map${showMaskLayer && maskLayer ? " + mask stand-in" : " only"}\n` +
    `map       ${mapNote}\n` +
    `\n` +
    `Owlbear   ${
      leaks > 0
        ? `<span class="bad">MOVED ${leaks}x from our input — navigation is leaking</span>`
        : `still (${tally.blamed.other} unattributed) · detector ${selfTest.note}`
    }\n` +
    `keyboard  ${focusAttempt.held ? `ours, claimed ${focusAttempt.claimedAtMs.toFixed(0)}ms in` : focusAttempt.note}\n` +
    `\n` +
    `<span class="key">drag</span> pan · <span class="key">wheel</span> zoom · ` +
    `<span class="key">[ ]</span> notch · <span class="key">, .</span> pinch · ` +
    `<span class="key">i</span> invert zoom · <span class="key">p</span> invert pan · ` +
    `<span class="key">f</span> fit · <span class="key">r</span> reopen view · ` +
    `<span class="key">m</span> mask · <span class="key">h</span> hide this · ` +
    `<span class="key">Esc</span> close\n` +
    `closes in ${(remaining / 1000).toFixed(0)}s`;
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

if (sheet instanceof HTMLElement) {
  let panning = false;
  let last: ScreenPoint | null = null;

  sheet.addEventListener("pointerdown", (event) => {
    noteEvent("drag");
    tally.pointerDown += 1;
    // Any button pans. A left-drag will eventually belong to the brush and panning will move to the
    // middle button or a held key — but that is a decision for the workspace, and forcing it now
    // would have the probe measure the feel of a gesture nobody has agreed on.
    panning = true;
    last = { x: event.clientX, y: event.clientY };
    sheet.classList.add("dragging");
    try {
      sheet.setPointerCapture(event.pointerId);
    } catch (error) {
      devLog("warn", "workspace probe: could not capture the pointer", describeError(error));
    }
    if (!focusAttempt.held) claimTheKeyboard();
    render();
  });

  sheet.addEventListener("pointermove", (event) => {
    if (!panning || !last) return;
    noteEvent("drag");
    tally.pointerMove += 1;
    setView(panBy(view, event.clientX - last.x, event.clientY - last.y));
    last = { x: event.clientX, y: event.clientY };
  });

  const endPan = (): void => {
    if (!panning) return;
    panning = false;
    last = null;
    tally.pointerUp += 1;
    sheet.classList.remove("dragging");
    render();
  };
  sheet.addEventListener("pointerup", endPan);
  sheet.addEventListener("pointercancel", () => {
    devLog("warn", "workspace probe: the pan gesture was cancelled by something above us");
    endPan();
  });

  sheet.addEventListener(
    "wheel",
    (event) => {
      noteEvent("wheel");
      tally.wheel += 1;
      if (event.cancelable) {
        tally.wheelCancelable += 1;
        // Measured at 86 of 86 cancelable, so this reliably stops the page doing anything of its
        // own with the gesture.
        event.preventDefault();
      }

      // Recorded, not acted on — see `wheelShape`.
      wheelShape.modes.add(event.deltaMode);
      const magnitude = Math.abs(event.deltaY);
      if (magnitude > 0) {
        wheelShape.smallestAbsDelta = Math.min(wheelShape.smallestAbsDelta, magnitude);
        wheelShape.largestAbsDelta = Math.max(wheelShape.largestAbsDelta, magnitude);
        if (!Number.isInteger(event.deltaY)) wheelShape.fractional += 1;
      }
      if (event.ctrlKey) wheelShape.withCtrl += 1;

      // Which axes arrived, and whether the two gestures ever mix. See `wheelShape`.
      if (event.deltaX !== 0 && event.deltaY !== 0) wheelShape.bothAxes += 1;
      else if (event.deltaX !== 0) wheelShape.xOnly += 1;
      else if (event.deltaY !== 0) wheelShape.yOnly += 1;
      if (event.ctrlKey && event.deltaX !== 0) wheelShape.pinchWithX += 1;

      const now = performance.now();
      if (
        wheelShape.lastWasCtrl !== null &&
        wheelShape.lastWasCtrl !== event.ctrlKey &&
        now - wheelShape.lastAt < GESTURE_GAP_MS
      ) {
        wheelShape.interleaved += 1;
      }
      wheelShape.lastWasCtrl = event.ctrlKey;
      wheelShape.lastAt = now;

      /*
        Three intents down one event, from two devices.

        Treating them as one is what made a two-finger scroll zoom the map, and what made a pinch
        apply a full notch per event. `classifyWheel` carries the reasoning and the measurements it
        came from.
      */
      const intent = classifyWheel(event);
      wheelShape.intents[intent] += 1;
      wheelShape.lastIntent = intent;

      // The browser's own sign convention, so whatever the OS is set to — natural scrolling or not
      // — this follows it rather than second-guessing it.
      const direction = panInverted ? -1 : 1;

      if (intent === "pan") {
        setView(panBy(view, -event.deltaX * direction, -event.deltaY * direction));
      } else if (intent === "zoom-pinch") {
        /*
          A pinch zooms by its vertical delta and pans by its horizontal one, in the same event.

          Reported from a room: a pinch cannot be combined with a drag, the way it can in most
          applications. Dropping `deltaX` here was one way that could happen and it is ours to fix,
          so it is fixed whether or not it turns out to be the cause — a sideways component that
          arrives and is discarded is a bug regardless of what else is wrong.

          The other possible cause is not ours: a browser may decide a gesture is a pinch or a
          scroll and never both, in which case the pan half never reaches this page at all. The
          `interleaved` and `pinchWithX` counts are what tell those apart.
        */
        const zoomed = zoomAbout(
          view,
          { x: event.clientX, y: event.clientY },
          pinchFactor(wheelInverted ? -event.deltaY : event.deltaY, pinchSensitivity),
        );
        setView(event.deltaX !== 0 ? panBy(zoomed, -event.deltaX * direction, 0) : zoomed);
      } else {
        setView(
          zoomAbout(
            view,
            { x: event.clientX, y: event.clientY },
            wheelFactor(event.deltaY, zoomStepPercent, wheelInverted),
          ),
        );
      }
      render();
    },
    // Explicitly non-passive: the root defaults to passive in Chrome and Firefox, where
    // `preventDefault` is ignored and a warning logged instead.
    { passive: false },
  );

  sheet.addEventListener("contextmenu", (event) => {
    tally.contextMenu += 1;
    event.preventDefault();
    render();
  });
}

window.addEventListener("resize", () => {
  dirty = true;
  render();
});

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

let anyPointerYet = false;
document.addEventListener(
  "pointerdown",
  () => {
    anyPointerYet = true;
  },
  true,
);
document.addEventListener(
  "contextmenu",
  () => {
    anyPointerYet = true;
  },
  true,
);

/**
 * Log the feel constants whenever they move.
 *
 * This is the probe's actual output. Whatever value the run settles on is the one the workspace
 * gets built with, and a number that only ever existed on screen is one that has to be found again
 * next session.
 */
function logStep(): void {
  devLog(
    "info",
    `workspace probe (${variant}): feel — notch ${zoomStepPercent}% per wheel step, ` +
      `pinch ${pinchSensitivity.toFixed(2)}% per trackpad pixel` +
      `${wheelInverted ? ", zoom INVERTED" : ""}${panInverted ? ", pan INVERTED" : ""} ` +
      `— scale ${view.scale.toFixed(3)}`,
  );
}

window.addEventListener("keydown", (event) => {
  noteEvent("key");
  tally.keyDown += 1;
  if (!anyPointerYet) tally.keysBeforeAnyPointer += 1;

  // Logged the instant it arrives, because a modal torn down by Owlbear writes no closing summary
  // and the first key is the evidence that the claim worked.
  if (tally.keyDown === 1) {
    devLog(
      "info",
      `workspace probe (${variant}): FIRST KEY "${event.key}" reached the modal ` +
        `${anyPointerYet ? "after a click" : "with NO click"}, keyboard ` +
        `${focusAttempt.held ? `claimed ${focusAttempt.claimedAtMs.toFixed(0)}ms in` : "NOT claimed"}`,
    );
  }

  switch (event.key) {
    case "Escape":
      event.preventDefault();
      dismiss("Escape pressed");
      return;
    case "f":
      if (mapImage) {
        setView(
          fitToViewport(
            { width: mapImage.naturalWidth, height: mapImage.naturalHeight },
            viewportSize(),
            24,
          ),
        );
      }
      break;
    case "r":
      if (openingView) setView(openingView);
      break;
    case ",":
      pinchSensitivity = Math.max(MIN_PINCH, Math.round((pinchSensitivity - PINCH_NUDGE) * 100) / 100);
      logStep();
      break;
    case ".":
      pinchSensitivity = Math.min(MAX_PINCH, Math.round((pinchSensitivity + PINCH_NUDGE) * 100) / 100);
      logStep();
      break;
    case "p":
      panInverted = !panInverted;
      logStep();
      break;
    case "[":
      zoomStepPercent = Math.max(MIN_ZOOM_STEP, zoomStepPercent - ZOOM_STEP_NUDGE);
      logStep();
      break;
    case "]":
      zoomStepPercent = Math.min(MAX_ZOOM_STEP, zoomStepPercent + ZOOM_STEP_NUDGE);
      logStep();
      break;
    case "i":
      wheelInverted = !wheelInverted;
      logStep();
      break;
    case "m":
      showMaskLayer = !showMaskLayer;
      // Cleared, so the comparison is between two settled numbers rather than a blend of both.
      frames.drawMs.length = 0;
      frames.frameMs.length = 0;
      dirty = true;
      break;
    case "h":
      hud?.classList.toggle("hidden");
      break;
    default:
      break;
  }
  render();
});

if (closeButton) {
  closeButton.addEventListener("click", () => dismiss("close button clicked"));
}

// ---------------------------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------------------------

function claimTheKeyboard(): void {
  if (stopped || focusAttempt.held) return;

  // The last honest reading of the unasked state, taken once, before we interfere with it.
  if (!focusAttempt.made) focusAttempt.before = document.hasFocus();

  focusAttempt.tries += 1;
  try {
    // Both calls, because they succeed independently: `window.focus()` asks the embedder to give
    // this frame the keyboard at all, and focusing an element decides where a key goes once it
    // arrives. Measured in a room, they do come apart.
    window.focus();
    if (sheet instanceof HTMLElement) sheet.focus({ preventScroll: true });
  } catch (error) {
    devLog("warn", "workspace probe: asking for focus threw", describeError(error));
  }
  focusAttempt.made = true;

  window.setTimeout(() => {
    if (stopped) return;
    const active = document.activeElement;
    const activeName =
      active instanceof HTMLElement && active.id
        ? `#${active.id}`
        : active
          ? active.tagName.toLowerCase()
          : "none";

    if (document.hasFocus()) {
      focusAttempt.held = true;
      focusAttempt.claimedAtMs = performance.now() - opened;
      focusAttempt.note = `claimed on try ${focusAttempt.tries} at ${focusAttempt.claimedAtMs.toFixed(0)}ms`;
      devLog(
        "info",
        `workspace probe (${variant}): keyboard CLAIMED ${focusAttempt.claimedAtMs.toFixed(0)}ms ` +
          `after load, on try ${focusAttempt.tries}, activeElement ${activeName}. ` +
          "Anything typed before this went to Owlbear.",
      );
      render();
      return;
    }

    if (performance.now() - opened < FOCUS_RETRY_LIMIT_MS) {
      // Silent between attempts: thirty lines saying "still not ours" would bury the one that
      // matters, which is the moment it becomes ours.
      focusAttempt.note = `asking… ${focusAttempt.tries} tries`;
      window.setTimeout(claimTheKeyboard, FOCUS_RETRY_MS);
      return;
    }

    focusAttempt.note = `NEVER claimed — ${focusAttempt.tries} tries, activeElement ${activeName}`;
    const alreadySaid = focusAttempt.gaveUp;
    focusAttempt.gaveUp = true;
    if (!alreadySaid) {
      devLog(
        "error",
        `workspace probe (${variant}): keyboard NEVER claimed after ${focusAttempt.tries} tries ` +
          `over ${FOCUS_RETRY_LIMIT_MS}ms — activeElement ${activeName}. Every key goes to Owlbear.`,
      );
    }
    render();
  }, FOCUS_SETTLE_MS);
}

/**
 * Notice the keyboard going back to Owlbear.
 *
 * **It does not fight back.** Re-focusing on every blur would mean a page that will not let the GM
 * alt-tab away from it, which is worse than a lost shortcut. The pointerdown handler takes it back
 * on a deliberate press instead.
 */
window.addEventListener("blur", () => {
  if (stopped || !focusAttempt.held) return;
  focusAttempt.held = false;
  focusAttempt.losses += 1;
  focusAttempt.note = `LOST the keyboard (${focusAttempt.losses}x) — click to take it back`;
  devLog("warn", `workspace probe (${variant}): LOST keyboard focus, ${focusAttempt.losses}x`);
  render();
});

// ---------------------------------------------------------------------------------------------
// Load, and the leak detector
// ---------------------------------------------------------------------------------------------

/**
 * Load the map image for drawing.
 *
 * Written here rather than reusing the pipeline's loader because that one decodes to pixels and
 * plans a raster budget — the expensive half, and none of it is wanted for drawing. There is no way
 * for two copies of `new Image()` to disagree about anything.
 *
 * `crossOrigin` is set even though drawing alone would not need it: the pipeline proves the CDN
 * sends the headers, and matching it means this probe cannot succeed where the real thing fails.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the map image failed to load"));
    image.src = url;
  });
}

/**
 * A stand-in for stage one's mask, at the map's own resolution.
 *
 * Not a real mask and not pretending to be — what it has to share with one is its **size**, since
 * the frame cost being measured is that of pushing two map-sized textures per frame. Sparse marks
 * rather than a fill, so the map stays readable underneath and the layer is visibly present.
 */
function buildMaskStandIn(width: number, height: number): HTMLCanvasElement | null {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const context = layer.getContext("2d");
  if (!context) return null;

  context.fillStyle = "rgba(255, 96, 160, 0.55)";
  const step = 64;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      context.fillRect(x, y, 26, 26);
    }
  }
  return layer;
}

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "workspace"));
  } catch (error) {
    devLog("warn", "workspace probe: could not read player role", describeError(error));
  }

  devLog("info", `workspace probe (${variant}): modal is alive and running its own script`);

  const [viewWidth, viewHeight] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);

  /*
    Two fixed world points to watch for a leak.

    Derived from screen corners rather than from the map, so the detector works even in a scene with
    nothing nominated. Two rather than one because a zoom centred exactly on a single probe point
    leaves it fixed and the whole gesture goes unobserved.
  */
  const [worldA, worldB] = await Promise.all([
    OBR.viewport.inverseTransformPoint({ x: 0, y: 0 }),
    OBR.viewport.inverseTransformPoint({ x: viewWidth, y: viewHeight }),
  ]);

  const map = await resolveTraceMap();
  if (!map) {
    mapNote = "none nominated — navigating empty ground";
    devLog("warn", "workspace probe: no map nominated, so there is nothing to navigate");
  } else {
    try {
      const image = await loadImage(map.image.url);
      mapImage = image;
      maskLayer = buildMaskStandIn(image.naturalWidth, image.naturalHeight);
      mapNote = `${map.name || "map"} ${image.naturalWidth}x${image.naturalHeight}`;

      /*
        Open on exactly what Owlbear is showing.

        Ask where the map's own world corners currently sit on screen and build the view from that
        rectangle. Nothing appears to jump when the sheet goes up — and, the reason it is worth two
        calls, the two navigations then start from the same framing, so comparing how they *feel* is
        not confounded by comparing what they show.
      */
      const bounds = await OBR.scene.items.getItemBounds([map.id]);
      const [cornerA, cornerB] = await Promise.all([
        OBR.viewport.transformPoint({ x: bounds.min.x, y: bounds.min.y }),
        OBR.viewport.transformPoint({ x: bounds.max.x, y: bounds.max.y }),
      ]);
      openingView = viewFromScreenRect(cornerA, cornerB, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setView(openingView);
      devLog(
        "info",
        `workspace probe (${variant}): opened on Owlbear's own view — ` +
          `scale ${openingView.scale.toFixed(4)} at (${openingView.x.toFixed(0)}, ` +
          `${openingView.y.toFixed(0)}), map ${image.naturalWidth}x${image.naturalHeight}, ` +
          `zoom step ${zoomStepPercent}% per notch`,
      );
    } catch (error) {
      mapNote = "failed to load — see the console";
      devLog("error", "workspace probe: could not load the map image", describeError(error));
      console.error("Fog Nudger — workspace probe could not load the map image", error);
    }
  }

  if (mapImage && !openingView) {
    // The fallback when the view could not be inherited: fitted and centred, which is at least a
    // framing rather than a guess.
    setView(
      fitToViewport(
        { width: mapImage.naturalWidth, height: mapImage.naturalHeight },
        viewportSize(),
        24,
      ),
    );
  }
  render();

  let previous: { a: ScreenPoint; b: ScreenPoint } | null = null;

  const poll = async (): Promise<void> => {
    const started = performance.now();
    const [a, b] = await Promise.all([
      OBR.viewport.transformPoint(worldA),
      OBR.viewport.transformPoint(worldB),
    ]);
    const cost = performance.now() - started;
    tally.polls += 1;
    tally.totalPollMs += cost;
    tally.worstPollMs = Math.max(tally.worstPollMs, cost);

    if (previous && (pointMoved(previous.a, a) || pointMoved(previous.b, b))) {
      if (selfTest.active) {
        selfTest.movementsSeen += 1;
      } else {
        const channel = attributeMovement(started, lastEventAt);
        tally.blamed[channel] += 1;
        if (tally.blamed[channel] <= MOVEMENTS_LOGGED_PER_CHANNEL) {
          devLog(
            "warn",
            `workspace probe (${variant}): Owlbear's view MOVED — blamed on ${channel} ` +
              `(#${tally.blamed[channel]}). Our navigation is reaching Owlbear underneath.`,
          );
        }
      }
    }
    previous = { a, b };
    render();
  };

  // A chain of timeouts rather than an interval, so a slow poll cannot overlap the next.
  const loop = (): void => {
    if (stopped) return;
    void poll()
      .catch((error: unknown) => {
        devLog("error", "workspace probe: poll failed", describeError(error));
      })
      .finally(() => {
        if (!stopped) window.setTimeout(loop, POLL_MS);
      });
  };
  loop();

  window.setTimeout(() => void runSelfTest(), SELF_TEST_AT_MS);
}

/**
 * Move the viewport deliberately, and find out whether the detector notices.
 *
 * "Owlbear moved 0 times" and "the movement check is broken" produce identical output, and that
 * zero was reported four runs before anything checked that it could report anything else. It
 * matters more here than it did for the input probe: **a pan that also panned Owlbear is exactly
 * the failure that would kill this surface**, and behind an opaque sheet it is invisible.
 */
async function runSelfTest(): Promise<void> {
  if (stopped) return;

  try {
    const start = await OBR.viewport.getPosition();
    selfTest.active = true;
    selfTest.movementsSeen = 0;

    await OBR.viewport.setPosition({ x: start.x + SELF_TEST_NUDGE, y: start.y });
    await new Promise((resolve) => window.setTimeout(resolve, SELF_TEST_SETTLE_MS));
    await OBR.viewport.setPosition(start);
    await new Promise((resolve) => window.setTimeout(resolve, SELF_TEST_SETTLE_MS));

    selfTest.active = false;
    selfTest.ran = true;

    const working = selfTest.movementsSeen > 0;
    selfTest.note = working
      ? `works (saw ${selfTest.movementsSeen}/2)`
      : "BLIND — every 'Owlbear still' above means nothing";
    devLog(working ? "info" : "error", `workspace probe (${variant}): self-test ${selfTest.note}`);
  } catch (error) {
    selfTest.active = false;
    selfTest.ran = true;
    selfTest.note = "FAILED to run — unverified";
    devLog("error", "workspace probe: self-test failed", describeError(error));
  }

  render();
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

/*
  The dismissal timer is armed at module load, before the SDK is consulted about anything, because
  the way out of an opaque sheet must depend on as little as possible.

  Everything else here that does not need Owlbear starts here too, and that placement was learned
  three times over: the drag pad, both focus paths and the variant label were each written inside
  `run()` first, and each was silently dead until the SDK answered.
*/
window.setTimeout(() => dismiss("lifetime expired"), LIFETIME_MS);
window.setInterval(() => {
  if (!stopped) render();
}, 500);

claimTheKeyboard();
window.requestAnimationFrame(frameLoop);
render();

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces no Owlbear activity. That silence is correct behaviour rather than a failure —
// and the navigation above still works, on empty ground, which is what makes it testable here.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    if (hud) hud.textContent = `Workspace probe failed: ${detail}`;
    devLog("error", "workspace probe: failed", detail);
  });
});
