/**
 * What would rebuild the walls, marked on the control that would do it — and the one question asked
 * before it can.
 *
 * ## The mark is on the thing that causes it, not on the group holding that thing
 *
 * It was on the group, which is a proxy and an inaccurate one (user, 2026-09-14). **Ink holds nine
 * controls and five of them regenerate**: the two brush widths and the two gap settings recompute
 * nothing at all. Marking the group told a GM the brush width was dangerous, which is false — and a
 * mark that is wrong about half of what it covers is worse than no mark, because the half it is
 * right about stops being believed.
 *
 * So the gate is per control and per tool. The group's own glyph keeps a mark as a **summary**, so
 * something is at stake is visible without opening anything; it asks nothing, because opening a
 * group to read what a threshold is set to destroys nothing.
 *
 * ## The question is asked before the act, for both kinds
 *
 * A marked slider is **locked** — it cannot be picked up until the GM agrees. A marked tool cannot
 * be armed until the same. That is one rule covering both, and it fixes an asymmetry that was
 * awkward in exactly one direction: the prompt used to fire on a slider's *release*, so declining
 * had to put the handle back, restoring the input **and** the row's own idea of where it sat, or the
 * next release would think nothing had changed and write the discarded value silently. Asking first
 * deletes that entirely.
 *
 * > A lock was proposed early and rejected, on the grounds that a lock prohibits where the truth is
 * > a price. That was right while nothing was actually locked. Something is now, so the reading is
 * > honest: **a marked control must be agreed to before it can be touched.**
 *
 * ## It only ever asks once
 *
 * Agreeing discards the stored graph, so `wallsEdited` goes false and every mark on the surface
 * clears together. There is no path where a GM answers this twice in a row.
 *
 * ## Why the glyph is a wall graph
 *
 * It names **what is at stake** rather than what the control does — which is the complaint that
 * retired the count (user, 2026-09-14): a badge on a brush reads as a property of the brush. It is
 * drawn in the structure blue the wall layer uses, so it reads as *walls of yours*.
 *
 * **Blue and not red**, which is where this started: red is reserved for destruction and earns its
 * alarm by being rare, while this can be worn for a whole session.
 *
 * DOM for the glyph; `stage.ts` for the question and for the consent.
 */

import { confirmAction } from "../confirmDialog";
import { describeError } from "../describeError";
import { regeneratesWalls, type SettingName } from "../settings";
import { stepRegeneratesWalls, TOOLS, type StepId } from "../steps";
import { say } from "./shell";
import { discardWalls, wallsEdited } from "./stage";

/** Whether a group holds anything that would rebuild the walls — the summary on its own glyph. */
export function stepIsMarked(step: StepId): boolean {
  return stepRegeneratesWalls(step) && wallsEdited();
}

/** Whether this control would rebuild the walls, and so cannot be touched without agreeing. */
export function controlIsMarked(name: SettingName): boolean {
  return regeneratesWalls(name) && wallsEdited();
}

/**
 * Whether this tool would rebuild the walls.
 *
 * **Every tool in the ink band, and the band is the honest test rather than a shortcut.** What those
 * three do is write to the reading's inputs — suppression and added ink are composed into the mask,
 * and accepting a gap writes into the added-ink layer — so all three change what the walls are
 * derived from, exactly as a threshold does. Nothing in the other bands touches the reading at all.
 */
export function toolIsMarked(tool: string): boolean {
  return TOOLS.find((choice) => choice.id === tool)?.band === "ink" && wallsEdited();
}

/**
 * Ask, and on agreement throw the stored graph away so the question is answered for good.
 *
 * **Consent is the document going rather than a flag recording that consent was given.** A flag is a
 * second statement of the same fact and can disagree with it; an absent graph cannot. With nothing
 * stored the derive runs freely, what it produces takes the screen, and the push adopts it — which
 * is the state a map that has never been edited is already in, so there is one path rather than a
 * consented one beside it.
 *
 * Returns whether the caller may go ahead. A failed discard answers **no**, so a GM is never left
 * with a setting that has moved against a document that has not.
 */
export async function confirmRegenerate(what: string): Promise<boolean> {
  const ok = await confirmAction({
    title: "Generate the walls again, discarding your changes to them?",
    body: [
      `${what} is one of the things the walls are derived from, so using it builds them again from ` +
        "the map. Anything you moved, drew or erased by hand is not in what replaces them, and it " +
        "cannot be undone afterwards.",
      "The ink you painted is safe: suppression and added ink are inputs to the reading, so they " +
        "survive it. Only changes made to the walls themselves go.",
    ],
    confirmLabel: "Generate them again",
    destructive: true,
  });
  if (!ok) {
    say("kept your wall changes — nothing was touched");
    return false;
  }

  try {
    await discardWalls();
    return true;
  } catch (error) {
    const detail = describeError(error);
    say(`could not discard the walls, so nothing changed: ${detail}`, "bad");
    console.error("Fog Nudger — discarding the walls failed", error);
    return false;
  }
}

/**
 * The mark itself: a small wall graph, cased the way every mark on the canvas is.
 *
 * The casing is not decoration — it is the one thing that makes a mark legible without knowing what
 * is behind it, and using it means this looks like the marks on the map rather than like chrome that
 * happens to be blue.
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
 * The line at the top of a group holding marked controls, saying what the marks mean.
 *
 * **A glyph cannot say what it costs**, and a sentence on every group would be noise on the ones
 * that are not marked. So it appears exactly where at least one control is locked, and it explains
 * the marks rather than the group — which is the change from when the group itself was the thing
 * marked, and this said "anything here rebuilds them".
 */
export function wallsNotice(): HTMLElement {
  const notice = document.createElement("p");
  notice.className = "walls-notice";
  notice.innerHTML =
    "<b>These walls hold changes of yours.</b> The marked settings build them again from the map, " +
    "so they ask before they will move.";
  return notice;
}
