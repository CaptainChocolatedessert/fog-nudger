/**
 * The dead ends a limit would prune, grouped into the pieces a GM can take one at a time.
 *
 * ## Why pieces, and why the cascade runs first — user, 2026-09-22
 *
 * *Prune the dead ends* rings what it would take and takes one ring per click, as Mend and *Collapse
 * small regions* do. **The whole cascade runs before the rings are placed** (user: *"so the rings and
 * the red marks agree with what will actually happen"*): taking a stub can leave the arm it hung from
 * a dead end too, and a ring drawn only round today's dead ends would be a promise about less than the
 * button takes.
 *
 * **One ring per piece, not per run**, and the shape of a cascade is what makes that possible. Every
 * connected lump of doomed runs is a **tree hanging off exactly one vertex that stays** — or off none,
 * when the whole lump goes. It cannot hang off two: a doomed run on a path between two walls that stay
 * would never become a dead end at any round. So a single hair is a piece, a star of short strokes is a
 * piece, and taking a piece whole never leaves anything floating. A ring per run would put a ring on a
 * star's middle arm whose click could not take that arm alone without stranding the strokes beyond it.
 *
 * **Two pieces hanging off the same vertex are two pieces.** They are grouped through the vertices that
 * go and never through the one that stays, so each click takes one hair and not every hair at a junction.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { removeEdges, type EditResult } from "./planarOps";
import { spurEdgesToPrune, type WallGraph } from "./wallGraph";

export interface PrunePiece {
  /** The walls that go, as ascending indices into `graph.edges`. */
  readonly edges: readonly number[];
  /** The vertex it hangs off, which stays — or `null` for a piece that goes entirely. */
  readonly anchor: number | null;
  /** Every point of it, the vertex it hangs off included, for the ring to enclose. Graph units. */
  readonly points: readonly Vector2[];
  /** Its length along the walls, in graph units. */
  readonly length: number;
}

/**
 * The pieces `limit` would prune, longest first — so a click where rings overlap, which takes the
 * nearest centre, is not decided by list order anyway, and the log can say how big the largest is.
 */
export function findPrunePieces(graph: WallGraph, limit: number): PrunePiece[] {
  const doomed = spurEdgesToPrune(graph, limit);
  if (doomed.edges.size === 0) return [];

  // Group doomed walls through the vertices that go. A vertex that stays — an anchor — joins nothing.
  const indices = [...doomed.edges];
  const parent = new Map<number, number>(indices.map((index) => [index, index]));
  const find = (index: number): number => {
    let root = index;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let at = index;
    while (parent.get(at) !== root) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const firstAt = new Map<number, number>();
  for (const index of indices) {
    const edge = graph.edges[index]!;
    for (const id of [edge.a, edge.b]) {
      if (doomed.anchors.has(id)) continue;
      const seen = firstAt.get(id);
      if (seen === undefined) firstAt.set(id, index);
      else parent.set(find(index), find(seen));
    }
  }

  const groups = new Map<number, number[]>();
  for (const index of indices) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }

  const pieces: PrunePiece[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left - right);
    let anchor: number | null = null;
    let length = 0;
    const ids = new Set<number>();
    for (const index of group) {
      const edge = graph.edges[index]!;
      const a = graph.nodes[edge.a]!;
      const b = graph.nodes[edge.b]!;
      length += Math.hypot(b.x - a.x, b.y - a.y);
      for (const id of [edge.a, edge.b]) {
        ids.add(id);
        if (doomed.anchors.has(id)) anchor = id;
      }
    }
    pieces.push({ edges: group, anchor, points: [...ids].map((id) => graph.nodes[id]!), length });
  }
  return pieces.sort((left, right) => right.length - left.length || left.edges[0]! - right.edges[0]!);
}

/**
 * Take some pieces off the graph — one for a click, all of them for the button.
 *
 * Deleting only, so no crossing sweep: nothing removed can make two walls cross. The vertices left with
 * no walls are compacted away by the caller after the gesture, as every wall edit's are.
 */
export function applyPrunePieces(graph: WallGraph, pieces: readonly PrunePiece[]): EditResult {
  const going = new Set<number>();
  for (const piece of pieces) for (const edge of piece.edges) going.add(edge);
  return removeEdges(graph, going);
}
