/**
 * Opening and closing the overlay probe's modal.
 *
 * Separate from the probe page itself because the two run in **different iframes** and share
 * nothing but this module's constants. The panel opens the modal; the modal's own script draws in
 * it and closes it. Both need the same id, and an id spelled out twice is an id that eventually
 * differs by a character — at which point the close call silently addresses a modal that does not
 * exist, which is the worst possible failure for the thing standing in for an escape hatch.
 *
 * ## The four flags, and which one is fatal
 *
 * - `fullScreen` — the sheet has to cover the map, since the map is what it is registering against.
 * - `hideBackdrop` and `hidePaper` — remove the dimming layer and the modal's own card. Together
 *   these are the claim that anything shows through at all.
 * - `disablePointerEvents` — the fatal one. If a drag does not reach the map underneath, a GM
 *   cannot pan while the overlay is up, and an overlay that must be dismissed before the map can
 *   be moved is not an overlay.
 *
 * All four are read off the SDK's type declarations and none is verified. Neither Dynamic Fog nor
 * the sibling project opens a modal anywhere, so there is no working example to compare against.
 *
 * Development only. Touches no scene items and writes no metadata.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { key } from "../namespace";

/**
 * The modal's id, shared by the opener and the page it opens.
 *
 * Namespaced like everything else of ours, so a modal from another extension cannot collide with
 * it and — more to the point — ours cannot collide with theirs.
 */
export const OVERLAY_PROBE_ID = key("overlay-probe");

/**
 * The probe page's URL.
 *
 * Built from Vite's base rather than spelled out, because the Pages subpath is hardcoded in ten
 * places already and every one of them is a thing to forget. Nothing in `src/` should add an
 * eleventh — a stale path here would 404 into a modal that opens empty and transparent, which is
 * indistinguishable from the transparency question answering "yes" and everything else failing.
 */
function probeUrl(): string {
  return `${import.meta.env.BASE_URL}overlay-probe.html`;
}

/**
 * Put the probe up.
 *
 * Deliberately does **not** try to close an existing one first. Opening the same id twice is
 * Owlbear's business, and a close-then-open here would race the page's own dismissal timer — which
 * is the one mechanism that must keep working no matter what else does.
 */
export async function openOverlayProbe(): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — the probe needs a map to align against.";
  }

  const url = probeUrl();
  devLog("info", `overlay probe: opening a full-screen modal at ${url}`);

  await OBR.modal.open({
    id: OVERLAY_PROBE_ID,
    url,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
    disablePointerEvents: true,
  });

  return (
    "Overlay probe up for 25 seconds, then it closes itself. Look for: the map through the blue " +
    "wash, panning still working, red crosshairs on the map's corners, and what the pink dashed " +
    "edge covers."
  );
}

/**
 * Take it down early.
 *
 * A convenience rather than the safety net. The panel is a popover and is dismissed by clicking
 * anywhere outside it, which takes this button with it — so the mechanism that has to survive
 * question 4 answering badly is the timer inside the probe page, not this.
 */
export async function closeOverlayProbe(): Promise<string> {
  await OBR.modal.close(OVERLAY_PROBE_ID);
  devLog("info", "overlay probe: closed from the panel");
  return "Overlay probe closed.";
}
