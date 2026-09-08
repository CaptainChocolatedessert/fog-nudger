/**
 * Where the GM's two pixel layers live: scene metadata, beside the settings and the wall graph.
 *
 * Same reasoning as those. The extension runs in a third-party iframe, so Firefox partitions
 * `localStorage` per top-level site and a local copy can simply vanish; and paint made by looking at
 * *this* map belongs to the scene rather than to a browser.
 *
 * ## A key each, not one key holding both
 *
 * Suppression and added ink are separate layers of the stack and are edited one at a time, so a key
 * each means finishing with one tool rewrites only what that tool changed — and two writes can never
 * race for the same key. It is the reasoning `wallGraphStore.ts` gives for keeping the graph out of
 * the settings, one level down.
 *
 * ## Each records which map it is for
 *
 * A layer is a raster of *a* map and nothing in it says which. A GM who paints and then nominates a
 * different image would otherwise have the first map's marks reinterpreted over the second. So the
 * stored value is a small wrapper — the map's id beside the encoded layer — and a mismatch reads as
 * "no paint for this map" rather than as paint. The layer's own *dimensions* are inside the encoding,
 * because which raster it was painted at is a fact about the document; which map it belongs to is a
 * fact about the scene.
 *
 * The SDK is imported here, so nothing in this file is reachable from a node test. Everything with a
 * decision in it lives in `trace/inkPaint.ts`, which is pure and tested; this is the round trip and
 * the error handling around it, and it is deliberately thin.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { key } from "./namespace";
import { decodePaint, encodePaint, type PaintLayer } from "./trace/inkPaint";

/** Which layer of the stack. The two are stored and read identically and never together. */
export type PaintKind = "suppress" | "ink";

const KEYS: Readonly<Record<PaintKind, string>> = {
  suppress: key("paint.suppress"),
  ink: key("paint.ink"),
};

/** How each layer is described on a state line and in the log, in one place rather than at each. */
export const PAINT_NAMES: Readonly<Record<PaintKind, string>> = {
  suppress: "suppression",
  ink: "added ink",
};

/**
 * The largest encoded layer this will write, in characters of base64.
 *
 * **Below the measured ceiling on purpose, and the ceiling is softer than it looks.** What the record
 * has is that no limit was found *below* 512KB per key — a floor on the limit rather than the limit
 * itself — and there are three of our keys in a scene, plus whatever else Owlbear keeps there. So
 * this refuses at a quarter of it, which every shape of real paint measured clears by an order of
 * magnitude.
 *
 * Refusing is the point. Without it, a layer too large simply fails somewhere inside the SDK, with a
 * message about metadata rather than about painting, at the moment the GM presses Done — and what
 * they would lose is the whole session's work with nothing saying what to do differently.
 */
const MAX_ENCODED = 128 * 1024;

/**
 * Read one of the scene's paint layers, or `null` if there is not one this build can vouch for.
 *
 * **`null` is a legitimate answer, not an error**: it is what every scene looks like before anything
 * was ever painted, and the caller's response is the same either way — start from an empty layer.
 *
 * It is also the answer for a layer that will not decode, and that case is *not* silent. There is no
 * per-field degrading available: a layer with some of its runs dropped is every mark after the fault
 * in the wrong place, which is a corrupt document presented as a valid one. So a bad payload costs
 * the GM that layer, which is a real loss and has to be said out loud rather than looking like "you
 * have not painted anything yet".
 */
export async function readPaintLayer(
  kind: PaintKind,
  mapId: string | null,
): Promise<{
  readonly layer: PaintLayer | null;
  /** True when there was something stored and it could not be read. */
  readonly corrupt: boolean;
}> {
  let stored: unknown;
  try {
    const metadata = await OBR.scene.getMetadata();
    stored = metadata[KEYS[kind]];
  } catch (error) {
    // Could not ask. Distinct from "asked and it was bad", so it does not claim the paint is lost.
    devLog("warn", `paint: could not read scene metadata — ${describeError(error)}`);
    return { layer: null, corrupt: false };
  }

  if (stored === undefined || stored === null) return { layer: null, corrupt: false };
  if (typeof stored !== "object") {
    console.error(`Fog Nudger: the stored ${PAINT_NAMES[kind]} is not an object`, typeof stored);
    return { layer: null, corrupt: true };
  }

  const record = stored as { map?: unknown; paint?: unknown };
  if (typeof record.paint !== "string") {
    console.error(`Fog Nudger: the stored ${PAINT_NAMES[kind]} has no encoded body`);
    return { layer: null, corrupt: true };
  }

  // Paint for another map is not corruption — it is a document that does not apply here. Silent,
  // because it is the ordinary consequence of nominating a different image.
  if (typeof record.map !== "string" || record.map !== mapId) {
    devLog("info", `paint: the stored ${PAINT_NAMES[kind]} belongs to another map, ignoring it`);
    return { layer: null, corrupt: false };
  }

  const layer = decodePaint(record.paint);
  if (!layer) {
    // `console.error`, not the dev log: the dev log compiles away in a production build, and this is
    // a message a GM may be told to go and look for.
    console.error(
      `Fog Nudger: the stored ${PAINT_NAMES[kind]} could not be decoded and has been ignored. ` +
        "That layer is lost for this scene; the reading settings and the other layer are not.",
    );
    return { layer: null, corrupt: true };
  }

  devLog(
    "info",
    `paint: loaded ${PAINT_NAMES[kind]} at ${layer.width}x${layer.height} ` +
      `from ${record.paint.length} characters`,
  );
  return { layer, corrupt: false };
}

/**
 * Write one paint layer, replacing whatever was there.
 *
 * Throws on failure rather than swallowing, which is the opposite of `readSettings` and is the right
 * way round: a *read* that fails can fall back to an empty layer and carry on, but a **write** that
 * fails silently means the GM goes on painting into something that is not being saved. The caller has
 * a state line and must use it.
 */
export async function writePaintLayer(
  kind: PaintKind,
  mapId: string,
  layer: PaintLayer,
): Promise<void> {
  const encoded = encodePaint(layer);
  if (encoded.length > MAX_ENCODED) {
    throw new Error(
      `this ${PAINT_NAMES[kind]} layer needs ${Math.round(encoded.length / 1024)}KB of scene ` +
        `storage, over the ${Math.round(MAX_ENCODED / 1024)}KB this will write. Very many small ` +
        `separate marks cost far more to store than the same area covered with a wide brush.`,
    );
  }
  await OBR.scene.setMetadata({ [KEYS[kind]]: { map: mapId, paint: encoded } });
  devLog(
    "info",
    `paint: stored ${PAINT_NAMES[kind]} at ${layer.width}x${layer.height} ` +
      `in ${encoded.length} characters`,
  );
}

/**
 * Discard one paint layer entirely.
 *
 * Called when a mode is finished with an empty layer, which is the only way a layer becomes empty.
 * Distinct from writing an empty layer, which would leave a key holding a valid document that says
 * nothing, and two ways of stating one fact that can then disagree.
 */
export async function clearPaintLayer(kind: PaintKind): Promise<void> {
  await OBR.scene.setMetadata({ [KEYS[kind]]: undefined });
  devLog("info", `paint: discarded ${PAINT_NAMES[kind]}`);
}
