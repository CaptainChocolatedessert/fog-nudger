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

import type { SettingName } from "./settings";
import type { Scale } from "./sliderScale";

/**
 * What the last run measured, for the readouts that report a value in something a GM can feel.
 *
 * Both are nullable and both are nullable *for a reason*: before a first trace there is no ink
 * width and no pixel density, and a control that invents one would be reporting a guess in the
 * voice of a measurement. The readouts say "trace once for a figure" instead.
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
  /** Measured ink width in raster pixels, or `null` before any run. */
  readonly inkWidth: number | null;
  /**
   * The raster the last reading used, in pixels across, or `null` before any run.
   *
   * What turns a fraction of the map back into pixels, for the two controls whose stored unit is a
   * fraction. Nullable for the same reason as the other two, and for one more: **the editor never
   * has it**, because it never runs a reading. A readout that invented a raster there would be
   * reporting a guess in the voice of a measurement about a mode that has no such measurement at
   * all.
   */
  readonly rasterWidth: number | null;
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
   * For the controls whose stored unit is a fraction of the map. That unit is the only one both modes
   * can speak, and it is not negotiable — but "0.00043" beside a slider is not a number anybody can
   * read, and neither was the per-ten-thousand spelling that replaced it (user, 2026-09-07: *"an
   * arbitrary large number and log scale don't make sense to the user"*).
   *
   * What a GM actually wants from that readout is to **remember a setting and come back to it**, and
   * a position on the track serves that where a logarithmic fraction does not.
   *
   * **The cost, stated: the number is a position, so it can drift.** The top of these tracks is
   * measured off the graph when the step opens, and the graph changes as walls are pruned and
   * straightened — so the same stored setting can read 40 today and 43 tomorrow. It is stable for as
   * long as the step is open, which is when a GM is comparing. The alternative, numbering against a
   * fixed reference range, is stable forever and puts the handle at the far right while the readout
   * says 78, which is wrong in a way you can see.
   */
  readonly readout?: "position";
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
 * about the problem and wrong about the fix: the control is called **strictness** now, and a
 * stricter threshold finding less ink needs no explaining. Likewise the spur limit, which is *the
 * longest dead end to remove* because "spur" is this project's word and not a GM's.
 *
 * **Two hints survive**, and each says something neither a name nor a number can: that a gap
 * proposal is not applied until it is accepted, and which way the same-wall distance leans.
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
 * What a brush width says, shared by the two brushes.
 *
 * A width in raster pixels means nothing on its own — a GM has no feel for what a pixel of *this*
 * map is — so it is reported in grid squares where a run has measured the density, and left as bare
 * pixels where none has. The nullable measurement is why: before a first reading there is no density
 * and a readout that invented one would be a guess in the voice of a measurement.
 */
/**
 * The same fraction in raster pixels, which is the unit a GM can actually feel.
 *
 * Only the ink mode can say it: it needs the raster the last reading used, and the editor has never
 * run one. That asymmetry is the whole reason the stored unit is a fraction — a control the editor
 * cannot denominate is a control the editor cannot have — so this is the readout being generous
 * where it can rather than the setting depending on a measurement.
 */
function inRasterPixels(value: number, { rasterWidth, inkWidth }: Measured): string {
  if (rasterWidth === null || rasterWidth <= 0) return "";
  const px = value * rasterWidth;
  const base = `${px.toFixed(1)}px`;
  if (inkWidth === null || inkWidth <= 0) return base;
  return `${base}, ${(px / inkWidth).toFixed(2)} of a ${inkWidth.toFixed(1)}px ink width`;
}

function brushReadout(value: number, { pxPerSquare }: Measured): string {
  const px = `${Math.round(value)}px across`;
  if (pxPerSquare === null || pxPerSquare <= 0) return px;
  return `${px}, ${(value / pxPerSquare).toFixed(2)} of a square`;
}

export const CONTROLS: readonly Control[] = [
  {
    name: "sauvolaK",
    // "Strictness" rather than "threshold" or "sensitivity", which is the whole of the direction
    // hint this used to carry: a stricter reading keeping only decisively dark pixels is guessable,
    // and a higher *sensitivity* finding less ink is not.
    label: "Ink strictness",
    hint: "",
  },
  {
    name: "blurSigma",
    label: "Texture blur",
    hint: "",
    derive: (value) => `${value.toFixed(2)} px`,
  },
  {
    name: "sauvolaRadiusPx",
    label: "Detail window",
    hint: "",
    derive: (value) => `${Math.round(value) * 2 + 1} px across`,
  },
  {
    name: "minStrokeInkWidths",
    label: "Thinnest stroke to keep",
    hint: "",
    derive: (value, { inkWidth }) => {
      if (value <= 0) return "off";
      if (inkWidth === null || inkWidth <= 0) return "trace once for a figure";
      const width = value * inkWidth;
      const radius = Math.max(0, Math.round(width / 2));
      return radius <= 0
        ? `rounds to nothing against ${inkWidth.toFixed(1)}px ink`
        : `under ~${radius * 2}px goes (ink is ${inkWidth.toFixed(1)}px)`;
    },
  },
  {
    name: "minIslandPx",
    label: "Smallest mark to keep",
    hint: "",
    derive: (value) => (value <= 0 ? "off" : `under ${Math.round(value)}px across goes`),
  },
  {
    name: "gapFillPx",
    label: "Largest gap to look for",
    // One of the two hints kept. Not a direction — the label and the readout give that — but the
    // one fact a GM must not learn by surprise: past a doorway's width the search proposes
    // doorways, and nothing about a proposal reaches the ink until it is accepted.
    hint: "Ringed, never added until you accept it. Past a doorway's width it proposes doorways.",
    derive: (value, { pxPerSquare }) => {
      if (value <= 0) return "off";
      if (pxPerSquare === null || pxPerSquare <= 0) return `${Math.round(value)}px`;
      return `${Math.round(value)}px, ${(value / pxPerSquare).toFixed(2)} of a square`;
    },
  },
  {
    name: "gapTravelPx",
    label: "Same-wall distance",
    // The other one kept. No name found says what "along the ink" means here, and the direction is
    // genuinely backwards: a *shorter* distance proposes *more*.
    hint: "How far apart a gap's two banks may be measured <b>along the ink</b>. Lower proposes more.",
    derive: (value) =>
      value <= 0 ? "propose every gap" : `${Math.round(value)}px along the ink`,
  },
  {
    name: "spurPruneFraction",
    // A spur is a wall run with a free end, and "spur" is vocabulary from `DESIGN.md` rather than
    // anything a GM brought with them. The label says the whole of what the number means.
    label: "Longest dead end to remove",
    scale: "log",
    hint: "",
    readout: "position",
    // Nothing when off, because the readout has already said so beside the label. These are the only
    // controls whose own readout names the off state, so they are the only ones whose hint must not
    // repeat it.
    derive: (value, measured) => (value <= 0 ? "" : inRasterPixels(value, measured)),
  },
  {
    name: "suppressBrushPx",
    label: "Brush width",
    hint: "",
    derive: brushReadout,
  },
  {
    name: "inkBrushPx",
    label: "Brush width",
    hint: "",
    derive: (value, measured) => {
      const base = brushReadout(value, measured);
      const { inkWidth } = measured;
      if (inkWidth === null || inkWidth <= 0) return base;
      return `${base}, ${(value / inkWidth).toFixed(1)}x the map's ink`;
    },
  },
  {
    name: "fillOpacity",
    label: "Preview fill",
    // "Preview" is the whole of the old sentence: it says this is how the rooms are drawn here and
    // nowhere else. What an emitted shape looks like is stated once, under the View heading.
    hint: "",
  },
  {
    name: "strokeSquares",
    label: "Preview outline",
    hint: "",
  },
  {
    name: "simplifyFraction",
    label: "Straightening",
    scale: "log",
    // The editor had a second copy of this, applied once by a button. One control now: it is part of
    // the derive, so turning it back down puts the detail straight back — and the price of a derive
    // when the walls carry hand edits is priced by the mark and the dialog, not by a note here.
    hint: "",
    readout: "position",
    derive: (value, measured) => (value <= 0 ? "" : inRasterPixels(value, measured)),
  },
];
