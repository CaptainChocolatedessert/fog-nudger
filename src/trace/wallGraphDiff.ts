/**
 * What the GM changed: the difference between the graph the trace derived and the graph in hand.
 *
 * ## Why this exists at all
 *
 * The surface needs to answer two questions, and they are the same question at two strengths.
 * *Is there work of mine in these walls?* decides whether the rail carries its mark, and
 * *what exactly would I lose?* is what a warning shows before regenerating them. A count of edits
 * answered neither: 14 tells a GM nothing they can act on, and this project has already retired one
 * numeric proxy — the merge alarm — for standing in, in a log nobody reads, for something that should
 * simply be looked at.
 *
 * So the comparison is against a **stored base**: the graph as the trace last derived it, kept beside
 * the document it became. Both are in the scene, which is why the answer survives closing the
 * workspace and coming back — the hand-edit count never could, because it lives in memory.
 *
 * ## A segment's identity is its two endpoints, not its node ids
 *
 * This is the decision that makes the whole thing work, and it looks wrong at first glance given how
 * hard the rest of the project insists that **identity is by id and never by proximity**.
 *
 * It is not that rule being broken. That rule is about deciding whether two walls *meet* — a doorway
 * is two ends deliberately near and deliberately separate, so asking "are these close" would join
 * things the GM kept apart. Nothing here asks that. This asks whether a segment is **present in both
 * sets**, and both sets hold float32 coordinates quantised through `Math.fround` on their way into
 * the document, so a segment that is in both is byte-identical. Exact equality, no tolerance, nothing
 * to tune.
 *
 * What it buys is that compaction and renumbering stop mattering. `compactNodes` renumbers every id
 * after a gesture and pruning compacts as well, so a diff by id would silently degrade the moment
 * either ran — and it would degrade into *wrong output*, not into an error. By coordinate, the two
 * graphs need share no numbering at all.
 *
 * ## A move is a removal and an addition, and that is deliberate
 *
 * There is no third category. Dragging a vertex changes the coordinates of every segment touching it,
 * so each one fails the test in both directions and falls out as a removal plus an addition with no
 * special handling anywhere. The GM sees the old run in amber and the new one in cyan, which is the
 * same subtractive/additive pair the painted ink layers already use — so the delta needs no
 * vocabulary that is not already on screen somewhere else.
 *
 * **The cost, stated: a crossing split reads as a change when nothing moved.** Splitting replaces one
 * segment with two halves sharing a new midpoint, and none of the three matches the original, so an
 * incidental crossing lights the whole wall up. That is over-reporting, which is the safe direction,
 * and the refinement if it ever bothers anyone is to treat a split as unchanged when the halves are
 * collinear with what they replaced. Not worth building before somebody minds.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { WallGraph } from "./wallGraph";

/** One segment, as geometry rather than as a pair of ids — which is the point (see above). */
export interface WallSegment {
  readonly a: Vector2;
  readonly b: Vector2;
}

export interface WallGraphDelta {
  /** Segments the graph in hand has and the derived one does not. The GM put these there. */
  readonly added: readonly WallSegment[];
  /** Segments the derived graph has and the one in hand does not. The GM took these away. */
  readonly removed: readonly WallSegment[];
}

/**
 * A segment's key: both endpoints, in a fixed order so direction cannot matter.
 *
 * An edge `{a, b}` and an edge `{b, a}` are the same wall, and nothing in the document promises which
 * way round they are stored — `insertEdge` takes the ends in the order the GM drew them. Ordering the
 * pair here is what stops a wall drawn right-to-left reading as one segment removed and a different
 * one added in the same place.
 *
 * `String` rather than arithmetic because these are float32 values and the key only has to be
 * *distinct*, never comparable. `-0` and `0` stringify alike, which is correct: they are the same
 * point.
 */
function segmentKey(a: Vector2, b: Vector2): string {
  const first = a.x < b.x || (a.x === b.x && a.y <= b.y);
  const [p, q] = first ? [a, b] : [b, a];
  return `${p.x},${p.y}|${q.x},${q.y}`;
}

/**
 * Every segment of a graph, keyed and counted.
 *
 * **Counted rather than a set**, because two coincident segments are a state the document can pass
 * through — the build drops the ones *it* produces and reports them, but nothing stops a GM drawing a
 * wall along one that is already there, and doubling a line in order to drag the copy elsewhere is a
 * legal intermediate. A set would call the second one identical to the first and report no change.
 */
function segmentCounts(graph: WallGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    // A decoded graph cannot reference a node that is not there — `decodeWallGraph` refuses
    // all-or-nothing rather than dropping the edge — so this is a guard against a caller holding
    // something mid-edit, not against the store.
    if (!a || !b) continue;
    const key = segmentKey(a, b);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the GM did to the derived graph to arrive at the one in hand.
 *
 * Both directions in one pass over each graph: walk the current one against a tally of the derived
 * one, and whatever the tally still holds at the end was taken away.
 */
export function diffWallGraphs(derived: WallGraph, current: WallGraph): WallGraphDelta {
  const remaining = segmentCounts(derived);
  const added: WallSegment[] = [];

  for (const edge of current.edges) {
    const a = current.nodes[edge.a];
    const b = current.nodes[edge.b];
    if (!a || !b) continue;
    const key = segmentKey(a, b);
    const left = remaining.get(key) ?? 0;
    // Claimed rather than merely matched: a second copy of a segment the derived graph has only once
    // is an addition, which is what the counting is for.
    if (left > 0) remaining.set(key, left - 1);
    else added.push({ a, b });
  }

  const removed: WallSegment[] = [];
  // What the tally still holds is what nothing in the current graph claimed. Read back off the
  // derived graph rather than reconstructed from the key, so the coordinates handed out are the
  // document's own numbers and never a parse of a string this module wrote.
  const unclaimed = new Map(remaining);
  for (const edge of derived.edges) {
    const a = derived.nodes[edge.a];
    const b = derived.nodes[edge.b];
    if (!a || !b) continue;
    const key = segmentKey(a, b);
    const left = unclaimed.get(key) ?? 0;
    if (left > 0) {
      unclaimed.set(key, left - 1);
      removed.push({ a, b });
    }
  }

  return { added, removed };
}

/**
 * Whether the graph in hand still is what the trace derived — the question the rail's mark asks.
 *
 * Cheaper than the delta and asked far more often, so it short-circuits on the segment count before
 * looking at any geometry.
 *
 * **No base means "assume it was edited", and that is the loud direction on purpose.** A graph saved
 * by a build that did not keep one tells us nothing about whether it was worked on, and the two
 * mistakes are not equal: marking an untouched graph costs a mark nobody needed, while failing to
 * mark an edited one lets a GM regenerate away an evening without being told. `null` on both sides is
 * the genuinely empty case and is the one that reports no difference.
 */
export function graphsDiffer(derived: WallGraph | null, current: WallGraph | null): boolean {
  if (!current) return derived !== null;
  if (!derived) return true;
  if (derived.edges.length !== current.edges.length) return true;

  const remaining = segmentCounts(derived);
  for (const edge of current.edges) {
    const a = current.nodes[edge.a];
    const b = current.nodes[edge.b];
    if (!a || !b) return true;
    const key = segmentKey(a, b);
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
  }
  return false;
}
