/**
 * Putting the ink overlay up and taking it down.
 *
 * Separate from the page because the two run in different iframes and share nothing but this
 * module's constants. Spelling the modal id out twice is how the close call ends up addressing a
 * modal that does not exist.
 *
 * ## How it is dismissed, and why that is safe
 *
 * The overlay covers the entire window — map, Owlbear's tools, and our own panel — so a close
 * button *on the overlay* would be unclickable, since the whole thing works by having pointer
 * events disabled. The escape hatch is that same disabling: **clicks pass through**, measured in a
 * room, so Owlbear's toolbar keeps working underneath and the panel can always be reopened and its
 * close button pressed. That is a real answer rather than a hopeful one, and it is only available
 * because the probe established click-through first.
 *
 * A long backstop timer sits behind it anyway, for the case where the panel itself is wedged. It is
 * generous rather than short: this is a working surface a GM leaves up while tuning, not a probe.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { key } from "../namespace";

export const OVERLAY_ID = key("ink-overlay");

/**
 * How long the overlay stays up without being touched.
 *
 * Ten minutes. Long enough that a GM tuning a map never meets it, short enough that a forgotten
 * overlay over a live session ends on its own.
 */
export const OVERLAY_LIFETIME_MS = 600_000;

function overlayUrl(): string {
  return `${import.meta.env.BASE_URL}overlay.html`;
}

export async function openInkOverlay(): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — the overlay needs a map to read.";
  }

  devLog("info", "overlay: opening the ink overlay");

  await OBR.modal.open({
    id: OVERLAY_ID,
    url: overlayUrl(),
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
    disablePointerEvents: true,
  });

  return "Ink overlay up. It blanks while you pan or zoom and repaints once the view settles.";
}

export async function closeInkOverlay(): Promise<string> {
  await OBR.modal.close(OVERLAY_ID);
  devLog("info", "overlay: closed from the panel");
  return "Ink overlay closed.";
}
