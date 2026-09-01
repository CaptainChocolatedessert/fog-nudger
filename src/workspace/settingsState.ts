/**
 * The settings the workspace is currently working with, and the one place they are written from.
 *
 * ## Why the surface holds a copy at all
 *
 * Scene metadata is the store, but it is the wrong thing to read on every frame and the wrong thing
 * to write on every drag frame — which is exactly what the `input`/`change` split on a slider
 * exists to prevent. So the surface keeps the working value, hands it to the pipeline when it asks
 * for a mask, and writes it back on release.
 *
 * ## One holder, because the steps share one settings object
 *
 * Before the split this was a module-level `let` that four different concerns wrote to. Spreading
 * that across step modules would mean each keeping its own copy and reconciling them, which is a
 * silent-disagreement machine of exactly the kind `settings.ts` exists to prevent one level down.
 * One holder, and everything reads it through here.
 *
 * No DOM. The SDK is reached only through `settingsStore`.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { readSettings, writeSettings } from "../settingsStore";

/**
 * Starts at the defaults so the surface can draw itself before Owlbear answers.
 *
 * The controls that show these are **disabled** until the stored settings arrive — see
 * `controlsLive` — because a slider dragged in that window would be moving a default that is about
 * to be overwritten by the GM's own saved value.
 */
let settings: Settings = DEFAULT_SETTINGS;

export function currentSettings(): Settings {
  return settings;
}

/** Apply a new settings object in memory. Persisting is a separate, explicit step. */
export function setSettings(next: Settings): void {
  settings = next;
}

/** Read the stored settings and adopt them. */
export async function loadSettings(): Promise<Settings> {
  settings = await readSettings();
  return settings;
}

/**
 * Where a failed write gets reported, supplied by whoever owns a state line.
 *
 * The whole of a GM's tuning is in that write, and it used to reach the dev log and nothing else —
 * against the standing rule that the log is not a channel to anyone. This module is deliberately
 * DOM-free and cannot `say` anything itself, so the reporter is registered from the composition root
 * the same way the shell's close action is. Unset is a legitimate state: nothing is lost, the log
 * still has it, and there is simply nowhere to put it yet.
 */
let reportFailure: ((message: string) => void) | null = null;

export function onSettingsWriteFailure(report: (message: string) => void): void {
  reportFailure = report;
}

export async function persistSettings(): Promise<void> {
  try {
    await writeSettings(settings);
  } catch (error) {
    devLog("error", "workspace: could not save settings", describeError(error));
    reportFailure?.("could not save your settings — this tuning will not survive a reload");
  }
}
