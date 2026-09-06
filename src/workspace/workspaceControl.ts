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
import { MODE_PARAM, type WorkspaceMode } from "./mode";

/**
 * A modal id per mode, shared by the opener and the page it opens.
 *
 * **Two ids rather than one**, and the reason is the hand-off. Finishing in the ink mode offers to
 * open the editor, which means both exist for the instant between the second opening and the first
 * closing — and the editor is opened *first*, so that the ink page never has to survive its own
 * teardown in order to make the call. With one id that ordering is not available: the second open
 * would be addressing the modal that is still up.
 */
const MODAL_IDS: Readonly<Record<WorkspaceMode, string>> = {
  ink: key("workspace"),
  edit: key("wall-editor"),
};

export function workspaceModalId(mode: WorkspaceMode): string {
  return MODAL_IDS[mode];
}

/**
 * The workspace page's URL.
 *
 * Built from Vite's base rather than spelled out. The Pages subpath is hardcoded in ten places
 * already and nothing in `src/` should add an eleventh — a stale path opens an opaque modal with
 * nothing in it, which for a full-screen surface is a blank slab over the room.
 */
function workspaceUrl(mode: WorkspaceMode): string {
  return `${import.meta.env.BASE_URL}workspace.html?${MODE_PARAM}=${mode}`;
}

/**
 * Open one of the two workspaces.
 *
 * Requires a scene, because both begin by resolving the scene's nominated map — the ink mode to read
 * it, the editor to draw the walls over it.
 *
 * **One page, two modes** (user, 2026-09-05). The mode goes in the query string rather than being a
 * second page: the shell, the accordion, the map loading, the view transform and every layer are
 * shared, so the difference is which steps are declared. A real second page would duplicate the
 * composition root and add an eleventh place for the Pages subpath to be hardcoded.
 */
export async function openWorkspace(mode: WorkspaceMode): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — both workspaces read the scene's map.";
  }

  const url = workspaceUrl(mode);
  devLog("info", `workspace: opening ${mode} at ${url}`);

  await OBR.modal.open({
    id: workspaceModalId(mode),
    url,
    fullScreen: true,
    hideBackdrop: true,
    hidePaper: true,
  });

  return mode === "edit"
    ? "Wall editor open. Escape or the Close button comes back."
    : "Reading the map. Escape or the Close button comes back.";
}
