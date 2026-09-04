/**
 * The edits: adding a wall, moving a vertex, merging two — each leaving the graph planar.
 *
 * Split from `planarGraph.ts`, which holds the *predicate* — how two segments meet, and whether a
 * graph has any crossings at all. This holds the operations that use it. The division is that the
 * predicate is pure geometry and could serve anything, while these know what a wall is and what an
 * edit means.
 *
 * ## Every edit is the same sweep at a different moment
 *
 * Adding a wall, dragging a vertex and merging two vertices all end the same way: some segments have
 * moved or appeared, and whatever they now cross has to be split. `resolveCrossings` is that step,
 * and it is the reason a drag carrying a vertex across a wall is not a new problem — it is the sweep
 * `insertEdge` already runs, discovered on release rather than on a click.
 *
 * ## Identity is by id, and the tool decides what merges
 *
 * Nothing here matches nodes by proximity. Two walls meet because they **share a node id**, and
 * whether a dragged vertex is close enough to an existing one to merge is the editing tool's
 * decision — made with a screen-space radius the GM can see, and suppressed by holding a modifier.
 * `nearestNode` is the query it uses; the tool then calls `moveNode` or `mergeNodes` accordingly.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentPoint, type FrozenEdge, type FrozenGraph } from "./frozenGraph";
import { segmentMeeting } from "./planarGraph";

export interface EditResult {
  readonly graph: FrozenGraph;
  /** How many segments that already existed were cut. */
  readonly splits: number;
  /** Collinear overlaps found. Reported, never fixed — splitting cannot separate them. */
  readonly overlaps: number;
}

/**
 * One segment on its way through an edit.
 *
 * `changed` marks the ones this edit touched, which is the only set worth sweeping: an untouched
 * segment cannot have started crossing something on its own. `isNew` is narrower and only decides
 * what counts towards `splits`, so "how many existing walls did I cut" stays a meaningful number
 * rather than counting a new wall's own subdivision.
 */
interface Pending {
  readonly a: number;
  readonly b: number;
  readonly changed: boolean;
  readonly isNew: boolean;
}

/**
 * Split every crossing the changed segments are involved in.
 *
 * **Only the changed segments are swept, and that is a correctness argument before it is a speed
 * one.** A graph that was planar before an edit can only have gained a crossing involving something
 * the edit moved or added, so sweeping the rest would find nothing. It is also what makes the cost
 * bearable: checking everything against everything is quadratic, and on a real map's tens of
 * thousands of segments that is of order 10^8 pairs at every drag-end.
 *
 * Pairs are checked changed-against-*everything*, including other changed segments, so a new wall
 * that crosses itself is split too.
 */
