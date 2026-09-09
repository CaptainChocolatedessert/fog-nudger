/**
 * What the Edit walls step says before its tools can do anything.
 *
 * **This used to be the tool picker.** Move, Draw and Erase moved to the tool strip on 2026-09-08,
 * where they sit beside the ink tools in one list — the change that lets the rail stop forcing one
 * section shut, because a heading no longer decides what a press means.
 *
 * What is left is the one thing the strip cannot say. The editor opens from the panel, so a GM can
 * reach it on a map that has never been through the ink mode; that is not an error and must not read
 * as one. The strip disables its wall tools in that state, which says *that* they are unavailable
 * but not *why* — so the answer, in the place the walls would have been, is a sentence saying where
 * they come from.
 */

import { wallGraph } from "./stage";

export function renderWallTools(body: HTMLElement): void {
  if (wallGraph()) return;

  const empty = document.createElement("p");
  empty.className = "hint";
  empty.innerHTML =
    "No walls are saved for this map yet. They are made by reading the map: close this, open " +
    "<b>Read the map</b> from the panel, and the last step there puts a graph here.";
  body.append(empty);
}
