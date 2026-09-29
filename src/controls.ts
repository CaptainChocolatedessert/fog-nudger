/**
 * Every control a GM can turn, declared once and rendered by two surfaces.
 *
 * ## Why this is its own module
 *
 * It lived in `panel.ts` until stage one moved to the workspace, which needs the same declarations
 * for the same controls. Two lists would be two places to disagree about what a knob is called,
 * which way it turns, or what unit it reports — and the disagreement would be silent, because each
 * surface would look right on its own. That is the argument `settings.ts` already makes for the
 * stage mapping, one level down.
 *
 * ## Pure, and `derive` is why
 *
 * A derived readout used to call `lastInkWidth()` out of the pipeline, which imports the SDK, which
 * would make this module unreachable from a headless test (§7). So a measurement a readout needs is
 * **passed in** rather than fetched. That is the better shape regardless: these functions turn
 * numbers into sentences and have no business knowing where the numbers came from — and the last
 * bug here was exactly a readout that hardcoded one map's ink width into a control meant for any
 * map.
 *
 * No DOM, no SDK.
 */

import { SETTING_LIMITS, type SettingName } from "./settings";
import type { Scale } from "./sliderScale";

/**
 * What the last run measured, for the readouts that report a value in something a GM can feel.
 *
 * Both are nullable and both are nullable *for a reason*: before a first reading there is no pixel
 * density and no raster, and a control that invented one would be reporting a guess in the voice of
 * a measurement. The readouts fall back to what they can say without it instead — bare pixels, or
 * nothing.
 *
 * **The measured ink width is deliberately not here** (user, 2026-09-16). Three readouts quoted it —
 * *"under ~4px goes (ink is 3.2px)"*, *"1.31 of a 3.2px ink width"*, *"3.8x the map's ink"* — and it
 * is an estimate: erosion-measured, biased thin, saturating at 2px and unrepresentative on a hatched
 * map, stated in the voice of a fact. Nobody looked at them while tuning; moving the slider and
 * watching the map is what the GM does. So they went rather than being reworded, and the field went
 * with its last reader. The pipeline still measures it, for seeding the straightening default.
 *
 * **A non-positive number is treated as no measurement**, not as a measurement of zero. Every
 * `derive` below tests `> 0` rather than `!== null`, because dividing by a zero pixel density puts
 * the literal string "Infinity" beside a slider — a guess in the voice of a measurement, wearing a
 * different hat. `lastPixelsPerSquare` already nulls a zero at source; this is the type's own
 * contract holding rather than one caller remembering.
 */
export interface Measured {
  /** Raster pixels per grid square, or `null` before any run. */
  readonly pxPerSquare: number | null;
  /**
   * Raster pixels per graph unit for the last reading, or `null` before any run.
   *
   * What turns a value in graph units back into pixels, for the controls stored in them. Nullable
   * for the same reason as the density: until a reading lands there is no raster, and a readout that
   * invented one would be reporting a guess in the voice of a measurement. (It gave a second reason
   * once — that the wall editor never runs a reading — and the editor is gone.)
   */
  readonly rasterPerUnit: number | null;
}