function resolveCrossings(
  nodes: Vector2[],
  pending: readonly Pending[],
  originals: readonly FrozenEdge[],
): EditResult {
  const cuts = new Map<number, { at: number; id: number }[]>();
  let overlaps = 0;

  const idFor = (point: Vector2): number => {
    const found = nodes.findIndex((n) => n.x === point.x && n.y === point.y);
    if (found >= 0) return found;
    nodes.push(point);
    return nodes.length - 1;
  };

  const addCut = (index: number, point: Vector2): void => {
    const segment = pending[index]!;
    const id = idFor(point);
    /*
      A cut at one of the segment's own ends is not a cut; the node is already there.

      The predicate's end tolerance already rejects a crossing near an end, so reaching this needs
      the crossing to be comfortably interior and *still* round onto an end — which takes a segment
      only a float32 unit or two long, well under a thousandth of a pixel. **Defence in depth, and
      not isolated by a test**: several attempts to construct the case landed either side of it. Said
      plainly rather than left looking like something the suite covers.
    */
    if (id === segment.a || id === segment.b) return;
    const from = nodes[segment.a]!;
    const to = nodes[segment.b]!;
    const span = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
    const at =
      span <= 0
        ? 0
        : ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / span;
    const list = cuts.get(index) ?? [];
    if (!list.some((cut) => cut.id === id)) list.push({ at, id });
    cuts.set(index, list);
  };

  for (let i = 0; i < pending.length; i++) {
    if (!pending[i]!.changed) continue;
    for (let j = 0; j < pending.length; j++) {
      if (i === j) continue;
      // A changed pair is checked once, from the lower index, or both cuts are added twice.
      if (pending[j]!.changed && j < i) continue;
      const meeting = segmentMeeting(
        nodes[pending[j]!.a]!,
        nodes[pending[j]!.b]!,
        nodes[pending[i]!.a]!,
        nodes[pending[i]!.b]!,
      );
      if (!meeting) continue;
      if (meeting.kind === "overlap") {
        overlaps += 1;
        continue;
      }
      if (meeting.splitsFirst) addCut(j, meeting.point);
      if (meeting.splitsSecond) addCut(i, meeting.point);
    }
  }

  const edges: FrozenEdge[] = [];
  let splits = 0;
  for (let i = 0; i < pending.length; i++) {
    const segment = pending[i]!;
    const list = cuts.get(i);
    if (!list || list.length === 0) {
      /*
        Uncut: an existing segment keeps its *identity*, by reference — but only if its **ids** are
        still the ones the original held.

        That guard is not decoration. A move changes the coordinates in the node table and leaves the
        pair of ids alone, so the original object is still an accurate description and returning it
        is right. A **merge renames one of the ids**, and the original then describes the segment as
        it was *before* the merge — returning it silently undoes the whole operation, which is
        precisely what it did until this comparison was added.
      */
      const original = originals[i];
      const unchanged = original && original.a === segment.a && original.b === segment.b;
      edges.push(!segment.isNew && unchanged ? original : { a: segment.a, b: segment.b });
      continue;
    }
    // Ordered along the segment, or the rebuilt wall threads through its own cuts backwards.
    list.sort((x, y) => x.at - y.at);
    if (!segment.isNew) splits += list.length;
    let previous = segment.a;
    for (const cut of list) {
      edges.push({ a: previous, b: cut.id });
      previous = cut.id;
    }
    edges.push({ a: previous, b: segment.b });
  }

  return { graph: { nodes, edges }, splits, overlaps };
}

/** Every node id, in order, that is not already the last one pushed. */
function idsFor(points: readonly Vector2[], nodes: Vector2[]): number[] {
  const idFor = (point: Vector2): number => {
    const found = nodes.findIndex((n) => n.x === point.x && n.y === point.y);
    if (found >= 0) return found;
    nodes.push(point);
    return nodes.length - 1;
  };
  return points.map(idFor);
}

/**
 * Add a wall as a run of points, splitting whatever it crosses.
 *
 * The points are in map fractions. **Whether they attach to existing nodes is the caller's
 * decision** — the tool snaps within a radius the GM can see and passes the snapped position.
 * Nothing here second-guesses that by proximity; an exact coordinate match reuses a node, and
 * anything else is a new one.
 *
 * Rebuilt rather than mutated: the caller holds the old graph until this returns, which is what lets
 * a failed edit leave the GM exactly where they were.
 */
export function insertEdge(graph: FrozenGraph, points: readonly Vector2[]): EditResult {
  const fresh: Vector2[] = [];
  for (const point of points) {
    const at = documentPoint(point.x, point.y);
    const last = fresh[fresh.length - 1];
    // Consecutive duplicates make zero-length segments, which have no direction to cross with.
    if (!last || last.x !== at.x || last.y !== at.y) fresh.push(at);
  }
  if (fresh.length < 2) return { graph, splits: 0, overlaps: 0 };

  const nodes: Vector2[] = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
  const newIds = idsFor(fresh, nodes);

  const pending: Pending[] = graph.edges.map((edge) => ({
    a: edge.a,
    b: edge.b,
    changed: false,
    isNew: false,
  }));
  for (let i = 0; i + 1 < newIds.length; i++) {
    pending.push({ a: newIds[i]!, b: newIds[i + 1]!, changed: true, isNew: true });
  }

  return resolveCrossings(nodes, pending, graph.edges);
}

