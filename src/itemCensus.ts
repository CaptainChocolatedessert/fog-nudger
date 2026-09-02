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

/** A derived item — a Dynamic Fog wall — and the id of the drawing it was built from. */
export interface AttachedItem {
  readonly attachedTo?: string | undefined;
}

/** One of our own items, and the human-readable label we gave it. */
export interface LabelledParent {
  readonly id: string;
  readonly label: string;
}

/**
 * Count derived items per parent, so "how many walls did *this* shape produce" is measured rather
 * than inferred from a total.
 *
 * ## Why a total is not good enough
 *
 * The first run of the probe reported ten walls from four shapes. That is consistent with the
 * decomposition we expected, and consistent with others we did not — so it could not actually
 * establish the thing it was run to establish. Reading a total and assuming a split is the
 * inherited failure of a diagnostic that cannot distinguish its outcomes, arriving in arithmetic
 * rather than in code.
 *
 * ## Zero must be reported, not omitted
 *
 * A parent that produced nothing is the single most interesting result this can return — it is what
 * "stroke width zero yields no walls" would look like. So every known parent appears in the output
 * with its count, including `×0`. An absent line and a zero line must never be the same thing.
 *
 * Anything attached to something we do not recognise is counted separately: a GM's own hand-drawn
 * fog produces walls too, and folding those into ours would inflate the numbers invisibly.
 *
 * ## And it says so when there is nothing to attribute
 *
 * With no parents *and* no derived items every branch below is skipped and the join produces the
 * empty string, so the census printed `Walls by shape: .` — which is the blank line
 * `summariseItems` has an explicit guard against, arriving in the function next to it. Found in a
 * room on 2026-09-01, on a scene that had no fog of ours in it yet. An empty answer and an answer
 * that never ran must not look the same, and a lone full stop is how that failure looks.
 *
 * ## Counted per LABEL, not per id — and that is now used deliberately
 *
 * Two parents sharing a label collapse into one entry. That reads as a bug against the paragraph
 * above, and it was one while every caller passed unique labels. It is now the mechanism the census
 * uses on a pushed map: hundreds of regions with a per-item split is a line nobody can read, which
 * is the failure of reporting a total wearing a different hat, so `fogProbe.ts` passes the *kind*
 * as the label above a threshold and gets `region×N, wall×M`. Below it, labels are unique and the
 * per-item promise holds. **If a caller needs per-item counts with colliding labels, it has to
 * disambiguate them before calling** — do not "fix" this to key by id without changing that caller.
 */
export function attributeByParent(
  derived: readonly AttachedItem[],
  parents: readonly LabelledParent[],
): string {
  const labelById = new Map(parents.map((parent) => [parent.id, parent.label]));
  const counts = new Map<string, number>(parents.map((parent) => [parent.label, 0]));

  let foreign = 0;
  let unattached = 0;

  for (const item of derived) {
    if (!item.attachedTo) {
      unattached += 1;
      continue;
    }
    const label = labelById.get(item.attachedTo);
    if (label === undefined) {
      foreign += 1;
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  // Parent order is preserved rather than sorted by count: these are compared against expectations
  // shape by shape, and a stable order makes two runs diffable.
  const parts = [...counts.entries()].map(([label, count]) => `${label}×${count}`);
  if (foreign > 0) parts.push(`other-parents×${foreign}`);
  if (unattached > 0) parts.push(`unattached×${unattached}`);
  if (parts.length === 0) return "nothing of ours in the scene, and no walls derived from anything";
  return parts.join(", ");
}
