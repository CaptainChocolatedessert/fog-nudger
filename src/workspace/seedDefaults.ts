/**
 * Seeding the defaults that cannot be one number on every map, once per map, from its reading.
 *
 * Three today: the simplification tolerance, from the measured ink width, and the mend tool's two
 * distances, from the raster. All three are stored in graph units, and all three are one module
 * because the rule that decides whether a value may be seeded — *untouched means equal to the static
 * default* — is one rule, and two copies of it would be two places for it to drift.
 *
 * ## Why the mend tool's are seeded too — 2026-09-16
 *
 * Its two settings are the graph's counterparts of the ink tool's gap sliders, whose 12px and 40px
 * defaults have been good (user). Those are raster pixels, and a fixed figure in graph units would
 * be a different stretch of wall on every map — the straightening default's own history, below. So
 * each starts at a pixel figure converted by raster pixels per graph unit: **20** for the largest
 * gap, since thinning pulls each free end back about half an ink width and a break is wider in the
 * graph than in the ink, and **40** for the same-wall distance.
 *
 * ## The problem this solves, found in a room
 *
 * The tolerance is stored in graph units, because the GM's graph outlives any one reading of the map.
 * A *default* in that unit cannot be right on every map: 4e-4 is 1.3px on a 3300px raster and
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
 * an ordinary stored absolute value that the GM can see on the slider and change, and that a
 * re-run reproduces exactly. The old arrangement — where the stored number *was* a multiple of a
 * measurement — is the thing that rule forbids, and it is what the unit change removed.
 *
 * ## Only once a reading has landed, and only while the value is untouched
 *
 * The ink width and the raster both come from a reading, so nothing is seeded before one.
 *
 * **The cost, stated: "untouched" is read as "equal to the static default", and those are not the
 * same thing.** A GM who deliberately sets the slider to exactly 4e-4 will have it re-seeded on the
 * next reading. That is one position on a thousand-step logarithmic track, and the direction it
 * moves them is toward a value that suits their map rather than away from one — but it is a setting
 * changing without being asked, so it is said in the log rather than done quietly.
 */

import { devLog } from "../devlog";
import { lastRasterPerGraphUnit } from "../pipeline";
import {
  DEFAULT_SETTINGS,
  readParameter,
  seededGraphUnitsFromPixels,
  writeParameter,
  type SettingName,
} from "../settings";
import { renderPanel } from "./drawer";
import { onReading } from "./reading";
import { currentSettings, persistSettings, setSettings } from "./settingsState";

export function registerDefaultSeeds(): void {
  onReading(() => {
    seedMends();
    // Never the reason a reading is marked failed. A listener returning false means a step could not
    // take the mask and the surface would be half-updated; this only ever writes a setting.
    return true;
  });
}

/*
  `seed` was here, and it went on 2026-09-18 with the setting it seeded.

  It gave the stored simplification tolerance a per-map starting value on the first reading, because a
  fixed default comes out sub-pixel on a small map and produced a graph too large to write. The
  tolerance is computed inside the derive now — a quarter of the measured ink width, the same figure —
  so there is no stored default left to seed and nothing to tell the GM they can override.

  The mend tool's two distances are still seeded below, which is why this module survives. *Untouched
  means equal to the static default* is one rule and it lives in one place.
*/

/**
 * The mend tool's two distances, each seeded only while it is still at its static default.
 *
 * Nothing is invalidated: they are tool settings, which change no picture until the tool runs, and
 * a search already running is told through `wallEdit` the same way a slider release tells it.
 */
function seedMends(): void {
  const rasterPerUnit = lastRasterPerGraphUnit();
  if (rasterPerUnit === null) return;

  const seeds: readonly (readonly [SettingName, number])[] = [
    ["mendReachGraphUnits", MEND_REACH_PX],
    ["mendTravelGraphUnits", MEND_TRAVEL_PX],
  ];
  let settings = currentSettings();
  const changed: string[] = [];
  for (const [name, pixels] of seeds) {
    const current = readParameter(settings, name);
    if (current !== readParameter(DEFAULT_SETTINGS, name)) continue;
    const value = seededGraphUnitsFromPixels(name, pixels, rasterPerUnit);
    if (value === current) continue;
    settings = writeParameter(settings, name, value);
    changed.push(`${name} ${value.toExponential(2)} (${pixels}px)`);
  }
  if (changed.length === 0) return;

  setSettings(settings);
  void persistSettings();
  renderPanel();
  devLog(
    "info",
    `workspace: the mend tool's distances were at their defaults and have been seeded from the ` +
      `map's raster at ${Math.round(rasterPerUnit)} pixels to the graph unit — ${changed.join(", ")}. ` +
      `Move a slider to choose your own.`,
  );
}

/** The mend tool's starting distances in raster pixels. `seedMends` says why these two. */
const MEND_REACH_PX = 20;
const MEND_TRAVEL_PX = 40;
