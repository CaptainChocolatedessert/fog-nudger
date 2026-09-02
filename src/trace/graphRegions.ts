/**
 * Regions from the wall graph — the deriving half of step D, end to end.
 *
 * Ink in, simplified rings out, by way of the skeleton rather than the space between the strokes.
 * The chain is thin, prune, chain, label, walk the faces, remove the slivers, fit. **Nothing welds**
 * — that was the sibling's fix for junction clusters, it moves points, and it is forbidden here;
 * `wallGraph.ts` carries the measurement that killed it.
 *
 * ## Two things here differ from the region-first pipeline, and both are forced
 *
 * **Simplification is per edge, not per ring.** Under the old partition, two adjacent rooms had
 * boundaries a wall width apart and simplifying each independently was harmless. Under the graph
 * their boundaries are *coincident*, so independent fitting would let them drift apart by up to the
 * tolerance and open a sliver between two rooms that share a wall. Fitting each edge once and
 * assembling both faces from it makes that impossible rather than unlikely.
 *
 * **Tolerance escalation is therefore global.** The old code raised the tolerance for one region at
 * a time until it fitted the command cap. That cannot survive shared edges — a room escalated on its
 * own would no longer match its neighbour along the wall between them. So when anything is over the
 * cap, the tolerance rises for the whole map and every edge is refitted. The cost is stated: one
 * enormous region can coarsen every other one. In exchange, no two faces can disagree about a wall.
 *
 * ## Meeting the cap by simplifying harder, never by splitting
 *
 * Carried here from `simplify.ts` when its per-region path was deleted, because it is a rule this
 * project must not lose rather than a note about an implementation.
 *
 * Splitting an oversized region into two adjacent shapes is the obvious remedy and the sharpest trap
 * in the design: Dynamic Fog derives a wall from every shape boundary, so the join becomes **a wall
 * across the middle of a room**. So the tolerance rises and everything is refitted from the original
 * edges — which keeps the displacement bound stated against the tolerance actually ended at, rather
 * than against the sum of every rung of the ladder.
 *
 * Escalation stops at a ceiling, and anything still over the cap is **reported rather than fixed**
 * (`overCap`, which the emit path turns into a skip). Emitting it would fail at the SDK boundary;
 * splitting it would put a wall through a room; crushing it to fit would produce a room shaped like
 * nothing on the map. Naming it is the honest option, and the count is the signal that either the ink
 * is far noisier than expected or two rooms have merged into something enormous.
 *
 * **The exterior is not special-cased, though it could be.** There is no room outside to clip and
 * nobody out there to cut off, so it could take a much looser tolerance than any room — and it gets
 * none, because the pipeline deliberately does not know which face the exterior is. The ladder covers
 * it anyway and without a guess: only a region with an enormous boundary escalates, the exterior's
 * boundary wraps every room on the map, and an ordinary room never comes close to the cap. The
 * exterior ends up loosely simplified because it is large, not because something decided it was
 * outside.
 *
 * ## No size threshold, and what happens to a hole
 *
 * Every face holding any map is emitted; the smallest-room control is gone (user, 2026-08-30). The
 * only thing dropped is a face with **no interior pixels**, which is not a threshold but an
 * invariant: there is nothing there to reveal.
 *
 * The containment rule for holes survives and now almost never fires — a hole is kept unless the
 * face on the other side of it holds no map. Its old caveat, that containment was checked one step
 * across rather than transitively, stops mattering for the same reason.
 *
 * Pure: no DOM, no SDK.
 */

import { commandCount, doubleSignedArea, MIN_RING_POINTS, type Ring } from "../geometry/ring";
import type { BinaryMask } from "./binarize";
import {
  fitFaces,
  resolveFaces,
  type FittedEdge,
  type GraphFace,
  type GraphFaces,
} from "./faces";
import { labelSpace, type LabelledSpace } from "./label";
import { COMMAND_CAP } from "./simplify";
import { pruneSpurs } from "./spurs";
import { thin } from "./thinning";
import { buildWallGraph, type WallGraph } from "./wallGraph";

