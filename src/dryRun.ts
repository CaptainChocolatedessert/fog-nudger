/**
 * Roadmap step 2 — the dry run.
 *
 * Reads the scene's own map, reports what it finds, and **writes nothing to the scene**. This is
 * where tuning happens from here on, and it is what replaces the separate trace harness the roadmap
 * originally inherited from the sibling (DESIGN.md §9). The harness's advantage was a viewer nobody
 * used; its fatal weakness was that it never ran the world-placement stage, so it could disagree
 * with a real room *in direction* and did. A dry run inside the extension executes the same code
 * the emit path will, so that class of disagreement cannot arise here by construction.
 *
 * ## What it cannot report yet, said plainly
 *
 * The roadmap calls for a **region** census. Regions do not exist until steps 4 and 5, so this
 * reports the rig around the hole they will fill: which map, at what resolution, under what
 * transform, with what luminance. That is less than the word "census" promises, and it is better to
 * say so than to let a smaller set of numbers wear the name.
 *
 * ## Everything is reported on every run
 *
 * Including the boring values, and including the ones that look like bookkeeping. This project has
 * inherited one lesson more expensively than any other: a diagnostic that only speaks when
 * something is wrong cannot tell "fine" from "never ran". So the log line saying nothing was
 * emitted is not a formality — it is the difference between a dry run that worked and a button that
 * did nothing.
 */

import { devLog } from "./devlog";
import { loadMapRaster, resolveTraceMap } from "./map/mapImage";
import { megapixels } from "./map/rasterPlan";
import {
  absorbedDrift,
  aspectMismatch,
  createPlacement,
  toWorldPoint,
} from "./map/placement";
import {
  describeHistogram,
  luminanceHistogram,
  meanLuminance,
  otsuSplit,
} from "./trace/luminance";

/**
 * Beyond this the world bounds are not a scaled copy of the image and a uniform placement is wrong.
 * One percent absorbs rounding in the raster height without admitting a real rotation.
 */
const MAX_ASPECT_MISMATCH = 0.01;

/**
 * Trace the scene's map as far as the pipeline currently goes, and report.
 *
 * @returns a one-line summary for the panel. Detail goes to the dev log, where it can be read
 * beside the numbers from the previous run.
 */
