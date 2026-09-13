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

/**
 * Whether a metadata key is one of ours.
 *
 * **The most dangerous predicate in the extension**, because the full clear deletes every item
 * carrying one — and the scene it runs in holds the GM's own fog, 419 hand-drawn items in this
 * project's test scene. Over-matching deletes their work; under-matching leaves ours behind and
 * makes "start over" a lie.
 *
 * **The separator is load-bearing.** Without it, a neighbouring extension whose id merely begins with
 * ours — any `…fog-nudger-something` — would be read as ours and have its items deleted. Matching on
 * the full prefix *including* the slash is what makes the test "is under our namespace" rather than
 * "starts with our name".
 *
 * Asked of the key rather than the value, so it is the same question for an item's metadata and for
 * the scene's: both are flat maps keyed this way, and a key we no longer write in this build is still
 * ours to clear.
 */
export function isOurKey(name: string): boolean {
  return name.startsWith(`${NAMESPACE}/`);
}