export interface GraphRegionOptions {
  /** Longest dead-end branch to prune from the skeleton, in pixels walked. Zero is off. */
  readonly spurPrunePx: number;
  /** Douglas–Peucker tolerance in raster pixels. */
  readonly tolerance: number;
  /** Ceiling the tolerance may escalate to. */
  readonly maxTolerance: number;
  /** Overridable only so tests can drive escalation on a fixture small enough to read. */
  readonly maxCommands?: number;
}

export interface GraphRegion {
  /** The face's label in the skeleton's labelling. */
  readonly id: number;
  readonly rings: readonly Ring[];
  readonly commands: number;
  /** Area the face covers, in pixels, measured before fitting. */
  readonly area: number;
  /** Rings kept unfitted because fitting would have collapsed them out of existence. */
  readonly preservedRings: number;
  readonly verticesBefore: number;
  readonly vertices: number;
  readonly overCap: boolean;
}

export interface GraphRegionResult {
  readonly graph: WallGraph;
  readonly faces: GraphFaces;
  /**
   * The labelling of the framed skeleton, with the smallest-room filter applied to its region list.
   *
   * Carried so the point probe reads the *same* partition the faces came from rather than a second
   * one derived beside it. Its `discarded` counts are the faces the filter dropped,
   * not anything the labelling itself refused — labelling runs with no minimum, because the area
   * identity compares against a pixel count and a filtered count would have holes in it.
   */
  readonly labelled: LabelledSpace;
  readonly regions: readonly GraphRegion[];
  /** The skeleton the graph came from, before the border frame was painted on. */
  readonly skeleton: BinaryMask;
  /** Faces holding no map at all — sub-pixel slivers. There is no size threshold any more. */
  readonly discarded: number;
  /**
   * Edges with the same face on both sides — the bridge criterion, which step E turns into lines.
   *
   * Every stub wall is one. A stub *joined* to a wall does not produce a cycle of its own: it is a
   * slit inside the surrounding face's cycle, walked out and back, so counting zero-area cycles
   * would report none of them. Only a wholly free-floating piece of linework gets its own cycle,
   * which is what `degenerateCycles` counts.
   */
  readonly bridges: number;
  /** Cycles enclosing no area at all — a free-floating piece of linework, walked out and back. */
  readonly degenerateCycles: number;
  /** Holes dropped because the face they enclose did not survive the minimum. */
  readonly filledHoles: number;
  /**
   * Cycles that produced no ring at all, so their edges were left for the wall lines.
   *
   * Expected to be zero: reaching it needs a cycle of one or two skeleton pixels, which sliver
   * removal should have taken already. Counted rather than only guarded, because the failure it
   * replaces was silent in both outputs at once.
   */
  readonly droppedCycles: number;
  /**
   * Every edge's fitted polyline, aligned with `graph.edges`, at the tolerance actually used.
   *
   * What step G freezes. Fitting keeps both ends of every edge, so these endpoints *are* the graph's
   * own nodes — which is what lets the stored document share them by reference rather than by two
   * coordinates happening to be equal.
   */
  readonly fittedEdges: readonly FittedEdge[];
  /**
   * Edges no emitted ring traverses — the walls that need a line of their own.
   *
   * **Every bridge is one**, plus two smaller cases:
   *
   * - **A free-floating piece of linework inside a face.** It forms a cycle of its own enclosing no
   *   area, which is not emitted as a ring, so nothing covers it.
   * - **An edge with no emitted face on either side** — between two faces that hold no map.
   *
   * ## This doc argued the opposite until 2026-09-01, and the test beside it says so
   *
   * It claimed the design record was wrong to say a bridge can never be covered: the traversal walks
   * a stub out and back as a slit inside the room's own ring, so the geometry is there and stroking
   * it yields the wall — "demonstrated by a fixture: the room's emitted ring repeats the stub's
   * tip". **Step E reversed that**, on the user's rejection of emitting the slit: it puts our
   * internal representation into the scene, leaves Skia's stroking and Owlbear's storage to
   * interpret a degenerate excursion, and produces something Owlbear's own tools cannot draw. The
   * slit is dropped from the emitted ring and the bridge goes out as a `LINE`.
   *
   * The fixture the old argument appealed to now asserts the reverse — `graphRegions.test.ts` checks
   * that the ring visits no vertex twice, and that `uncoveredEdges.length` equals the bridge count.
   *
   * Carried as fitted polylines in raster space, ready for placement.
   */
  readonly uncoveredEdges: readonly FittedEdge[];
  readonly tolerance: number;
  readonly escalations: number;
  /** Sub-pixel slivers deleted from the graph, and how many rounds it took. */
  readonly sliversRemoved: number;
  readonly sliverRounds: number;
  /** Slivers still present when the round cap was reached. Expected to be zero. */
  readonly sliversLeft: number;
  readonly timings: {
    readonly thinMs: number;
    readonly pruneMs: number;
    readonly graphMs: number;
    readonly labelMs: number;
    readonly faceMs: number;
    readonly fitMs: number;
  };
  readonly thinning: { readonly before: number; readonly after: number; readonly passes: number };
  readonly pruning: { readonly removed: number; readonly pixels: number; readonly rounds: number };
}

