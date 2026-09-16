/**
 * Ask, by putting the answer on the map and the two replies in the bar.
 *
 * ## It was a dialog, and a dialog could not be answered — user, 2026-09-15
 *
 * The modal asked two questions at once. *Do you understand what this costs* is a yes or no and a box
 * is the right shape for it. *Is what it costs acceptable* can only be answered by looking — panning,
 * zooming, finding the wall you drew across the corridor and deciding whether you mind — and a modal
 * exists precisely to stop you doing anything else. It drew the delta behind itself and lightened its
 * own backdrop to compensate, which was the compromise showing; needing to **pan** is where it
 * stopped holding (*"maybe the dialog isn't the right idea if there is interaction needed"*).
 *
 * So there is no dialog on this path. Pressing the lock's key puts the delta on the map and the two
 * answers **in the drawer, level with the button that was pressed**, and the surface stays entirely
 * live while the GM looks. **Nothing is pending while they do**: the walls are exactly as they were,
 * so wandering off and arming some other tool is a perfectly good answer and simply takes the marks
 * down.
 *
 * ## The answers were in the bar for a few hours — user, 2026-09-15
 *
 * *"It's easy to miss those buttons down on the bar."* The bar was chosen because the question
 * arrives from two places — a locked slider inside a drawer, a marked tool in the strip — and it is
 * the one piece of furniture both can reach. Reachable from both turned out to mean near neither.
 *
 * That is a failure this record had already written down about the **state line**: it sits at the
 * foot of a full-screen window while every control that writes to it is in the left rail, so a
 * message about a press arrives as far from the press as the window allows — and that is what once
 * made three working buttons read as dead. The fix is placement rather than emphasis. Colouring the
 * bar louder would have been treating the same defect as a visibility problem.
 *
 * The drawer is where a press already puts things. Using it means the answers arrive where the eye
 * is and no new place has to be learnt — at the cost of the two buttons stacking rather than
 * sitting side by side, and of a locked slider's own drawer being taken over by the question about
 * it. Both are fair: the slider cannot be touched until it is answered anyway.
 *
 * That is this project's own rule one step further on. `confirmDialog.ts` already argues that a
 * dialog is a bad way to make a boundary visible, because it arrives *after* the gesture, and that
 * the boundary should be shown first by disabling what would cross it and saying why. The lock and
 * its mark are that first half. This is the second: it shows what is behind the boundary rather than
 * describing it.
 *
 * **Two costs, and they are real.** The destructive action is no longer behind a modal, so a stray
 * click can reach it — which is why it is the **second** of the two in a drawer that has just
 * appeared, so the reflex press lands on the harmless one, and why it is the only urgent chip on
 * screen. And this is a **mode**, on a surface that has been shedding them; the mildest kind, since
 * it changes nothing and leaves on any other action, but one.
 *
 * ## What the mark is on, and why it is not on the group
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
 */

import { describeError } from "../describeError";
import { regeneratesWalls, type SettingName } from "../settings";
import { stepRegeneratesWalls, TOOLS, type StepId } from "../steps";
import { say } from "./shell";
import { discardWalls, onStageChange, wallsEdited } from "./stage";
import { showWallDelta } from "./layers/delta";

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
 * What the GM came to do, held while they decide whether it is worth the walls.
 *
 * **The walls are not pending; the press is**, and the difference is the whole argument for this
 * shape. Nothing has happened to the document, so leaving costs nothing — but a GM who reached for
 * Add ink meant to reach for Add ink, and making them press it twice would turn a confirmation into
 * an errand. A locked slider has no `then`: unlocking is the entire act.
 */
interface Review {
  readonly what: string;
  readonly then: (() => void) | null;
  /**
   * Which strip button the drawer should open level with, or `null` for wherever it already is.
   *
   * A marked **tool** names its own button, because the press that raised the question is that
   * button and the answer belongs beside it. A locked **slider** names nothing: its key is inside
   * a drawer that is already anchored at its group, so the question stays exactly where the GM
   * was looking rather than jumping to a button they did not press.
   */
  readonly anchor: string | null;
}

let review: Review | null = null;

const listeners: (() => void)[] = [];

/** Told when the review opens or closes, so the bar can show or hide its two answers. */
export function onRegenerateReview(listener: () => void): void {
  listeners.push(listener);
}

