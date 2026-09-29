/**
 * The number beside a slider's label — the yellow one.
 *
 * Moved out of `settingRows.ts` on 2026-09-29, when the text rules gave it units, so that what it
 * prints can be tested: that module imports the SDK through the shell, and this imports nothing that
 * does.
 *
 * A control may ask to report **where its handle is** rather than what its value is, because two of
 * them store graph units and neither that nor any spelling of it is a number a GM can hold on to.
 * Everything else takes the shared formatter, which knows about steps and off positions and should
 * not be bypassed for taste.
 *
 * **A control with `stepFor` reports its tick instead of either.** The raw value is a guess in a unit
 * (ink widths) nobody can feel, and the track position is not the count that matters — what changed
 * as the handle moved is how many of the control's own, measured stops it crossed, and that is what
 * the tick marks under it count too. The two are meant to agree: the number says how many ticks
 * back the handle sits, and the marks say where they are.
 *
 * No DOM, no SDK.
 */

import type { Control } from "../controls";
import { formatValue, positionReadout, type Scale, type ScaleLimits } from "../sliderScale";
import { tickIndex } from "./tickMarks";

export function readoutText(
  control: Control,
  value: number,
  position: number,
  limits: ScaleLimits,
  scale: Scale,
): string {
  // A whole percentage. The one control that asks is the region opacity, stepped in twos, so a
  // decimal would only ever print zero. (It had one while the blob tolerance, stepped in halves,
  // was the control asking.)
  if (control.readout === "percent") return `${Math.round(value * 100)}%`;
  // A number and its unit with a space between (text rules, 2026-09-29), and off at the bottom of a
  // track that starts at zero, where the filter or search it sets does nothing.
  if (control.unit) {
    if (value <= 0 && limits.min <= 0) return "off";
    const shown = control.shown ? String(control.shown(value)) : formatValue(value, limits, scale);
    return `${shown} ${control.unit}`;
  }
  if (control.stepFor) {
    // Off is a state rather than a tick, on the same argument the position readout below makes —
    // true here specifically because a radius of zero is where this filter is exactly a no-op.
    if (value <= 0) return "off";
    return String(tickIndex(value, limits));
  }
  if (control.readout !== "position") return formatValue(value, limits, scale);
  // Off is a state rather than a place on the track, and it is the one thing about these controls
  // that a number would obscure rather than convey.
  if (value <= 0) return "off";
  return String(positionReadout(position));
}
