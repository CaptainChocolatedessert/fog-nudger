/**
 * Getting a scene's map out of Owlbear and into pixels.
 *
 * Two jobs, deliberately separated: decide *which* image to trace, and turn it into a raster plus
 * the transform that puts results back where the map is.
 *
 * ## Reading the pixels is allowed, but the flag is still required
 *
 * Owlbear's CDN sends `Access-Control-Allow-Origin: *`, verified by the sibling against a real
 * `image.url` through the SDK. `crossOrigin = "anonymous"` is nonetheless mandatory: without it the
 * canvas is tainted whatever the server sends, and `getImageData` throws. A failure here means that
 * result has changed, so it is reported rather than swallowed — and reported through `console.error`
 * rather than the dev log, because the dev log compiles away in a production build.
 *
 * **All three of `loadMapRaster`'s failure exits use `console.error`, and that took two goes.** The
 * paragraph above was written about the tainted-canvas one and applied only to it; the other two —
 * the image not loading at all, which is where a CORS refusal lands first, and a decode to zero
 * pixels — were on the dev log, which is a no-op in a deployed build. The GM-facing message for all
 * three is "Could not read pixels from ... — see the console", so two of the three sent a GM to an
 * empty console. Nothing is lost in development either way: `installDevLog` wraps `console.error`
 * and forwards it, so one call reaches both channels in dev and the surviving one in production.
 */

// Aliased: the SDK's `Image` item type would otherwise shadow the DOM `Image` constructor that
// `loadImage` needs, and a type-only binding cannot be called.
import OBR, { isImage, type Image as ImageItem, type Item } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { defaultMapId, largestByArea } from "./mapChoice";
import { key } from "../namespace";
import { planRaster, type RasterPlan } from "./rasterPlan";
import type { PixelImage } from "../trace/field";
import type { WorldBounds } from "./placement";

/**
 * Which map the GM nominated, stored against the scene.
 *
 * Scene metadata rather than anything local, and not by preference. The extension runs in a
 * third-party iframe, so Firefox partitions `localStorage` per top-level site and a local choice
 * can simply vanish. Scene metadata also travels with the scene, which is the right lifetime for a
 * fact about that scene's map.
 */
const MAP_CHOICE_KEY = key("map-choice");

export interface MapRaster {
  readonly mapId: string;
  readonly name: string;
  /** Identifies what was traced, so a later cache can tell a re-trace from a redraw. */
  readonly url: string;
  readonly pixels: PixelImage;
  readonly bounds: WorldBounds;
  readonly plan: RasterPlan;
}

/** A `MAP`-layer image as the panel needs to show it. */
export interface MapImageSummary {
  readonly id: string;
  readonly name: string;
  /**
   * The image's own size in pixels — the number on the file, not what it covers on the table.
   *
   * World units were shown first and were actively misleading: a map reading "10308x7965" beside
   * its name is read as an image resolution by anyone who has ever seen one, and this map's image is
   * in fact 3300x2550. Grid squares replaced them and were replaced in turn (user, 2026-08-29),
   * because the pixel size is the one figure a GM can match against the picture they imported - and
   * because it is the resolution the trace actually reads, which squares only imply.
   */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly locked: boolean;
  readonly visible: boolean;
  /** Whether this is the one a scene with no nomination would trace. */
  readonly isDefault: boolean;
}

/**
 * Every `MAP`-layer image in the scene, in the layer's own **z-order**, for the GM to choose from.
 *
 * Everything is listed and nothing is filtered (user, 2026-08-29). Locked images are here - a scene
 * map is normally locked and therefore cannot be clicked, which is how the sibling's
 * selection-based nomination became unreachable in exactly the scene that needed it - and so are
 * hidden ones and tiny ones. A list needs no selection and no permission.
 *
 * **No plausibility mark.** An area filter used to flag anything under a quarter of the largest as
 * "too small?"; the sizes are on screen and the GM can see the picture, so the mark was a heuristic
 * offering an opinion where the evidence was already in view.
 *
 * **Z-order rather than largest-first**, bottom of the stack upward: that is the order the images
 * were laid down, so the base map comes before whatever was put on top of it. Ranking still happens
 * - the largest is marked as the default - but it no longer decides the order, because a list that
 * reorders itself as a GM scales an image is a list whose rows move under the cursor.
 */
export async function listMapImages(): Promise<MapImageSummary[]> {
  const maps = await OBR.scene.items.getItems<ImageItem>(
    (item) => isImage(item) && item.layer === "MAP",
  );
  if (maps.length === 0) return [];

  const measured = await measure(maps);
  const areas = new Map(
    measured.map(({ map, bounds }) => [
      map.id,
      Math.max(0, bounds.width) * Math.max(0, bounds.height),
    ]),
  );
  // `defaultMapId` rather than `largestByArea` directly, because a lone map is the trace's choice
  // whatever its area — see that function for the scene the two answer differently on.
  const fallbackId = defaultMapId([...areas].map(([id, area]) => ({ id, area })));

  return measured
    .map(({ map }) => ({
      id: map.id,
      name: map.name || "unnamed",
      pixelWidth: map.image.width,
      pixelHeight: map.image.height,
      locked: map.locked,
      visible: map.visible,
      isDefault: map.id === fallbackId,
    }))
    .sort((a, b) => zIndexOf(maps, a.id) - zIndexOf(maps, b.id));
}

