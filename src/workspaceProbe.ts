/**
 * The workspace probe — can a modal be an **opaque window that owns its own input**?
 *
 * ## Why a probe rather than a feature
 *
 * The ink overlay's modal is measured and works: `fullScreen` + `hideBackdrop` + `hidePaper` +
 * `disablePointerEvents`. The workspace (DESIGN.md §4, "Superseding all of the above") needs that
 * same modal **without** `disablePointerEvents`, and that combination has never been opened — not
 * here, not in the sibling, not in Dynamic Fog. There is nothing to read and nothing to copy.
 *
 * What is unknown is not whether it appears. It is whether the input a working surface would live
 * on actually arrives: drags as drags, a wheel we can cancel, keystrokes without a fight — and,
 * the one that decides the design, whether Owlbear acts on any of it underneath at the same time.
 *
 * ## The measurement that cannot be replaced by looking
 *
 * The sheet is **opaque**. So the map underneath is hidden, so a GM dragging on it cannot see
 * whether the map moved too. The probe's central question is invisible on the probe's own surface,
 * which is why this page does arithmetic rather than just drawing something. It asks Owlbear where
 * two fixed world points are, on a poll, and blames any movement on whichever input channel of
 * ours was most recent.
 *
 * That is a *guess* rather than a proof — it is attribution by timing, and it is labelled as such
 * in `workspaceInput`. It is the strongest thing available from inside an opaque box.
 *
 * ## What is deliberately absent
 *
 * No pan, no zoom, no map, no mask. Navigation is the next conversation and this probe must not
 * pre-empt it; frame cost is worth measuring only with a map-sized image being drawn per frame,
 * which is that same conversation.
 *
 * ## The way out is the experiment
 *
 * An opaque sheet that swallows input is a worse trap than a transparent click-through one, so
 * there are three independent ways to dismiss it and they do not share a mechanism:
 *
 * - **the timer**, which fires whether or not anything on screen can be clicked, and which is armed
 *   before any code that could throw. This is the one that has to work.
 * - **the button**, which is also the pointer-capture test.
 * - **Escape**, which is also the keyboard test.
 *
 * Development only. Draws nothing into the scene and writes nothing anywhere.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { WORKSPACE_PROBE_ID } from "./probe/workspaceProbeControl";
import {
  attributeMovement,
  channelVerdict,
  describeKeyboardFocus,
  pointMoved,
  summariseCapture,
  type InputChannel,
} from "./probe/workspaceInput";
import type { ScreenPoint } from "./probe/viewportSettle";

installDevLog("workspace");

/**
 * How long the probe stays up.
 *
 * Longer than the overlay probe's 25 seconds, because this one asks for four separate gestures —
 * drag, wheel, type, click — and a timer that expires mid-experiment turns a measurement into two
 * measurements. Short enough that being stuck behind an opaque sheet is an annoyance.
 */
const LIFETIME_MS = 60_000;

/**
 * How often Owlbear is asked where our two fixed world points are.
 *
 * The measured cost of that pair is 2–4ms, so this is nowhere near a burden. The rate is chosen
 * for **attribution resolution** instead: a movement is blamed on the most recent input event, and
 * polling slowly widens the interval in which some other event could have slipped in.
 */
const POLL_MS = 150;

/**
 * When focus is sampled, and why not immediately.
 *
 * A newly-opened iframe may be handed focus a beat after its script runs, so reading
 * `document.hasFocus()` at load would report "not focused" about the timing rather than about the
 * modal. The readout names the delay so the sample is not mistaken for an instant one.
 */
const FOCUS_SAMPLE_MS = 300;

/**
 * When the leak detector's control experiment runs.
 *
 * Late enough that the poll loop has a previous reading to compare against, early enough that a
 * short run still gets the answer — a probe closed after five seconds should not be one whose only
 * safety check never happened.
 */
const SELF_TEST_AT_MS = 2_000;