/*
  What a control says, and nothing about where it lives.

  It carried a `section` string until the steps became real. That was declared presentation-only,
  with "nothing may switch on it", because a control moved between headings for tidiness must not
  change what it recomputes — and a step now decides which layers are painted and what a drag means,
  so it is not presentation-only any more. Which step owns a parameter is declared in `steps.ts`,
  beside the stage and the kind and separately from both.
*/
export interface Control {
  readonly name: SettingName;
  readonly label: string;
  readonly hint: string;
  readonly scale?: Scale;
  /**
   * Report **where the handle is**, one to a hundred, instead of what the value is.
   *
   * For the controls whose stored unit is graph units — the map's longer side is 1. That unit is not
   * negotiable, since it is the graph's own — but "0.00043" beside a slider is not a number anybody can
   * read, and neither was the per-ten-thousand spelling that replaced it (user, 2026-09-07: *"an
   * arbitrary large number and log scale don't make sense to the user"*).
   *
   * What a GM actually wants from that readout is to **remember a setting and come back to it**, and
   * a position on the track serves that where a logarithmic figure does not.
   *
   * **The cost, stated: the number is a position, so it can drift.** The top of these tracks is
   * measured off the graph when the step opens, and the graph changes as walls are pruned and
   * straightened — so the same stored setting can read 40 today and 43 tomorrow. It is stable for as
   * long as the step is open, which is when a GM is comparing. The alternative, numbering against a
   * fixed reference range, is stable forever and puts the handle at the far right while the readout
   * says 78, which is wrong in a way you can see.
   */
  readonly readout?: "position" | "percent" | "pixels";
  /**
   * The unit the number beside the label is printed in — `12 px` — and `off` at zero on a track that
   * starts there (text rules, 2026-09-29: the yellow number carries the slider's one unit, and there
   * is never a second beside it). Where this is set, `derive` is not: a line under the slider saying
   * the same number again was the second unit the rules took away.
   */
  readonly unit?: "px";
  /**
   * What the number beside the label shows, where that is not the stored value itself. Only the
   * window has one: it stores a radius, and what a GM can picture is the window's width.
   */
  readonly shown?: (value: number) => number;
  /**
   * Draw the distribution this control acts on, rising off its own rail.
   *
   * Only the two ink filters have one, and that is a decision rather than a starting point: each is
   * a threshold over a population the pipeline can *measure* — stroke widths and island spans — so
   * the picture says where the populations are and the handle says which of them you are keeping.
   * A control with no distribution behind it has nothing to draw, and one drawn for every slider
   * would grow a 22rem column by 20 pixels a row for decoration.
   *
   * §8 asks a control that can be wrong for a visual channel. Both of these already have one — the
   * damage appears under the GM's cursor as they drag — and this is a second, cheaper channel that
   * works *before* the drag rather than during it.
   */
  readonly profile?: boolean;
  /**
   * Renders the value in a unit the GM can feel.
   *
   * Returns an empty string when it cannot say anything honest yet, which is how a control reports
   * "no measurement" without the caller having to know which readouts need which measurement.
   *
   * Takes only the measurements. It briefly took the whole settings object, when the repair width
   * was expressed as a share of a separate marking width; with one control there is nothing here
   * that is relative to another setting, and a readout that cannot see its neighbours cannot go
   * stale when one of them moves.
   */
  readonly derive?: (value: number, measured: Measured) => string;
  /**
   * Override the slider's own step, given the last reading's measured ink width in raster pixels —
   * or `null` before a first reading.
   *
   * **Only the stroke filter has one**, because its declared step is not its real resolution.
   * `radiusForWidth` turns a pixel width into an integer radius by halving it, so the smallest change
   * that is never a no-op is exactly 2 raster pixels of width — `2 / inkWidthPx` in this control's
   * own unit, ink widths. A fixed step cannot do this because the conversion depends on the map.
   *
   * Takes the measurement as an argument rather than fetching it, for the same reason `derive` does:
   * `lastInkWidth()` lives in the pipeline, which imports the SDK, and this module must not.
   */
  readonly stepFor?: (inkWidthPx: number | null) => number;
}