/**
 * An item's stacking position, or zero if it is not in the list.
 *
 * The `?? 0` cannot fire: `maps` is the in-memory array the summaries were derived from rather
 * than a re-query, so every id is present by construction. It said "vanished between the query and
 * the sort", which describes a race this cannot have. Kept because a total function here is worth
 * more than the branch costs, and it is a `find` inside a sort comparator either way — quadratic
 * in the number of maps in a scene, which is a number in the single digits.
 */
function zIndexOf(maps: readonly ImageItem[], id: string): number {
  return maps.find((map) => map.id === id)?.zIndex ?? 0;
}

/**
 * A cheap fingerprint of the map-layer images in a set of items.
 *
 * Exists so a watcher can tell "the maps changed" from "something else in the scene moved" without
 * a round trip per image for bounds. Kept here rather than in the panel deliberately: what counts
 * as a map image is decided in one place, and two places deciding it is how they drift apart.
 *
 * ## It covers everything a row displays, which id and name did not
 *
 * The picker rebuilds only when this string changes, so anything a row shows and this omits goes
 * stale silently. It was `id:name` alone, and three things a row shows are not either of those. The
 * worst is **which row is marked as the trace's choice**: with no nomination that is the largest by
 * world *area*, so a GM scaling map B past map A changed which map would be traced while the picker
 * went on marking A — the exact lie `largestByArea` exists to prevent, arriving through the refresh
 * guard rather than through a duplicated rule. The `locked` and `hidden` badges were stale the same
 * way.
 *
 * **Still no round trip.** Every field here is already on the item; the bounds this deliberately
 * avoids are not needed, because scale and position are what *change* the area. Rounded to two
 * decimals so a drag by another client rebuilds the rows a bounded number of times rather than on
 * every floating-point twitch — the workspace is a full-screen modal, so the GM whose list it is
 * cannot be the one dragging.
 */
export function mapSignature(items: readonly Item[]): string {
  return items
    .filter((item): item is ImageItem => isImage(item) && item.layer === "MAP")
    .map((item) =>
      [
        item.id,
        item.name,
        item.scale.x.toFixed(2),
        item.scale.y.toFixed(2),
        item.position.x.toFixed(2),
        item.position.y.toFixed(2),
        item.rotation.toFixed(2),
        item.image.width,
        item.image.height,
        item.locked,
        item.visible,
      ].join(":"),
    )
    .sort()
    .join("|");
}

/** The GM's nominated map id for this scene, or `null` if they have not chosen. */
export async function readNominatedMapId(): Promise<string | null> {
  const metadata = await OBR.scene.getMetadata();
  const chosen = metadata[MAP_CHOICE_KEY];
  return typeof chosen === "string" && chosen.length > 0 ? chosen : null;
}

/**
 * Nominate a map.
 *
 * `null` clears the choice, which puts the scene back on the largest image. No control does that
 * today — every row in the picker names a real image — but the stored shape has to mean something
 * for a scene that has never been nominated at all, and this is that meaning written down.
 */
export async function nominateMap(id: string | null): Promise<void> {
  await OBR.scene.setMetadata({ [MAP_CHOICE_KEY]: id ?? undefined });
  devLog("info", `map: nomination set to ${id ?? "none (largest wins)"}`);
}

/**
 * The map image to trace: the GM's nomination, or the largest image in the scene.
 *
 * `null` only when the scene holds no `MAP`-layer image at all, which is an ordinary state rather
 * than a refusal - see `largestByArea` for why the refusal went.
 */
