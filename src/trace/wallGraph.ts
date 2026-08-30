/**
 * The wall graph — a pruned skeleton turned into nodes and edges.
 *
 * This is the document the rest of the pipeline renders (DESIGN.md §4). Faces come from walking
 * this graph, not from rasterising it: a raster route would produce the emitted geometry twice, in
 * two copies that disagree, and the read-back scheme requires a room and the stub wall meeting it to
 * share a vertex exactly.
 *
 * Adapted from the sibling project's `trace/skeleton.ts`, which in turn adapted the author's own
 * `VTT_Maps`. Three rules come straight from there, each because the obvious version is wrong:
 *
 * - **Chains run node to node**, a node being any pixel whose degree is not 2. Interior pixels are
 *   marked as consumed so a chain is not traced again from its far end; node pixels are never marked,
 *   because several chains legitimately share one.
 * - **Junction clusters have to be dealt with somehow.** Thinning leaves junction pixels one or two
 *   apart, and the stubby chains between them survive everything else: stub pruning refuses them
 *   because both ends are junctions, and collinear merging refuses them because they are not
 *   degree-2. The sibling welds nearby endpoints together. **We cannot** — see `buildWallGraph`.
 *
 * **One rule of the sibling's is forbidden here rather than merely defaulted off.** It also merges
 * chains *through* junctions, pairing the straightest continuations, because a stroke drawn as one
 * line has to wobble as one line. Merging where exactly two ends meet is right for us too — such a
 * node is not a junction — but merging through a degree-3 node would destroy the incidence the faces
 * are read from.
 *
 * **Degree here is a raw neighbour count, and spur pruning's is the crossing number.** They are
 * different measures for different jobs and the difference is load-bearing both ways. Pruning walks
 * branches and must not stop early, so it counts contiguous runs — counting raw leaves a nub on the
 * wall at every pruned spur. Chain walking must not lose a pixel, so it counts neighbours — counting
 * runs lets the walk pass straight through a four-neighbour pixel and strand whichever branch it did
 * not take.
 *
 * Every point is a lattice point and every step between consecutive points is to an 8-neighbour.
 * That is not incidental tidiness — the area check in `faces.ts` is an exact lattice identity and
 * needs it, and it is the second of the two reasons nothing here may ever move a point.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";
import type { BinaryMask } from "./binarize";

export interface WallNode {
  readonly x: number;
  readonly y: number;
}

export interface WallEdge {
  /** Node indices. Equal when the edge is a closed loop. */
  readonly a: number;
  readonly b: number;
  /**
   * Lattice points from node `a` to node `b` inclusive. Consecutive points are always 8-adjacent,
   * so the number of steps is `points.length - 1` and no lattice point lies between two of them.
   */
  readonly points: readonly Vector2[];
}

export interface WallGraph {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly WallNode[];
  readonly edges: readonly WallEdge[];
  /** The skeleton the graph was built from, with the border frame painted in. */
  readonly framed: BinaryMask;
  readonly stats: WallGraphStats;
}

export interface WallGraphStats {
  /** Chains found, before the degree-2 joins. */
  readonly chains: number;
  /** Degree-2 nodes smoothed away by joining the two chains that met there. */
  readonly merged: number;
  /**
   * Skeleton pixels no chain claimed.
   *
   * Should be zero. A non-zero count means the chain walk stepped over a pixel — the staircase case
   * the orthogonal-first rule exists to prevent — and is reported rather than thrown because losing
   * a pixel degrades the graph without invalidating it.
   */
  readonly orphans: number;
}

/** Clockwise from north, so a walk round the ring is contiguous. Crossing numbers depend on it. */
const RING: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function at(data: Uint8Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return data[y * width + x] ?? 0;
}

/**
 * Paint the raster border into the skeleton.
 *
 * Without it the graph's outer face is unbounded and has no polygon, so the map's exterior could not
 * be produced at all — and §4 decided to emit the exterior rather than work out which region it is.
 * With the frame, the exterior is an ordinary bounded face whose outer ring is the frame and whose
 * holes are the buildings, which is what the labelling already gives.
 */
