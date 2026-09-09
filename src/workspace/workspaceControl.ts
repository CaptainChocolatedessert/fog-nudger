/**
 * Opening the two workspaces, and the ids they close themselves by.
 *
 * Separate from the page it opens because the two run in **different iframes** and share nothing
 * but this module's constants — the same reason the probes' controls are separate, and the same
 * hazard: an id spelled out twice eventually differs by a character, at which point the close call
 * addresses a modal that does not exist.
 *
 * ## The flags, and why none of them is a guess any more
 *
 * `fullScreen` with **no** `disablePointerEvents`, measured over fifteen probe runs (`DESIGN.md`
 * §4): the surface receives pointer, wheel and right-click with nothing reaching Owlbear
 * underneath, against a detector that was made to fail before its zero was believed.
 *
 * `hidePaper` and `hideBackdrop` are set, though the probe found they make no observable difference
 * under `fullScreen` — no card, no inset, no backdrop either way. They stay because asking for no
 * chrome is what this page means, and a flag that currently changes nothing is cheaper to keep than
 * to re-measure if Owlbear ever starts honouring it.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { key } from "../namespace";

/**
 * The modal id, shared by the opener and the page it opens.
 *
 * **One, since the modes merged.** There were two, and the reason was the hand-off: finishing in the
 * ink mode opened the editor, so both existed for the instant between the second opening and the
 * first closing, and one id could not express that ordering. There is no hand-off now — saving does
 * not move the GM anywhere, because the tools they would have been handed to are already on screen.
 */
const MODAL_ID = key("workspace");

export function workspaceModalId(): string {
  return MODAL_ID;
}

/**
 * The workspace page's URL.
 *
 * Built from Vite's base rather than spelled out. The Pages subpath is hardcoded in ten places
 * already and nothing in `src/` should add an eleventh — a stale path opens an opaque modal with
 * nothing in it, which for a full-screen surface is a blank slab over the room.
 */
function workspaceUrl(): string {
  return `${import.meta.env.BASE_URL}workspace.html`;
}

/**
 * Open the workspace.
 *
 * Requires a scene, because it begins by resolving the scene's nominated map.
 *
 * **One page, and one button that opens it** (user, 2026-09-08). It was two — read the map, edit the
 * walls — and the split ran across the grain of the job: the work loop is look at the rooms, spot a
 * merged one, go back to the ink, look again, which crossed the boundary twice per iteration. What
 * the boundary protected is real and is now a count rather than a place; see `stage.ts`.
 */
export async function openWorkspace(): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — the workspace reads the scene's map.";
  }

  const url = workspaceUrl();
  devLog("info", `workspace: opening at ${url}`);

  await OBR.modal.open({
    id: workspaceModalId(),
    url,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
  });

  return "Workspace open. Escape or the Close button comes back.";
}