/**
 * How far the viewport is deliberately moved, in its own position units.
 *
 * Far enough to clear the one-pixel stillness threshold at any sane zoom, small enough that if the
 * restore ever failed the GM's camera is a nudge off rather than somewhere else entirely.
 */
const SELF_TEST_NUDGE = 60;

/** How long to hold each end of the nudge, comfortably more than one poll interval. */
const SELF_TEST_SETTLE_MS = 500;

/**
 * When the page asks for keyboard focus, having first measured what it gets without asking.
 *
 * After the passive sample above, deliberately, so the two never blur into one another. Thirteen
 * runs settled the unasked case — no keystroke of any kind reaches this modal until it is clicked,
 * so every key goes to Owlbear underneath — and that measurement is not worth repeating. What is
 * still open is whether the keyboard can be *claimed*, which is the difference between a workspace
 * with shortcuts and a pointer-only one.
 */
const FOCUS_ATTEMPT_MS = 800;

/** How long after asking before the result is read, letting the focus change settle. */
const FOCUS_SETTLE_MS = 150;

/**
 * How many movements to narrate per channel before falling silent and merely counting.
 *
 * A genuine leak during a drag would log one of these every poll and bury the rest of the run.
 * Three is enough to establish that it is happening and roughly when.
 */
const MOVEMENTS_LOGGED_PER_CHANNEL = 3;

const sheet = document.getElementById("sheet");
const pad = document.getElementById("pad");
const typing = document.getElementById("typing");
const closeButton = document.getElementById("close");
const readout = document.getElementById("readout");
const verdicts = document.getElementById("verdicts");
const variantLabel = document.getElementById("variant");

/** Which chrome variant the opener asked for, purely so the readout can name it. */
const variant = new URLSearchParams(window.location.search).get("variant") ?? "unknown";

function say(element: Element | null, html: string): void {
  if (element) element.innerHTML = html;
}

/** Everything the readout reports, in one place so nothing is counted in two. */
const tally = {
  pointerDown: 0,
  pointerMove: 0,
  pointerUp: 0,
  wheel: 0,
  contextMenu: 0,
  keyDown: 0,
  /** Wheel events that arrived `cancelable`, which is what decides whether a zoom can be stopped. */
  wheelCancelable: 0,
  /** Keys seen before any pointer event at all — the proof that focus did not need a click. */
  keysBeforeAnyPointer: 0,
  keysAfterAPointer: 0,
  /**
   * Keys that arrived before the page asked for focus.
   *
   * The only evidence that separates focus we were *given* from focus we *took*. Once the page asks
   * automatically, a key with no click beforehand is explained equally well by either, and the
   * order is the only thing that tells them apart.
   */
  keysBeforeFocusAttempt: 0,
  /** Viewport movements observed, split by which channel of ours was most recent. */
  blamed: { drag: 0, wheel: 0, key: 0, other: 0 } as Record<InputChannel, number>,
  polls: 0,
  worstPollMs: 0,
  totalPollMs: 0,
};

/** When each channel last fired, feeding the attribution of an observed movement. */
const lastEventAt: Record<InputChannel, number | null> = {
  drag: null,
  wheel: null,
  key: null,
  other: null,
};

/**
 * The leak detector's own control experiment.
 *
 * "Owlbear moved 0 times" and "the movement check is broken" produce identical output, and the
 * first three runs of this probe reported that zero and had a conclusion drawn from it. The
 * project's own rule is to treat a clean diagnostic as evidence about the diagnostic until it has
 * failed at least once — so the probe moves the viewport itself, on purpose, and reports whether it
 * noticed.
 *
 * Movements during the self-test are counted **here** and deliberately not blamed on an input
 * channel: the probe caused them, and letting them fall through the ordinary attribution would have
 * the control experiment report itself as a leak.
 */
const selfTest = {
  /** True only while the deliberate movement is in flight. */
  active: false,
  ran: false,
  movementsSeen: 0,
  note: "not run yet",
};

/**
 * What happened when the page asked for the keyboard.
 *
 * Kept apart from `hadFocusAtOpen` because they answer different questions and conflating them
 * would lose the only interesting one: whether asking *changes* anything.
 */