export function frameSkeleton(skeleton: BinaryMask): BinaryMask {
  const { width, height } = skeleton;
  const data = new Uint8Array(skeleton.data);
  if (width === 0 || height === 0) return { width, height, data };

  for (let x = 0; x < width; x++) {
    data[x] = 1;
    data[(height - 1) * width + x] = 1;
  }
  for (let y = 0; y < height; y++) {
    data[y * width] = 1;
    data[y * width + width - 1] = 1;
  }

  /*
    Isolated single pixels are erased here, and it is the area check that asks for it.

    A pixel with no neighbours is a component with no edges: it contributes no cycle, so it ends up
    neither inside a face nor on any boundary, and the identity comes up one interior point short.
    Erasing it makes it ordinary space, which is what a speck of skeleton is. The island filter
    normally removes these upstream; this is the backstop, not the policy.
  */
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] !== 1) continue;
      let neighbours = 0;
      for (const [dx, dy] of RING) neighbours += at(data, width, height, x + dx, y + dy);
      if (neighbours === 0) data[y * width + x] = 0;
    }
  }

  return { width, height, data };
}

interface Chain {
  readonly points: Vector2[];
  readonly closed: boolean;
}

/**
 * Walk the skeleton into chains running node to node.
 *
 * The next step out of a path pixel prefers an **orthogonal** neighbour over a diagonal one. On a
 * staircase, a pixel's two forward neighbours are themselves adjacent, and taking the diagonal first
 * steps straight over the near one and orphans it.
 */
function walkChains(mask: BinaryMask): { chains: Chain[]; orphans: number } {
  const { width, height, data } = mask;
  const consumed = new Uint8Array(width * height);
  const chains: Chain[] = [];

  /*
    A node is any pixel without exactly two neighbours, counted **raw**.

    Not the crossing number, and that was a bug first. The crossing number counts contiguous *runs*
    of ink around the ring, so a pixel with four neighbours in two runs reads as an ordinary path
    pixel — and the walk then passes straight through it, consuming it, and whichever branch was not
    taken is stranded. On one random fixture that silently dropped a free end from the graph, and the
    area check caught it as a face short by one interior point.

    The cost of counting raw is spurious nodes where three mutually-adjacent pixels form a triangle.
    Those are real faces of half a pixel, and they are removed downstream with every other sub-pixel
    sliver. Spur pruning still uses the crossing number, where it is the right measure and where
    getting it wrong left a nub on every pruned wall.
  */
  const nodeAt = (index: number): boolean => neighbours(index).length !== 2;

  const neighbours = (index: number): number[] => {
    const x = index % width;
    const y = (index - x) / width;
    const found: number[] = [];
    for (const [dx, dy] of RING) {
      if (at(data, width, height, x + dx, y + dy) === 1) found.push((y + dy) * width + (x + dx));
    }
    return found;
  };

  const point = (index: number): Vector2 => {
    const x = index % width;
    return { x, y: (index - x) / width };
  };

  const step = (from: number, to: number): number => {
    const ax = from % width;
    const bx = to % width;
    return ax === bx || (from - ax) / width === (to - bx) / width ? 1 : 2;
  };

  /** Follow a chain from a node into one of its neighbours, stopping at the next node. */
  const follow = (start: number, into: number): number[] => {
    const path = [start, into];
    let previous = start;
    let current = into;

    while (!nodeAt(current)) {
      consumed[current] = 1;
      const options = neighbours(current).filter(
        (candidate) => candidate !== previous && consumed[candidate] !== 1,
      );
      if (options.length === 0) break;
      // Orthogonal first; among equals, whichever the ring order found.
      options.sort((left, right) => step(current, left) - step(current, right));
      const next = options[0]!;
      path.push(next);
      previous = current;
      current = next;
    }

    return path;
  };

  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 1 || !nodeAt(index)) continue;

    for (const neighbour of neighbours(index)) {
      if (consumed[neighbour] === 1) continue;

      if (nodeAt(neighbour)) {
        // Two nodes touching directly. Emitted once, by index, so the pass over the other end
        // does not repeat it. A node is never marked consumed — several chains share one.
        if (index < neighbour) {
          chains.push({ points: [point(index), point(neighbour)], closed: false });
        }
        continue;
      }

      const path = follow(index, neighbour);
      chains.push({ points: path.map(point), closed: false });
    }
  }

  // Anything left is a loop with no node on it at all — every pixel of degree 2.
  let orphans = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 1 || consumed[index] === 1 || nodeAt(index)) continue;

    const path = [index];
    consumed[index] = 1;
    let current = index;

    for (;;) {
      const options = neighbours(current).filter((candidate) => consumed[candidate] !== 1);
      if (options.length === 0) break;
      options.sort((left, right) => step(current, left) - step(current, right));
      const next = options[0]!;
      consumed[next] = 1;
      path.push(next);
      current = next;
    }

    if (path.length >= 3) {
      // Closed by repeating the first point, so the chain reads like every other one: first and
      // last are the same node.
      chains.push({ points: [...path.map(point), point(path[0]!)], closed: true });
    } else {
      orphans += path.length;
    }
  }

  // Every skeleton pixel must have reached a chain, **node pixels included**. Counting only
  // non-nodes was the blind spot that let a stranded free end go unreported.
  const claimed = new Set<number>();
  for (const chain of chains) {
    for (const point of chain.points) claimed.add(point.y * width + point.x);
  }
  for (let index = 0; index < data.length; index++) {
    if (data[index] === 1 && !claimed.has(index)) orphans += 1;
  }

  return { chains, orphans };
}

