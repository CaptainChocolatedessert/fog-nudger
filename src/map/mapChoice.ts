/**
 * Which map the trace reads when the GM has not said.
 *
 * Split out of `mapImage.ts` so it can be tested. That file imports the SDK, and the SDK reads
 * `window.location.search` at module load, so nothing in it is reachable from a Node test — which
 * left the one rule this project describes as *"one rule, two callers, because a picker showing one
 * image selected while the trace read a different one would be a lie told by two functions agreeing
 * separately"* with no test at all. Pure: no DOM, no SDK.
 */

/**
 * The largest by world **area**, or `null` if nothing has any.
 *
 * World area rather than pixel count, because "the map" means the thing covering the most ground. A
 * small image blown up to fill the table is the map; a crisp 4000px inset of one room is not.
 *
 * **It no longer refuses an ambiguous scene** (user, 2026-08-29). It used to: two images within 4x
 * of each other and no choice made produced nothing at all, on the argument that the wrong one might
 * be a GM overlay whose linework would shape what players can see. That argument was written when a
 * wrong guess was *invisible* — a trace started from a popover with no picture anywhere. The
 * workspace inverts it: the chosen map is drawn full-screen with its name above the picker, so
 * picking wrong is evident in the thing the GM is looking at and is one click from being fixed,
 * which is this project's own standard for when a guess may be a guess.
 */
export function largestByArea<T extends { readonly area: number }>(maps: readonly T[]): T | null {
  let best: T | null = null;
  // Zero and negative areas are skipped: a degenerate item cannot be a map, and letting one win on
  // an empty scene would trace nothing while claiming to have chosen.
  for (const map of maps) {
    if (map.area <= 0) continue;
    if (!best || map.area > best.area) best = map;
  }
  return best;
}

/**
 * The row the picker marks, which must be the map the resolver would read.
 *
 * Differs from `largestByArea` in exactly one case, and that case is why this function exists: **a
 * lone map wins whatever its area.** `resolveTraceMap` returns a single map without measuring it,
 * deliberately — the measurement is a bounds round trip paid on every load of the overwhelmingly
 * common single-map scene. So on a scene holding one MAP image with degenerate bounds, the area
 * guard would have the picker show nothing selected while the trace went ahead and read that map.
 * A list disagreeing with the trace is the failure the shared rule exists to prevent, so the
 * shortcut is matched here rather than removed there.
 */
export function defaultMapId(maps: readonly { readonly id: string; readonly area: number }[]): string | null {
  if (maps.length === 1) return maps[0]!.id;
  return largestByArea(maps)?.id ?? null;
}