const focusAttempt = {
  made: false,
  /** `document.hasFocus()` immediately before asking, and again after it settled. */
  before: false,
  after: false,
  note: "not attempted yet",
};

let hadFocusAtOpen = false;
let lastPointer = "—";
let lastWheel = "—";
let lastKey = "—";

/** Owlbear's own idea of the viewport, read once at open. */
let viewWidth = 0;
let viewHeight = 0;

let stopped = false;

/**
 * Close the modal.
 *
 * Idempotent by way of `stopped`, because all three exits can race — pressing Escape as the timer
 * fires would otherwise close a modal that is already gone, and the rejection would be logged as a
 * fault when nothing is wrong.
 */
function dismiss(why: string): void {
  if (stopped) return;
  stopped = true;

  const mean = tally.totalPollMs / Math.max(1, tally.polls);
  devLog(
    "info",
    `workspace probe (${variant}): closing — ${why}. ` +
      `pointer ${tally.pointerDown}/${tally.pointerMove}/${tally.pointerUp} down/move/up, ` +
      `wheel ${tally.wheel} (${tally.wheelCancelable} cancelable), ` +
      `context ${tally.contextMenu}, keys ${tally.keyDown} ` +
      `(${tally.keysBeforeAnyPointer} before any click). ` +
      `Owlbear moved ${tally.blamed.drag + tally.blamed.wheel + tally.blamed.key + tally.blamed.other} ` +
      `times: drag ${tally.blamed.drag}, wheel ${tally.blamed.wheel}, key ${tally.blamed.key}, ` +
      `unattributed ${tally.blamed.other}. ` +
      // Reported beside the zero it qualifies, because a zero whose detector was never checked is
      // not the same fact as a zero whose detector demonstrably fires.
      `Detector self-test: ${selfTest.note}. ` +
      `Poll ${mean.toFixed(0)}ms mean, ${tally.worstPollMs.toFixed(0)}ms worst over ${tally.polls}. ` +
      `iframe ${window.innerWidth}x${window.innerHeight} against viewport ${viewWidth}x${viewHeight}.`,
  );

  void OBR.modal.close(WORKSPACE_PROBE_ID).catch((error: unknown) => {
    devLog("error", "workspace probe: could not close itself", describeError(error));
  });
}

/**
 * Note that one of our channels just fired.
 *
 * Every input handler goes through here so there is exactly one place that decides what "recent"
 * means. Two handlers keeping their own timestamps is how one of them ends up not keeping any.
 */
function noteEvent(channel: Exclude<InputChannel, "other">): void {
  lastEventAt[channel] = performance.now();
}

// ---------------------------------------------------------------------------------------------
// The drag pad
// ---------------------------------------------------------------------------------------------

/**
 * The pad draws the trail of every move it receives.
 *
 * A count in the readout says events arrived. A *continuous line* says they arrived at a usable
 * rate and were not delivered as a lonely down and up with a hole between them, which is what a
 * surface that only half-owns a drag would produce — and a hole is the kind of thing a number
 * cannot show and a picture can.
 */
