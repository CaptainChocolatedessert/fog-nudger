/**
 * The stage-one overlay probe — does a modal work as a transparent, click-through sheet over the
 * map, and how fast can it follow one?
 *
 * ## Why a probe rather than a feature
 *
 * The overlay idea rests on four things the SDK's types state as flag names and nothing more:
 * whether `hidePaper` and `hideBackdrop` produce real transparency, whether `disablePointerEvents`
 * really passes a drag through to the map, whether this iframe's pixels are the viewport's pixels,
 * and what a full-screen modal covers. Neither Dynamic Fog nor the sibling project opens a modal at
 * all, so there is no precedent to read either. One of those — the click-through — is fatal if it
 * goes the wrong way, because a GM who cannot pan while the overlay is up has no overlay.
 *
 * This is the same shape as the sibling's nine-cell shader probe and its data-URL ladder: build the
 * cheapest thing that makes every unknown visible at once, look at it in a room, and let the answer
 * decide the design rather than the other way round.
 *
 * ## The fifth answer, which is a number rather than a yes
 *
 * There is **no viewport change event** in the SDK — checked against the types, and the player
 * record carries a `syncView` flag but not the transform. So an overlay can only poll, and an
 * overlay that polls too slowly shows ink displaced from the linework it exists to be compared
 * against. That is worse than no overlay: it does not merely lag, it lies.
 *
 * The intended answer to that is to blank on any movement and redraw only once the view is still,
 * so the overlay is either absent or correct and never wrong-but-present. This page runs that loop
 * for real and reports what the poll actually costs, which is the figure the whole design rests on
 * and is currently a guess.
 *
 * ## It closes itself, and that is not a nicety
 *
 * A full-screen click-through sheet can cover Owlbear's toolbar, which is where the button that
 * opens the panel lives. If dismissing it required reaching the panel, a wrong answer to question 4
 * would leave a GM stuck behind an overlay with no way to remove it. So the escape hatch is a timer
 * in here, which fires whether or not anything on screen can be clicked. The panel's own close
 * button is the convenience, not the safety net — a popover is dismissed by clicking anywhere
 * outside it, which kills its timers with it.
 *
 * **Armed at module load, not inside `onReady`, and that distinction is the whole of the guarantee.**
 * This paragraph was true in intent and false in fact until 2026-09-01: the timer sat at the end of
 * `run()`, which Owlbear calls, so it was armed only once the SDK had replied — measured at 2,396ms
 * on a cold load, and never at all if the SDK never answers. A safety net that depends on the thing
 * it is protecting against is not one.
 *
 * Development only. Draws nothing into the scene and writes nothing anywhere.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { resolveTraceMap } from "./map/mapImage";
import { OVERLAY_PROBE_ID } from "./probe/overlayProbeControl";
import { shouldShow, viewMoved, type ScreenPair } from "./probe/viewportSettle";

installDevLog("overlay");

/**
 * How long the probe stays up.
 *
 * Long enough to look at it, try a pan, and read the numbers; short enough that being stuck behind
 * it is an annoyance rather than a problem.
 */
const LIFETIME_MS = 25_000;

/**
 * How often the viewport is asked where the map's corners are now.
 *
 * Deliberately not fast. The point is to measure what a poll costs and how a blank-and-restore
 * loop feels at a sane rate, not to find the highest rate the message bus will take — and this
 * project's inherited notes are explicit that the bus is contended.
 */
const POLL_MS = 120;

/** How long the view must hold still before the sheet is painted back in. */
const SETTLE_MS = 200;

const sheet = document.getElementById("sheet");
const readout = document.getElementById("readout");

/*
  The escape hatch, armed at module load and NOT inside `onReady`.

  This is the one thing on the page that must not depend on Owlbear answering. It sat at the end of
  `run()` — which is called from `OBR.onReady` — for the whole life of the file, while three
  separate places (this module's own doc, the page's comment, and the operating notes) claimed the
  opposite. `workspaceProbe.ts` got it right and said why; this did not, and it is kept as the
  *record* of how the platform answers were got, so teaching the wrong thing about its own safety
  net is the expensive kind of stale.

  The dead window it closes is real and measured: the iframe's load was 2,396ms cold. A timer armed
  after the SDK replies is a timer that starts two and a half seconds late, and the sibling has a
  constant named "300ms after load" that measured 300ms after the SDK replied.

  `stopped` is module-scope for the same reason — the timer has to be able to stop the poll loop
  that `run()` owns.
*/
const opened = performance.now();
let stopped = false;

