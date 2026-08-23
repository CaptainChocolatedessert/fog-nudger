/**
 * Opening and closing the workspace probe's modal.
 *
 * Separate from the page it opens because the two run in **different iframes** and share nothing
 * but this module's constants — the same reason `overlayProbeControl` is separate, and the same
 * hazard: an id spelled out twice eventually differs by a character, at which point the close call
 * addresses a modal that does not exist. That is worse here than it was there, because the sheet
 * this opens is opaque.
 *
 * ## The combination under test, and why it is unproven
 *
 * The ink overlay's modal is `fullScreen` + `hideBackdrop` + `hidePaper` + **`disablePointerEvents`**,
 * and every one of those was measured in a room. The workspace needs the same modal **without**
 * `disablePointerEvents`, and that combination has never been opened. What is unknown is not
 * whether it appears — it is whether the input a workspace would live on actually arrives:
 * drags, the wheel, and keystrokes, without Owlbear acting on them underneath at the same time.
 *
 * DESIGN.md §4 "Superseding all of the above" and §11 item 0.
 *
 * ## Two variants, because `hidePaper` is a second unknown
 *
 * - **bare** — `hidePaper` and `hideBackdrop` both on, so nothing of Owlbear's chrome is drawn and
 *   the page paints the entire window itself. This is what the workspace would most likely be.
 * - **framed** — both off, so Owlbear draws its own modal card and backdrop around us. The record
 *   lists "whether `hidePaper: false` gives a usable frame" as unmeasured, and it is worth knowing:
 *   a frame supplies a title bar and a way out for free, which is not nothing for a surface that
 *   otherwise covers the whole screen.
 *
 * Only those two flags differ. Everything else is held still so a difference between the two runs
 * has one cause.
 *
 * Development only. Touches no scene items and writes no metadata.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { key } from "../namespace";

/** The modal's id, shared by the opener and the page it opens. */
export const WORKSPACE_PROBE_ID = key("workspace-probe");

/** Which of Owlbear's chrome the modal is opened with. */
export type WorkspaceProbeVariant = "bare" | "framed";

/**
 * The probe page's URL, carrying the variant so the readout can name which one is on screen.
 *
 * Built from Vite's base rather than spelled out. The Pages subpath is hardcoded in ten places
 * already and nothing in `src/` should add an eleventh — a stale path here opens an empty modal,
 * which for an *opaque* probe means a blank slab with no readout and no close button, and only the
 * page's own dismissal timer to end it.
 */
function probeUrl(variant: WorkspaceProbeVariant): string {
  return `${import.meta.env.BASE_URL}workspace-probe.html?variant=${variant}`;
}

/**
 * Put the probe up.
 *
 * Like the overlay probe, this deliberately does not close an existing one first: a close-then-open
 * here would race the page's own dismissal timer, which is the one mechanism that has to keep
 * working when everything else has answered badly.
 */
export async function openWorkspaceProbe(variant: WorkspaceProbeVariant): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    // The probe does not trace anything, but it asks Owlbear where a world point is in order to
    // detect input leaking through, and that needs a scene.
    return "No scene open — the probe needs one to tell whether input is reaching Owlbear.";
  }

  const url = probeUrl(variant);
  const chrome = variant === "framed" ? "Owlbear's own card and backdrop" : "no chrome at all";
  devLog("info", `workspace probe: opening a full-screen modal (${variant}, ${chrome}) at ${url}`);

  await OBR.modal.open({
    id: WORKSPACE_PROBE_ID,
    url,
    fullScreen: true,
    // The variant, and the whole of the difference between the two.
    hideBackdrop: variant === "bare",
    hidePaper: variant === "bare",
    // Omitted on purpose rather than set false, because *this absence is the experiment*. Spelling
    // it out as `false` would read as a setting someone chose and might be "tidied" back to true by
    // a later session copying the overlay's call.
  });

  return (
    `Workspace probe (${variant}) up for 60 seconds. Drag the pad, spin the wheel, type in the ` +
    "box — the readout says whether Owlbear moved underneath. Escape or the button closes it, and " +
    "it closes itself regardless."
  );
}

/**
 * Take it down early.
 *
 * A convenience, not the safety net — this panel is a popover and disappears the moment anything
 * else is clicked, and in any case the probe covers it. The mechanisms that have to survive a bad
 * answer are inside the page: its own button, Escape, and the timer behind both.
 */
export async function closeWorkspaceProbe(): Promise<string> {
  await OBR.modal.close(WORKSPACE_PROBE_ID);
  devLog("info", "workspace probe: closed from the panel");
  return "Workspace probe closed.";
}