function setUpPad(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  let drawing = false;

  const resize = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width === Math.round(width * ratio) && canvas.height === Math.round(height * ratio)) {
      // Assigning either dimension clears the canvas even when the value is unchanged, which would
      // wipe a trail mid-stroke every time an observer fired for a layout that did not move.
      return;
    }
    // Backing store in device pixels, CSS box in layout pixels, or a one-pixel trail lands as a
    // two-pixel smear on a HiDPI display and a gap in it becomes hard to see.
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  /*
    Sized once, synchronously, and then watched.

    The synchronous call is not redundant with the observer below it. Reading `clientWidth` forces
    layout, so this gets real dimensions even at module load — whereas a `ResizeObserver`'s first
    delivery is scheduled with the rendering steps, and a page that is not being painted may not get
    one at all. Leaving the initial sizing to the observer means a first drag drawn into the canvas
    element's 300x150 default, which is what happened when this was observer-only: the trail
    appeared, in the wrong place, at the wrong scale.
  */
  resize();

  /*
    A `ResizeObserver` on the canvas, not a window resize listener.

    The window listener was the first draft and it was wrong in a way that matters here more than
    almost anywhere: this canvas is sized by flex against its siblings, so it reflows when the
    *readout below it grows*, with no window resize to hear. Measured at 1074x550 in the box against
    a 1074x658 backing store — the pad would have drawn every trail displaced from the cursor that
    made it, on the one surface whose entire job is showing that a drag registers where it happened.
  */
  new ResizeObserver(resize).observe(canvas);

  const at = (event: PointerEvent): ScreenPoint => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  canvas.addEventListener("pointerdown", (event) => {
    noteEvent("drag");
    tally.pointerDown += 1;
    drawing = true;
    // Capture, so a drag that leaves the pad keeps reporting. Without it a fast gesture ends at the
    // pad's edge and the trail would show a break that is ours rather than Owlbear's.
    //
    // Guarded because `setPointerCapture` throws on a pointer the browser no longer considers
    // active, and an exception here would abandon the rest of the handler — losing the trail and
    // the readout for the gesture that was being measured. A capture that fails is worth knowing
    // about; it is not worth losing the measurement over.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      devLog("warn", "workspace probe: could not capture the pointer", describeError(error));
    }
    const point = at(event);
    lastPointer = `down at ${point.x.toFixed(0)}, ${point.y.toFixed(0)} (${event.pointerType})`;
    if (context) {
      context.strokeStyle = "#bb99ff";
      context.lineWidth = 2;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(point.x, point.y);
    }
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    noteEvent("drag");
    tally.pointerMove += 1;
    const point = at(event);
    lastPointer = `move at ${point.x.toFixed(0)}, ${point.y.toFixed(0)}`;
    if (context) {
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    render();
  });

  const finish = (event: PointerEvent): void => {
    if (!drawing) return;
    noteEvent("drag");
    tally.pointerUp += 1;
    drawing = false;
    const point = at(event);
    lastPointer = `up at ${point.x.toFixed(0)}, ${point.y.toFixed(0)}`;
    render();
  };
  canvas.addEventListener("pointerup", finish);
  // A cancel is a real answer rather than a tidy-up: it means something above us took the gesture
  // away mid-drag, which for a painting surface is the same failure as never getting it.
  canvas.addEventListener("pointercancel", (event) => {
    lastPointer = "POINTERCANCEL — the gesture was taken away";
    finish(event);
  });
}

// ---------------------------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------------------------