/**
 * Every control, in the order a GM meets them.
 *
 * **Almost none carries a hint, and that is deliberate** (user, 2026-09-09). A paragraph under every
 * slider in a 22rem column is a wall of prose nobody reads, and the label plus the readout beside it
 * is already the explanation — the readout says the value in a unit a GM can feel, which is the part
 * the sentence was mostly restating.
 *
 * Where a name was doing too little the **name changed** rather than being propped up by a sentence.
 * The old note here defended the hints on the grounds that a direction is not guessable — raising
 * Sauvola's `k` finds *less* ink, and "sensitivity" suggests the opposite. That argument was right
 * about the problem and wrong about the fix: the control is the **Ink contrast threshold** now
 * (text pass, 2026-09-29), and a higher threshold finding less ink needs no explaining. Likewise the
 * spur limit, which was *the longest dead end to remove* because "spur" is this project's word and
 * not a GM's.
 *
 * **Two hints survive**, one for each gap tool, and both define rather than steer (text rules,
 * 2026-09-29): what the distance under the label measures — the shortest path from one side of a
 * gap to the other, through the ink or along the walls. Which way to move it went, and so did the
 * gap search's warning that a proposal is not applied until accepted, which the highlight says.
 *
 * One list rather than one per surface: which stage a control belongs to is read from the stage
 * declaration in `settings.ts`, which is the same declaration the pipeline's cache invalidation
 * uses. Two lists would be two places to disagree about what a knob invalidates.
 *
 * **Order is presentation and nothing else**, and it is the only ordering a step has: each step
 * draws its controls in this order, so a control that should be met first is declared first. A
 * control that decides how a step's own layer is *drawn* leads its step, because looking at the thing
 * comes before tuning it — which is why the preview fill and outline come first in View. The ink's
 * opacity led the Ink step on the same argument until it was removed (2026-09-09).
 */
/**
 * A value in graph units, in raster pixels — the unit a GM can actually feel.
 *
 * It needs the raster the last reading used, so it says nothing until one has landed. The stored
 * unit stays graph units regardless — that is what keeps the setting from depending on a
 * measurement — and this is the readout being generous where it can.
 */

/*
  `brushReadout` was here: a brush width in pixels, and in grid squares where a run had measured the
  density. It went with the text rules of 2026-09-29 — one unit, on the number beside the label, and
  pixels need no second (user: *"pixels is already clear"*).
*/

/**
 * The stroke filter's step, in ink widths — see `Control.stepFor`.
 *
 * Rounded to three significant figures, the same precision a log-scaled setting snaps to, so the
 * step itself is a number a GM would not wince at if they ever saw it (they do not — only its
 * effect, in how many stops apart two outcomes sit, is visible) and so its decimal count stays short
 * enough for the readout beside the slider to print cleanly.
 */
function strokeFilterStep(inkWidthPx: number | null): number {
  if (inkWidthPx === null || !(inkWidthPx > 0)) return SETTING_LIMITS.minStrokeInkWidths.step;
  return Number((2 / inkWidthPx).toPrecision(3));
}

