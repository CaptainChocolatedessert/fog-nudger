/**
 * Which of the two workspaces this page is, read once from its own URL.
 *
 * ## Two modes, one page — settled 2026-09-05 (user)
 *
 * Stage one and the wall editor are separate *processes*: each starts by looking at the scene and
 * ends by putting something on it. That is the whole argument for splitting them, and it is about
 * shape rather than code — a seven-header accordion spanning both is a list to be worked down, where
 * two modes are two things a GM can hold whole. It also fixes a defect: the editor used to be a step
 * reachable only by scrolling past the stage-one controls that were dimmed out *because* you were in
 * the editor.
 *
 * **They are one page because they are one surface.** The shell, the accordion, the map loading, the
 * view transform and every layer are shared; A.1 split the workspace into a shell plus a list of
 * steps precisely so this is a variation in one declaration rather than a second application. A real
 * second page would duplicate the composition root and add a manifest entry to a subpath that is
 * already hardcoded in ten places.
 *
 * ## The mode is in the URL, and is fixed for the life of the page
 *
 * Read from the query string rather than from scene metadata, because it is not a property of the
 * scene: two GMs could reasonably want different modes open on the same map, and a mode stored in
 * the scene would be one of them deciding for the other. It is also what the panel's two buttons
 * pass, so the button pressed and the surface that opens cannot disagree.
 *
 * Anything unrecognised is the ink mode. That is the mode you can always be in — it needs nothing to
 * exist beforehand — where the editor with no stored graph has nothing to show.
 */

export type WorkspaceMode = "ink" | "edit";

/** The query parameter the panel sets and this reads. Named once so the two cannot drift. */
export const MODE_PARAM = "mode";

let cached: WorkspaceMode | null = null;

/**
 * Which mode this page is.
 *
 * Cached after the first read, so a mode cannot change under code that has already branched on it.
 * The alternative — reading `location.search` at each call — would let a history change part-way
 * through a frame produce a surface half in each mode.
 */
export function workspaceMode(): WorkspaceMode {
  if (cached) return cached;
  cached = readMode();
  return cached;
}

/** Whether this page is the wall editor, which is the branch most callers actually want. */
export function inEditor(): boolean {
  return workspaceMode() === "edit";
}

function readMode(): WorkspaceMode {
  try {
    return new URLSearchParams(window.location.search).get(MODE_PARAM) === "edit" ? "edit" : "ink";
  } catch {
    // A malformed query is not worth a message: the ink mode is the safe answer, because it is the
    // one that needs nothing to already exist.
    return "ink";
  }
}
