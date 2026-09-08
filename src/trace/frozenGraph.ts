/**
 * The document: the fitted wall graph, as it is stored and as it comes back.
 *
 * Step G freezes here. Stage one is the map — tune the reading, edit pixels, generate the graph.
 * Stage two is *this*, and it never re-derives, which is what makes editing possible at all: nothing
 * is renumbered behind the GM's back, so a moved vertex is just a stored coordinate rather than a
 * thing that has to be found again in a freshly derived graph.
 *
 * ## Coordinates are FRACTIONS OF THE MAP, not raster pixels
 *
 * Changed 2026-09-03 (user), and the reason is a trap this project has already written down once.
 * `rasterPlan.ts` records that *the sibling's real trap was denominating its parameters in raster
 * pixels, which made the raster load-bearing forever* — and the raster here is an artefact of our own
 * memory budget, not of the map. A 52.9-megapixel map caps to half size for reasons that have
 * nothing to do with its content. Storing the GM's **work** in that space is the same trap one level
 * worse, because a parameter can be re-tuned and their editing cannot.
 *
 * So a node is `{ x, y }` in 0–1 of the map's own extent. That is independent of the megapixel cap,
 * independent of the source image's pixel dimensions, and converts to world at emit time from the
 * map's *current* bounds — so moving or scaling the map in Owlbear carries the fog with it, which
 * absolute world coordinates would not. The point probe already speaks in fractions of the map for
 * the same reason.
 *
 * **Stored as float32, and quantised to float32 on the way in.** `Math.fround` at every point a
 * coordinate enters the document means storing and reloading is *exact* rather than nearly so, which
 * is what lets the round-trip test assert equality instead of a tolerance. The precision is about
 * one ten-millionth of the map — a thousandth of a pixel on any map this will ever see.
 *
 * ## Nodes and SEGMENTS, not polylines
 *
 * Also 2026-09-03 (user). An edge is two node ids and nothing else, so **every vertex is a node**.
 *
 * The previous shape stored a wall as a polyline, which meant the face traversal needed the
 * invariant "a junction is always an edge endpoint" — and that invariant is violable. A wall meeting
 * another head-on at one of its middle vertices makes a junction at a point that is structurally an
 * interior point, and the walk goes straight through it without turning. That was found by mutation
 * testing and fixed by a normalisation pass; this makes it **impossible** instead, which is the
 * better of the two by this project's own standard.
 *
 * Junction-ness is then purely derived: degree 1 is a free end, 2 is a bend, 3+ is a junction. A
 * *wall* — the thing a GM thinks they are editing and the thing that emits as a run of lines — is
 * recovered by `wallRuns`, chaining through the degree-2 nodes.
 *
 * The cost is storage: a run of k segments is 2k ids rather than k+1. About twice, which on the test
 * map is tens of kilobytes against a 512KB ceiling.
 *
 * ## Refusing rather than throwing, and all-or-nothing
 *
 * `decodeFrozenGraph` returns `null` for anything it cannot read, and never throws. Metadata arrives
 * from another client, an older version of this extension, or a hand edit.
 *
 * Unlike `normaliseSettings` it does **not** degrade field by field, and that difference is
 * deliberate. Settings are independent — a bad blur can take its default while the other eleven
 * survive. A graph is not: an edge referencing a node that does not exist has no sensible fallback,
 * and a graph with an edge quietly dropped is a *corrupt document presented as a valid one*, which
 * is this project's worst failure shape. So it is a complete graph or `null`, and `null` is a
 * legitimate state — it is what a scene looks like before anything was ever frozen.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { FittedEdge } from "./faces";
import { dropCollinear } from "./simplify";
import { spursToPrune, type PrunableRun } from "./spurs";
import type { WallGraph } from "./wallGraph";

export interface FrozenGraph {
  /** Every vertex, in 0–1 of the map's extent. Position in this list is the id. */
  readonly nodes: readonly Vector2[];
  /** One segment each. A wall is a run of these, chained through degree-2 nodes. */
  readonly edges: readonly FrozenEdge[];
}

export interface FrozenEdge {
  readonly a: number;
  readonly b: number;
}

