/**
 * Headless entry point. Owlbear loads this via manifest `background_url`.
 *
 * **Deliberately inert, and still is.** It labels its surface, says the extension loaded and says
 * when a scene opens, and nothing else. It began as build order step 0 — prove the extension loads
 * in a real room and prove the dev log round-trips — and the probes it once announced as landing
 * next have landed, answered their questions and been retired.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";

installDevLog("bg");

OBR.onReady(async () => {
  // Label this surface before anything else logs — every client in the room, and every iframe
  // within a client, shares one receiver, and unlabelled interleaved output is actively
  // misleading rather than merely unhelpful.
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "bg"));
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
