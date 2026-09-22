/**
 * The acts the strip draws at the foot of a band, in the order they appear there.
 *
 * ## What an act is
 *
 * The strip's **third kind of button**, beside the drawer opener and the verb. It opens nothing and
 * arms nothing, so there is no state for it to be in and it never draws pressed — which is the
 * distinction doing the work, since nothing else tells it from a verb. The argument that lets the
 * first two share a column covers it: the column is a list of things to press, and what each one
 * does is its own business.
 *
 * ## Why the order is stated here rather than in the strip
 *
 * A band can hold more than one, and Walls now does: *Toggle walls around the map edge* and then
 * *Clear wall edits*. Which comes first is a fact about the band, not about the loop that draws it —
 * and the strip's own rule is that **what a button acts on is said by where it is**, which only
 * holds if "where" is written down once.
 *
 * **Adds before destroys**, which is the order below and is deliberate: the bin is the last thing in
 * every band, so the foot of the column means the same thing wherever the eye lands on it.
 *
 * ## One shape for two families
 *
 * The clears confirm and are undoable in one step; the frame asks nothing in either direction,
 * because the opposite press puts back what it did. That difference lives in each act's own `run`,
 * not here — this only says which band a press belongs to, what it looks like, and when it is
 * structurally unavailable.
 *
 * **A toggle is still an act, and still never draws pressed.** The frame reads its state out of the
 * document, and the GM reads it off the map; the name says *toggle*, so it is true in both states.
 */

import { CLEAR_ACTS } from "./clearActions";
import { FRAME_ACT } from "./frameAction";

export interface BandAct {
  /** The band this sits at the foot of, which is also the caption that says its subject. */
  readonly step: string;
  readonly label: string;
  /** The glyph's id in `toolIcons.ts`. The two clears share one, and the caption tells them apart. */
  readonly glyph: string;
  /**
   * Whether the press can do anything at all — the *structural* question, asked on every redraw.
   *
   * The ink acts need a map; the wall acts need walls. Whether there is anything to clear **right
   * now** is a different question and is deliberately answered at the press instead: knowing it
   * means walking the raster, and this column redraws on every tool change.
   */
  readonly gate: () => boolean;
  readonly run: () => Promise<void>;
}

export const BAND_ACTS: readonly BandAct[] = [
  ...CLEAR_ACTS.filter((act) => act.step === "ink"),
  FRAME_ACT,
  ...CLEAR_ACTS.filter((act) => act.step === "walls"),
];