/** What freezing produced, and what it had to throw away to produce it. */
export interface Frozen {
  readonly graph: FrozenGraph;
  /**
   * Segments dropped for lying exactly on one already stored.
   *
   * **Each one is a room the map has and the document does not**, so the count is reported rather
   * than swallowed. Found in a room on 2026-09-05: the traversal said its arithmetic check had
   * failed, and the numbers were off by exactly what one doubled wall produces — 34 faces where the
   * trace had found 35.
   *
   * The cause is simplification, not the graph. Two walls bounding a room thinner than the smoothing
   * tolerance both fit to the *same* straight line between the same two corners, so the room closes
   * up. Stage one has a guard for this at the ring — it keeps the unfitted ring when fitting would
   * collapse it, and says so in the log — and the freeze stores fitted edges with no equivalent.
   *
   * **Dropping is the GM's decision** (user, 2026-09-05), taken over restoring the unfitted chain
   * for one of the pair. What it costs is stated rather than argued away: the thin room is gone from
   * the document and will not be emitted. What it buys is an embedding a traversal can mean
   * something over, since two coincident segments enclose nothing and make Euler's identity fail.
   */
  readonly duplicates: number;
  /** Segments whose ends quantised onto the same point. Same family, same treatment. */
  readonly zeroLength: number;
  /**
   * Points dropped for lying exactly on the line between their neighbours.
   *
   * **Nothing is lost by these**, which is what separates the count from the two above: every
   * remaining point is where it was and the shape is identical. It is reported because it is the
   * difference between a document a scene can hold and one it cannot — each point dropped is a
   * segment fewer, and each segment is its own `LINE` item when no room's boundary covers it.
   */
  readonly collinear: number;
}

/**
 * Bumped whenever the byte layout changes.
 *
 * Durable data in someone's scene, so a format change has to be *detectable*. A version that does
 * not match is refused, which costs the GM their stored graph once; reading old bytes under new
 * rules would cost them a graph that is subtly wrong and says nothing.
 *
 * Version 1 was a lattice walk of the pixel-chain graph; version 2 was polylines in raster pixels.
 * Neither was ever deployed or written to a scene, so nothing needs migrating from them.
 */
const FORMAT_VERSION = 3;

/**
 * A coordinate as the document holds it.
 *
 * `Math.fround` because the store writes float32: quantising on the way *in* is what makes the round
 * trip exact rather than nearly exact, so nothing downstream has to carry a tolerance for storage
 * having changed a number slightly.
 */
export function documentCoordinate(value: number): number {
  return Math.fround(value);
}

/** A point in map fractions, quantised the way the document holds them. */
export function documentPoint(x: number, y: number): Vector2 {
  return { x: documentCoordinate(x), y: documentCoordinate(y) };
}

/**
 * Build the document from a derivation.
 *
 * `fitted` is positionally aligned with `graph.edges`, and each fitted polyline runs from that edge's
 * first node to its second — `simplifyPolyline` keeps both ends, which is what makes the endpoints
 * reusable rather than approximated. So the shared points are exactly the derived graph's own nodes,
 * and each fitted polyline becomes a run of segments between them.
 *
 * Raster pixels go in and map fractions come out; `graph.width`/`height` are the raster that gives
 * the division, and are not stored, because the whole point is that the document does not know what
 * raster it came from.
 */