/**
 * Build the wall graph from a pruned skeleton.
 *
 * **Nothing here moves a point**, and that is a hard requirement rather than a preference. An earlier
 * version welded chain ends within a radius onto a shared node, walking the moved end there along a
 * straight lattice path. That is the sibling's approach and it is safe when the output is polylines.
 * It is not safe when the output is *faces*: an invented path can cross other linework, and once the
 * embedding is no longer planar a half-edge traversal means nothing at all. Measured over random
 * linework, the 3px default failed the area check on **76% of cases**, against 3.5% with no welding.
 *
 * What welding was for — the junction cluster thinning leaves — is dealt with after the faces are
 * walked instead, by deleting the sub-pixel faces such a cluster produces. Deleting an edge is a
 * purely combinatorial edit and cannot cross anything. See `removeEdges` and `graphRegions.ts`.
 */
export function buildWallGraph(skeleton: BinaryMask): WallGraph {
  const framed = frameSkeleton(skeleton);
  const { chains, orphans } = walkChains(framed);
  return assembleGraph(
    chains.map((chain) => chain.points),
    framed,
    { chains: chains.length, orphans },
  );
}

/**
 * A copy of the graph with some edges gone, rejoined wherever that leaves a node with two ends.
 *
 * Deleting an edge is the one repair available here that cannot break planarity: it merges two faces
 * and moves nothing. Used on the sub-pixel slivers a junction cluster leaves, which hold no space at
 * all, so the face each is merged into keeps exactly the pixels it already had.
 */
export function removeEdges(graph: WallGraph, dropped: ReadonlySet<number>): WallGraph {
  const kept = graph.edges
    .filter((_, index) => !dropped.has(index))
    .map((edge) => [...edge.points]);
  return assembleGraph(kept, graph.framed, {
    chains: graph.stats.chains,
    orphans: graph.stats.orphans,
  });
}

