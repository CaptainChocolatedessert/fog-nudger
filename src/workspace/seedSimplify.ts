/**
 * Seeding the simplification tolerance from the measured ink width, once, in the ink mode.
 *
 * ## The problem this solves, found in a room
 *
 * The tolerance is stored as a fraction of the map, because that is the only unit both modes can
 * speak. A *default* in that unit cannot be right on every map: 4e-4 is 1.3px on a 3300px raster and
 * **0.30px on a 751px one** — sub-pixel, which is very nearly no simplification, and on Barrow Mound
 * it produced 2,273 vertices against 510 at a sane setting. Clicking through the defaults on a small
 * map gave a graph too large for a scene write to carry.
 *
 * A bigger constant only moves the failure to large maps. What the ink width gives is a figure that
 * means the same thing everywhere: a quarter of the linework's own width, which is what this control
 * defaulted to for the months it was denominated in ink widths.
 *
 * ## Seeding a default is NOT a threshold that moves with a measurement
 *
 * The standing rule is that a threshold moving with a measurement changes the result invisibly, and
 * this does not violate it. The measurement decides where the value *starts*; from that moment it is
 * an ordinary stored absolute fraction that the GM can see on the slider and change, and that a
 * re-run reproduces exactly. The old arrangement — where the stored number *was* a multiple of a
 * measurement — is the thing that rule forbids, and it is what the unit change removed.
 *
 * ## Only in the ink mode, and only while the value is untouched
 *
 * The editor has no reading and therefore no ink width, which is the whole reason the stored unit is
 * a fraction; it also has no simplification control of this key. So this is the ink mode's alone.
 *
 * **The cost, stated: "untouched" is read as "equal to the static default", and those are not the
 * same thing.** A GM who deliberately sets the slider to exactly 4e-4 will have it re-seeded on the
 * next reading. That is one position on a thousand-step logarithmic track, and the direction it
 * moves them is toward a value that suits their map rather than away from one — but it is a setting
 * changing without being asked, so it is said in the log rather than done quietly.
 */

import { devLog } from "../devlog";
import { lastInkWidth, lastRasterWidth } from "../pipeline";
import {
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  seededSimplifyFraction,
  writeParameter,
} from "../settings";
import { renderPanel } from "./accordion";
import { onReading } from "./reading";
import { invalidateRegions } from "./regions";
import { currentSettings, persistSettings, setSettings } from "./settingsState";

export function registerSimplifySeed(): void {
  onReading(() => {
    seed();
    // Never the reason a reading is marked failed. A listener returning false means a step could not
    // take the mask and the surface would be half-updated; this only ever writes a setting.
    return true;
  });
}

function seed(): void {

  const settings = currentSettings();
  if (settings.trace.simplifyFraction !== DEFAULT_SETTINGS.trace.simplifyFraction) return;

  const inkWidth = lastInkWidth();
  const rasterWidth = lastRasterWidth();
  if (inkWidth === null || rasterWidth === null) return;

  const value = seededSimplifyFraction(inkWidth, rasterWidth);
  if (value === settings.trace.simplifyFraction) return;

  setSettings(writeParameter(settings, "simplifyFraction", value));
  void persistSettings();
  /*
    Invalidated explicitly rather than relying on the reading's own listeners to do it afterwards.

    The regions subscribe to readings too, and the order listeners are told in is registration order,
    which is not something this should depend on — a seed that landed after the invalidation would
    derive the partition at the old tolerance and mark it current. One extra invalidation costs
    nothing, because deriving is lazy and only runs when a step that draws it is open.
  */
  invalidateRegions();
  // Rebuilt so the slider moves to where the value now is. It also re-measures the track's top,
  // which is correct: this is the first reading, so it is the first graph worth measuring.
  renderPanel();
  devLog(
    "info",
    `workspace: simplification was at its default and has been seeded from the map — ` +
      `${value.toExponential(2)} of the map, a quarter of the measured ${inkWidth.toFixed(1)}px ` +
      `ink width on a ${rasterWidth}px raster. Move the slider to choose your own.`,
  );
  if (value >= SETTING_LIMITS.simplifyFraction.max) {
    devLog(
      "warn",
      "workspace: the seeded tolerance hit the storage ceiling, which means the measured ink width " +
        "is an implausible share of the map. Check the Ink step before trusting the graph.",
    );
  }
}