export function freezeGraph(graph: WallGraph, fitted: readonly FittedEdge[]): Frozen {
  const width = Math.max(1, graph.width);
  const height = Math.max(1, graph.height);
  const nodes: Vector2[] = graph.nodes.map((node) =>
    documentPoint(node.x / width, node.y / height),
  );
  const edges: FrozenEdge[] = [];

  /*
    Every pair of vertices a segment has already been stored between.

    Unordered, because a wall from A to B and one from B to A are the same wall drawn twice. Held as
    a string rather than an arithmetic key because the node table grows while this runs, so there is
    no bound to multiply by that is still true at the end.
  */
  const stored = new Set<string>();
  let duplicates = 0;
  let zeroLength = 0;

  const keep = (a: number, b: number): void => {
    if (a === b) {
      zeroLength += 1;
      return;
    }
    const from = nodes[a]!;
    const to = nodes[b]!;
    // Two distinct ids can quantise onto one point on a large map, and a segment between them has
    // no direction — nothing can sort it into a rotation, so the traversal cannot use it.
    if (from.x === to.x && from.y === to.y) {
      zeroLength += 1;
      return;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (stored.has(key)) {
      duplicates += 1;
      return;
    }
    stored.add(key);
    edges.push({ a, b });
  };

  let collinear = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i]!;
    const fittedPoints = fitted[i]?.points ?? edge.points;
    /*
      The lossless pass, and it happens **here** rather than inside the fitter for two reasons.

      The freeze is where the document is built, so this is the last moment before anything a GM sees
      — Walls draws the frozen graph — and before the emit path turns each remaining segment into its
      own `LINE` item. Every point dropped here is one scene item fewer.

      And the fitter must be left alone: the randomised sweep runs the derivation at a tolerance of
      zero precisely to get *unfitted* rings, and asserts that every step of one is to an 8-neighbour
      — a walk along the skeleton cannot teleport, which is the assertion that caught the lollipop.
      Collapsing a straight run inside `simplifyPolyline` would break that for a reason that has
      nothing to do with what it guards.
    */
    const points = dropCollinear(fittedPoints);
    collinear += fittedPoints.length - points.length;
    // The two ends are the derived graph's own nodes, reused by id. Everything between them is new.
    let previous = edge.a;
    for (let p = 1; p < points.length - 1; p++) {
      const id = nodes.length;
      nodes.push(documentPoint(points[p]!.x / width, points[p]!.y / height));
      keep(previous, id);
      previous = id;
    }
    keep(previous, edge.b);
  }

  return { graph: { nodes, edges }, duplicates, zeroLength, collinear };
}

/**
 * How many edges meet at each node — 1 a free end, 2 a bend, 3+ a junction.
 *
 * Derived rather than stored, because a stored flag can disagree with the edges and this cannot. A
 * self-loop counts twice, which is right: it arrives and leaves.
 */
export function nodeDegrees(graph: FrozenGraph): number[] {
  const degrees = new Array<number>(graph.nodes.length).fill(0);
  for (const edge of graph.edges) {
    degrees[edge.a] = (degrees[edge.a] ?? 0) + 1;
    degrees[edge.b] = (degrees[edge.b] ?? 0) + 1;
  }
  return degrees;
}

/**
 * Drop the vertices no wall uses, renumbering what is left.
 *
 * **Erasing and merging both leave vertices behind**, because ids are the only stable identity this
 * document has and renumbering mid-gesture would invalidate every one a caller is holding —
 * including, in a drag, the one being carried. That rule has not changed. What this adds is a
 * *separate* operation to run at a moment when nothing is in hand, so the junk does not accumulate
 * in a stored document for the life of a map (user, 2026-09-05).
 *
 * **The caller must hold no ids across it**, and the way to satisfy that is not to translate them
 * but to stop holding them: the wall tools compact only after a gesture has ended and its state is
 * cleared, then re-ask what is under the pointer. That is also more correct than remapping, since
 * the graph has just changed and what is under the cursor may genuinely be something else.
 *
 * O(V + E) and allocation-bound. **Measured 2026-09-05**: 0.05ms at 430 vertices, **0.31ms at
 * 9,900**, and 1.06ms at 44,000 — against a scene write of about 1,200ms, which is what it happens
 * beside. Speed was never the objection to renumbering; holding ids across it was.
 */
export function compactNodes(graph: FrozenGraph): FrozenGraph {
  const used = new Uint8Array(graph.nodes.length);
  for (const edge of graph.edges) {
    if (edge.a >= 0 && edge.a < used.length) used[edge.a] = 1;
    if (edge.b >= 0 && edge.b < used.length) used[edge.b] = 1;
  }

  const renumbered = new Int32Array(graph.nodes.length).fill(-1);
  const nodes: Vector2[] = [];
  for (let id = 0; id < graph.nodes.length; id++) {
    if (used[id] !== 1) continue;
    renumbered[id] = nodes.length;
    nodes.push(graph.nodes[id]!);
  }
  // Nothing to drop, so nothing to rebuild: returning the same object lets a caller skip a write.
  if (nodes.length === graph.nodes.length) return graph;

  const edges: FrozenEdge[] = [];
  for (const edge of graph.edges) {
    const a = renumbered[edge.a] ?? -1;
    const b = renumbered[edge.b] ?? -1;
    // An edge naming a vertex outside the table is not one this can renumber, and dropping it
    // quietly would lose linework. It cannot arise from a decoded document, which range-checks.
    if (a < 0 || b < 0) continue;
    edges.push({ a, b });
  }
  return { nodes, edges };
}