export async function resolveTraceMap(): Promise<ImageItem | null> {
  const maps = await OBR.scene.items.getItems<ImageItem>(
    (item) => isImage(item) && item.layer === "MAP",
  );

  if (maps.length === 0) {
    devLog("info", "map: no MAP image in this scene, nothing to trace");
    return null;
  }

  const chosenId = await readNominatedMapId();
  if (chosenId) {
    const chosen = maps.find((map) => map.id === chosenId);
    if (chosen) return chosen;
    // The nominated image is gone: deleted, or this scene was duplicated from one that carried the
    // metadata. **Not** "the choice was made in another scene", which this used to say — the
    // nomination lives in *scene* metadata, so it cannot leak between scenes. Falling through to
    // the largest rather than tracing nothing is right whatever the cause.
    devLog("warn", `map: the nominated map ${chosenId.slice(0, 8)} is not in this scene`);
  }

  // One map wins without a bounds round trip, and therefore without the area guard `largestByArea`
  // applies. That trade is deliberate: the round trip would be paid on every map load of the
  // overwhelmingly common single-map scene, and this function runs several times per load. The guard
  // it skips only bites on a lone MAP image with degenerate bounds, and `listMapImages` marks that
  // same map as the default so the picker agrees rather than showing nothing selected. **Do not
  // "fix" this back into consulting the area** without changing the picker in the same edit.
  if (maps.length === 1) return maps[0]!;

  const measured = await measure(maps);
  const largest = largestByArea(
    measured.map(({ map, bounds }) => ({
      map,
      area: Math.max(0, bounds.width) * Math.max(0, bounds.height),
    })),
  );
  if (!largest) {
    devLog("warn", `map: ${maps.length} MAP images and none with any area, so nothing is traced`);
    return null;
  }

  devLog(
    "info",
    `map: no choice made, tracing the largest of ${maps.length} - ` +
      `"${largest.map.name || "unnamed"}" (${largest.map.id.slice(0, 8)}, ` +
      `${largest.map.image.width}x${largest.map.image.height} px)`,
  );
  return largest.map;
}

/**
 * The scene's grid size in world units.
 *
 * Exposed separately from `loadMapRaster` because the trace cache needs it *before* deciding
 * whether to load anything: the grid sets pixels-per-square, which sets the Sauvola radius, so a
 * changed grid invalidates a cached mask. Reading it costs one SDK call; loading the raster costs
 * a fetch and a full-image `getImageData`.
 */
export async function readGridDpi(): Promise<number> {
  return await OBR.scene.grid.getDpi();
}

/**
 * Load a map image and read its pixels.
 *
 * At native resolution unless the megapixel budget bites — see `rasterPlan.ts` for why that budget
 * is about memory rather than time, and why downscaling is the thing to avoid here.
 *
 * @returns `null` if the image cannot be loaded or its pixels cannot be read. Both are reported,
 * since either would otherwise surface as a dry run that simply never says anything.
 */
export async function loadMapRaster(map: ImageItem): Promise<MapRaster | null> {
  // Bounds only. This used to fetch the grid dpi alongside and carry it on the result, and nothing
  // ever read it: the one caller destructures pixels, plan and bounds, and the dpi it needs it has
  // already got from `readGridDpi` before deciding whether to load anything at all. A populated
  // field with no consumer is one the next reader assumes something consumes.
  const bounds = await OBR.scene.items.getItemBounds([map.id]);

  let source: HTMLImageElement;
  try {
    source = await loadImage(map.image.url);
  } catch (error) {
    console.error(`Fog Nudger: could not load the map image ${map.image.url}`, error);
    return null;
  }

  const plan = planRaster(source.naturalWidth, source.naturalHeight);
  if (plan.width === 0 || plan.height === 0) {
    console.error(`Fog Nudger: "${map.name || "map"}" decoded to zero pixels — broken asset?`);
    return null;
  }

  let pixels: PixelImage;
  try {
    pixels = drawToPixels(source, plan);
  } catch (error) {
    console.error(
      "Fog Nudger: map pixels are unreadable — the asset did not send " +
        "Access-Control-Allow-Origin, or the raster was too large to allocate.",
      error,
    );
    return null;
  }

  return {
    mapId: map.id,
    name: map.name || "map",
    url: map.image.url,
    pixels,
    bounds: { min: bounds.min, max: bounds.max },
    plan,
  };
}

async function measure(
  maps: readonly ImageItem[],
): Promise<{ map: ImageItem; bounds: { width: number; height: number } }[]> {
  return Promise.all(
    maps.map(async (map) => ({
      map,
      bounds: await OBR.scene.items.getItemBounds([map.id]),
    })),
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Required regardless of what the server sends: without it the canvas is tainted and
    // getImageData throws even for a fully permissive CDN.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "image failed to load (a cross-origin image needs CORS headers even to load)",
        ),
      );
    image.src = url;
  });
}

/**
 * Draw the image into a canvas at the planned size and read it back.
 *
 * When the plan is native — the common case — this is a straight copy and no resampling happens at
 * all. When the budget bit, the reduction is done by the **browser's own resampler** during the
 * draw, not by a box filter of ours. That is a real limitation and worth naming: a box average
 * would be the better filter, but computing one requires the full-resolution pixels in memory,
 * which is precisely what the budget exists to avoid. Drawing straight to the reduced size is what
 * keeps the allocation bounded, so the browser's filter is what there is.
 *
 * The integer ratio still earns its keep here. It makes the reduction uniform across the image,
 * where a fractional ratio would resample different regions against different sub-pixel phases and
 * thin linework unevenly.
 */
function drawToPixels(source: HTMLImageElement, plan: RasterPlan): PixelImage {
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d canvas context");

  // Only meaningful when the plan reduces. At native size there is nothing to interpolate, and
  // asking for high quality costs nothing.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  context.drawImage(source, 0, 0, plan.width, plan.height);
  return context.getImageData(0, 0, plan.width, plan.height);
}
