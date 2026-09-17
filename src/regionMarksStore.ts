/**
 * Where the GM's suppression marks live: scene metadata, beside the wall graph and the paint.
 *
 * ## A key of their own, not a field in the wall graph
 *
 * **Marks survive a rebuild of the walls** (user, 2026-09-16). A slider that regenerates the walls
 * throws the stored graph away, and anything kept inside it would go too — so marks sit beside the
 * walls, as the painted ink does, and a mark lands in whatever region the new walls make at its point.
 * That is also what keeps placing one from being a hand edit to the walls: it touches nothing the
 * rebuild controls care about, so it locks none of them.
 *
 * ## It records which map it is for
 *
 * A mark is in graph units of *a* map and says nothing about which, so the stored value names the map
 * and a mismatch reads as "no marks here" — the reasoning `inkPaintStore.ts` gives for paint.
 *
 * The SDK is imported here, so nothing in this file is reachable from a node test. The codec is in
 * `trace/suppression.ts`, which is pure and tested; this is the round trip around it.
 */

import OBR, { type Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { key } from "./namespace";
import { decodeMarks, encodeMarks } from "./trace/suppression";

const MARKS_KEY = key("regions.suppressed");

/**
 * Read the scene's marks for a map.
 *
 * An empty list is the ordinary answer — every scene before a mark was placed, and every map the
 * stored marks were not placed on. A list that will not decode is **not** silent: it costs the GM
 * every mark, and has to be said rather than looking like "you have not suppressed anything".
 */
export async function readRegionMarks(mapId: string | null): Promise<{
  readonly marks: readonly Vector2[];
  /** True when there was something stored for this map and it could not be read. */
  readonly corrupt: boolean;
}> {
  let stored: unknown;
  try {
    const metadata = await OBR.scene.getMetadata();
    stored = metadata[MARKS_KEY];
  } catch (error) {
    devLog("warn", `marks: could not read scene metadata — ${describeError(error)}`);
    return { marks: [], corrupt: false };
  }

  if (stored === undefined || stored === null) return { marks: [], corrupt: false };
  const record = typeof stored === "object" ? (stored as { map?: unknown; marks?: unknown }) : {};
  if (typeof record.map === "string" && record.map !== mapId) {
    devLog("info", "marks: the stored marks belong to another map, ignoring them");
    return { marks: [], corrupt: false };
  }

  const marks = typeof record.map === "string" ? decodeMarks(record.marks) : null;
  if (!marks) {
    // `console.error`, not the dev log, which compiles away in a production build.
    console.error(
      "Fog Nudger: the stored suppression marks could not be read and have been ignored. " +
        "Every suppressed region on this map is a room again until it is marked again.",
    );
    return { marks: [], corrupt: true };
  }
  devLog("info", `marks: loaded ${marks.length}`);
  return { marks, corrupt: false };
}

/**
 * Write the marks for a map, replacing whatever was there — or remove the key when there are none.
 *
 * **Throws on failure**, as every write here does: a GM who goes on marking regions into something
 * that is not being saved would find out at the table. **No marks is no key**, rather than a key
 * holding an empty list, so "nothing suppressed" is stated one way.
 */
export async function writeRegionMarks(mapId: string, marks: readonly Vector2[]): Promise<void> {
  await OBR.scene.setMetadata({
    [MARKS_KEY]: marks.length === 0 ? undefined : { map: mapId, marks: encodeMarks(marks) },
  });
  devLog("info", `marks: stored ${marks.length}`);
}