/** Nodes by exact position, then the degree-2 join, then the tables. Shared by both entry points. */
function assembleGraph(
  chains: Vector2[][],
  framed: BinaryMask,
  carried: { chains: number; orphans: number },
): WallGraph {
  // Two ends are the same node when they are the same pixel. Nothing approximate about it: a node is
  // a skeleton pixel, and two chains either meet there or they do not.
  const nodeOf = new Map<string, number>();
  const clusterOf: number[] = [];
  for (const chain of chains) {
    for (const end of [chain[0]!, chain[chain.length - 1]!]) {
      const key = `${end.x},${end.y}`;
      let id = nodeOf.get(key);
      if (id === undefined) {
        id = nodeOf.size;
        nodeOf.set(key, id);
      }
      clusterOf.push(id);
    }
  }

  const merged = mergeThroughPathNodes(
    chains,
    clusterOf,
    chains.map(() => false),
  );

  const nodeIndex = new Map<string, number>();
  const nodes: WallNode[] = [];
  const idFor = (point: Vector2): number => {
    const key = `${point.x},${point.y}`;
    const found = nodeIndex.get(key);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push({ x: point.x, y: point.y });
    nodeIndex.set(key, id);
    return id;
  };

  const edges: WallEdge[] = merged.edges.map((points) => ({
    a: idFor(points[0]!),
    b: idFor(points[points.length - 1]!),
    points,
  }));

  return {
    width: framed.width,
    height: framed.height,
    nodes,
    edges,
    framed,
    stats: { chains: carried.chains, merged: merged.merged, orphans: carried.orphans },
  };
}

/**
 * Join chains at nodes where exactly two ends meet.
 *
 * Such a node is not a junction, so the two chains are one edge and smoothing it away changes no
 * face. This is where the sibling would go further and pair the straightest continuations through a
 * *junction* as well; here that is forbidden, because merging two edges through a degree-3 node
 * destroys the incidence the faces are read from.
 */
function mergeThroughPathNodes(
  chains: readonly (readonly Vector2[])[],
  clusterOf: readonly number[],
  dropped: readonly boolean[],
): { edges: Vector2[][]; merged: number } {
  const atNode = new Map<number, number[]>();
  chains.forEach((_, edge) => {
    if (dropped[edge]) return;
    for (const end of [0, 1] as const) {
      const flat = edge * 2 + end;
      const key = clusterOf[flat]!;
      const list = atNode.get(key);
      if (list) list.push(flat);
      else atNode.set(key, [flat]);
    }
  });

  const partner = new Map<number, number>();
  let merged = 0;
  for (const ends of atNode.values()) {
    if (ends.length !== 2) continue;
    const [first, second] = ends as [number, number];
    // Both ends of one chain meeting at a node is a closed loop, not a join.
    if (first >> 1 === second >> 1) continue;
    partner.set(first, second);
    partner.set(second, first);
    merged += 1;
  }

  const used = new Uint8Array(chains.length);
  dropped.forEach((skip, edge) => {
    if (skip) used[edge] = 1;
  });
  const edges: Vector2[][] = [];

  const run = (startEdge: number, startEnd: 0 | 1): Vector2[] => {
    const out: Vector2[] = [];
    let edge = startEdge;
    let entry: 0 | 1 = startEnd;

    for (;;) {
      used[edge] = 1;
      const chain = chains[edge]!;
      const piece = entry === 0 ? [...chain] : [...chain].reverse();
      // The shared node is one point, however many chains meet at it.
      out.push(...(out.length === 0 ? piece : piece.slice(1)));

      const exit = (entry === 0 ? 1 : 0) as 0 | 1;
      const next = partner.get(edge * 2 + exit);
      if (next === undefined) break;
      const nextEdge = next >> 1;
      if (used[nextEdge] === 1) break;
      edge = nextEdge;
      entry = (next & 1) as 0 | 1;
    }

    return out;
  };

  // Free ends first, so a run is entered at its end rather than in the middle.
  for (let edge = 0; edge < chains.length; edge++) {
    for (const end of [0, 1] as const) {
      if (used[edge] === 1) continue;
      if (partner.has(edge * 2 + end)) continue;
      edges.push(run(edge, end));
    }
  }
  for (let edge = 0; edge < chains.length; edge++) {
    if (used[edge] === 1) continue;
    edges.push(run(edge, 0));
  }

  return { edges: edges.filter((points) => points.length >= 2), merged };
}