function render(): void {
  const dragVerdict = channelVerdict(tally.pointerDown, tally.blamed.drag);
  const wheelVerdict = channelVerdict(tally.wheel, tally.blamed.wheel);
  const capture = summariseCapture({ drag: dragVerdict, wheel: wheelVerdict });

  const focus = describeKeyboardFocus({
    hadFocusAtOpen,
    keysBeforeAnyPointer: tally.keysBeforeAnyPointer,
    keysAfterAPointer: tally.keysAfterAPointer,
    focusWasAsked: focusAttempt.made,
    keysBeforeFocusAttempt: tally.keysBeforeFocusAttempt,
  });

  const leaked = dragVerdict === "leaking" || wheelVerdict === "leaking";
  say(
    verdicts,
    `<b>input capture</b>\n` +
      `${leaked ? `<span class="bad">${capture}</span>` : capture}\n` +
      `<b>keyboard</b>\n${focus}\n${focusAttempt.note}`,
  );

  const remaining = Math.max(0, LIFETIME_MS - (performance.now() - opened));
  const meanPoll = tally.totalPollMs / Math.max(1, tally.polls);
  /*
    The viewport is 0x0 until Owlbear has answered, and a difference computed against zero produces
    a confident negative "frame cost" — a number where the honest answer is "not known yet". Same
    failure as the coverage line that reported 0.00% bare on a map with bare patches: an arithmetic
    result standing in for a measurement that never happened.
  */
  const viewportKnown = viewWidth > 0 && viewHeight > 0;
  const sameRect = window.innerWidth === viewWidth && window.innerHeight === viewHeight;

  say(
    readout,
    `pointer   down ${tally.pointerDown} · move ${tally.pointerMove} · up ${tally.pointerUp} · ${lastPointer}\n` +
      `wheel     ${tally.wheel} events, ${tally.wheelCancelable} cancelable · ${lastWheel}\n` +
      `context   ${tally.contextMenu} right-clicks reached us\n` +
      `keys      ${tally.keyDown} · last ${lastKey} · document.hasFocus() ${document.hasFocus()}\n` +
      `\n` +
      `Owlbear moved underneath: drag ${tally.blamed.drag} · wheel ${tally.blamed.wheel} · ` +
      `key ${tally.blamed.key} · unattributed ${tally.blamed.other}\n` +
      `  (unattributed is not a leak — another player panning looks like this)\n` +
      `detector  ${
        selfTest.ran && selfTest.movementsSeen === 0
          ? `<span class="bad">${selfTest.note}</span>`
          : selfTest.note
      }\n` +
      `poll      ${meanPoll.toFixed(0)}ms mean, ${tally.worstPollMs.toFixed(0)}ms worst over ${tally.polls}\n` +
      `\n` +
      `iframe    ${window.innerWidth}x${window.innerHeight} · Owlbear viewport ` +
      (!viewportKnown
        ? "not read yet"
        : sameRect
          ? `${viewWidth}x${viewHeight} (same rectangle)`
          : `${viewWidth}x${viewHeight} <b>(frame costs ` +
            `${viewWidth - window.innerWidth}x${viewHeight - window.innerHeight})</b>`) +
      `\n` +
      `closes in ${(remaining / 1000).toFixed(0)}s`,
  );
}

/**
 * When the sheet went up, and the single origin for both the countdown and the dismissal timer.
 *
 * Set at module load and never reassigned — see the timer's own note further down for why that
 * matters more here than it would on a click-through overlay.
 */
const opened = performance.now();

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "workspace"));
  } catch (error) {
    devLog("warn", "workspace probe: could not read player role", describeError(error));
  }

  devLog("info", `workspace probe (${variant}): modal is alive and running its own script`);
  say(variantLabel, `· ${variant}`);

  [viewWidth, viewHeight] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);

  /*
    Two fixed world points to watch.

    Derived from screen corners at open rather than from the map's bounds, so the probe works in a
    scene with no map nominated — it is testing the surface, not the pipeline. Two rather than one
    because a zoom centred exactly on a single probe point leaves it fixed, and the whole gesture
    would go unobserved; that is the same reasoning the ink overlay uses, and the same pair of
    calls.
  */
  const [worldA, worldB] = await Promise.all([
    OBR.viewport.inverseTransformPoint({ x: 0, y: 0 }),
    OBR.viewport.inverseTransformPoint({ x: viewWidth, y: viewHeight }),
  ]);

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
        // The probe moved the view itself. Counted as proof the detector works, never as a leak.
        selfTest.movementsSeen += 1;
      } else {
        // Blame the movement on whichever of our channels fired most recently before it.
        // Attribution by timing is a guess, and it is the only one available from inside an opaque
        // box.
        const channel = attributeMovement(started, lastEventAt);
        tally.blamed[channel] += 1;

        /*
          Written the moment it happens, not only in the closing summary.

          Owlbear tears this modal down on Escape without our dismissal ever running, and two runs
          in the last session ended that way — reporting nothing at all about leaks, because the
          only line that carries the tally is the one that never got written. A movement is the
          single most important thing this page can observe, so it should not depend on being able
          to say goodbye.

          Capped, because a real leak during a drag would produce one of these per poll and bury
          everything else in the log. Past the cap they are still counted, just not narrated.
        */
        if (tally.blamed[channel] <= MOVEMENTS_LOGGED_PER_CHANNEL) {
          devLog(
            "warn",
            `workspace probe (${variant}): Owlbear's view MOVED — blamed on ${channel} ` +
              `(#${tally.blamed[channel]} for that channel). Input is reaching Owlbear underneath.`,
          );
        }
      }
    }
    previous = { a, b };
    render();
  };

  // A chain of timeouts rather than an interval, so a slow poll cannot overlap the next and turn a
  // contended bus into a queue that never drains.
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

  window.setTimeout(() => {
    void runSelfTest();
  }, SELF_TEST_AT_MS);
}

