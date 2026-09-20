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
 * So there is no dialog on this path. Pressing the cover puts the delta on the map and the two
 * answers **in the drawer, level with the lid that was pressed**, and the surface stays entirely
 * live while the GM looks. **Nothing is pending while they do**: the walls are exactly as they were,
 * so wandering off and arming some other tool is a perfectly good answer and simply takes the marks
 * down.
 *
 * ## The answers were in the bar for a few hours — user, 2026-09-15
 *
 * *"It's easy to miss those buttons down on the bar."* The bar was chosen because the question then
 * arrived from two places — a locked slider inside a drawer, a marked tool in the strip — and it is
 * the one piece of furniture both can reach. Reachable from both turned out to mean near neither.
 * (There is one place now, and it is the lid; the reasoning is kept because it is what the drawer
 * had to answer, and because the failure it names is this surface's own gravity.)
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
 * the boundary should be shown first by disabling what would cross it and saying why. The lid is
 * that first half. This is the second: it shows what is behind the boundary rather than describing
 * it.
 *
 * **Two costs, and they are real.** The destructive action is no longer behind a modal, so a stray
 * click can reach it — which is why it is the **second** of the two in a drawer that has just
 * appeared, so the reflex press lands on the harmless one, and why it is the only urgent chip on
 * screen. And this is a **mode**, on a surface that has been shedding them; the mildest kind, since
 * it changes nothing and leaves on any other action, but one.
 *
 * ## What is locked: a side, not a control — 2026-09-20
 *
 * **It was per control, and before that per group, and both were the same mistake at two sizes.**
 * The group was a proxy and an inaccurate one (user, 2026-09-14): Ink holds nine controls and five
 * of them regenerate, so marking the group told a GM the brush width was dangerous — and a mark
 * that is wrong about half of what it covers stops being believed about the other half. Going per
 * control fixed the accuracy and kept the shape: a set of controls, membership of which a GM
 * **cannot predict and therefore cannot hold**, so the surface had to tell them each time.
 *
 * The cover organises it around the **cause** instead. What the walls are made from is the map and
 * the ink, which is one sentence and the same line stage one and stage two fall either side of, so
 * the whole ink side goes under one lid and no control is asked about itself. The map picker joins
 * it for the first time — nominating a different image discards the graph outright, and it declared
 * no parameter, so the most destructive control on the surface was the one thing the per-control
 * gate could never mark.
 *
 * ## It exists only when there is something to lose
 *
 * Gated on `wallsEdited`, so no hand edits means no cover and nothing interrupts. **That makes it a
 * state the document is in rather than a place the GM is**, which is the formulation the mode
 * boundary never managed — and it answers the live objection to the old arrangement, that *the
 * ceremony fires on crossing the boundary whether or not anything is at stake.*
 *
 * ## It only ever asks once
 *
 * Agreeing discards the stored graph, so `wallsEdited` goes false and the lid comes down with it.
 * There is no path where a GM answers this twice in a row.
 *
 * ## The lid carries no glyph, and why that is the point
 *
 * The strip is a column of glyphs, so another glyph in it is another tool to read past. Four
 * candidates were drawn at strip size and lost to a plain lid: it is furniture over the buttons
 * rather than a button among them, and it **lightens** rather than darkening, so the tools stay
 * legible underneath at half strength. *Readable but unreachable* is the honest picture of the
 * state, where a dark scrim says gone.
 *
 * **The cost:** with no glyph and no word, its blue carries the meaning alone — which reads as
 * *your walls* to somebody who knows the palette and as *locked* to somebody who does not, who
 * learns why on pressing it. Blue and not red regardless: red is reserved for destruction and earns
 * its alarm by being rare, while this can be worn for a whole session.
 */

import { describeError } from "../describeError";
import { say } from "./shell";
import { discardWalls, onStageChange, wallsEdited } from "./stage";
import { showWallDelta } from "./layers/delta";

/*
  The per-control gate was here and went on 2026-09-20, when the cover replaced it.

  `stepIsMarked`, `controlIsMarked`, `toolIsMarked`, the `wallsMark` glyph they all wore and the
  `wallsNotice` that explained it: five exports, each asking *would this particular press rebuild
  the walls*, and every one of them true only while the cover is up — which is to say only while the
  control it marked is under the lid and cannot be pressed at all.

  **They are not being tidied away; they had stopped being reachable.** That is the distinction this
  project has paid for before, in the other direction: `toolPalette` once exported an `onToolChange`
  nothing subscribed to, and the unreachability *was* the defect rather than dead weight. Here it is
  the intended consequence — the rework's whole point is that a GM cannot hold the set of controls
  that regenerate, so the surface stopped asking them to and locked a whole side instead.

  What went with them, one layer down: `regeneratesWalls` in `settings.ts` and
  `stepRegeneratesWalls` in `steps.ts`, whose only callers these were.
*/

/**
 * The `data-opens` stamp the cover carries.
 *
 * A stamp and not an id, for the reason every other press here uses one: the drawer anchors level
 * with whatever raised the question and the strip draws that same thing raised, and both go through
 * this one string. **The cover has no pressed state of its own** — it is neither a drawer opener nor
 * a verb — so the stylesheet answers `aria-pressed` by brightening the lid.
 */
export const COVER_ANCHOR = "cover";

/**
 * Whether the cover is over the ink side: these walls are not what the trace derived.
 *
 * **The same question every mark it replaces asked, put once to a whole half of the surface.**
 * `wallsEdited` compares the stored document against the graph the trace last derived, so this is
 * true exactly when there is something to lose — and false most of the time, when nothing
 * interrupts. No hand edits, no cover.
 *
 * Named rather than called straight through, because *is there a cover* and *has this been
 * hand-edited* are the same fact today and need not stay so; the gate is one line to move.
 */
export function coverIsUp(): boolean {
  return wallsEdited();
}

/**
 * The cover's press: raise the question, with nothing waiting on the answer.
 *
 * **No `then`, unlike a marked tool.** A tool hands over its own arming, so agreeing does both in
 * one go; the cover is not a press at anything in particular — a GM reached for the half of the
 * surface that is shut — so unlocking is the whole of the act, exactly as a locked slider's key was.
 *
 * **The subject is the cause, not a control.** Every per-control mark named the control it sat on,
 * because it sat on one. This names what the whole side does, which is the rework's own sentence:
 * the walls come from the ink, so changing the ink makes new walls.
 */
export function reviewFromCover(): void {
  up = true;
  const marked = showWallDelta(true);
  // The state line still narrates, because it is the surface's running commentary and this is an
  // event. What it is not any more is where the *answer* lives.
  say(
    marked
      ? `${COVER_SUBJECT} would build these walls again from the map — look at what changes, then choose`
      : `${COVER_SUBJECT} would build these walls again from the map`,
  );
  announce();
}

/**
 * What the question is about, in the one place the state line and the drawer both read it from.
 *
 * **The cause rather than a control.** Every per-control mark named the thing it sat on, because it
 * sat on one; the cover sits over a whole side, and what that side does is the rework's own
 * sentence — the walls come from the ink, so changing the ink makes new walls.
 */
const COVER_SUBJECT = "Changing the map or the ink";

/**
 * Whether the question is up. A boolean, and it did not used to be.
 *
 * It held **what** the press was and **what to do** if the answer turned out to be yes, because a
 * marked tool handed over its own arming: a GM who reached for Add ink meant to reach for Add ink,
 * and making them press it twice would have turned a confirmation into an errand. With the cover
 * there is no such press — reaching for the locked half of the surface is not reaching for anything
 * in particular — so **unlocking is the entire act**, which is what a locked slider's key already
 * was. The subject and the anchor are constants now, and nothing is pending but the answer.
 */
let up = false;

const listeners: (() => void)[] = [];

/** Told when the review opens or closes, so the drawer can raise or drop its two answers. */
export function onRegenerateReview(listener: () => void): void {
  listeners.push(listener);
}

/** Whether the question is on screen. Read by the drawer to decide what to show. */
export function reviewIsUp(): boolean {
  return up;
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** Take the question down, leaving the walls as they are. */
export function keepWallChanges(): void {
  if (!up) return;
  up = false;
  showWallDelta(false);
  say("kept your wall changes — nothing was touched");
  announce();
}

/**
 * Agree: throw the stored graph away.
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
  if (!up) return;

  try {
    await discardWalls();
  } catch (error) {
    const detail = describeError(error);
    say(`could not discard the walls, so nothing changed: ${detail}`, "bad");
    console.error("Fog Nudger — discarding the walls failed", error);
    return;
  }

  up = false;
  showWallDelta(false);
  announce();
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
  if (!up) return body;

  const said = document.createElement("p");
  said.className = "sub";
  said.innerHTML =
    `<b>${COVER_SUBJECT}</b> builds these walls again from the map. Anything you moved, drew or ` +
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
      if (!up || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      keepWallChanges();
    },
    true,
  );

  onStageChange(() => {
    if (up && !wallsEdited()) keepWallChanges();
  });
}
