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
 * **It has been stale twice, which says something about sentences that describe a route.** It first
 * read "close this, open **Read the map** from the panel", describing an arrangement that no longer
 * existed. Then it said to put the walls on the map from **Walls** — true until the save button was
 * deleted on 2026-09-14, after which there is nothing to press there and the walls simply appear
 * once a map has been read. What is left points at the only thing that is actually missing.
 */

import { wallGraph } from "./stage";

export function renderWallTools(body: HTMLElement): void {
  if (wallGraph()) return;

  const empty = document.createElement("p");
  empty.className = "hint";
  empty.innerHTML = "No walls yet. Choose a map and open <b>Ink</b> above to read its linework.";
  body.append(empty);
}
