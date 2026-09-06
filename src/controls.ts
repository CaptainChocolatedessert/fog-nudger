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
 * Every control, in the order a GM meets them, each with a hint saying which way to turn it.
 *
 * **The hints are not decoration.** Every one of these is a number whose direction is not guessable —
 * raising Sauvola's `k` makes *less* ink, which is the opposite of what "sensitivity" suggests to
 * most people. A control whose direction you have to discover by experiment is a control that gets
 * turned once and left alone.
 *
 * One list rather than one per surface: which stage a control belongs to is read from the stage
 * declaration in `settings.ts`, which is the same declaration the pipeline's cache invalidation
 * uses. Two lists would be two places to disagree about what a knob invalidates.
 *
 * **Order is presentation and nothing else**, and it is the only ordering a step has: each step
 * draws its controls in this order, so a control that should be met first is declared first. The two
 * that decide how a step's own layer is *drawn* lead their steps, because looking at the thing comes
 * before tuning it.
 */
/**
 * What a brush width says, shared by the two brushes.
 *
 * A width in raster pixels means nothing on its own — a GM has no feel for what a pixel of *this*
 * map is — so it is reported in grid squares where a run has measured the density, and left as bare
 * pixels where none has. The nullable measurement is why: before a first reading there is no density
 * and a readout that invented one would be a guess in the voice of a measurement.
 */
function brushReadout(value: number, { pxPerSquare }: Measured): string {
  const px = `${Math.round(value)}px across`;
  if (pxPerSquare === null || pxPerSquare <= 0) return px;
  return `${px}, ${(value / pxPerSquare).toFixed(2)} of a square`;
}

export const CONTROLS: readonly Control[] = [
  {
    name: "inkOpacity",
    label: "Overlay opacity",
    hint: "Solid is easiest to judge <b>what</b> the trace called ink. Lower it to a tint when the question is whether that ink sits on the linework underneath.",
  },
  {
    name: "sauvolaK",
    label: "Ink threshold",
    hint: "Higher finds <b>less</b> ink — only decisively dark pixels. Lower catches faint linework, and eventually the paper.",
  },
  {
    name: "blurSigma",
    label: "Texture blur",
    hint: "Fades the finest marks below the threshold. The blunt lever against speckle and a printed floor grid — blunt because it works on contrast, so it takes faint walls too.",
    derive: (value) => `${value.toFixed(2)} px`,
  },
  {
    name: "sauvolaRadiusPx",
    label: "Detail window",
    hint: "How local the threshold is, as a radius in pixels. Wants to stay comfortably wider than the linework is thick, or a bold stroke becomes its own background and stops counting as ink.",
    derive: (value) => `${Math.round(value) * 2 + 1} px across`,
  },
  {
    name: "minStrokeInkWidths",
    label: "Minimum stroke width",
    hint: "Removes marks narrower than this, keeping thicker ones at full width. As a share of the measured ink width; <b>zero is off</b>. Works on width, not contrast, so it reaches a floor grid the blur cannot.",
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
    label: "Smallest ink island",
    hint: "Removes isolated marks shorter than this on <b>both</b> sides — decoration that survived the filter above. Walls join into one network, so they are not islands. In pixels; <b>zero is off</b>.",
    derive: (value) => (value <= 0 ? "off" : `under ${Math.round(value)}px across goes`),
  },
  {
    name: "gapFillPx",
    label: "Largest break to look for",
    hint: "How wide a break the search will find, in pixels; <b>zero finds none</b>. Each one is ringed and shown in <b class='gap-key'>purple</b> &mdash; <b>nothing is added until you accept it</b>. Past a doorway's width it starts proposing doorways, and no measurement can tell those apart.",
    derive: (value, { pxPerSquare }) => {
      if (value <= 0) return "off";
      if (pxPerSquare === null || pxPerSquare <= 0) return `${Math.round(value)}px`;
      return `${Math.round(value)}px, ${(value / pxPerSquare).toFixed(2)} of a square`;
    },
  },
  {
    name: "gapTravelPx",
    label: "Same-wall distance",
    hint: "How far apart two edges of a break can be <b>along the ink</b> and still count as one piece of wall. Low proposes more: a crack beside a corner starts counting. High treats distant linework as connected and goes quiet.",
    derive: (value) =>
      value <= 0 ? "propose every break" : `${Math.round(value)}px along the ink`,
  },
  {
    name: "spurPrunePx",
    label: "Prune spurs",
    hint: "Removes dead-end walls shorter than this, measured along the wall in pixels. A ragged ink edge grows hairs; a wall that really stops in mid-air is a <b>stub</b> and must survive. Only length tells them apart. <b>Zero is off</b>, and past a wall's own length it eats the graph.",
    derive: (value, { pxPerSquare }) => {
      if (value <= 0) return "off";
      if (pxPerSquare === null || pxPerSquare <= 0) return `${Math.round(value)}px`;
      return `${Math.round(value)}px, ${(value / pxPerSquare).toFixed(2)} of a square`;
    },
  },
  {
    name: "suppressBrushPx",
    label: "Brush width",
    hint: "In raster pixels, so a stroke covers the same amount of map however far you are zoomed out &mdash; zoom in to work finely rather than turning this down. A stroke keeps the width it was painted at.",
    derive: brushReadout,
  },
  {
    name: "inkBrushPx",
    label: "Brush width",
    hint: "In raster pixels. This draws linework, so a width near the map's own ink is usually right &mdash; the readout below says what that measured.",
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
    hint: "How the partition is drawn <b>here</b>, and nowhere else &mdash; an emitted fog shape is always fully opaque, or revealed ground keeps a tint of the fog colour. Low keeps the map readable underneath.",
  },
  {
    name: "strokeSquares",
    label: "Preview outline",
    hint: "In grid squares, and <b>only here</b>. An emitted shape carries no outline at all: Dynamic Fog offsets its walls by exactly that width, so an outline would push them half of one either side of the boundary.",
  },
  {
    name: "simplifyInkWidths",
    label: "Edge simplification",
    hint: "As a share of the measured ink width. Capped below a half, which is the point past which a boundary could cross the middle of a wall into the next room.",
    derive: (value, { inkWidth }) =>
      inkWidth === null || inkWidth <= 0
        ? "trace once for a figure"
        : `${(value * inkWidth).toFixed(1)}px of a ${inkWidth.toFixed(1)}px ink width`,
  },
];