window.setTimeout(() => {
  stopped = true;
  devLog("info", `overlay probe: closing after ${(LIFETIME_MS / 1000).toFixed(0)}s`);
  void OBR.modal.close(OVERLAY_PROBE_ID).catch((error: unknown) => {
    devLog("error", "overlay probe: could not close itself", describeError(error));
  });
}, LIFETIME_MS);

function say(text: string): void {
  if (readout) readout.innerHTML = text;
}

/**
 * Two opposite corners of the map in world coordinates.
 *
 * Two points fully determine the screen mapping when there is no rotation, which is the same
 * assumption the trace pipeline already makes and reports on. They serve double duty: if either
 * moved between polls the view has changed, and when they are still they *are* the transform the
 * overlay would draw with. The polling is the drawing's own input rather than overhead on top of
 * it.
 */
interface Corners {
  readonly min: { x: number; y: number };
  readonly max: { x: number; y: number };
}

interface Screen extends ScreenPair {
  /** Round trip for the pair, in milliseconds — the number this probe exists to produce. */
  readonly ms: number;
}

async function readScreen(corners: Corners): Promise<Screen> {
  const started = performance.now();
  const [a, b] = await Promise.all([
    OBR.viewport.transformPoint(corners.min),
    OBR.viewport.transformPoint(corners.max),
  ]);
  return { a, b, ms: performance.now() - started };
}

/**
 * Paint the sheet, or clear it.
 *
 * `null` means the view is moving, and that case is the whole point: clearing is instant and local,
 * needing no round trip, so the overlay can be honest about not knowing where it is long before it
 * could work out where it should be.
 */