/**
 * Ask for the keyboard, and report honestly whether asking worked.
 *
 * Both calls are made because they can succeed independently: `window.focus()` asks the embedder to
 * hand this frame the keyboard at all, and focusing an element decides where a key goes once it
 * arrives. Either alone could leave the other half unsatisfied, and the failure would look the
 * same — nothing happening.
 *
 * The result is deliberately not trusted from `document.hasFocus()` alone. A frame can report focus
 * and still not be where keys land, so the honest confirmation is a keystroke actually arriving,
 * which the first-key line records with the attempt's state attached.
 */
function claimTheKeyboard(): void {
  if (stopped) return;

  focusAttempt.before = document.hasFocus();
  try {
    window.focus();
    if (sheet instanceof HTMLElement) sheet.focus({ preventScroll: true });
  } catch (error) {
    devLog("warn", "workspace probe: asking for focus threw", describeError(error));
  }
  focusAttempt.made = true;

  window.setTimeout(() => {
    focusAttempt.after = document.hasFocus();
    const active = document.activeElement;
    // Both halves, never one verdict. Focusing an element and the frame holding the keyboard are
    // separate things that fail separately, and the first measurement of this showed exactly that
    // split: activeElement became the sheet while document.hasFocus() stayed false.
    focusAttempt.note =
      `asked at ${FOCUS_ATTEMPT_MS}ms — hasFocus ${focusAttempt.before} → ` +
      `${focusAttempt.after}, activeElement ${active instanceof HTMLElement && active.id ? `#${active.id}` : active ? active.tagName.toLowerCase() : "none"}`;
    devLog(
      "info",
      `workspace probe (${variant}): asked for the keyboard — document.hasFocus() went ` +
        `${focusAttempt.before} → ${focusAttempt.after}, activeElement is ` +
        `${active ? active.tagName.toLowerCase() : "none"}` +
        `${active instanceof HTMLElement && active.id ? `#${active.id}` : ""}. ` +
        "Only a key actually arriving proves it worked.",
    );
    render();
  }, FOCUS_SETTLE_MS);
}

/**
 * Move the viewport deliberately, and find out whether the detector notices.
 *
 * The nudge is in the viewport's own position units and is put straight back, so the net effect on
 * the GM's camera is nothing. It happens behind an opaque sheet, so there is nothing to see either
 * way — which is precisely why the answer has to be a number.
 *
 * `viewport.setPosition` moves this client's camera only; it is not scene state and no other player
 * sees it.
 */
async function runSelfTest(): Promise<void> {
  if (stopped) return;

  try {
    const start = await OBR.viewport.getPosition();
    devLog(
      "info",
      `workspace probe (${variant}): self-test — nudging the viewport ${SELF_TEST_NUDGE} from ` +
        `(${start.x.toFixed(0)}, ${start.y.toFixed(0)}) and putting it back`,
    );

    selfTest.active = true;
    selfTest.movementsSeen = 0;

    await OBR.viewport.setPosition({ x: start.x + SELF_TEST_NUDGE, y: start.y });
    // Long enough for several polls at POLL_MS to see the moved state, since one poll landing in
    // the gap would report a working detector as blind.
    await new Promise((resolve) => window.setTimeout(resolve, SELF_TEST_SETTLE_MS));
    await OBR.viewport.setPosition(start);
    await new Promise((resolve) => window.setTimeout(resolve, SELF_TEST_SETTLE_MS));

    selfTest.active = false;
    selfTest.ran = true;

    // Two movements are expected — out and back. One is enough to prove the detector is not blind,
    // which is the whole claim being tested; the count is reported so a partial answer is visible
    // rather than rounded up to a pass.
    const working = selfTest.movementsSeen > 0;
    selfTest.note = working
      ? `saw ${selfTest.movementsSeen} of an expected 2 — the detector works`
      : `saw NOTHING — the detector is blind, so every "Owlbear moved 0 times" above means nothing`;
    devLog(working ? "info" : "error", `workspace probe (${variant}): self-test ${selfTest.note}`);
  } catch (error) {
    selfTest.active = false;
    selfTest.ran = true;
    selfTest.note = "FAILED to run — the detector is unverified";
    devLog("error", "workspace probe: self-test failed", describeError(error));
  }

  render();
}

