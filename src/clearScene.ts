/**
 * Everything this extension owns in a scene, removed — the "start over" a room asked for.
 *
 * ## Why this is not *Remove all Fog Nudger items*
 *
 * That button deletes our items and clears the saved wall graph, and a room reasonably read it as a
 * full reset (user, 2026-09-13). It is not: the **reading settings**, the **two painted layers** and
 * the **map nomination** survive it, so re-reading a map you have painted on still composes your old
 * strokes into the ink and there is no way back to a blank start.
 *
 * ## Found by namespace, not by a list
 *
 * Every key we write is `NAMESPACE/<name>` and every item we place carries one, so this asks the
 * scene what of ours is in it rather than naming the five keys it knows about today. That is the
 * difference between a reset and a reset *that will still be right next year*: a key written by an
 * older build, whose name no longer exists anywhere in this code, is exactly the thing a GM starting
 * over needs gone and exactly the thing a maintained list forgets. Nothing has to be added here when
 * a new key is invented.
 *
 * It is also why this catches the retired step-one probe's shapes, which `ourItems` in the emit path
 * does not: that predicate names the two keys the emit path writes, which is right for *its* job and
 * too narrow for this one.
 *
 * ## The one genuinely irreversible control on the surface
 *
 * Undo does not reach metadata — it holds snapshots of the wall graph and nothing else — so unlike
 * pruning or straightening, which a room was wrongly warned about, this really cannot be taken back.
 * The panel arms it behind a second press for that reason.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "./devlog";
import { describeError } from "./describeError";
import { isOurKey } from "./namespace";

/**
 * Whether any of this object's metadata keys belong to us.
 *
 * The key test itself lives in `namespace.ts`, which is pure and can be reached from a node test —
 * this module cannot, and the predicate is the one place a mistake deletes a GM's own fog.
 */
function oursByNamespace(metadata: Record<string, unknown>): boolean {
  return Object.keys(metadata).some(isOurKey);
}

export interface Cleared {
  readonly items: number;
  readonly keys: number;
}

/**
 * Take out every item and every stored key this extension owns.
 *
 * Items first, then metadata, and the order matters on failure rather than on success: an item left
 * behind is visible and can be removed again, where a graph left in metadata with its shapes gone
 * would put the walls straight back on the next push. Failing halfway leaves the recoverable half
 * undone.
 *
 * **Not `removeOurs`, and it does not call it.** That reports a message and matches the emit path's
 * two keys; this needs the namespace sweep and the counts.
 */
export async function clearOurScene(): Promise<Cleared> {
  const ours = await OBR.scene.items.getItems((item) => oursByNamespace(item.metadata));
  if (ours.length > 0) {
    await OBR.scene.items.deleteItems(ours.map((item) => item.id));
  }

  const metadata = await OBR.scene.getMetadata();
  const keys = Object.keys(metadata).filter(isOurKey);
  if (keys.length > 0) {
    // One write rather than one per store: five round trips would leave four windows in which the
    // scene holds half a reset, and a reader between them cannot tell that from a real state.
    await OBR.scene.setMetadata(Object.fromEntries(keys.map((name) => [name, undefined])));
  }

  devLog("info", `clear: removed ${ours.length} items and ${keys.length} stored keys`);
  return { items: ours.length, keys: keys.length };
}

/**
 * The same, worded for the panel's result line.
 *
 * **It says what happened and stops** (text rules, 2026-09-29, DESIGN.md §7a). It used to list what
 * went — the map choice and the settings being the two a GM does not expect — and that list is the
 * confirmation's title now: *all Fog Nudger data*, asked before anything goes rather than reported
 * after.
 */
export async function clearEverything(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  try {
    const { items, keys } = await clearOurScene();
    if (items === 0 && keys === 0) return "No Fog Nudger data in this scene.";
    // Stored data with no items in the scene is the case a GM asked about in the text pass: it is
    // cleared like any other, and the count is left out rather than printed as a zero.
    if (items === 0) return "Cleared everything stored.";
    return `Cleared ${items} item${items === 1 ? "" : "s"} and everything stored.`;
  } catch (error) {
    const detail = describeError(error);
    console.error(`Fog Nudger — clearing the scene failed: ${detail}`);
    return `Clear failed: ${detail}.`;
  }
}
