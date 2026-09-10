/**
 * What the Edit walls step says before its tools can do anything.
 *
 * **This used to be the tool picker.** Move, Draw and Erase moved to the tool strip on 2026-09-08,
 * where they sit beside the ink tools in one list — the change that lets the rail stop forcing one
 * section shut, because a heading no longer decides what a press means.
 *
 * What is left is the one thing the strip cannot say. A GM can reach this step on a map that has
 * never been read; that is not an error and must not read as one. The strip disables its wall tools
 * in that state, which says *that* they are unavailable but not *why* — so the answer, in the place
 * the walls would have been, is a sentence saying where they come from.
 *
 * **The sentence was stale and is fixed (2026-09-09).** It read "close this, open **Read the map**
 * from the panel", which described the two-page arrangement: no control called that has existed
 * since the workspaces merged, and there is nothing to close — Walls is a heading in the same rail,
 * two above this one.
 */

import { wallGraph } from "./stage";

export function renderWallTools(body: HTMLElement): void {
  if (wallGraph()) return;

  const empty = document.createElement("p");
  empty.className = "hint";
  empty.innerHTML =
    "No walls are saved for this map yet. Open <b>Walls</b> above and put them on the map from there.";
  body.append(empty);
}