/**
 * The walls: runs of segments chained through their degree-2 nodes.
 *
 * This is what the polyline used to be, recovered rather than stored — the thing a GM points at and
 * the thing that emits as a run of `LINE` items. Each run is a list of node ids, ends first.
 *
 * A run starts at every node that is *not* degree 2, because that is where a wall genuinely begins.
 * Anything left over after those is a closed loop with no junction anywhere on it, and is walked from
 * an arbitrary point on it — which is the same thing the derived graph does with such a chain.
 */
export function wallRuns(graph: FrozenGraph): number[][] {
  return walkRuns(graph).map((run) => run.nodes);
}

/**
 * The same runs, as edge indices.
 *
 * Pruning needs these and the node ids both — the ids to decide which runs have a free end, the
 * edges to take out of the graph. Recovering the edges from consecutive node pairs afterwards is not
 * safe: two distinct segments can join the same pair of vertices, which is a legal state to pass
 * through in the editor, and the lookup would have to guess between them.
 */
export function wallRunEdges(graph: FrozenGraph): number[][] {
  return walkRuns(graph).map((run) => run.edges);
}

interface TracedRun {
  /** Node ids, ends first and last. Equal at both ends when the run is a closed loop. */
  readonly nodes: number[];
  /** The segments between them, in the same order. */
  readonly edges: number[];
}

function walkRuns(graph: FrozenGraph): TracedRun[] {
  const neighbours = new Map<number, { edge: number; to: number }[]>();
  for (let i = 0; i < graph.edges.length; i++) {
    const { a, b } = graph.edges[i]!;
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push({ edge: i, to: b });
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push({ edge: i, to: a });
  }

  const degrees = nodeDegrees(graph);
  const used = new Uint8Array(graph.edges.length);
  const runs: TracedRun[] = [];

  const walk = (from: number, first: { edge: number; to: number }): void => {
    const nodes = [from];
    const edges: number[] = [];
    let step: { edge: number; to: number } | undefined = first;
    let at = from;
    while (step && !used[step.edge]) {
      used[step.edge] = 1;
      nodes.push(step.to);
      edges.push(step.edge);
      at = step.to;
      if (degrees[at] !== 2) break;
      step = neighbours.get(at)?.find((n) => !used[n.edge]);
    }
    if (nodes.length > 1) runs.push({ nodes, edges });
  };

  for (let id = 0; id < graph.nodes.length; id++) {
    if (degrees[id] === 2) continue;
    for (const step of neighbours.get(id) ?? []) {
      if (!used[step.edge]) walk(id, step);
    }
  }
  // Whatever is left is a loop of degree-2 nodes with no end to start from.
  for (let i = 0; i < graph.edges.length; i++) {
    if (!used[i]) walk(graph.edges[i]!.a, { edge: i, to: graph.edges[i]!.b });
  }
  return runs;
}

/** What pruning removed, in the document's own units. */
export interface FrozenPruning {
  readonly graph: FrozenGraph;
  /** Wall runs removed, over all rounds. */
  readonly removed: number;
  /** Segments those runs held — what the document actually loses. */
  readonly segments: number;
  /** Total length removed, in fractions of the map. */
  readonly length: number;
  readonly rounds: number;
}

