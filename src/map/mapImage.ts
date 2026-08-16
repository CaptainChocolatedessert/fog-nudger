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
 * rather than the dev log, because the dev log compiles away in a production build and this is the
 * one failure that is about the platform rather than about the map.
 */

// Aliased: the SDK's `Image` item type would otherwise shadow the DOM `Image` constructor that
// `loadImage` needs, and a type-only binding cannot be called.
import OBR, { isImage, type Image as ImageItem, type Item } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { key } from "../namespace";
import { selectMapCandidates } from "./mapCandidates";
import { planRaster, type RasterPlan } from "./rasterPlan";
import type { PixelImage } from "../trace/luminance";
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
  /** Scene grid size in world units, for reporting density. */
  readonly dpi: number;
}

/** A `MAP`-layer image as the panel needs to show it. */
export interface MapImageSummary {
  readonly id: string;
  readonly name: string;
  /**
   * Size in **grid squares**, not pixels and not world units.
   *
   * World units were shown first and were actively misleading: a map reading "10308×7965" next to
   * its name is read as an image resolution by anyone who has ever seen one, and this map's image
   * is in fact 3300×2550. Grid squares are the only one of the three a GM can check against the map
   * in front of them, and they still do the job the number is here for — telling a real map apart
   * from a token stranded on the map layer.
   */
  readonly width: number;
  readonly height: number;
  readonly locked: boolean;
  readonly visible: boolean;
  /** Whether the area filter would keep this as a plausible map. */
  readonly plausible: boolean;
}

/**
 * Every `MAP`-layer image in the scene, largest first, for the GM to choose from.
 *
 * Deliberately not the same thing as `resolveTraceMap`, and the difference is the point of having a
 * picker at all. The resolver refuses an ambiguous scene, because guessing risks tracing a GM
 * overlay. This lists everything and lets a human decide, which is safe precisely because a human
 * is reading the names.
 *
 * `locked` is reported but blocks nothing. A scene map is normally locked and therefore cannot be
 * clicked, which is how the sibling's selection-based nomination became unreachable in exactly the
 * scene that needed it. A list in a panel needs no selection.
 *
 * `plausible` carries the area filter's verdict as information rather than as a rule — a stray
 * token on the map layer is shown, marked, and still choosable, because the filter is a heuristic
 * and the GM is not.
 */
export async function listMapImages(): Promise<MapImageSummary[]> {
  const maps = await OBR.scene.items.getItems<ImageItem>(
    (item) => isImage(item) && item.layer === "MAP",
  );
  if (maps.length === 0) return [];

  const [measured, dpi] = await Promise.all([measure(maps), OBR.scene.grid.getDpi()]);
  const kept = selectMapCandidates(
    measured.map(({ map, bounds }) => ({
      id: map.id,
      name: map.name || "unnamed",
      area: Math.max(0, bounds.width) * Math.max(0, bounds.height),
    })),
  );

  // Ranking still happens on world area. Only the *displayed* figure is converted, so a dpi of
  // zero degrades to showing zeroes rather than silently reordering the list.
  const squares = (units: number): number => (dpi > 0 ? Math.round(units / dpi) : 0);

  return measured
    .map(({ map, bounds }) => ({
      id: map.id,
      name: map.name || "unnamed",
      width: squares(bounds.width),
      height: squares(bounds.height),
      locked: map.locked,
      visible: map.visible,
      plausible: kept.some((candidate) => candidate.id === map.id),
    }))
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/**
 * A cheap fingerprint of the map-layer images in a set of items.
 *
 * Exists so a watcher can tell "the maps changed" from "something else in the scene moved" without
 * a round trip per image for bounds. Kept here rather than in the panel deliberately: what counts
 * as a map image is decided in one place, and two places deciding it is how they drift apart.
 */
export function mapSignature(items: readonly Item[]): string {
  return items
    .filter((item) => isImage(item) && item.layer === "MAP")
    .map((item) => `${item.id}:${item.name}`)
    .sort()
    .join("|");
}

/** The GM's nominated map id for this scene, or `null` if they have not chosen. */
export async function readNominatedMapId(): Promise<string | null> {
  const metadata = await OBR.scene.getMetadata();
  const chosen = metadata[MAP_CHOICE_KEY];
  return typeof chosen === "string" && chosen.length > 0 ? chosen : null;
}

/** Nominate a map, or pass `null` to go back to letting the resolver decide. */
export async function nominateMap(id: string | null): Promise<void> {
  await OBR.scene.setMetadata({ [MAP_CHOICE_KEY]: id ?? undefined });
  devLog("info", `map: nomination set to ${id ?? "auto"}`);
}

/**
 * The map image to trace, or `null` when that cannot be decided safely.
 *
 * Refusing is the right outcome for an ambiguous scene. No output plus a log line naming the
 * candidates is recoverable in one click of the picker; tracing the wrong image is not, because the
 * wrong image may be a GM overlay whose linework would end up shaping what players can see.
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
    // The nominated image is gone — deleted, or the choice was made in another scene. Fall through
    // to the single-map rule rather than tracing something nobody picked.
    devLog("warn", `map: the nominated map ${chosenId.slice(0, 8)} is not in this scene`);
  }

  if (maps.length === 1) return maps[0]!;

  const measured = await measure(maps);
  const candidates = selectMapCandidates(
    measured.map(({ map, bounds }) => ({
      id: map.id,
      name: map.name || "unnamed",
      area: Math.max(0, bounds.width) * Math.max(0, bounds.height),
    })),
  );

  if (candidates.length === 1) {
    const only = maps.find((map) => map.id === candidates[0]!.id);
    if (only) {
      devLog(
        "info",
        `map: tracing "${only.name || "map"}" — the other ${maps.length - 1} MAP ` +
          `image${maps.length === 2 ? " is" : "s are"} too small to be a map`,
      );
      return only;
    }
  }

  devLog(
    "warn",
    `map: ${candidates.length} comparable MAP images and no choice made, so nothing is traced — ` +
      `one may be a GM overlay. Pick one in the panel. Candidates: ` +
      measured
        .filter(({ map }) => candidates.some((candidate) => candidate.id === map.id))
        .map(
          ({ map, bounds }) =>
            `${map.name || "unnamed"} (${map.id.slice(0, 8)}, ` +
            `${Math.round(bounds.width)}x${Math.round(bounds.height)}, ` +
            `${map.locked ? "locked" : "unlocked"}, ` +
            `${map.visible ? "visible" : "hidden"})`,
        )
        .join("; "),
  );
  return null;
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
  const [bounds, dpi] = await Promise.all([
    OBR.scene.items.getItemBounds([map.id]),
    OBR.scene.grid.getDpi(),
  ]);

  let source: HTMLImageElement;
  try {
    source = await loadImage(map.image.url);
  } catch (error) {
    devLog("error", `map: could not load the map image ${map.image.url}`, error);
    return null;
  }

  const plan = planRaster(source.naturalWidth, source.naturalHeight);
  if (plan.width === 0 || plan.height === 0) {
    devLog("error", `map: "${map.name || "map"}" decoded to zero pixels — broken asset?`);
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
    dpi,
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
