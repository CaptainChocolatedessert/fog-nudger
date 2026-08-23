/**
 * The stage-one ink overlay — the binary mask painted over the map it was read from.
 *
 * Stage one's data is a per-pixel classification at native resolution, which is a different *kind*
 * of thing from stage two's few hundred polygons: dense, unsummarisable, and until now answerable
 * only one pixel at a time by the point probe. That probe is the one diagnostic in this project
 * that has reliably worked, because every other reports a total and a total cannot say what is
 * happening *there*. This is the probe's answer for every pixel at once.
 *
 * It paints **the mask and nothing else**. Ink, and everything else left alone. Kept-versus-
 * discarded floor is decided by labelling and the minimum-area filter, which are stage two, and
 * belong with the regions.
 *
 * ## Why this is a modal
 *
 * Rasters cannot enter an Owlbear scene: the sibling measured `data:` URLs drawing a broken-image
 * placeholder at 0.3KB, refused outright at 21.6KB, and wedging the message bus at 1.37MB, with
 * asset upload the only mechanism that delivers pixels and no opacity or tint on an image item
 * anyway. A modal drawing on its own canvas sidesteps all of it, because the pixels never enter the
 * scene graph. Measured in a room 2026-08-23: it composites, drags pass through to Owlbear
 * underneath, and its coordinate space *is* the viewport's — Owlbear's map canvas is the full
 * window with its tools floating over it, so no inset needs discovering.
 *
 * ## Blank and restore
 *
 * There is no viewport change event, so the transform can only be polled. **An overlay that lags
 * does not merely trail — it lies**, showing ink displaced from the linework it exists to be
 * compared against, which a GM would read as the trace having found the wall in the wrong place. So
 * the sheet blanks the instant anything moves and repaints only once the view is still: absent or
 * correct, never present and wrong.
 *
 * The poll measured 2–4ms, so this runs far tighter than the probe did. That is the only thing the
 * cheap poll buys — it shrinks the window in which the view has moved and the sheet has not yet
 * noticed. It does not make continuous tracking viable: at any rate the sheet during a drag is
 * offset by velocity times the interval, which is tens of pixels against ink about five wide.
 *
 * ## The mask is computed here, not sent here
 *
 * This is a different iframe from the panel and shares no memory with it, and the mask is 8.4MB on
 * this project's test map — comfortably past what wedged the sibling's message bus. So this page
 * runs stage one itself, through the *same* function the trace uses, and picks up its own cache in
 * its own iframe. Settings arrive the way they always do, from scene metadata, and a change to them
 * arrives as an event rather than needing to be forwarded.
 */

import OBR from "@owlbear-rodeo/sdk";

import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { maskForOverlay } from "./pipeline";
import { readSettings } from "./settingsStore";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { OVERLAY_ID, OVERLAY_LIFETIME_MS } from "./overlay/overlayControl";
import { paintMask, parseColour, screenRect } from "./overlay/maskImage";
import { shouldShow, viewMoved, type ScreenPair } from "./probe/viewportSettle";

installDevLog("overlay");

/**
 * How often the transform is polled.
 *
 * 40ms rather than the probe's 120, because the probe measured the poll at 2–4ms and the interval
 * is the whole of the window in which the sheet can be up and already wrong. Two frames of that is
 * about as good as polling can be made without spending real bus traffic on it.
 */
const POLL_MS = 40;

/** How long the view must hold still before the sheet is painted back in. */
const SETTLE_MS = 160;

const sheet = document.getElementById("sheet");
const statusLine = document.getElementById("status");

function say(text: string): void {
  if (statusLine) statusLine.textContent = text;
}

/** The mask rasterised into RGBA once, so every view change is a `drawImage` rather than a repaint. */
interface Painted {
  readonly canvas: HTMLCanvasElement;
  readonly buffer: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  /** The world box the raster covers, which is what the screen rectangle is derived from. */
  readonly bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  /** The colour it was painted in, so a recolour can tell whether it needs to repaint at all. */
  colour: string;
}

let painted: Painted | null = null;
let settings: Settings = DEFAULT_SETTINGS;

/**
 * Build (or recolour) the offscreen image of the mask.
 *
 * Runs stage one when there is no image yet, and only re-paints pixels when the *colour* changed —
 * opacity never gets this far, because the canvas applies it to the whole image at draw time for
 * nothing. Painting 8.4 million pixels because a slider moved would be a lot of work to arrive at
 * an image the compositor could have produced for free.
 */
async function rebuild(force: boolean): Promise<boolean> {
  const colour = parseColour(settings.overlay.inkColour);
  if (!colour) {
    // The normaliser guarantees the format, so reaching here means something upstream changed.
    // Refusing to draw is right: substituting a colour would look like the picker not working.
    say("Overlay: the ink colour is not readable. Pick one again in the panel.");
    devLog("error", `overlay: unusable ink colour ${settings.overlay.inkColour}`);
    return false;
  }

  if (painted && !force) {
    if (painted.colour === settings.overlay.inkColour) return true;
    // Recolour in place. The mask has not changed, so the expensive half is already done and the
    // buffer is the right size by construction.
    const context = painted.canvas.getContext("2d");
    if (!context) return false;
    paintMask(
      { width: painted.width, height: painted.height, data: currentMask! },
      colour,
      painted.buffer,
    );
    context.putImageData(new ImageData(painted.buffer, painted.width, painted.height), 0, 0);
    painted.colour = settings.overlay.inkColour;
    devLog("info", `overlay: recoloured to ${settings.overlay.inkColour} without re-reading`);
    return true;
  }

  const started = performance.now();
  const result = await maskForOverlay();
  if (!result) {
    say("Overlay: no map to read. Nominate one in the panel.");
    return false;
  }

  currentMask = result.mask.data;
  const { width, height } = result.mask;
  const buffer = paintMask(result.mask, colour, painted?.buffer);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    say("Overlay: could not allocate a canvas for the mask.");
    devLog("error", `overlay: no 2d context for a ${width}x${height} canvas`);
    return false;
  }
  context.putImageData(new ImageData(buffer, width, height), 0, 0);

  painted = {
    canvas,
    buffer,
    width,
    height,
    bounds: result.bounds,
    colour: settings.overlay.inkColour,
  };

  devLog(
    "info",
    `overlay: built ${width}x${height} ink image in ${Math.round(performance.now() - started)}ms ` +
      `(mask ${result.reused ? "reused from cache" : "recomputed"}) for "${result.mapName}"`,
  );
  say("");
  return true;
}