/**
 * Prune the dead-end walls shorter than `budget`, measured along the wall in map fractions.
 *
 * ## Why this is on the fitted graph rather than on the skeleton
 *
 * Pruning used to happen in the raster, between thinning and chaining, and the obvious alternative
 * was to build the graph, prune it, rasterise the survivors and build again. **That was tried and
 * abandoned, and the measurement is the reason.** At a spur budget of 4 over generated linework, the
 * rebuild left 181 of 400 seeds carrying a sub-pixel sliver the cleanup cannot remove, against 1 of
 * 400 for the raster prune — the same artefact, thirty to a hundred times more of it. The cause is
 * that the raster walk stops *before* the junction a branch runs into and leaves that pixel, where
 * deleting a whole graph edge takes it too, one pixel further into every pruned junction, which is
 * exactly where junction clusters come from.
 *
 * Doing it here has neither problem, because **there is no raster left to disturb**. The freeze is
 * the point where the pixels stop being needed; a run deleted after it changes the document and
 * nothing else, and nothing is ever rebuilt from a rasterised copy of it.
 *
 * It is also what lets the two modes share one implementation. The editor has no skeleton and never
 * will, so a raster prune could only ever have been the ink mode's.
 *
 * ## Degree is unambiguous here, and that retires a class of defect
 *
 * The raster version had to count contiguous runs around a pixel's ring rather than raw neighbours,
 * because a pixel one row above a line touches three of its pixels diagonally and reads as a
 * junction — which stopped the branch walk early and left a nub on the wall. On a graph a run is
 * deleted whole and a node's degree is just how many runs name it. `spursToPrune` carries the rest
 * of the reasoning, including why a closed loop can never be a spur.
 *
 * Node ids are renumbered by the compaction at the end, so **this may not run inside a gesture** —
 * the standing rule. Everywhere it is called, the caller stops holding ids across it.
 */
export function pruneFrozenGraph(graph: FrozenGraph, budget: number): FrozenPruning {
  const doomed = spurEdgesToPrune(graph, budget);
  if (doomed.edges.size === 0) {
    return { graph, removed: 0, segments: 0, length: 0, rounds: doomed.rounds };
  }

  const edges = graph.edges.filter((_, index) => !doomed.edges.has(index));
  const segments = doomed.edges.size;
  return {
    // Compacted, because a pruned run leaves its interior vertices referenced by nothing, and this
    // project does not leave junk lying around once a gesture is over.
    graph: compactNodes({ nodes: graph.nodes, edges }),
    removed: doomed.runs,
    segments,
    length: doomed.length,
    rounds: doomed.rounds,
  };
}

/** Which segments a spur budget would remove, without removing them. */
export interface DoomedSpurs {
  /** Indices into `graph.edges`. */
  readonly edges: ReadonlySet<number>;
  /** Whole wall runs those segments make up. */
  readonly runs: number;
  /** Total length, in map fractions. */
  readonly length: number;
  readonly rounds: number;
}

/**
 * The segments a budget would prune — the question asked without the answer being applied.
 *
 * ## Why this is separate from doing it
 *
 * **Pruning is destructive and cannot be undone**, and the standing rule is that a control which can
 * be wrong needs a visual channel *before* it is used rather than a report afterwards. So the editor
 * draws the doomed walls in red while the slider moves, and this is what it asks. Reported from a
 * room on 2026-09-07: *"the slider should show the spurs that will be pruned in red or something for
 * visualization."*
 *
 * `pruneFrozenGraph` is written in terms of it, so the preview and the operation cannot disagree —
 * which is the whole point. A second implementation of "which runs go" would be a picture that lies
 * about what the button does, and this project has already paid for a preview and an emit path
 * answering the same question differently.
 *
 * Cheap enough to call per frame on any real graph, but the caller memoises anyway: it is a run walk
 * plus a cascade, and a canvas redraws sixty times a second for reasons that have nothing to do with
 * the slider.
 */
export function spurEdgesToPrune(graph: FrozenGraph, budget: number): DoomedSpurs {
  const empty = { edges: new Set<number>(), runs: 0, length: 0, rounds: 0 };
  if (!(budget > 0)) return empty;

  const runs = walkRuns(graph);
  const prunable: PrunableRun[] = runs.map((run) => ({
    a: run.nodes[0]!,
    b: run.nodes[run.nodes.length - 1]!,
    length: runLength(graph, run.nodes),
  }));
  const decision = spursToPrune(prunable, budget);
  if (decision.removed.size === 0) return { ...empty, rounds: decision.rounds };

  const edges = new Set<number>();
  for (const index of decision.removed) {
    for (const edge of runs[index]!.edges) edges.add(edge);
  }
  return { edges, runs: decision.removed.size, length: decision.length, rounds: decision.rounds };
}

