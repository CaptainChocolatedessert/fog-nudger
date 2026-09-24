/**
 * What the pipeline thinks is at one pixel.
 *
 * ## Why this exists
 *
 * A GM reported light areas inside rooms showing through as bare map. Four explanations were
 * offered before this module was written — fog painting over the staging layer, tokens rendering
 * above it, holes kept by a size rule, and a filled tone landing on the ink side of the threshold —
 * and every one of them was argued from geometry or from an aggregate. Two were refuted by a
 * measurement that already existed, and one by the GM pointing out that the areas are *white*, which
 * no binariser is going to call ink.
 *
 * The common fault is not that the guesses were bad. It is that **every other diagnostic here
 * reports a total**, and a total cannot answer "what is happening *there*". The coverage line sums
 * areas, the ink-shape check ranks components — neither can be pointed at the thing a human is
 * looking at.
 *
 * That is also why this one survived when both censuses were deleted on 2026-09-02. The workspace
 * draws the ink, the skeleton and the partition, so most of what an aggregate used to stand in for
 * can simply be looked at now. **This answers what looking cannot**: what luminance was actually
 * read, whether the threshold called it ink, and whether the GM painted it rather than the map
 * having it.
 *
 * So this reports one pixel, and the numbers it returns are the ones that discriminate:
 *
 * - **Luminance**, which settles "is this actually white" objectively rather than by eye through two
 *   layers of tint.
 * - **Ink or not**, from the composed mask the walls are derived from.
 * - **Which of the GM's layers decided it**, if either did. Outcomes that look identical on screen
 *   and have completely different causes.
 *
 * ## Which region a point is in is not answered here, deliberately — 2026-09-24
 *
 * It was, from a labelling every derive made for this module alone: the thinned centrelines as a
 * raster, each pocket between them numbered. It cost over 40% of a derive on a real map, and it
 * answered a question the screen already answers — every room is drawn in its own fill. **And it
 * answered it wrongly in the commonest case**: the labelling was a different partition from the one
 * drawn, so a click outside the dungeon was told it was *"inside region 1, which is emitted as its
 * own shape — so this point IS covered"*, when the outside is never emitted. A suppressed region got
 * the same sentence, and the region numbers matched nothing on screen or in the log.
 *
 * **If "which region" is ever wanted back, ask the wall graph's own faces** — the lookup Erase loop
 * uses — which are the regions drawn and know about the outside and the marks. Not a raster of
 * something else.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import type { ScalarField } from "./field";

export type PointKind =
  | "outside-raster"
  /** Ink in the composed mask, read from the map rather than painted. */
  | "ink"
  /**
   * Ink **this run invented** — the gap repair filled it, and the map has no ink there.
   *
   * Worth its own kind rather than a clause on `"ink"`, because every word of the ink message is
   * misdirection here: the luminance is light *because there is nothing there*, the local threshold
   * did not call it ink, and the binariser is not wrong. The old answer sent a GM to tune the
   * threshold when the control that did this is the gap repair.
   */
  /*
    `invented-ink` was here, and it is gone rather than merely unused (2026-09-05).

    It meant ink the gap repair filled in, which the map does not have — and every clause of the
    plain ink answer was misdirection for it, which is why it earned a kind. That case cannot arise
    any more: the repair became a tool, and what it fills is written into the **added-ink layer**, so
    a pixel that was once "invented" now reports as ink the GM drew. Which is true — they accepted
    it — and is the design saying that an accepted fill is paint like any other.
  */
  /**
   * Ink the **GM drew** on the added-ink layer.
   *
   * Its own kind for the same reason `invented-ink` is: every clause of the ink message points at
   * the wrong control. The luminance is whatever the map happens to be, the threshold did not put it
   * here, no filter can take it away, and the thing that would change it is a brush rather than a
   * slider. This is also the answer that closes the loop on "I painted here and nothing happened".
   */
  | "added-ink"
  /**
   * Not ink **because the GM suppressed it**, whatever the map says.
   *
   * The counterpart, and the more valuable of the two: without it, a suppressed wall reads as plain
   * space with a luminance that flatly contradicts it — a dark pixel the trace calls ground — and
   * the obvious conclusion is that the threshold is broken. Naming the layer that did it is the
   * difference between an hour on the wrong slider and one click of the erase brush.
   */
  | "suppressed"
  /**
   * Not ink, and neither of the GM's layers touched it: the reading called it ground.
   *
   * Nothing is said about which region it is in or whether that region is emitted — the fill on
   * screen says both, and the header says why this module stopped guessing.
   */
  | "space";

