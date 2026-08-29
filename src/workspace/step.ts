/**
 * What a step is, and how the shell picks one up.
 *
 * A step owns **its controls, what it paints, and what a drag means** (`DESIGN.md` §4, "Six
 * steps"). The shell owns the transform, the input and the canvas stack. Everything a step declares
 * here is handed to the shell once, at wiring time.
 *
 * ## What a step is not, yet
 *
 * These are still the sections of one panel rather than tabs, and every step's painter runs on every
 * frame — this split is deliberately behaviour-preserving (step A.1). The step *id* is currently
 * also the control section and the container it renders into, which is the mapping the surface
 * already had. Promoting it to a first-class declaration carrying paint layer and tool binding is
 * the next step, and it comes with a test pinning that the step, the stage, the kind and the
 * post-reading boundary stay independently declared — because the moment a step carries behaviour,
 * `section`'s old "presentation only, nothing may switch on it" rule stops holding.
 */

import { sectionControls } from "../controls";
import { PARAMETER_STAGE } from "../settings";
import { onReading, type ReadingListener } from "./reading";
import { resetHints, settingRow } from "./settingRows";
import { addPainter, type Painter } from "./shell";

export interface Step {
  /** Identifies the step, and for now names both its control section and its container. */
  readonly id: string;
  /** What it draws over the map. Registered once; draw order is the order of the step list. */
  readonly paint?: Painter;
  /** What it does with a reading when one lands. */
  readonly onReading?: ReadingListener;
  /** Anything the step draws in its panel beyond the rows built from its controls. */
  readonly mount?: () => void;
}

/**
 * Attach the steps to the shell. Once, at start-up — not on every render.
 *
 * Painters and reading listeners are registrations rather than state; re-running this would draw
 * every layer twice and rasterise every mask twice.
 */
export function wireSteps(steps: readonly Step[]): void {
  for (const step of steps) {
    if (step.paint) addPainter(step.paint);
    if (step.onReading) onReading(step.onReading);
  }
}

/**
 * Draw every step's controls.
 *
 * Repeatable, and repeated: the rows are built once from the defaults so the surface looks like
 * itself from the first frame, then rebuilt wholesale when the stored settings arrive. Wholesale
 * rather than patched, so there is no path by which a row keeps a value from the defaults it was
 * first drawn with.
 */
export function renderSteps(steps: readonly Step[]): void {
  resetHints();
  for (const step of steps) {
    const container = document.getElementById(`section-${step.id}`);
    if (container) {
      container.replaceChildren();
      for (const control of sectionControls(step.id)) {
        // Stage two and three's controls stay in the popover: this surface is stage one, and the
        // representation that explains it is the mask. `PARAMETER_STAGE` is the same declaration the
        // cache invalidation reads, so the two cannot drift apart.
        if (PARAMETER_STAGE[control.name] !== "read") continue;
        container.append(settingRow(control));
      }
    }
    step.mount?.();
  }
}
