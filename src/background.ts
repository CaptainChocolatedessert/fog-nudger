/**
 * Headless entry point. Owlbear loads this via manifest `background_url`.
 *
 * Build order step 0 scope, and no more: prove the extension loads in a real room and prove the
 * dev log round-trips. The probe that answers how a wall is written (DESIGN.md §4, Q1/Q2) lands
 * next, deliberately separately — if the skeleton and the probe arrive together, a silent room
 * cannot say which of the two failed.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel } from "./devlog";
import { describeError } from "./describeError";

installDevLog();

OBR.onReady(async () => {
  // Label this client before anything else logs — every client in the room shares one receiver,
  // and unlabelled interleaved output is actively misleading.
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(`${role === "GM" ? "GM" : "player"}:${OBR.player.id.slice(0, 4)}`);
  } catch (error) {
    devLog("warn", "could not read player role", describeError(error));
  }

  devLog("info", "Fog Nudger: background ready");

  // Subscribe BEFORE the first check, not after. A scene that becomes ready in the window between
  // reading `isReady()` and subscribing produces no transition to observe, and whatever was
  // waiting on it then never runs at all — silently, with no error. Subscribing first cannot miss
  // the transition; anything hung off it has to be idempotent to pay for the overlap.
  //
  // Nothing hangs off it yet. It is here now because the shape is the trap, and because a line
  // saying whether a scene is open is exactly what makes an otherwise-silent room readable.
  OBR.scene.onReadyChange((ready) => {
    devLog("info", `scene ready -> ${ready}`);
  });

  try {
    devLog("info", `scene ready at startup: ${await OBR.scene.isReady()}`);
  } catch (error) {
    devLog("error", "scene readiness check failed", describeError(error));
  }
});