/**
 * Move one vertex, and split whatever its walls now cross.
 *
 * The whole of a vertex drag, applied once the gesture has ended. Only the segments meeting that
 * node can have started crossing something, so those are what gets swept.
 *
 * **A drag that carries a vertex across a wall is therefore not a new problem**: it is the same
 * sweep `insertEdge` runs, discovered on release rather than on a click. That was the one question
 * raised against building the drag tool, and this is the answer to it.
 *
 * **Snapping onto another vertex is not this operation.** That is a merge, and `mergeNodes` is where
 * it lives — the tool decides which of the two the GM meant.
 */
export function moveNode(graph: FrozenGraph, id: number, to: Vector2): EditResult {
  if (id < 0 || id >= graph.nodes.length) return { graph, splits: 0, overlaps: 0 };
  const at = documentPoint(to.x, to.y);
  const current = graph.nodes[id]!;
  if (current.x === at.x && current.y === at.y) return { graph, splits: 0, overlaps: 0 };

  const nodes: Vector2[] = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
  nodes[id] = at;

  const pending: Pending[] = graph.edges.map((edge) => ({
    a: edge.a,
    b: edge.b,
    changed: edge.a === id || edge.b === id,
    isNew: false,
  }));

  return resolveCrossings(nodes, pending, graph.edges);
}

/**
 * Fold one vertex into another, which is what snapping a drag onto an existing vertex means.
 *
 * Every reference to `from` becomes `into`, so the two walls genuinely **share a point** rather than
 * holding equal coordinates — the distinction the whole document exists to preserve, and the one the
 * emitted fog throws away.
 *
 * A segment with both ends on the pair collapses to nothing and is dropped: it is the wall that was
 * being closed up, and keeping a segment from a node to itself would leave a wall of no length that
 * nothing draws.
 *
 * **The `from` node is left in the table, unreferenced.** Renumbering to close the gap would
 * invalidate every id the caller is holding — including, mid-gesture, the one being dragged — and ids
 * are the only stable identity this document has. An unreferenced node costs eight bytes.
 */
export function mergeNodes(graph: FrozenGraph, from: number, into: number): EditResult {
  if (from === into) return { graph, splits: 0, overlaps: 0 };
  if (from < 0 || from >= graph.nodes.length) return { graph, splits: 0, overlaps: 0 };
  if (into < 0 || into >= graph.nodes.length) return { graph, splits: 0, overlaps: 0 };

  const nodes: Vector2[] = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
  const rename = (id: number): number => (id === from ? into : id);

  const pending: Pending[] = [];
  const originals: FrozenEdge[] = [];
  for (const edge of graph.edges) {
    const a = rename(edge.a);
    const b = rename(edge.b);
    // The wall that was being closed up. Dropped rather than kept as a zero-length segment.
    if (a === b) continue;
    pending.push({ a, b, changed: edge.a === from || edge.b === from, isNew: false });
    originals.push(edge);
  }

  return resolveCrossings(nodes, pending, originals);
}

/**
 * The nearest vertex within `radius`, or `null`.
 *
 * The snapping query. It lives here so it can be tested, but **the decision is still the tool's**: it
 * passes a radius derived from screen space, so the target stays the same size under the cursor at
 * any zoom, and it is what shows the GM that a merge is about to happen. Holding the modifier means
 * simply not calling this.
 *
 * Ties go to the lower id — stable rather than meaningful. Two vertices at the same distance are
 * indistinguishable to the GM, and an arbitrary-but-repeatable answer beats one that changes between
 * frames while they hold still.
 */
export function nearestNode(
  graph: FrozenGraph,
  point: Vector2,
  radius: number,
  /** Left out of the search — the vertex being dragged must not snap to itself. */
  exclude?: number,
): number | null {
  let best: number | null = null;
  let bestDistance = radius * radius;
  for (let id = 0; id < graph.nodes.length; id++) {
    if (id === exclude) continue;
    const node = graph.nodes[id]!;
    const distance = (node.x - point.x) ** 2 + (node.y - point.y) ** 2;
    if (distance <= bestDistance && (best === null || distance < bestDistance)) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}