function paint(canvas: HTMLCanvasElement, screen: Screen | null): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  // Backing store in device pixels, CSS box in layout pixels, or everything is soft on a HiDPI
  // display and a crosshair drawn one pixel wide lands as a two-pixel smear — which is precisely
  // the kind of blur that would make a real registration error look like anti-aliasing.
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  // This iframe's exact extent, so what a full-screen modal actually covers is visible rather than
  // inferred. Inset by one pixel because a stroke centred on the edge loses half its width.
  context.strokeStyle = "rgba(255, 96, 160, 0.9)";
  context.setLineDash([8, 6]);
  context.lineWidth = 2;
  context.strokeRect(1, 1, width - 2, height - 2);
  context.setLineDash([]);

  if (!screen) {
    // Nothing else is drawn while the view is moving. The blank IS the result — this is the state
    // the real overlay would spend every pan in, so it should be looked at rather than glossed.
    return;
  }

  // A light wash over everything, which is question 1. If the map is visible through this, the
  // modal composites; if the screen is a flat slab of this colour, it does not.
  context.fillStyle = "rgba(120, 200, 255, 0.16)";
  context.fillRect(0, 0, width, height);

  // The map's own box as Owlbear places it, and a crosshair at each corner. If these sit on the
  // corners of the map image, this iframe's pixels are the viewport's pixels. A uniform offset
  // means they are not, and the size of it is the inset to correct for.
  const left = Math.min(screen.a.x, screen.b.x);
  const right = Math.max(screen.a.x, screen.b.x);
  const top = Math.min(screen.a.y, screen.b.y);
  const bottom = Math.max(screen.a.y, screen.b.y);

  context.strokeStyle = "rgba(255, 224, 64, 0.95)";
  context.lineWidth = 2;
  context.strokeRect(left, top, right - left, bottom - top);

  context.strokeStyle = "rgba(255, 64, 64, 0.95)";
  context.lineWidth = 2;
  for (const x of [left, right]) {
    for (const y of [top, bottom]) {
      context.beginPath();
      context.moveTo(x - 22, y);
      context.lineTo(x + 22, y);
      context.moveTo(x, y - 22);
      context.lineTo(x, y + 22);
      context.stroke();
    }
  }
}

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "overlay"));
  } catch (error) {
    devLog("warn", "overlay probe: could not read player role", describeError(error));
  }

  devLog("info", "overlay probe: modal is alive and running its own script");

  if (!(sheet instanceof HTMLCanvasElement)) {
    say("Overlay probe: no canvas in the page. The markup and the script disagree.");
    devLog("error", "overlay probe: #sheet is not a canvas");
    return;
  }

  const map = await resolveTraceMap();
  if (!map) {
    say("Overlay probe: no map to align against. Nominate one in the panel and try again.");
    devLog("warn", "overlay probe: no map resolved, nothing to draw crosshairs on");
    // Still closes on the timer below — a probe that cannot measure must not become a sheet
    // nobody can remove.
  }

  const bounds = map ? await OBR.scene.items.getItemBounds([map.id]) : null;
  const corners: Corners | null = bounds
    ? { min: { x: bounds.min.x, y: bounds.min.y }, max: { x: bounds.max.x, y: bounds.max.y } }
    : null;

  // Owlbear's own idea of how big the viewport is, against this iframe's. If they differ, the
  // modal is not the same rectangle as the map view and question 3's answer is already half known
  // before a single crosshair is looked at.
  const [viewWidth, viewHeight] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);

  devLog(
    "info",
    `overlay probe: iframe ${window.innerWidth}x${window.innerHeight} at dpr ` +
      `${window.devicePixelRatio || 1}; Owlbear reports viewport ${viewWidth}x${viewHeight}. ` +
      (window.innerWidth === viewWidth && window.innerHeight === viewHeight
        ? "Same rectangle."
        : "DIFFERENT — the modal is not the map view, so screen positions need an offset."),
  );

  let previous: Screen | null = null;
  let stillSince = performance.now();
  let showing = false;
  let polls = 0;
  let worstMs = 0;
  let totalMs = 0;
  let blanks = 0;

  const tick = async (): Promise<void> => {
    const remaining = Math.max(0, LIFETIME_MS - (performance.now() - opened));

    if (!corners) {
      paint(sheet, null);
      say(
        `<b>Fog Nudger overlay probe</b>\n` +
          `No map nominated, so there is nothing to align against.\n` +
          `iframe ${window.innerWidth}x${window.innerHeight} · viewport ${viewWidth}x${viewHeight}\n` +
          `closes in ${(remaining / 1000).toFixed(0)}s`,
      );
      return;
    }

    const next = await readScreen(corners);
    polls += 1;
    totalMs += next.ms;
    worstMs = Math.max(worstMs, next.ms);

    if (viewMoved(previous, next)) {
      stillSince = performance.now();
      if (showing) blanks += 1;
      showing = false;
      // Blank first and ask questions later. This is the entire safety property: the sheet is
      // either absent or right, never present and wrong.
      paint(sheet, null);
    } else if (!showing && shouldShow(performance.now() - stillSince, SETTLE_MS)) {
      showing = true;
      paint(sheet, next);
    }

    previous = next;

    say(
      `<b>Fog Nudger overlay probe</b>\n` +
        `1 transparent?  is the map visible through the blue wash\n` +
        `2 click-through? try to pan and zoom — does the map move\n` +
        `3 registered?   do the red crosshairs sit on the map's corners\n` +
        `4 covers what?  the pink dashed line is this iframe's edge\n` +
        `\n` +
        `sheet ${showing ? "SHOWN (view still)" : "BLANK (view moving)"}\n` +
        `poll ${next.ms.toFixed(0)}ms now, ${(totalMs / Math.max(1, polls)).toFixed(0)}ms mean, ` +
        `${worstMs.toFixed(0)}ms worst over ${polls}\n` +
        `blanked ${blanks} times · every ${POLL_MS}ms, settles after ${SETTLE_MS}ms\n` +
        `iframe ${window.innerWidth}x${window.innerHeight} · viewport ${viewWidth}x${viewHeight}` +
        (window.innerWidth === viewWidth && window.innerHeight === viewHeight
          ? " (same)"
          : " <b>(DIFFERENT)</b>") +
        `\n` +
        `map corners on screen (${next.a.x.toFixed(0)}, ${next.a.y.toFixed(0)}) to ` +
        `(${next.b.x.toFixed(0)}, ${next.b.y.toFixed(0)})\n` +
        `closes in ${(remaining / 1000).toFixed(0)}s`,
    );
  };

  // A chain of timeouts rather than an interval, so a poll that runs long cannot overlap the next
  // one and turn a slow bus into a queue that never drains. `stopped` is module-scope, set by the
  // dismissal timer armed at load.
  const loop = (): void => {
    if (stopped) return;
    void tick()
      .catch((error: unknown) => {
        devLog("error", "overlay probe: poll failed", describeError(error));
      })
      .finally(() => {
        if (!stopped) window.setTimeout(loop, POLL_MS);
      });
  };
  loop();

  // The poll figures, on the same schedule as the dismissal above — which is armed at module load
  // and knows nothing about them. Separated so the *closing* cannot depend on `run()` having got
  // this far, which was the whole defect.
  window.setTimeout(() => {
    devLog(
      "info",
      `overlay probe: ${polls} polls, ` +
        `${(totalMs / Math.max(1, polls)).toFixed(0)}ms mean, ${worstMs.toFixed(0)}ms worst, ` +
        `blanked ${blanks} times`,
    );
  }, LIFETIME_MS);
}

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces nothing. That silence is correct behaviour rather than a failure.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    say(`Overlay probe failed: ${detail}`);
    devLog("error", "overlay probe: failed", detail);
  });
});