export function deriveGraphRegions(
  ink: BinaryMask,
  options: GraphRegionOptions,
): GraphRegionResult {
  const thinStarted = performance.now();
  const thinned = thin(ink);
  const thinMs = performance.now() - thinStarted;

  const pruneStarted = performance.now();
  const pruned = pruneSpurs(thinned.mask, options.spurPrunePx);
  const pruneMs = performance.now() - pruneStarted;

  const graphStarted = performance.now();
  let graph = buildWallGraph(pruned.mask);
  const graphMs = performance.now() - graphStarted;

  // No minimum here on purpose. The area identity compares against this pixel count, and filtering
  // first would leave it checking against a count with holes punched in it. The smallest-room
  // filter is applied to whole faces below, where it belongs.
  //
  // Labelled once and reused across the sliver rounds below: deleting a graph edge changes the
  // arrangement and never the raster, so the labels cannot move under it.
  const labelStarted = performance.now();
  const labelled = labelSpace(graph.framed, { minArea: 0 });
  const labelMs = performance.now() - labelStarted;

  const faceStarted = performance.now();
  const resolved = resolveFaces(graph, labelled);
  graph = resolved.graph;
  const faces = resolved.faces;
  const sliversRemoved = resolved.sliversRemoved;
  const sliverRounds = resolved.rounds;
  const faceMs = performance.now() - faceStarted;

  /*
    Every face that holds any map at all is emitted. There is no size threshold.

    **The smallest-room control is gone** (user, 2026-08-30). It was a blunt instrument standing in
    for judgement the GM is better placed to make once the walls are editable: what it deleted was a
    *region*, when what is usually wrong is a *wall*. Removing a sliver by deleting the wall that
    made it is exact, local, and something a GM can see; removing it by area is none of those.

    **It also resolves a defect this record carried for weeks.** A discarded face was never turned
    into ink — it was simply not emitted, so it stayed permanently unrevealable and showed as bare
    map inside a revealed room unless a filled hole happened to reach it. Nothing is discarded now,
    so there is no bare map.

    What remains is not a threshold but an invariant: **a face with no interior pixels holds no map**,
    so there is nothing there to reveal and nothing to emit. Those are the sub-pixel slivers a
    junction cluster leaves where no bounding edge was free of interior pixels to delete.
  */
  const survives = new Set<number>();
  let discarded = 0;
  for (const face of faces.faces) {
    if (face.interior > 0) survives.add(face.label);
    else discarded += 1;
  }

  // Carried out with the survivors only, so the point probe describes what was emitted.
  const filteredLabelling: LabelledSpace = {
    ...labelled,
    regions: labelled.regions.filter((region) => survives.has(region.id)),
    discarded,
    // Always zero, and not by accident: a face is only ever dropped for holding no pixels.
    discardedArea: 0,
  };

  // Which face sits on the other side of a cycle, so the hole rule has something to ask.
  const faceOfHalfEdge = new Map<number, number>();
  for (const face of faces.faces) {
    for (const cycle of face.cycles) {
      for (const half of cycle.halfEdges) faceOfHalfEdge.set(half, face.label);
    }
  }

  // The bridge criterion: an edge with the same face on both sides is a wall no region boundary can
  // cover, because there is only one region there. The traversal walks it out and back as a slit,
  // which is right for the area check and wrong to emit, so these are left out of the rings and
  // emitted as lines of their own.
  const bridgeEdges = new Set<number>();
  for (let edge = 0; edge < graph.edges.length; edge += 1) {
    const left = faceOfHalfEdge.get(edge * 2);
    const right = faceOfHalfEdge.get(edge * 2 + 1);
    if (left !== undefined && left === right) bridgeEdges.add(edge);
  }
  const bridges = bridgeEdges.size;

  const kept = faces.faces.filter((face) => survives.has(face.label));

  const fitStarted = performance.now();
  const ceiling = Math.max(options.tolerance, options.maxTolerance);
  const cap = options.maxCommands ?? COMMAND_CAP;

  let tolerance = options.tolerance;
  let escalations = 0;
  let built = assemble(graph, kept, faceOfHalfEdge, survives, bridgeEdges, tolerance);

  // `tolerance > 0` is not decoration: doubling zero is zero, so a caller asking for no
  // simplification at all would spin here forever on any region over the cap.
  while (built.regions.some((region) => region.commands > cap) && tolerance > 0 && tolerance < ceiling) {
    tolerance = Math.min(tolerance * 2, ceiling);
    escalations += 1;
    built = assemble(graph, kept, faceOfHalfEdge, survives, bridgeEdges, tolerance);
  }
  const fitMs = performance.now() - fitStarted;

  return {
    graph,
    faces,
    labelled: filteredLabelling,
    regions: built.regions.map((region) => ({ ...region, overCap: region.commands > cap })),
    fittedEdges: built.fitted,
    skeleton: pruned.mask,
    discarded,
    bridges,
    uncoveredEdges: built.uncovered,
    degenerateCycles: built.degenerateCycles,
    filledHoles: built.filledHoles,
    droppedCycles: built.droppedCycles,
    tolerance,
    escalations,
    sliversRemoved,
    sliverRounds,
    sliversLeft: faces.slivers.length,
    timings: { thinMs, pruneMs, graphMs, labelMs, faceMs, fitMs },
    thinning: { before: thinned.before, after: thinned.after, passes: thinned.passes },
    pruning: { removed: pruned.removed, pixels: pruned.pixels, rounds: pruned.rounds },
  };
}

