/**
 * Undo and redo: the pair of buttons, and the keystrokes that do the same.
 *
 * ## Why this exists now and did not before
 *
 * While the reading controls and the editing tools were separate pages, wall edits could not be
 * destroyed by accident — the boundary was in the way. On one surface they can be, and the hand-edit
 * count and its warning only help a GM *predict*: they say what a re-read would cost before it
 * happens. Neither does anything for a judgement that looked right and was not, which is the ordinary
 * case. Pruning at a limit that seemed sensible and taking a wall you wanted had no route back but
 * regenerating the whole graph and losing every other edit with it.
 *
 * ## In the rail head, beside the count they act on — user, 2026-09-13
 *
 * Undo sat in the chrome bar at the top right, among Fit, Controls and Close. Those are about the
 * **surface**: how you are looking at it and how you leave. Undo is about the **document**, and being
 * in the wrong company is what a room noticed when it proposed moving the pair.
 *
 * **They are not tools, so they are not in the tool strip**, which is where the room first put them.
 * Every button there is a *mode* — picked, held, and shown by a pressed state — where these are
 * momentary; one list holding both would make that highlight mean two things. The machinery agrees: a
 * tool declares which drag it binds, whether it opens paint mode, and what the pinned hint says while
 * it is *in hand*, and undo has no answer to any of them. Needing a special case at every turn is
 * usually the sign that the category is wrong.
 *
 * The rail head is where they landed instead: it never scrolls or collapses, and the **hand-edit
 * count** was already there with nothing owning it — its own comment said it "is not a property of
 * the tool, it belongs to the document" and should move to whatever owns that. These are that owner,
 * so the count and the way back from it are one block.
 *
 * ## What they cover
 *
 * **The graph and the painted ink**, since 2026-09-13 — strokes on either layer, accepting gaps,
 * discarding or clearing a layer, and every wall edit. Settings are outside it and always were:
 * turning a slider back puts the walls back, because a derivation is not spent by being redone.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { toolIcon } from "./toolIcons";
import { invalidate, say } from "./shell";
import { onUndoChange, redoLabel, redoLast, undoLabel, undoLast } from "./undoHistory";

/**
 * One direction of the pair, which is all that differs between them.
 *
 * Written once rather than twice because the two are the same control pointed opposite ways: the same
 * disabling, the same naming, the same guard against a second press mid-write. Two copies would be
 * two places for that to drift, and the drift would be invisible — a redo that re-enabled itself a
 * moment early looks exactly like a redo that works.
 */
interface Direction {
  readonly id: string;
  /** Finishes "Nothing to …" and "… drawing added ink", so it is the verb a GM would use. */
  readonly verb: string;
  /** What the state line says while it runs, and after. */
  readonly present: string;
  readonly past: string;
  readonly label: () => string | null;
  readonly run: () => Promise<string | null>;
}

const DIRECTIONS: readonly Direction[] = [
  { id: "undo", verb: "Undo", present: "undoing", past: "undid", label: undoLabel, run: undoLast },
  { id: "redo", verb: "Redo", present: "redoing", past: "redid", label: redoLabel, run: redoLast },
];

const buttons = new Map<string, HTMLButtonElement>();

/** Whichever direction is mid-write, so neither button invites a second press over it. */
let running: string | null = null;

/**
 * Keep each button saying what it would do.
 *
 * Named rather than bare, because "Undo pruning the dead ends" says what you are about to get back
 * where "Undo" asks you to remember what you last did — and the whole reason this is needed is that
 * a GM has just done something whose effect they misjudged.
 *
 * ## The undo name is beside the button, not only inside its tooltip — room, 2026-09-15
 *
 * It was a tooltip alone, on the strip's argument: a glyph needs the name somewhere, and hover is
 * where a glyph's name goes. That is right for a **mode**, which you pick once and then hold. It is
 * wrong here, and a room showed why — four presses in a row, none of them hovered, each one taking
 * a brush stroke off a map while the GM was trying to take back a wall edit. *"Sometimes I thought
 * undo wasn't working, so I probably clicked multiple times."*
 *
 * **A tooltip cannot answer a question the GM does not know they have.** They were not asking what
 * the button does; they were sure they knew. The name in the open is the only thing in that
 * sequence that would have stopped the second press.
 *
 * **The undo side only.** One element says one thing, and redo keeps its tooltip — a stated cost,
 * and the smaller one: redo follows an undo the GM has just watched, so what it would put back is
 * the thing they were looking at a moment ago.
 *
 * **The label, never the tag.** Entries carry an opaque tag so the history can forget one
 * document's without learning what it holds, and printing it here would make it meaningful and
 * take that back. The words already separate them: *erasing a wall* and *drawing added ink* are
 * not going to be confused.
 */
function paint(): void {
  for (const direction of DIRECTIONS) {
    const button = buttons.get(direction.id);
    if (!button) continue;
    const label = direction.label();
    button.disabled = label === null || running !== null;
    button.title =
      label === null ? `Nothing to ${direction.verb.toLowerCase()}` : `${direction.verb} ${label}`;
  }

  const line = document.getElementById("history-label");
  if (line) {
    const next = undoLabel();
    line.textContent = next ?? "";
    // The full text where the bar has clipped it, which is the one thing the tooltip is still
    // good for here.
    line.title = next ?? "";
  }
}

async function run(direction: Direction): Promise<void> {
  if (running !== null || direction.label() === null) return;
  running = direction.id;
  paint();
  say(`${direction.present}…`, "working");
  try {
    const label = await direction.run();
    say(label === null ? `nothing to ${direction.verb.toLowerCase()}` : `${direction.past} ${label}`);
  } catch (error) {
    const detail = describeError(error);
    say(`could not ${direction.verb.toLowerCase()}: ${detail}`, "bad");
    devLog("error", `workspace: ${direction.verb.toLowerCase()} failed`, detail);
    console.error(`Fog Nudger — ${direction.verb.toLowerCase()} failed`, error);
  } finally {
    running = null;
    paint();
    invalidate();
  }
}

export function registerUndoAction(): void {
  for (const direction of DIRECTIONS) {
    const found = document.getElementById(direction.id);
    if (!(found instanceof HTMLButtonElement)) continue;
    buttons.set(direction.id, found);

    // Drawn rather than written, and `aria-label` rather than text, for the reason the tool strip
    // gives: a glyph needs the name somewhere a screen reader reaches.
    const glyph = toolIcon(direction.id);
    if (glyph) found.append(glyph);
    found.setAttribute("aria-label", direction.verb);
    found.addEventListener("click", () => void run(direction));
  }

  /*
    Every act that can be taken back announces here, and so does every clearing.

    It was `onStageChange`, which is a graph event — right while the stack held graphs alone, and
    silent for a brush stroke. The stack tells us itself now, whichever document moved.
  */
  onUndoChange(paint);

  /*
    Ctrl+Z and Ctrl+Shift+Z as well as the buttons, because the surface owns its keyboard.

    Not Cmd+Z: the probe measured this running in Firefox on Windows, and adding a modifier nobody
    here presses would be guessing at a platform rather than serving one. The buttons are the
    discoverable route and the keystrokes are the fast one.

    **Shift is what separates them**, which is why the undo handler always tested for it: the pair was
    planned before redo existed, so the key that would mean redo was refused rather than ignored.
  */
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== "z") return;
    // Not while typing into something — the number inputs on the sliders take a caret.
    if (document.activeElement instanceof HTMLInputElement) return;
    event.preventDefault();
    void run(event.shiftKey ? DIRECTIONS[1]! : DIRECTIONS[0]!);
  });

  paint();
}