/** Held alongside the painted image so a recolour can repaint without another stage-one run. */
let currentMask: Uint8Array | null = null;

/**
 * Where the raster's two opposite world corners currently sit on screen.
 *
 * Two points fully determine the mapping absent rotation — the same assumption the pipeline already
 * makes and reports on — and they do double duty: a difference between polls means the view moved,
 * and when they are still they *are* the transform to draw with.
 */
async function readCorners(bounds: Painted["bounds"]): Promise<ScreenPair> {
  const [a, b] = await Promise.all([
    OBR.viewport.transformPoint(bounds.min),
    OBR.viewport.transformPoint(bounds.max),
  ]);
  return { a, b };
}

function draw(where: ScreenPair | null): void {
  if (!(sheet instanceof HTMLCanvasElement)) return;
  const context = sheet.getContext("2d");
  if (!context) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  // Backing store in device pixels so ink five pixels wide does not arrive as a smear on a HiDPI
  // display — which would blur exactly the detail the overlay exists to let a GM look at.
  const ratio = window.devicePixelRatio || 1;
  if (sheet.width !== Math.round(width * ratio) || sheet.height !== Math.round(height * ratio)) {
    sheet.width = Math.round(width * ratio);
    sheet.height = Math.round(height * ratio);
    sheet.style.width = `${width}px`;
    sheet.style.height = `${height}px`;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  // Clearing is instant and needs no round trip, which is the whole reason blanking is affordable:
  // the sheet can be honest about not knowing where it is long before it could work out where it
  // should be.
  if (!where || !painted) return;

  const rect = screenRect(where.a, where.b);
  if (rect.width <= 0 || rect.height <= 0) return;

  context.globalAlpha = settings.overlay.inkOpacity;
  // Nearest-neighbour. Zoomed in, a GM is judging individual strokes and smoothing invents edges
  // that are not in the mask; zoomed out this cannot save thin ink anyway, so there is nothing to
  // trade for the invention.
  context.imageSmoothingEnabled = false;
  context.drawImage(painted.canvas, rect.x, rect.y, rect.width, rect.height);
  context.globalAlpha = 1;
}

async function run(): Promise<void> {
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "overlay"));
  } catch (error) {
    devLog("warn", "overlay: could not read player role", describeError(error));
  }

  settings = await readSettings();
  say("Overlay: reading the map…");
  if (!(await rebuild(true))) return;

  let previous: ScreenPair | null = null;
  let stillSince = performance.now();
  let showing = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (!painted) return;
    const next = await readCorners(painted.bounds);

    if (viewMoved(previous, next)) {
      stillSince = performance.now();
      showing = false;
      draw(null);
    } else if (!showing && shouldShow(performance.now() - stillSince, SETTLE_MS)) {
      showing = true;
      draw(next);
    }
    previous = next;
  };

  // A chain of timeouts rather than an interval, so a poll that runs long cannot overlap the next
  // and turn a slow moment on the bus into a queue that never drains.
  const loop = (): void => {
    if (stopped) return;
    void tick()
      .catch((error: unknown) => {
        devLog("error", "overlay: poll failed", describeError(error));
      })
      .finally(() => {
        if (!stopped) window.setTimeout(loop, POLL_MS);
      });
  };
  loop();

  // Settings arrive as an event rather than being forwarded from the panel, because they already
  // live in scene metadata and both iframes read the same store. A reading change rebuilds the
  // mask; a colour change repaints; an opacity change costs nothing at all.
  OBR.scene.onMetadataChange(() => {
    void (async () => {
      const next = await readSettings();
      const readingChanged =
        JSON.stringify(next.trace) !== JSON.stringify(settings.trace);
      settings = next;
      if (readingChanged) {
        showing = false;
        draw(null);
        say("Overlay: re-reading the map…");
        await rebuild(true);
        // Force a repaint on the next poll rather than drawing at a transform read before the
        // rebuild, which could be several hundred milliseconds stale by now.
        previous = null;
      } else {
        await rebuild(false);
        if (showing) draw(previous);
      }
    })().catch((error: unknown) => {
      devLog("error", "overlay: could not apply a settings change", describeError(error));
    });
  });

  window.setTimeout(() => {
    stopped = true;
    devLog("info", "overlay: closing on the backstop timer");
    void OBR.modal.close(OVERLAY_ID).catch(() => undefined);
  }, OVERLAY_LIFETIME_MS);
}

// `OBR.onReady` does not fire outside a room, so opening this page directly in a browser runs the
// code and produces nothing. That silence is correct rather than a failure.
OBR.onReady(() => {
  void run().catch((error: unknown) => {
    const detail = describeError(error);
    say(`Overlay failed: ${detail}`);
    devLog("error", "overlay: failed", detail);
  });
});
