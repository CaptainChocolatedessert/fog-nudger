/**
 * Opening and closing the stage-one workspace.
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

/** The workspace's modal id, shared by the opener and the page it opens. */
export const WORKSPACE_ID = key("workspace");

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
 * Requires a scene, because the first thing it does is ask which map it is reading — and a
 * workspace with no map is a black rectangle with sliders on it.
 */
export async function openWorkspace(): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — the workspace reads the scene's map.";
  }

  const url = workspaceUrl();
  devLog("info", `workspace: opening at ${url}`);

  await OBR.modal.open({
    id: WORKSPACE_ID,
    url,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
  });

  return "Workspace open. Escape or the Close button comes back.";
}

/**
 * Close it from outside.
 *
 * A convenience only. The workspace covers this panel, and a popover is dismissed by clicking
 * anywhere outside it, so by the time the workspace is up this button is gone. The ways out that
 * matter are on the workspace itself.
 */
export async function closeWorkspace(): Promise<string> {
  await OBR.modal.close(WORKSPACE_ID);
  devLog("info", "workspace: closed from the panel");
  return "Workspace closed.";
}