function assemble(
  graph: WallGraph,
  kept: readonly GraphFace[],
  faceOfHalfEdge: ReadonlyMap<number, number>,
  survives: ReadonlySet<number>,
  bridgeEdges: ReadonlySet<number>,
  tolerance: number,
): {
  uncovered: FittedEdge[];
  /**
   * Every edge's fitted polyline, positionally aligned with `graph.edges`.
   *
   * Carried out so the freeze can store it. It is the *escalated* set when the tolerance rose, which
   * is the point: what gets frozen has to be what would have been emitted, not a first attempt that
   * did not fit the command cap.
   */
  fitted: readonly FittedEdge[];
  regions: Omit<GraphRegion, "overCap">[];
  degenerateCycles: number;
  filledHoles: number;
  droppedCycles: number;
  /** Edges some emitted ring actually traverses. Everything else needs a line of its own. */
  covered: Set<number>;
} {
  const { rings: fittedRings, edges: fittedEdges } = fitFaces(graph, kept, tolerance, bridgeEdges);
  const regions: Omit<GraphRegion, "overCap">[] = [];
  const covered = new Set<number>();
  let degenerateCycles = 0;
  let filledHoles = 0;
  let droppedCycles = 0;

  kept.forEach((face, index) => {
    const rings: Ring[] = [];
    let preserved = 0;
    let verticesBefore = 0;

    face.cycles.forEach((cycle, cycleIndex) => {
      verticesBefore += cycle.points.length;

      if (cycle.doubleArea === 0) {
        // A bridge, walked out and back. It encloses nothing, so it is not a ring — step E emits it
        // as a line by the same criterion.
        degenerateCycles += 1;
        return;
      }

      if (cycleIndex > 0) {
        // A hole. Kept only when the face on its far side is emitted — which, with no size
        // threshold left, means only when that face holds no map at all.
        const inside = cycle.halfEdges
          .map((half) => faceOfHalfEdge.get(half ^ 1))
          .filter((label): label is number => label !== undefined && label !== face.label);
        if (inside.length > 0 && !inside.some((label) => survives.has(label))) {
          filledHoles += 1;
          return;
        }
      }

      // A cycle yields more than one ring when a bridge splits it: removing a stalk from a
      // boundary genuinely disconnects it, so one hole around a building-plus-lollipop becomes two.
      /**
       * Whether this cycle contributed a ring at all.
       *
       * The `covered` loop below used to run unconditionally, which is wrong when *every* ring the
       * cycle produced was dropped: its edges were then recorded as covered by a ring that does not
       * exist, so they were not emitted as wall lines either and the linework vanished from both
       * outputs silently. Reaching it needs a cycle of one or two skeleton pixels, which sliver
       * removal should already have taken — a latent hole rather than an observed defect, which is
       * why it is also counted rather than only guarded.
       */
      let contributed = false;

      for (const fitted of fittedRings[index]![cycleIndex]!) {
        // A ring small against the tolerance collapses to two points and stops being a shape at
        // all, which for a region means the room vanishes. Vertices are the cheap thing here and a
        // room is not, so the unfitted ring is kept instead.
        if (fitted.points.length < MIN_RING_POINTS) {
          if (fitted.raw.length < MIN_RING_POINTS) continue;
          preserved += 1;
          rings.push([...fitted.raw]);
        } else {
          rings.push(fitted.points);
        }
        contributed = true;
      }

      if (!contributed) {
        droppedCycles += 1;
        return;
      }

      // This ring is emitted, so every edge it walks is represented in the scene by it — except the
      // bridges, which `fitFaces` left out and which emit as lines instead.
      for (const half of cycle.halfEdges) {
        if (!bridgeEdges.has(half >> 1)) covered.add(half >> 1);
      }
    });

    let vertices = 0;
    for (const ring of rings) vertices += ring.length;

    regions.push({
      id: face.label,
      rings,
      commands: commandCount(rings),
      area: face.doubleArea / 2,
      preservedRings: preserved,
      verticesBefore,
      vertices,
    });
  });

  // Whatever no ring walked has to be emitted on its own, as the fitted polyline rather than the
  // pixel chain: a line and a room that meet at a corner must carry the identical point.
  const uncovered: FittedEdge[] = [];
  for (let edge = 0; edge < graph.edges.length; edge += 1) {
    if (!covered.has(edge)) uncovered.push(fittedEdges[edge]!);
  }

  return { regions, degenerateCycles, filledHoles, droppedCycles, covered, uncovered, fitted: fittedEdges };
}

