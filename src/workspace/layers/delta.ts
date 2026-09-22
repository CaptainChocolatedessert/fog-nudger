/**
 * The delta layer: what a regenerate would take away, and what it would bring back.
 *
 * ## It is the answer the count was standing in for
 *
 * The mark on a locked control says *there is work of yours in these walls*, and the dialog behind
 * it says *using this destroys it*. Neither says **which walls**, and that was the complaint that
 * retired the hand-edit count in the first place (user, 2026-09-14): fourteen tells a GM nothing
 * they can act on, because they cannot know whether those fourteen mattered. The thing that answers
 * it is a picture, and the surface is already showing the map the walls are drawn on.
 *
 * ## Amber for what goes, cyan for what arrives — and the diff's words are the other way round
 *
 * `diffWallGraphs(base, document)` reports what the **GM** did: `added` is what they put there,
 * `removed` is what they took away. This draws the **future**, so the two swap. A wall they added is
 * not in the derivation that would replace it, so it goes, and goes in the subtractive colour; a
 * wall they erased is in that derivation, so it comes back, in the additive one.
 *
 * That is the same amber/cyan pair the painted ink uses, deliberately — the GM has already learnt it
 * on the brushes, and the meanings are identical: this is leaving, this is arriving. No vocabulary
 * is introduced that is not already somewhere else on the canvas.
 *
 * **A move reads as both**, because the diff has no third category: dragging a vertex moves every
 * segment touching it, so the old run is amber and the new run is cyan beside it. That is the
 * honest picture of what a regenerate does to a moved wall.
 *
 * ## Computed once when the question is asked, not per frame
 *
 * Both graphs are walked to build it, and a real map's document is thousands of segments. The
 * question is up for as long as a GM takes to read it and the answer cannot change while it is —
 * nothing can edit the walls behind a modal — so this is held from the moment it is armed.
 *
 * ## Drawn last, over everything
 *
 * Registered after the graph layer, so the delta covers the blue walls it is about rather than
 * hiding under them. That is the right way round while the question is up: the unchanged walls are
 * still there in blue, and the ones at stake are the ones that changed colour.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../../devlog";
import { diffWallGraphs, type WallGraphDelta } from "../../trace/wallGraphDiff";
import { colourFor } from "../palette";
import { addPainter, invalidate, type Painter } from "../shell";
import { derivedBase, wallGraph } from "../stage";

/** The delta being asked about, or `null` when nothing is. */
let showing: WallGraphDelta | null = null;

const listeners: (() => void)[] = [];

/**
 * Told when the delta comes up or goes down.
 *
 * `toolPalette` is the only subscriber and the reason is structural rather than incidental: it owns
 * the whole layer proposal, and a module reaching past it to `requireLayer` would be adding to a
 * list something else replaces on its next render — which is exactly the defect that made arming a
 * wall tool take the walls off the screen.
 */
export function onDeltaChange(listener: () => void): void {
  listeners.push(listener);
}

/** Whether the delta is being asked about, which is what puts its layer in the proposal. */
export function deltaShowing(): boolean {
  return showing !== null;
}

/**
 * Put the delta up, or take it down.
 *
 * Returns whether anything is actually on screen, so a caller can tell a GM to look at the map
 * without promising marks that are not there. Nothing is drawn when there is no base to compare
 * against — a document stored before bases existed — which is a state the mark cannot be shown in
 * anyway, since `wallsEdited` is what gates both.
 */
export function showWallDelta(on: boolean): boolean {
  const base = derivedBase();
  const document = wallGraph();
  showing = on && base && document ? diffWallGraphs(base, document) : null;
  if (showing) {
    /*
      Logged every time, including when it is nothing.

      A delta can be entirely outside the view — the GM may have edited a corner and then zoomed
      elsewhere — so an empty-looking map is the one case a picture cannot distinguish from a
      picture that never ran. The counts are the thing that separates them, and they go to the log
      rather than into the dialog, where a number was the instrument this whole feature replaced.
    */
    devLog(
      "info",
      `delta: ${showing.added.length} walls of yours would go and ${showing.removed.length} ` +
        "erased ones would come back if the walls were derived again",
    );
  }
  for (const listener of listeners) listener();
  invalidate();
  return showing !== null && showing.added.length + showing.removed.length > 0;
}

/** Screen pixels. Wider than a wall line, because this is drawn to be found rather than aimed at. */
const DELTA_WIDTH_PX = 4;

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const delta = showing;
  if (!delta) return;

  // Graph units to screen, the same arithmetic the graph layer uses and for the same reason: the map
  // is drawn at the image's own aspect, so the longer drawn side is one unit on both axes. There is
  // no raster here to be consistent with.
  const long = Math.max(drawWidth, drawHeight);
  const x = (units: number): number => view.x + units * long;
  const y = (units: number): number => view.y + units * long;

  const trace = (segments: readonly { readonly a: Vector2; readonly b: Vector2 }[]): void => {
    context.beginPath();
    for (const segment of segments) {
      context.moveTo(x(segment.a.x), y(segment.a.y));
      context.lineTo(x(segment.b.x), y(segment.b.y));
    }
    // Cased before coloured, the lesson the wall lines taught: a centreline lies exactly on the
    // map's own linework, so a saturated core over a light casing is the only treatment that reads
    // against dark ink and pale paper alike.
    context.strokeStyle = colourFor("casing");
    context.lineWidth = DELTA_WIDTH_PX + 2;
    context.stroke();
  };

  /*
    **What comes back is drawn over what goes** (user, 2026-09-22). Straightening replaces nearly every
    wall, so the two sets lie on each other almost everywhere, and with amber on top the picture read as
    everything being deleted when it is being replaced. Cyan last means amber shows only where no new
    wall lies over it. The names are the diff's, which run the other way — see this file's notes.
  */
  for (const [segments, role] of [
    [delta.added, "subtractive"],
    [delta.removed, "additive"],
  ] as const) {
    if (segments.length === 0) continue;
    trace(segments);
    context.strokeStyle = colourFor(role);
    context.lineWidth = DELTA_WIDTH_PX;
    context.stroke();
  }
};

/** Wire the layer up. Registered after the graph, which is what puts the delta over the walls. */
export function registerDeltaLayer(): void {
  addPainter("delta", paint);
}
