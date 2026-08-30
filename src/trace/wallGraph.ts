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
 * - **Junction clusters must be welded.** Thinning leaves junction pixels one or two apart, and the
 *   stubby chains between them survive everything else: stub pruning refuses them because both ends
 *   are junctions, and collinear merging refuses them because they are not degree-2.
 * - **The cluster's own connectors are dropped before anything looks at degree**, or they inflate the
 *   node's degree and the real edges never join through it.
 *
 * **One rule of the sibling's is forbidden here rather than merely defaulted off.** It also merges
 * chains *through* junctions, pairing the straightest continuations, because a stroke drawn as one
 * line has to wobble as one line. Merging where exactly two ends meet is right for us too — such a
 * node is not a junction — but merging through a degree-3 node would destroy the incidence the faces
 * are read from.
 *
 * **Degree is the crossing number, not a raw neighbour count.** The sibling counts raw neighbours and
 * therefore has to weld before pruning, otherwise a pixel one row off a straight line reads as a
 * junction and leaves a nub. We already pay for the crossing number in spur pruning, so the order
 * here is the natural one: thin, prune, chain, weld.
 *
 * Every point is a lattice point and every step between consecutive points is to an 8-neighbour.
 * That is not incidental tidiness — the area check in `faces.ts` is an exact lattice identity and
 * needs it. Welding therefore *walks* an endpoint to its node rather than teleporting it.
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
  /** Chains found before welding. */
  readonly chains: number;
  /** Endpoints that moved onto a shared node. */
  readonly welded: number;
  /** Cluster connectors dropped — the junction clusters themselves. */
  readonly dropped: number;
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

/** How many times the ring goes background→ink: 1 at an end, 2 on a path, 3 or more at a junction. */
function crossings(data: Uint8Array, width: number, height: number, index: number): number {
  const x = index % width;
  const y = (index - x) / width;
  const ring = RING.map(([dx, dy]) => at(data, width, height, x + dx, y + dy));
  let count = 0;
  for (let i = 0; i < 8; i++) if (ring[i] === 0 && ring[(i + 1) % 8] === 1) count += 1;
  return count;
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

  const nodeAt = (index: number): boolean => crossings(data, width, height, index) !== 2;

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

  for (let index = 0; index < data.length; index++) {
    if (data[index] === 1 && consumed[index] !== 1 && !nodeAt(index)) orphans += 1;
  }

  return { chains, orphans };
}

/** Union endpoints within `radius` of each other, via a hash grid so dense linework stays linear-ish. */
function clusterEnds(
  positions: readonly Vector2[],
  radius: number,
): { of: number[]; position: Vector2[] } {
  const parent = positions.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]!]!;
      root = parent[root]!;
    }
    return root;
  };

  if (positions.length > 0) {
    const cell = Math.max(1, radius);
    const buckets = new Map<string, number[]>();
    const keyOf = (point: Vector2) => `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;

    positions.forEach((point, index) => {
      const key = keyOf(point);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    });

    positions.forEach((point, index) => {
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const other of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (other === index) continue;
            const target = positions[other]!;
            const distance = Math.hypot(point.x - target.x, point.y - target.y);
            // Coincident ends are always one node, whatever the radius. Otherwise a radius of zero
            // would leave two chains meeting at a pixel unaware of each other, and nothing would
            // count that node's degree correctly.
            if (distance === 0 || distance < radius) {
              const rootA = find(index);
              const rootB = find(other);
              if (rootA !== rootB) parent[rootA] = rootB;
            }
          }
        }
      }
    });
  }

  const of = positions.map((_, index) => find(index));

  // The node sits on the cluster member nearest its centroid, **not on the centroid itself**. A
  // centroid is generally not a lattice point, and the area check is a lattice identity.
  const totals = new Map<number, { x: number; y: number; count: number }>();
  positions.forEach((point, index) => {
    const root = of[index]!;
    const total = totals.get(root) ?? { x: 0, y: 0, count: 0 };
    total.x += point.x;
    total.y += point.y;
    total.count += 1;
    totals.set(root, total);
  });

  const best = new Map<number, { index: number; distance: number }>();
  positions.forEach((point, index) => {
    const root = of[index]!;
    const total = totals.get(root)!;
    const distance = Math.hypot(point.x - total.x / total.count, point.y - total.y / total.count);
    const current = best.get(root);
    if (!current || distance < current.distance) best.set(root, { index, distance });
  });

  const position: Vector2[] = [];
  for (const [root, choice] of best) position[root] = positions[choice.index]!;

  return { of, position };
}

/**
 * An 8-connected lattice walk from `from` to `to`, excluding `from` and including `to`.
 *
 * Used to carry a welded endpoint onto its node without leaving a step that spans intermediate
 * lattice points. Chebyshev stepping, which is the shortest such walk.
 */
function walkTo(from: Vector2, to: Vector2): Vector2[] {
  const path: Vector2[] = [];
  let { x, y } = from;
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    path.push({ x, y });
  }
  return path;
}

function chainLength(points: readonly Vector2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/**
 * Build the wall graph from a pruned skeleton.
 *
 * `weldRadius` is in raster pixels and collapses endpoints within it into one node. Zero disables
 * welding entirely, which leaves every junction cluster in place — useful in tests, wrong on a map.
 */
export function buildWallGraph(skeleton: BinaryMask, weldRadius: number): WallGraph {
  const framed = frameSkeleton(skeleton);
  const { chains, orphans } = walkChains(framed);

  const ends: Vector2[] = [];
  for (const chain of chains) {
    ends.push(chain.points[0]!);
    ends.push(chain.points[chain.points.length - 1]!);
  }

  const cluster = clusterEnds(ends, weldRadius);

  // Carry each end onto its node, keeping every step 8-adjacent.
  let welded = 0;
  const moved = chains.map((chain, index) => {
    const startNode = cluster.position[cluster.of[index * 2]!]!;
    const endNode = cluster.position[cluster.of[index * 2 + 1]!]!;
    const body = [...chain.points];

    const head = body[0]!;
    if (head.x !== startNode.x || head.y !== startNode.y) {
      welded += 1;
      body.splice(0, 1, startNode, ...walkTo(startNode, head));
    }

    const tail = body[body.length - 1]!;
    if (tail.x !== endNode.x || tail.y !== endNode.y) {
      welded += 1;
      // Appended, never spliced over the tail: dropping it would leave a two-pixel jump behind, and
      // every step has to stay 8-adjacent for the area check to hold.
      body.push(...walkTo(tail, endNode));
    }

    return body;
  });

  // Chains that begin and end inside the same welded node are the junction cluster itself, not
  // geometry. Dropped **before** anything counts degree, or they inflate it and the real edges
  // never join through the node.
  const dropped = moved.map(
    (points, index) =>
      cluster.of[index * 2] === cluster.of[index * 2 + 1] &&
      !chains[index]!.closed &&
      chainLength(points) <= Math.max(weldRadius, 1),
  );

  const merged = mergeThroughPathNodes(moved, cluster.of, dropped);

  // Rebuild the node table from the endpoints that survived.
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
    stats: {
      chains: chains.length,
      welded,
      dropped: dropped.filter(Boolean).length,
      merged: merged.merged,
      orphans,
    },
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
