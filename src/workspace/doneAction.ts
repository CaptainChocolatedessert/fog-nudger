/**
 * *Done*: the button that puts the tool in hand down.
 *
 * ## Why a tool needs one at all
 *
 * Some tools only finish when they are put down. A brush's strokes are written to a working copy and
 * saved on the way out; *Suppress speckles* holds its presses the same way, and the recompose with the
 * derive behind it waits for the same moment; *Straighten* applies its amount when its drawer closes.
 * In each, **leaving is the act** — and leaving was only reachable by arming something else, which is
 * an odd way to say "I have finished" (user, 2026-09-22).
 *
 * ## It is a press on Pan and nothing else
 *
 * `armTool` is what the strip's own buttons call, so this is exactly the press a GM could already make
 * there. Every tool keeps its own answer to *what does leaving mean* — the commit paths are untouched,
 * and this only reaches them the way putting the tool down always did.
 *
 * **`setTool` would not do**: it leaves the drawer open, and an open drawer is a tool not yet left.
 *
 * ## What it does not do
 *
 * It does not say the step is finished, and a room called that out as slightly odd (user, 2026-09-22:
 * *"It's also a little odd to close the drawer and have the step not visibly finish, but it's ok for
 * now."*). Saving the paint still happens when the Ink side is left, not here.
 */

import { armTool } from "./toolPalette";

/** A row holding the button, ready to append to a drawer. */
export function doneRow(): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "step-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "chip";
  done.textContent = "Done";
  done.addEventListener("click", () => armTool("pan"));
  actions.append(done);
  return actions;
}