/** What is being reviewed, or `null`. Read by the bar to decide what its buttons say. */
export function regenerateReview(): Review | null {
  return review;
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Put the question up: the delta on the map, the answers in the bar.
 *
 * Takes what the GM was trying to do rather than returning whether they may. **The old signature was
 * a promise of a yes or a no**, which is what a modal can offer and this cannot: there is no moment
 * at which this function knows the answer, because the surface goes on working while the answer is
 * being decided. A caller hands over what to do if the answer turns out to be yes.
 */
export function reviewRegenerate(what: string, then?: () => void, anchor?: string): void {
  review = { what, then: then ?? null, anchor: anchor ?? null };
  const marked = showWallDelta(true);
  // The state line still narrates, because it is the surface's running commentary and this is an
  // event. What it is not any more is where the *answer* lives.
  say(
    marked
      ? `${what} would build these walls again from the map — look at what changes, then choose`
      : `${what} would build these walls again from the map`,
  );
  announce();
}

/** Take the question down, leaving the walls as they are. */
export function keepWallChanges(): void {
  if (!review) return;
  review = null;
  showWallDelta(false);
  say("kept your wall changes — nothing was touched");
  announce();
}

/**
 * Agree: throw the stored graph away, then do whatever the press was for.
 *
 * **Consent is the document going rather than a flag recording that consent was given.** A flag is a
 * second statement of the same fact and can disagree with it; an absent graph cannot. With nothing
 * stored the derive runs freely, what it produces takes the screen, and the push adopts it — which
 * is the state a map that has never been edited is already in, so there is one path rather than a
 * consented one beside it.
 *
 * A failed discard leaves the review **up**, so the GM is never left with a setting that has moved
 * against a document that has not — and the marks on the map still describe the walls exactly, which
 * is what makes staying up the honest state rather than a stuck one.
 */
export async function acceptRegenerate(): Promise<void> {
  const pending = review;
  if (!pending) return;

  try {
    await discardWalls();
  } catch (error) {
    const detail = describeError(error);
    say(`could not discard the walls, so nothing changed: ${detail}`, "bad");
    console.error("Fog Nudger — discarding the walls failed", error);
    return;
  }

  review = null;
  showWallDelta(false);
  announce();
  pending.then?.();
}

/**
 * The question, built for the drawer to put in its slot.
 *
 * Built fresh on every render and wired directly, with no ids on anything. A drawer's contents are
 * rebuilt wholesale, so an id here would be a handle onto an element that may already have been
 * replaced — which is how a lookup for `#tool-hint` came to name nothing at all.
 */
export function reviewBody(): HTMLElement {
  const body = document.createElement("div");
  body.className = "review-body";
  if (!review) return body;

  const said = document.createElement("p");
  said.className = "sub";
  said.innerHTML =
    `<b>${review.what}</b> builds these walls again from the map. Anything you moved, drew or ` +
    "erased by hand goes with them, and the ink you painted does not — it is an input to the " +
    "reading, so it survives.";
  body.append(said);

  /*
    The key names no colour, and is printed in them instead.

    A sentence saying "what goes is in amber" is a copy of a value the GM can retune — the palette
    publishes every role as a custom property so the page and the canvas cannot disagree, and a
    hue's *name* in prose is the one form of that copy no property can keep honest.
  */
  const legend = document.createElement("p");
  legend.className = "review-legend";
  legend.innerHTML =
    'On the map: <b class="going">what goes</b> · <b class="coming">what comes back</b>';
  body.append(legend);

  // Keep first, destroy second: a drawer that has just appeared under the cursor should meet a
  // reflex press with the harmless answer.
  const keep = document.createElement("button");
  keep.type = "button";
  // The ordinary chip, filled, which on this surface is what a default answer looks like. Not
  // `quiet` — that is styled under `.step-actions` and would be a class doing nothing here.
  keep.className = "chip";
  keep.textContent = "Keep my changes";
  keep.addEventListener("click", keepWallChanges);

  const go = document.createElement("button");
  go.type = "button";
  go.className = "chip urgent";
  go.textContent = "Generate them again";
  go.addEventListener("click", () => void acceptRegenerate());

  body.append(keep, go);
  return body;
}

/**
 * The ways out of a review that are not one of its own two buttons.
 *
 * `onStageChange` closes a review the walls have moved out from under — an undo taking the last hand
 * edit back is the reachable one, and it leaves a delta describing a difference that no longer
 * exists. The marks would be the stale diagnostic this project keeps paying for, and the question
 * would be asking about nothing.
 */
export function registerRegenerateReview(): void {
  /*
    Escape answers "keep", and stops there.

    The shell's own Escape closes the workspace, which is what the dialog used to intercept while it
    was up. Without this, the reflex that dismissed the old prompt would now shut the surface.
  */
  document.addEventListener(
    "keydown",
    (event) => {
      if (!review || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      keepWallChanges();
    },
    true,
  );

  onStageChange(() => {
    if (review && !wallsEdited()) keepWallChanges();
  });
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
