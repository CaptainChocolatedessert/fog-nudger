/**
 * Summarise a set of scene items as one line: how many of each `TYPE:LAYER`.
 *
 * The sibling's single most productive diagnostic. A census across both the networked scene and the
 * local set is what revealed that Dynamic Fog's walls live only in the local one — in one line,
 * after a wrong guess that it was not installed at all.
 *
 * Pure so it can be tested, and so the interesting half does not need a room.
 */

/** The only fields a census reads. Deliberately narrow so tests need not build whole items. */
export interface CensusItem {
  readonly type: string;
  readonly layer: string;
}

/**
 * Count items by `TYPE:LAYER`, most numerous first, ties broken alphabetically so the output is
 * stable enough to diff between two runs.
 *
 * **Says so when there is nothing**, rather than returning an empty string. An empty census and a
 * census that never ran must not look the same in a log — that is the failure this project has
 * inherited a standing warning about, and a blank line is exactly how it arrives.
 */
export function summariseItems(items: readonly CensusItem[]): string {
  if (items.length === 0) return "no items";

  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${item.type}:${item.layer}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}×${count}`)
    .join(", ");
}