// ---------------------------------------------------------------------------------------------
// Input wiring — installed at module load, before the SDK is involved in anything
// ---------------------------------------------------------------------------------------------

/*
  These listeners are attached now rather than inside `run()` deliberately. If the SDK never becomes
  ready, or `run()` throws on its first await, the page must still be able to demonstrate whether it
  receives input at all — that is the question, and it does not depend on Owlbear answering.
*/

/*
  Both focus timers are started here, at module load, and not inside `run()`.

  Focus is a browser fact with nothing to do with Owlbear being ready, and putting these in `run()`
  made them wait on two SDK round trips first — so a constant named for 300ms after load would have
  measured 300ms after Owlbear answered, which on a cold open was two and a half seconds later. A
  measurement labelled with a time it did not happen at is worse than no measurement, because it
  gets quoted.
*/
window.setTimeout(() => {
  hadFocusAtOpen = document.hasFocus();
  devLog(
    "info",
    `workspace probe (${variant}): ${FOCUS_SAMPLE_MS}ms after load, document.hasFocus() is ` +
      `${hadFocusAtOpen} — whether the modal is focused without being clicked or asking`,
  );
  render();
}, FOCUS_SAMPLE_MS);

window.setTimeout(claimTheKeyboard, FOCUS_ATTEMPT_MS);

// The pad is the primary pointer test, so it is wired here with everything else rather than inside
// `run()`. It sat there in the first draft and the consequence was immediate: outside a room
// nothing reached it, because `OBR.onReady` never fires — the one surface whose whole purpose is
// receiving drags was the one surface that could not receive them until Owlbear said so.
if (pad instanceof HTMLCanvasElement) setUpPad(pad);

if (sheet) {
  sheet.addEventListener(
    "wheel",
    (event) => {
      noteEvent("wheel");
      tally.wheel += 1;
      if (event.cancelable) {
        tally.wheelCancelable += 1;
        // Whether this actually stops Owlbear zooming is the measurement. A listener registered
        // passively could not even try, which is why the option below is explicit.
        event.preventDefault();
      }
      lastWheel = `deltaY ${event.deltaY.toFixed(0)}, ${
        event.cancelable ? "cancelable" : "NOT cancelable"
      }`;
      render();
    },
    // Chrome and Firefox default wheel listeners on the root to passive, where `preventDefault` is
    // ignored and a warning is logged. Saying so explicitly is the difference between owning the
    // wheel and merely watching it go past.
    { passive: false },
  );

  sheet.addEventListener("contextmenu", (event) => {
    tally.contextMenu += 1;
    // Suppressed because a workspace would want the right button for its own purposes. Whether
    // Owlbear's own menu appears anyway is part of the answer.
    event.preventDefault();
    render();
  });

  // A pointerdown anywhere, not just on the pad, is what "the modal has been clicked" means for
  // the keyboard-focus question.
  sheet.addEventListener("pointerdown", () => {
    if (lastEventAt.drag === null) noteEvent("drag");
  });
}

