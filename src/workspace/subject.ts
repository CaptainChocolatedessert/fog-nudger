/**
 * Which half of the work the GM is on, and what that turns down.
 *
 * ## Why dim anything
 *
 * Most of the crowding on this surface is a **strength** problem rather than a presence problem: the
 * ink mask, the room fills and the wall centrelines all want the same few pixels of a wall stroke,
 * and every one of them is worth seeing at some point. Hiding a layer is the blunt answer and the
 * switches already offer it; turning the other side down keeps it there as reference while the thing
 * being worked on reads first.
 *
 * ## It is keyed on the SIDE last touched, not on the tool and not on the drawer
 *
 * Arming an ink brush, moving an ink slider and pressing *Clear ink edits* all mean the same thing —
 * *I am working on the ink* — and so does everything on the wall side for the walls. **Keying it to
 * the open drawer would put the pre-2026-09-14 arrangement back**, when a group was a mode and
 * reading a number changed what your drag meant; that was the whole complaint the tool strip
 * answered.
 *
 * ## The document chooses where it starts — user, 2026-09-20
 *
 * This used to say *nothing dims until the first interaction, so the workspace opens on the plain
 * picture*. It opens with a side already lit instead, and the side is the one the GM can actually
 * work on: **no wall edits, the ink**, which is where somebody with nothing to lose is going anyway;
 * **wall edits, the walls**, because the ink half is under the cover and pressing it costs the walls.
 *
 * That also retires the start-up **advance**, which used to open the Ink *parameters* drawer the
 * moment a map loaded. A drawer is a guess at which controls are wanted; a dim is a statement about
 * which half of the map is the subject, which is the thing start-up actually knows.
 *
 * **The cost, stated:** the surface no longer opens on the plain picture, so the first thing a GM
 * sees is already a judgement about what they are here for. It is a judgement the *document* makes
 * rather than one being guessed — which is what separates it from automating *which layer is the
 * subject*, rejected in September for being a guess — but one side is dim before anyone has done
 * anything, and there is no both-full state at all.
 *
 * ## Two things that deliberately do not move it
 *
 * **Undo and redo.** An entry carries an **opaque tag** so the history can forget one document's
 * entries without learning what it holds, and the pair prints the entry's *label* rather than its
 * tag for exactly that reason. Reading the tag here to decide what to light would make it
 * meaningful and take that back. Undo is a correction rather than a change of subject: take back a
 * brush stroke while working on the walls and you are still working on the walls.
 *
 * **Opening a drawer**, per the rule above.
 *
 * Pure: no DOM, no SDK.
 */

import { LAYERS, stepIsInkSide, type LayerId, type StepId } from "../steps";

/** The two halves of the work: what the walls are made from, and the walls themselves. */
export type Side = "ink" | "walls";

/**
 * How far down the side that is not the subject goes.
 *
 * **They differ for a reason and are not a scale.** The ink is a flat area fill; the wall
 * centrelines are **cased** — a light stroke two pixels wider under a saturated core — and the
 * casing is what makes them read on dark linework at all, so one number would take the walls out
 * before it touched the ink.
 *
 * **Starting figures, to be moved by eye** (user, 2026-09-18). Nothing measures them and nothing
 * can: how faint is too faint over a particular map's artwork is a room's question.
 */
export const DIM: Readonly<Record<Side, number>> = {
  ink: 0.3,
  walls: 0.45,
};

/**
 * Which side each layer belongs to, or `null` for one that never dims.
 *
 * **Total over `LAYERS`, and that is the contract.** A layer added later has to be filed here or
 * `tsc` refuses, which is the one thing a desk can check about any of this — the alternative is a
 * default, and a layer silently defaulting to *never dims* is a layer that stops obeying the rule
 * with nothing to say so.
 *
 * **Only the two always-on subject layers are dimmable, and the rest fall out rather than being
 * exceptions:**
 *
 * - **`regions` never dims** (user, 2026-09-18): *"they're already pretty faint."* They are also the
 *   consequence a GM paints to fix, and the crowding this exists for is at the *stroke*, where the
 *   centrelines are and the fills are not.
 * - **`paint`, `gaps` and `blob`** are drawn only while an ink tool is armed, which *is* the ink
 *   side; **`mends`**, **`collapses`** and **`prunes`** likewise on the wall side. A tool layer can never be the dimmed side, so the
 *   answer is `null` by construction rather than by decision.
 * - **`delta`** belongs to the review, which is a question about both sides at once.
 */
const SIDE_OF_LAYER: Readonly<Record<LayerId, Side | null>> = {
  ink: "ink",
  graph: "walls",
  regions: null,
  paint: null,
  gaps: null,
  mends: null,
  // A tool layer on the wall side, drawn only while its tool is in hand — so never the dimmed side.
  collapses: null,
  prunes: null,
  blob: null,
  delta: null,
};

/**
 * The alpha a layer is drawn at, given which side is the subject.
 *
 * Pure, and the whole of the decision: the paint loop asks this on its way past each painter, so no
 * layer module ever learns that dimming exists.
 */
export function alphaFor(layer: LayerId, subject: Side): number {
  const side = SIDE_OF_LAYER[layer];
  if (side === null || side === subject) return 1;
  return DIM[side];
}

/** Which side a group belongs to, or `null` for one that is about neither — View. */
export function sideOfStep(step: StepId): Side | null {
  if (stepIsInkSide(step)) return "ink";
  return step === "walls" ? "walls" : null;
}

/** Every layer that can be dimmed at all, for the test that pins the table is not all `null`. */
export function dimmableLayers(): readonly LayerId[] {
  return LAYERS.filter((layer) => SIDE_OF_LAYER[layer] !== null);
}

/**
 * The subject, which is always one of the two.
 *
 * There is no "nothing yet": start-up sets it from the document, so the question the old design
 * answered with an undimmed opening is answered with a side instead.
 */
let subject: Side = "ink";

const listeners: (() => void)[] = [];

/** Told when the subject changes, so the canvas can repaint. */
export function onSubjectChange(listener: () => void): void {
  listeners.push(listener);
}

/** Which side is the subject. */
export function currentSide(): Side {
  return subject;
}

/**
 * The GM did something to this side. `null` is ignored, which is what View's controls hand over.
 *
 * Announcing only on a change, because this is called from every tool press and every slider
 * release and almost all of them say what is already true.
 */
export function workOn(side: Side | null): void {
  if (side === null || side === subject) return;
  subject = side;
  for (const listener of listeners) listener();
}

/**
 * Where the map opens: the walls if they hold anything the trace did not derive, otherwise the ink.
 *
 * **Not `workOn`**, because it is not a thing the GM did — it is the document saying which half is
 * available. It also has to be able to move the subject *back* to the ink when a map with no edits
 * is loaded after one that had them.
 */
export function startOn(wallsHoldEdits: boolean): void {
  const side: Side = wallsHoldEdits ? "walls" : "ink";
  if (side === subject) return;
  subject = side;
  for (const listener of listeners) listener();
}
