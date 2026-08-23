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
 */
export interface Measured {
  /** Raster pixels per grid square, or `null` before any run. */
  readonly pxPerSquare: number | null;
  /** Measured ink width in raster pixels, or `null` before any run. */
  readonly inkWidth: number | null;
}

/**
 * The controls, in the order a GM meets them, with a hint saying which way to turn each one.
 *
 * The hints exist because every one of these is a number whose direction is not guessable —
 * raising Sauvola's `k` makes *less* ink, which is the opposite of what "sensitivity" suggests to
 * most people. A control whose direction you have to discover by experiment is a control that gets
 * turned once and left alone.
 */
export interface Control {
  readonly name: SettingName;
  readonly label: string;
  readonly hint: string;
  /**
   * Which container the control is drawn in, on whichever surface draws it.
   *
   * **Presentation only, and deliberately separate from `PARAMETER_KIND`.** The kind decides what a
   * change *invalidates* and is read by the mask fingerprint; this decides only where the control
   * appears. Stage one is two things in series — what is a mark, then which marks are walls — and
   * both halves are reading-stage pipeline controls, so the division must not touch the cascade.
   */
  readonly section: string;
  readonly scale?: Scale;
  /**
   * Renders the value in a unit the GM can feel.
   *
   * Returns an empty string when it cannot say anything honest yet, which is how a control reports
   * "no measurement" without the caller having to know which readouts need which measurement.
   */
  readonly derive?: (value: number, measured: Measured) => string;
}

/**
 * Every control, in stage order.
 *
 * One list rather than one per surface: which stage a control belongs to is read from the stage
 * declaration in `settings.ts`, which is the same declaration the pipeline's cache invalidation
 * uses. Two lists would be two places to disagree about what a knob invalidates.
 */
export const CONTROLS: readonly Control[] = [
  {
    name: "sauvolaK",
    section: "ink",
    label: "Ink threshold",
    hint: "Higher finds <b>less</b> ink — only decisively dark pixels. Lower catches faint linework, and eventually the paper.",
  },
  {
    name: "blurSigma",
    section: "ink",
    label: "Texture blur",
    hint: "Fades the finest marks below the threshold. The blunt lever against speckle and a printed floor grid — blunt because it works on contrast, so it takes faint walls too.",
    derive: (value) => `${value.toFixed(2)} px`,
  },
  {
    name: "sauvolaRadiusPx",
    section: "ink",
    label: "Detail window",
    hint: "How local the threshold is, as a radius in pixels. Wants to stay comfortably wider than the linework is thick, or a bold stroke becomes its own background and stops counting as ink.",
    derive: (value) => `${Math.round(value) * 2 + 1} px across`,
  },
  {
    name: "minStrokeInkWidths",
    section: "walls",
    label: "Minimum stroke width",
    hint: "Removes marks narrower than this, keeping thicker ones at full width. As a share of the measured ink width; <b>zero is off</b>. Works on width, not contrast, so it reaches a floor grid the blur cannot.",
    derive: (value, { inkWidth }) => {
      if (value <= 0) return "off";
      if (inkWidth === null) return "trace once for a figure";
      const width = value * inkWidth;
      const radius = Math.max(0, Math.round(width / 2));
      return radius <= 0
        ? `rounds to nothing against ${inkWidth.toFixed(1)}px ink`
        : `under ~${radius * 2}px goes (ink is ${inkWidth.toFixed(1)}px)`;
    },
  },
  {
    name: "minIslandPx",
    section: "walls",
    label: "Smallest ink island",
    hint: "Removes isolated marks shorter than this on <b>both</b> sides — decoration that survived the filter above. Walls join into one network, so they are not islands. In pixels; <b>zero is off</b>.",
    derive: (value) => (value <= 0 ? "off" : `under ${Math.round(value)}px across goes`),
  },
  {
    name: "gapWidthPx",
    section: "gaps",
    label: "Largest break to mark",
    hint: "Marks narrow breaks in the linework, which are what merge two rooms into one. In pixels; <b>zero is off</b>. Past a doorway's width it starts marking doorways, and no measurement can tell those apart.",
    derive: (value, { pxPerSquare }) => {
      if (value <= 0) return "off";
      if (pxPerSquare === null) return `${Math.round(value)}px`;
      return `${Math.round(value)}px, ${(value / pxPerSquare).toFixed(2)} of a square`;
    },
  },
  {
    name: "gapTravelPx",
    section: "gaps",
    label: "Same-wall distance",
    hint: "How far apart two edges of a break can be <b>along the ink</b> and still count as one piece of wall. Low marks more: a crack beside a corner starts counting. High treats distant linework as connected and goes quiet.",
    derive: (value) => (value <= 0 ? "mark every break" : `${Math.round(value)}px along the ink`),
  },
  {
    name: "gapFillPx",
    section: "gaps",
    label: "Largest break to fill",
    hint: "Repairs the marked breaks up to this width, so two rooms do not merge across a break the map has not got. Filled ones turn <b class='gap-key filled'>green</b>; the rest stay <b class='gap-key'>purple</b>. In pixels; <b>zero fills nothing</b>. Settle the width above first, then sweep this one.",
    derive: (value, { pxPerSquare }) => {
      if (value <= 0) return "nothing filled";
      if (pxPerSquare === null) return `${Math.round(value)}px`;
      return `${Math.round(value)}px, ${(value / pxPerSquare).toFixed(2)} of a square`;
    },
  },
  {
    name: "minRoomSquares",
    section: "settings",
    // Logarithmic: three orders of magnitude, with everything a GM will pick near the bottom. On a
    // linear track the default sits 1.6% along and the rest of the slider chooses between absurd
    // values.
    scale: "log",
    label: "Smallest room",
    hint: "Anything smaller is discarded, and shows as bare map unless something swallows it. Low is safer: a spurious region costs one click, a bare patch is a visible defect.",
    derive: (value, { pxPerSquare }) =>
      pxPerSquare === null
        ? "trace once for a figure"
        : `${Math.round(value * pxPerSquare * pxPerSquare)} px, ${(Math.sqrt(value) * pxPerSquare).toFixed(0)} px across`,
  },
  {
    name: "simplifyInkWidths",
    section: "settings",
    label: "Edge simplification",
    hint: "As a share of the measured ink width. Capped below a half, which is the point past which a boundary could cross the middle of a wall into the next room.",
    derive: (value, { inkWidth }) =>
      inkWidth === null
        ? "trace once for a figure"
        : `${(value * inkWidth).toFixed(1)}px of a ${inkWidth.toFixed(1)}px ink width`,
  },
  {
    name: "fillOpacity",
    section: "settings",
    label: "Proposal fill",
    hint: "Low keeps the map readable underneath. The partition is carried by the colour changes and the outlines, not by the fill.",
  },
  {
    name: "strokeSquares",
    section: "settings",
    label: "Proposal outline",
    hint: "In grid squares. Free — outline width does not affect the walls Dynamic Fog derives.",
  },
  {
    name: "inkOpacity",
    section: "display",
    label: "Overlay opacity",
    hint: "Solid is easiest to judge <b>what</b> the trace called ink. Lower it to a tint when the question is whether that ink sits on the linework underneath.",
  },
];

/** The controls belonging to one section, in declaration order. */
export function sectionControls(section: string): readonly Control[] {
  return CONTROLS.filter((control) => control.section === section);
}