/*
  "Has this modal been clicked yet" is tracked on the document, in the capture phase, and
  separately from every other counter.

  The obvious version reads `tally.pointerDown`, and it is wrong in a way that would have been
  believed: that counter only rises on the *pad*. Clicking the text box or the close button would
  leave it at zero, so a key pressed afterwards would be filed as arriving "before any pointer" and
  the readout would claim focus was ours on open — a confident answer to the exact question being
  asked, produced by a click it did not notice. Capture phase because a handler that stops
  propagation must not be able to hide the click from this.
*/
let anyPointerYet = false;
document.addEventListener("pointerdown", () => { anyPointerYet = true; }, true);
document.addEventListener("contextmenu", () => { anyPointerYet = true; }, true);

window.addEventListener("keydown", (event) => {
  noteEvent("key");
  tally.keyDown += 1;
  lastKey = event.key;
  // "Before any pointer" is the proof that focus arrived without a click, so it is counted against
  // whether anything has been pressed rather than against the focus flag — a flag samples one
  // moment, and this is a fact about the whole session.
  if (!anyPointerYet) tally.keysBeforeAnyPointer += 1;
  else tally.keysAfterAPointer += 1;
  if (!focusAttempt.made) tally.keysBeforeFocusAttempt += 1;

  /*
    The first key is logged the instant it arrives, rather than only in the closing summary.

    Escape can end this modal two ways and they look identical from a chair: our handler below, or
    Owlbear closing it over our heads without the key ever reaching this iframe. The summary cannot
    tell them apart, because in the second case there is no summary — the page is gone. A line
    written at the moment of the keystroke survives that, so an Escape pressed before any click
    either leaves this line behind or proves the key never got here.
  */
  if (tally.keyDown === 1) {
    devLog(
      "info",
      `workspace probe (${variant}): FIRST KEY "${event.key}" reached the modal ` +
        `${anyPointerYet ? "after a click" : "with NO click"}, ` +
        // Deliberately the same sentence the readout shows, from the same function, so the log and
        // the screen cannot disagree about what was concluded from one keystroke.
        describeKeyboardFocus({
          hadFocusAtOpen,
          keysBeforeAnyPointer: tally.keysBeforeAnyPointer,
          keysAfterAPointer: tally.keysAfterAPointer,
          focusWasAsked: focusAttempt.made,
          keysBeforeFocusAttempt: tally.keysBeforeFocusAttempt,
        }),
    );
  }

  if (event.key === "Escape") {
    event.preventDefault();
    dismiss("Escape pressed — keyboard reaches us");
  }
  render();
});

if (closeButton) {
  closeButton.addEventListener("click", () => {
    dismiss("close button clicked — pointer input reaches us");
  });
}

if (typing instanceof HTMLInputElement) {
  // Not focused programmatically, on purpose. Calling `focus()` here would guarantee the answer to
  // "does this surface get keyboard focus on its own", which is one of the things being asked.
  typing.addEventListener("input", render);
}

// ---------------------------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------------------------

/*
  The dismissal timer is armed at module load, before the SDK is consulted about anything.

  The overlay probe sets its own timer at the end of its run, after several awaits — survivable
  there because that sheet is click-through and a GM can simply carry on. Here the sheet is opaque
  and may, for all anyone yet knows, swallow every click aimed at the button, so the way out must
  depend on as little as possible. Arming it inside `OBR.onReady` would make it depend on the SDK
  becoming ready, which is a thing that can fail to happen; arming it here does not, and inside a
  room `onReady` fires anyway so nothing is lost.

  It also gives the countdown and the timer a single origin. Two clocks started at different
  moments would drift, and a readout saying "closes in 3s" over a sheet that stays up is the sort
  of small lie that gets a working mechanism mistrusted.
*/
window.setTimeout(() => dismiss("lifetime expired"), LIFETIME_MS);

// Keep the countdown honest even when nothing is being touched; every other render is driven by an
// event or a poll, and both stop if the SDK never answers.
window.setInterval(() => {
  if (!stopped) render();
}, 500);

render();

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces no Owlbear activity. That silence is correct behaviour rather than a failure —
// and everything above this line still works, which is what makes the page's own input testable
// without a room.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    say(readout, `Workspace probe failed: ${detail}`);
    devLog("error", "workspace probe: failed", detail);
  });
});
