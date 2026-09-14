/**
 * The mark saying a group's controls would regenerate walls the GM has changed by hand.
 *
 * ## What it is, and what it is not
 *
 * It is a **notice**, not a warning. It fires nothing, blocks nothing, and opening the group it sits
 * on asks no question — because opening destroys nothing. All it says is *the walls hold work of
 * yours, and these controls build the walls*. The price is named at the moment a slider is released,
 * which is the only moment anything is actually lost.
 *
 * > Marker at the navigation, dialog at the mutation. Putting both at the press would ask the
 * > question every time a GM went to look at a number, which is the fastest way to train someone to
 * > dismiss the one warning that matters.
 *
 * ## No number — user, 2026-09-14
 *
 * It carried a count of hand edits for a day and the count was the wrong instrument. Fourteen tells a
 * GM nothing they can act on: they cannot know whether fourteen is a lot, or whether those fourteen
 * mattered. It is a numeric proxy for something that should be looked at, which is the fault that
 * retired the merge alarm. What answers the question properly is the **delta** — what would go and
 * what would arrive, drawn on the map — and this is only the thing that says there is one.
 *
 * The count also could not survive a session, because it lives in memory. This asks
 * `wallsEdited`, which compares two graphs that are both in the scene, so a GM returning to a map
 * they worked on last week gets the same answer they left with.
 *
 * ## Why the wall glyph rather than a dot or a lock
 *
 * The mark sits on **Ink** and **Walls** — the controls that would do the destroying — so a plain
 * badge there reads as a modifier on the tool rather than as a statement about the document (user,
 * 2026-09-14). A **lock** prohibits, and nothing is locked: the truth is a price, not a refusal. A
 * **check** claims the step is settled, which the software cannot know.
 *
 * A miniature of the wall graph names **what is at stake** instead of what the button does, which is
 * the thing that was actually wrong. It is drawn in the structure blue the wall layer uses, so it
 * reads as *walls of yours*, and it cannot be confused with the layer row's own marks, which mean
 * something else entirely.
 *
 * **Blue and not red**, which is where this started: red is reserved for destruction and earns its
 * alarm by being rare, while this can be worn for a whole session.
 *
 * DOM, and `stage.ts` for the question.
 */

import type { StepId } from "../steps";
import { stepRegeneratesWalls } from "../steps";
import { wallsEdited } from "./stage";

/** Whether this step should be carrying the mark right now. */
export function stepIsMarked(step: StepId): boolean {
  return stepRegeneratesWalls(step) && wallsEdited();
}

/**
 * The mark itself: a small wall graph, cased the way every mark on the canvas is.
 *
 * The casing is not decoration here either — it is the one thing that makes a mark legible without
 * knowing what is behind it, and using it means this looks like the marks on the map rather than
 * like chrome that happens to be blue.
 */
export function wallsMark(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("walls-mark");

  const path = "M3 13 L3 4 L9 4 L9 9 L14 9";
  // The casing is a literal and not a custom property, deliberately: it is the part doing the
  // visibility work, and the palette exposes core hues only so a GM cannot tune away the mechanism
  // the hues rely on.
  for (const [stroke, width] of [
    ["rgba(255, 255, 255, 0.5)", "3.4"],
    ["var(--structure, #7aa7ff)", "1.7"],
  ] as const) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", path);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", width);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    svg.append(line);
  }

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", "9");
  dot.setAttribute("cy", "4");
  dot.setAttribute("r", "2.1");
  dot.setAttribute("fill", "var(--structure, #7aa7ff)");
  svg.append(dot);

  return svg;
}

/**
 * The line at the top of a marked group, saying what the mark means.
 *
 * **The mark is ambient and this is the sentence**, and they are split on purpose: a glyph in a
 * header cannot say what it costs, and a sentence in a header would be noise on every step that is
 * not marked. A GM who wants to know why the mark is there opens the group and reads one line.
 *
 * It does not name a count, for the reason the mark does not. What it names is the operation and its
 * price, which is the part that is actually actionable.
 */
export function wallsNotice(): HTMLElement {
  const notice = document.createElement("p");
  notice.className = "walls-notice";
  notice.innerHTML =
    "<b>These walls hold changes of yours.</b> Anything here rebuilds them from the map, " +
    "and what you moved, drew or erased is not in what replaces it.";
  return notice;
}