export interface PointReading {
  readonly x: number;
  readonly y: number;
  readonly kind: PointKind;
  /** 0–1, from the field the binariser actually read. `null` outside the raster. */
  readonly luminance: number | null;
}

export function readPoint(
  field: ScalarField,
  mask: BinaryMask,
  x: number,
  y: number,
  /**
   * The GM's two layers, as this run composed them.
   *
   * Optional, and the same lookup as the ink verdict: from the data that produced the picture
   * rather than from a parallel path. What makes them worth a kind each is that
   * they are the only inputs here **no slider can explain** — a GM tuning the threshold to fix a
   * pixel their own brush decided has no way to find that out by looking.
   */
  paint: {
    readonly suppress: { readonly width: number; readonly data: Uint8Array } | null;
    readonly ink: { readonly width: number; readonly data: Uint8Array } | null;
  } | null = null,
): PointReading {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) {
    return { x: px, y: py, kind: "outside-raster", luminance: null };
  }

  const i = py * mask.width + px;
  const luminance = field.data[i] ?? 0;
  const ink = mask.data[i] === 1;

  /*
    Whether each of the GM's layers covers this pixel. **Which of them gets to explain it is decided
    by the order of the chain below, and by nothing else.**

    That is worth stating because a mutation pass found the first version saying it twice, on both
    flags. Suppression also tested `!ink`, which is what the chain already guarantees: suppression
    composes before the gap repair, so the only way a suppressed pixel is ink at the end is that
    the repair or the GM's own brush put it back — and both are answered above it. Added ink also
    tested `ink`, which cannot be false where it covers: it composes **last of everything**, so every
    pixel it covers is ink by construction. Two statements of one rule is one that can be changed
    while the other keeps the tests green.

    So both flags mean only "this layer covers this pixel", and composing order decides the rest.
    Added ink is at the top of the chain because it is last in the composition.

    The width check is not redundant: the pipeline resamples a layer to the run's raster before
    composing, so these normally match, and a caller handing over the *stored* layer instead would
    otherwise index it as though it were this raster — reporting about a pixel some distance from the
    one being asked about.
  */
  const layerCovers = (
    layer: { readonly width: number; readonly data: Uint8Array } | null | undefined,
  ): boolean => !!layer && layer.width === mask.width && layer.data[i] !== 0;

  const drawn = layerCovers(paint?.ink);
  const suppressedHere = layerCovers(paint?.suppress);

  const kind = drawn ? "added-ink" : ink ? "ink" : suppressedHere ? "suppressed" : "space";
  return { x: px, y: py, kind, luminance };
}

/**
 * One line a human can act on, naming what would have to be true for each outcome.
 *
 * Says something in every case, including the dull one: "not ink" over a gap a GM is asking about
 * says the gap is in the reading, before any wall was fitted to it.
 */
export function describePoint(reading: PointReading): string {
  const at = `raster (${reading.x}, ${reading.y})`;
  const tone =
    reading.luminance === null ? "" : ` luminance ${reading.luminance.toFixed(3)}`;

  /** The binariser verdict, which is worth shouting about only when the tone contradicts it. */
  const inkTone =
    reading.luminance !== null && reading.luminance > 0.8
      ? ` That luminance is nearly white, which a local threshold should not call ink — if this is ` +
        `a flat area rather than fine linework, the binariser is wrong here.`
      : ` It is dark enough for that to be the expected answer.`;

  switch (reading.kind) {
    case "outside-raster":
      return `${at} is outside the map image entirely — the point did not land on the traced map.`;
    case "ink":
      return `${at}${tone} is INK, read from the map.${inkTone}`;
    case "added-ink":
      return (
        `${at}${tone} is ink YOU DREW, on the added-ink layer. The map's own reading does not decide ` +
        `this and no filter can remove it — added ink goes in last of everything. To change it, use ` +
        `the erase brush under Add ink rather than any slider.`
      );
    case "suppressed":
      return (
        `${at}${tone} is not ink because YOU SUPPRESSED it, whatever the map says here. The ` +
        `threshold is not what did this and moving it will not bring the mark back — use the erase ` +
        `brush under Suppress.`
      );
    case "space":
      return (
        `${at}${tone} is not ink — the reading called it ground, and neither of your layers ` +
        `touched it.`
      );
  }
}