/**
 * How long a run is, following it rather than measuring end to end.
 *
 * The distinction is the same one the raster version made by counting steps: a curled spur is as
 * long as the path along it, and one that doubles back would otherwise measure as short as its ends
 * happen to be close.
 */
function runLength(graph: FrozenGraph, nodes: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    const from = graph.nodes[nodes[i - 1]!];
    const to = graph.nodes[nodes[i]!];
    if (!from || !to) continue;
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

/**
 * The longest wall run in the graph — the top end of the prune slider's track.
 *
 * ## Why every run, and not only the ones that are spurs today
 *
 * **This measured only spurs until 2026-09-07, and that was wrong in a way a room found.** A spur is
 * a run with a free end, which is what pruning can reach *at this instant* — but pruning cascades:
 * every arm of a junction becomes a dead end once its neighbours go, so a run that is between two
 * junctions now can be a dead end three rounds later. Measuring only today's spurs made the top of
 * the track too short to reach exactly those walls, so the far right left long dead ends standing
 * where a GM reasonably expected everything to go. Reported from a room as *"very long walls that
 * don't enclose a space"*.
 *
 * The longest run is the honest bound (user, 2026-09-07): **no run can be longer than the longest
 * run**, so a budget set here can reach anything the cascade ever frees. The far right therefore
 * means "every dead end, whatever its length", while staying a finite number measured off this graph
 * rather than an infinity dressed up as a setting.
 *
 * ## What it costs, and why it is less than it sounds
 *
 * The note this replaces said including non-spurs would put every useful setting "in the first
 * percent", because the exterior wall's run would dominate. **That was overstated, and the arithmetic
 * is why**: the track is logarithmic, so a top twenty times larger costs about a fifth of the track
 * rather than all of it. A working budget on the test map sits around two thirds of the way up under
 * the old measurement and around half under this one.
 *
 * The argument does still hold for `largestBend`, which is measured per *vertex* for exactly that
 * reason — and the distinction between the two is worth keeping straight. Pruning acts on whole runs,
 * so the longest run is a bound it can actually be set to. Simplification acts at a vertex, so a
 * whole wall's deviation from its own chord is not a quantity that control could ever use.
 *
 * Zero when there is nothing to measure, which the caller reads as "no top".
 */
export function longestRun(graph: FrozenGraph): number {
  let longest = 0;
  for (const run of walkRuns(graph)) longest = Math.max(longest, runLength(graph, run.nodes));
  return longest;
}

/**
 * The largest bend in the graph, which is what a simplification slider's top end is measured from.
 *
 * A **bend** is measured at one vertex: how far it sits off the straight line joining its two
 * neighbours. That is the same quantity a Douglas–Peucker tolerance is compared against, so a
 * tolerance at this figure is one at which every bend on the map is a candidate for removal — which
 * is the deliberate over-reach the top of the track is for, in the same family as the ink filters
 * that run far enough to erase a map.
 *
 * **Per vertex rather than per wall**, and that is the difference between a usable track and a
 * useless one. A whole wall's deviation from the chord between its ends is dominated by the exterior
 * wall, which wraps the building and departs from its own chord by something like half the map — so
 * a top measured that way would put every setting a GM wants in the first percent of the track.
 *
 * Only vertices with exactly two walls are counted, because those are the only ones simplification
 * can remove. A junction and a free end survive any tolerance, so a bend at one is not a bend this
 * control could act on.
 *
 * Zero when there is nothing to measure, which the caller reads as "no top".
 */
export function largestBend(graph: FrozenGraph): number {
  const degrees = nodeDegrees(graph);
  const neighbours = new Map<number, number[]>();
  for (const edge of graph.edges) {
    if (degrees[edge.a] === 2) (neighbours.get(edge.a) ?? neighbours.set(edge.a, []).get(edge.a)!).push(edge.b);
    if (degrees[edge.b] === 2) (neighbours.get(edge.b) ?? neighbours.set(edge.b, []).get(edge.b)!).push(edge.a);
  }

  let largest = 0;
  for (const [id, sides] of neighbours) {
    if (sides.length !== 2) continue;
    const point = graph.nodes[id];
    const from = graph.nodes[sides[0]!];
    const to = graph.nodes[sides[1]!];
    if (!point || !from || !to) continue;
    largest = Math.max(largest, offLine(point, from, to));
  }
  return largest;
}

/**
 * How far `point` sits off the line through `from` and `to`.
 *
 * The distance to the infinite line rather than to the segment, which is what Douglas–Peucker
 * measures and therefore what a tolerance is comparable to. When the two neighbours coincide there
 * is no line, so the distance to the point they share is the honest answer.
 */
function offLine(point: Vector2, from: Vector2, to: Vector2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy);
  if (span === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  return Math.abs(dy * (point.x - from.x) - dx * (point.y - from.y)) / span;
}

/** Grows as needed; `bytes()` returns exactly what was written. */
class ByteWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;
  private readonly scratch = new DataView(new ArrayBuffer(4));

  push(value: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = value & 0xff;
  }

  /** Base-128, low bits first: one byte under 128, two under 16384. */
  varint(value: number): void {
    let rest = Math.max(0, Math.floor(value));
    while (rest >= 0x80) {
      this.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.push(rest);
  }

  float32(value: number): void {
    this.scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.push(this.scratch.getUint8(i));
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

class ByteReader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get done(): boolean {
    return this.at >= this.data.length;
  }

  byte(): number | null {
    return this.at < this.data.length ? this.data[this.at++]! : null;
  }

  varint(): number | null {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (byte === null) return null;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 0x80;
    }
    return null;
  }

  float32(): number | null {
    if (this.at + 4 > this.data.length) return null;
    const value = this.view.getFloat32(this.at, true);
    this.at += 4;
    return value;
  }
}

/**
 * FNV-1a over the body, to notice corruption the structure cannot.
 *
 * Structure checks catch a great deal — a node id out of range, a truncated payload, a bad length —
 * but they cannot see a wall that has quietly moved, because a corrupted coordinate is simply a
 * different and entirely plausible coordinate. This can.
 */
function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // The FNV prime by shifts, so 32-bit arithmetic cannot overflow into a float.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Encode the document. Base64, because the destination is a JSON string in scene metadata. */
export function encodeFrozenGraph(graph: FrozenGraph): string {
  const body = new ByteWriter();
  body.varint(graph.nodes.length);
  for (const node of graph.nodes) {
    body.float32(node.x);
    body.float32(node.y);
  }
  body.varint(graph.edges.length);
  for (const edge of graph.edges) {
    body.varint(edge.a);
    body.varint(edge.b);
  }

  const bytes = body.bytes();
  const out = new ByteWriter();
  out.push(FORMAT_VERSION);
  const sum = checksum(bytes);
  // Four plain bytes rather than a varint: a fixed width means a corrupted checksum cannot change
  // where the body starts.
  out.push(sum & 0xff);
  out.push((sum >>> 8) & 0xff);
  out.push((sum >>> 16) & 0xff);
  out.push((sum >>> 24) & 0xff);
  for (const byte of bytes) out.push(byte);
  return toBase64(out.bytes());
}

/**
 * Decode the document, or `null` if it is not one this version wrote and can vouch for.
 *
 * Six refusals: not base64, wrong version, a checksum that does not match, a truncated body, a node
 * id outside the table, and trailing bytes.
 */
export function decodeFrozenGraph(text: string): FrozenGraph | null {
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 5) return null;
  if (bytes[0] !== FORMAT_VERSION) return null;

  const expected = (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
  const body = bytes.slice(5);
  if (checksum(body) !== expected) return null;

  const input = new ByteReader(body);
  const nodeCount = input.varint();
  if (nodeCount === null) return null;

  const nodes: Vector2[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const x = input.float32();
    const y = input.float32();
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    nodes.push({ x, y });
  }

  const edgeCount = input.varint();
  if (edgeCount === null) return null;

  const edges: FrozenEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = input.varint();
    const b = input.varint();
    if (a === null || b === null || a >= nodes.length || b >= nodes.length) return null;
    edges.push({ a, b });
  }

  // Trailing bytes mean this is not the payload it claims to be, whatever it decoded to.
  if (!input.done) return null;

  return { nodes, edges };
}

/**
 * Base64 over bytes, chunked.
 *
 * `String.fromCharCode(...bytes)` in one call overflows the argument limit on a real map's worth of
 * nodes — a crash rather than a wrong answer, but only on maps big enough that nobody tested it.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
