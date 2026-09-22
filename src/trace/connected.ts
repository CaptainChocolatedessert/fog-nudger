/**
 * Everything joined to one wall: the set *Erase chain* takes.
 *
 * ## What "joined" means, and what it does not
 *
 * Two walls are joined when they **share a vertex id**. That is the document's standing identity
 * rule, and it is the whole definition here — no proximity, no tolerance. Two ends that merely sit at
 * the same coordinates without sharing a node are two separate sets, and the red preview is where a
 * GM sees that: half the thing lights up, and the half that did not was never attached.
 *
 * **It is not a chain in the narrow sense**, and the tool's name is the GM's word rather than this
 * one. The set branches at junctions and includes loops; a run through degree-2 vertices is what the
 * record calls a *wall*, and that is a different and much smaller thing.
 *
 * ## The set is usually the whole map, and that is the point of the preview
 *
 * A dungeon's walls are one enormous connected component — every room shares walls with a corridor,
 * and with the map's edge walled everything reaching the edge joins the frame too. So a press on the
 * main linework takes all of it. The tool is for the other case: a stranded thing inside a room,
 * which is tedious to erase a segment at a time and is detached, or can be detached with one erase.
 * Nothing here decides which case a GM is in; the preview draws the set in the destructive colour and
 * the GM looks.
 *
 * Pure: no DOM, no SDK.
 */

import type { WallGraph } from "./wallGraph";

/**
 * The indices of every wall reachable from `from`, including it.
 *
 * Empty when the index names no wall, which is the same answer as "nothing to remove" and is what a
 * press outside the search radius already means.
 *
 * **Breadth-first over an adjacency built once**, O(V + E) in the graph rather than in the component,
 * because the adjacency has to be built before the first step can be taken. A real map's graph is a
 * few thousand walls and this runs on a hover, so it is timed rather than assumed — `connected.test.ts`
 * carries the measurement.
 */
export function connectedEdges(graph: WallGraph, from: number): number[] {
  if (from < 0 || from >= graph.edges.length) return [];

  // Vertex id to the walls that use it. A flat array of arrays, built in one pass.
  const atNode: number[][] = Array.from({ length: graph.nodes.length }, () => []);
  for (let index = 0; index < graph.edges.length; index++) {
    const edge = graph.edges[index]!;
    if (edge.a >= 0 && edge.a < atNode.length) atNode[edge.a]!.push(index);
    if (edge.b >= 0 && edge.b < atNode.length) atNode[edge.b]!.push(index);
  }

  const seen = new Uint8Array(graph.edges.length);
  const found: number[] = [from];
  seen[from] = 1;
  // The queue is the answer itself, walked with a moving head — one allocation rather than two, and
  // the order it comes out in is the order it was reached, which nothing downstream depends on.
  for (let head = 0; head < found.length; head++) {
    const edge = graph.edges[found[head]!]!;
    for (const end of [edge.a, edge.b]) {
      if (end < 0 || end >= atNode.length) continue;
      for (const neighbour of atNode[end]!) {
        if (seen[neighbour] === 1) continue;
        seen[neighbour] = 1;
        found.push(neighbour);
      }
    }
  }
  return found;
}
