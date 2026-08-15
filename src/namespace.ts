/**
 * The one metadata namespace everything of ours lives under — items in the scene, and settings
 * stored against the scene.
 *
 * Extracted here because it is now load-bearing in two independent places. Provenance metadata is
 * what lets promote, remove and re-run find exactly our shapes and never the GM's (DESIGN.md §4),
 * and the map nomination is a scene-scoped setting that has to survive a reload. Two modules each
 * spelling the string out is how they end up differing by a character and silently failing to see
 * each other's items.
 */

export const NAMESPACE = "io.github.captainchocolatedessert.fog-nudger";

/** A namespaced metadata key. */
export function key(name: string): string {
  return `${NAMESPACE}/${name}`;
}