export async function dryRun(): Promise<string> {
  const started = performance.now();

  const map = await resolveTraceMap();
  if (!map) {
    // The resolver has already logged which case this was and named the candidates, so repeating
    // that here would only make the panel's one line unreadable.
    return "No map to trace — see dev.log for which case this was, or pick one above.";
  }

  const raster = await loadMapRaster(map);
  if (!raster) {
    return `Could not read pixels from "${map.name || "map"}" — see the console.`;
  }

  const { pixels, plan, bounds, dpi } = raster;

  // ## Resolution
  //
  // Reported whether or not the budget bit. A run that quietly halved the resolution and a run at
  // native size must not produce the same log, because the first is the one that can invent a leak
  // between two rooms by thinning the ink.
  devLog(
    "info",
    `dry run: "${raster.name}" source ${plan.sourceWidth}x${plan.sourceHeight} ` +
      `(${megapixels(plan.sourceWidth, plan.sourceHeight).toFixed(1)} MP) -> raster ` +
      `${plan.width}x${plan.height} (${megapixels(plan.width, plan.height).toFixed(1)} MP), ` +
      (plan.capped
        ? `REDUCED by ${plan.factor}x to fit the megapixel budget — thin ink may have been ` +
          `averaged away, and a leak between rooms is the way that shows up`
        : `native resolution, nothing resampled`),
  );

  // ## Placement
  //
  // Step 7's arithmetic, run early so it can be read rather than trusted. The last figure is what
  // the per-axis scaling is *absorbing*, not an error it leaves behind — expect a non-zero value on
  // any map nudged out of proportion to line its drawn grid up with Owlbear's.
  const placement = createPlacement(bounds, plan.width, plan.height);
  const mismatch = aspectMismatch(bounds, plan.width, plan.height);
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldHeight = bounds.max.y - bounds.min.y;
  const drift = absorbedDrift(placement);

  devLog(
    "info",
    `dry run: placement origin (${bounds.min.x.toFixed(1)}, ${bounds.min.y.toFixed(1)}) ` +
      `world ${worldWidth.toFixed(1)}x${worldHeight.toFixed(1)}; units/px ` +
      `x ${placement.unitsPerPixelX.toFixed(4)} y ${placement.unitsPerPixelY.toFixed(4)}; ` +
      `aspect mismatch ${(mismatch * 100).toFixed(3)}%, per-axis scaling absorbing ` +
      `${drift >= 0 ? "+" : ""}${drift.toFixed(1)} world units at the map's bottom edge`,
  );

  if (mismatch > MAX_ASPECT_MISMATCH) {
    devLog(
      "warn",
      `dry run: world bounds are ${(mismatch * 100).toFixed(0)}% off the image's aspect ratio, ` +
        `which usually means the map is rotated. Rotation is not handled — output would be ` +
        `misplaced.`,
    );
  }

  // A corner check, because a transform that is flipped or transposed produces perfectly plausible
  // numbers above and lands the bottom-right of the map somewhere absurd. Deliberately the opposite
  // corner from the origin: it is the only one that disagrees under every wrong transform.
  const farCorner = toWorldPoint(placement, plan.width, plan.height);
  devLog(
    "info",
    `dry run: raster (0,0) -> world (${bounds.min.x.toFixed(1)}, ${bounds.min.y.toFixed(1)}), ` +
      `raster (${plan.width},${plan.height}) -> world ` +
      `(${farCorner.x.toFixed(1)}, ${farCorner.y.toFixed(1)}); ` +
      `map spans ${dpi > 0 ? (worldWidth / dpi).toFixed(1) : "?"} grid squares at dpi ${dpi}, ` +
      `so ${dpi > 0 ? (plan.width / (worldWidth / dpi)).toFixed(1) : "?"} raster px per square`,
  );

  // ## Luminance
  //
  // The one measurement here that is not bookkeeping. Step 3 has to handle polarity, and this says
  // what the ink and the ground on *this* map actually are rather than assuming dark-on-light.
  const histogram = luminanceHistogram(pixels);
  const split = otsuSplit(histogram);

  devLog(
    "info",
    `dry run: luminance mean ${meanLuminance(histogram).toFixed(3)}, ` +
      `profile dark->light ${describeHistogram(histogram)} (% per 1/16 band)`,
  );

  if (split) {
    // The minority class is the ink on line art. Stated as a reading rather than a fact, because a
    // share near a half means this is not line art at all and the whole interpretation is off.
    const darkPercent = split.darkShare * 100;
    const reading =
      darkPercent < 35
        ? "dark ink on light ground"
        : darkPercent > 65
          ? "LIGHT ink on dark ground — step 3 must invert polarity for this map"
          : "neither class is a clear minority, so this may not be line art";
    devLog(
      "info",
      `dry run: global split at ${(split.threshold / 255).toFixed(3)} — ` +
        `${darkPercent.toFixed(1)}% dark (mean ${split.darkMean.toFixed(3)}) vs ` +
        `${(100 - darkPercent).toFixed(1)}% light (mean ${split.lightMean.toFixed(3)}); ` +
        `reads as ${reading}`,
    );
  } else {
    devLog(
      "warn",
      "dry run: luminance has fewer than two distinct values — a blank or broken asset",
    );
  }

  const elapsed = Math.round(performance.now() - started);
  // The explicit statement that nothing was written. A dry run and a dry run that silently failed
  // to reach this point look identical without it.
  devLog("info", `dry run: complete in ${elapsed}ms — emitted nothing`);

  return (
    `"${raster.name}" ${plan.width}x${plan.height}` +
    (plan.capped ? ` (reduced ${plan.factor}x)` : " (native)") +
    `, ${split ? `${(split.darkShare * 100).toFixed(0)}% dark` : "flat"}` +
    `, ${elapsed}ms. Nothing emitted — detail in dev.log.`
  );
}