export const CONTROLS: readonly Control[] = [
  /*
    The two halves of one threshold first, then the blur (user, text pass 2026-09-29): the contrast
    threshold and its window are Sauvola's two parameters, and a GM tunes them together.
  */
  {
    name: "sauvolaK",
    // Sauvola's `k`, which sets how far below its neighbourhood's average a pixel must be to count as
    // ink — furthest where the neighbourhood is flat. "Threshold" says the direction: a higher one
    // demands more contrast and finds less ink. It was *Ink strictness* until the text pass.
    label: "Ink contrast threshold",
    hint: "",
  },
  {
    name: "sauvolaRadiusPx",
    label: "Contrast window",
    hint: "",
    unit: "px",
    shown: (value) => Math.round(value) * 2 + 1,
  },
  {
    name: "blurSigma",
    // Named for what it is for, in the image editor's word: the blur is how texture and specks are
    // kept out of the reading. It was *Texture blur*.
    label: "Despeckle",
    hint: "",
    unit: "px",
  },
  {
    name: "minStrokeInkWidths",
    profile: true,
    label: "Thinnest stroke to keep",
    hint: "",
    // No derived line. Every figure it could give is the setting times the measured ink width, which
    // is an estimate — so a pixel count here is the same guess in another unit. The number at the
    // right is the setting itself, which is what a GM needs to come back to one.
    stepFor: strokeFilterStep,
  },
  {
    name: "minIslandPx",
    profile: true,
    // *Mark* is the surface's word for something drawn on the map image (text rules, 2026-09-29), and
    // the tool that suppresses them one by one measures them with the same definition.
    label: "Smallest mark to keep",
    hint: "",
    unit: "px",
  },
  {
    name: "gapFillPx",
    label: "Largest gap to highlight",
    // The hint that stood here — ringed, never added until accepted, and past a doorway's width it
    // proposes doorways — went with the text rules: the highlight says the first, and the second is
    // what a GM sees the moment the handle passes a doorway.
    hint: "",
    unit: "px",
  },
  {
    name: "gapTravelPx",
    label: "Smallest ink distance for a gap",
    // Kept, and rewritten to define rather than steer (text pass, 2026-09-29): no label says what
    // this distance is measured along, which is the one thing a GM cannot see. It used to add which
    // way the setting leans; the map says that as the handle moves.
    hint: "Shortest path from one side of a gap to the other, through ink.",
    unit: "px",
  },
  /*
    `spurPruneGraphUnits` was here, labelled *Longest dead end to remove*, and it went on 2026-09-18
    with `simplifyGraphUnits`.

    It was read by the derive, so a stored limit was re-applied on every derive and turning it discarded
    every hand edit. Pruning is an amount at the foot of this group now — **Prune the dead ends** — which
    applies to the walls in front of the GM and needs no lock. The label was the good part and it
    survives: *spur* is this record's vocabulary rather than anything a GM brought with them.
  */
  {
    name: "suppressBrushPx",
    label: "Brush width",
    hint: "",
    unit: "px",
  },
  {
    name: "inkBrushPx",
    label: "Brush width",
    hint: "",
    unit: "px",
  },
  {
    name: "fillOpacity",
    // The image editor's word, and the percentage it is always given in (user, text pass). It was
    // *Preview fill*, with a note under the View heading saying an emitted shape is opaque — which
    // went with the text rules, as a fact a GM never needs in order to set this.
    label: "Region opacity",
    hint: "",
    readout: "percent",
  },
  /*
    `strokeSquares` was here, labelled *Preview outline*, and it went on 2026-09-24: the region fills
    are bounded by walls already, and the two outlines conflict visually, so the fill lost its own.

    `simplifyGraphUnits` was here, labelled *Straightening*, and it went on 2026-09-18 with the
    setting behind it.

    It was a **fitting** tolerance the derive read, which is why it could only ever apply to a fresh
    derivation — and therefore why turning it discarded every hand edit and the group carrying it had
    to be locked. The number is computed from the measured ink width inside the derive now, because the
    figure that works is a measurement rather than a preference: a quarter of an ink width means the
    same thing on every map, and the report while it was still on screen was that nobody looked at it
    while tuning.

    What a GM presses instead is **Straighten**, at the foot of this group — an amount applied to the
    walls in front of them, which discards nothing and needs no lock.
  */
  /*
    The mend tool's two, labelled as the ink tool's are (user, 2026-09-16): they are the same two
    questions asked of the walls instead of the ink. Positions on a log track like the other graph
    controls, with the pixels beside them where a reading has given a raster to count in.
  */
  /*
    Both keep a place from 1 to 100 and the pixels on the line under them, which is a second unit the
    text rules would otherwise take away: a unit for the Walls tools is parked (user, 2026-09-29), and
    Mend, already printing pixels, is the case that question is about.
  */
  {
    name: "mendReachGraphUnits",
    label: "Largest gap to highlight",
    scale: "log",
    hint: "",
    readout: "pixels",
  },
  {
    name: "mendTravelGraphUnits",
    label: "Smallest wall distance for a gap",
    scale: "log",
    // The ink tool's sentence asked of the walls, as the label is.
    hint: "Shortest path from one side of a gap to the other, along walls.",
    readout: "pixels",
  },
];
