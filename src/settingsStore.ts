/**
 * Where the GM's settings live: scene metadata.
 *
 * Same reasoning as the map nomination, and not a preference. The extension runs in a third-party
 * iframe, so Firefox partitions `localStorage` per top-level site and a local choice can simply
 * vanish. Scene metadata also travels with the scene, which is the right lifetime for tuning that
 * was arrived at by looking at *this* map.
 *
 * Everything read here goes through `normaliseSettings`, which is total. A scene written by an older
 * build, or by another client, or with a key hand-edited to nonsense, still yields a runnable set.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { key } from "./namespace";
import { DEFAULT_SETTINGS, normaliseSettings, type Settings } from "./settings";

const SETTINGS_KEY = key("settings");

/**
 * Read the scene's settings, falling back to the defaults on any failure.
 *
 * Never throws. A trace that refused to run because a settings read failed would be a worse outcome
 * than a trace at default parameters, and the failure is reported rather than swallowed.
 */
export async function readSettings(): Promise<Settings> {
  try {
    const metadata = await OBR.scene.getMetadata();
    return normaliseSettings(metadata[SETTINGS_KEY]);
  } catch (error) {
    devLog("warn", `settings: could not read, using defaults — ${describeError(error)}`);
    return DEFAULT_SETTINGS;
  }
}

/** Write the scene's settings, normalised first so nothing invalid is ever stored. */
export async function writeSettings(settings: Settings): Promise<Settings> {
  const normalised = normaliseSettings(settings);
  await OBR.scene.setMetadata({ [SETTINGS_KEY]: normalised });
  return normalised;
}