/** One line for the log. */
export function describeGraphRegions(result: GraphRegionResult): string {
  const { graph, faces, timings } = result;
  const exact =
    faces.exact === faces.checked
      ? "area check exact"
      : `area check FAILED on ${faces.checked - faces.exact} of ${faces.checked}`;
  return (
    `${result.regions.length} faces from ${graph.nodes.length} nodes and ${graph.edges.length} ` +
    // "held no map", not "below the minimum": there is no size threshold any more. A face is left
    // out only when it has zero interior pixels, which is a sub-pixel sliver rather than a room
    // somebody filtered away.
    `edges (${result.discarded} faces held no map, ${result.bridges} bridges, ` +
    `${result.sliversRemoved} slivers removed in ${result.sliverRounds} rounds, ` +
    `${result.filledHoles} holes filled, ${result.droppedCycles} cycles produced no ring); ` +
    `${exact}; tolerance ${result.tolerance.toFixed(2)}px ` +
    `after ${result.escalations} escalations; thin ${Math.round(timings.thinMs)}ms, ` +
    `prune ${Math.round(timings.pruneMs)}ms, graph ${Math.round(timings.graphMs)}ms, ` +
    `label ${Math.round(timings.labelMs)}ms, faces ${Math.round(timings.faceMs)}ms, ` +
    `fit ${Math.round(timings.fitMs)}ms`
  );
}

/** Total area the emitted rings enclose, for the coverage line. */
export function coveredArea(regions: readonly GraphRegion[]): number {
  let total = 0;
  for (const region of regions) {
    for (const ring of region.rings) total += doubleSignedArea(ring) / 2;
  }
  return total;
}
