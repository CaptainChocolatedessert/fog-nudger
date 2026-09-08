/**
 * Ink to a frozen wall graph — the deriving half of step D, end to end.
 *
 * The chain is thin, chain, remove the sub-pixel slivers, fit each edge, freeze. **Nothing welds** —
 * that was the sibling's fix for junction clusters, it moves points, and it is forbidden here;
 * `wallGraph.ts` carries the measurement that killed it.
 *
 * ## It used to build faces from the raster, and that is gone — 2026-09-08
 *
 * This module used to assemble **regions**: walk the arrangement, name each face by sampling the
 * raster labelling one step to the right of every boundary step, apply a hole-containment rule, and
 * fit each face's rings. It also ran the *area check*, a lattice identity asserting that the polygon
 * it produced enclosed exactly the pixels the flood fill had attributed to that face.
 *
 * None of it survives, because **faces stopped being made of pixels**. The document is a planar
 * graph, and a planar graph partitions the plane by construction — so there is nothing to check
 * about every part of the map being under a face, and nothing to *derive* either: the faces come
 * from walking the frozen graph, which is the same walk the push uses.
 *
 * What is left here is the part that genuinely needs the raster: turning ink into a graph, and
 * choosing how hard to fit it.
 *
 * ## Meeting the command cap by simplifying harder, never by splitting
 *
 * A rule this project must not lose. Splitting an oversized region into two adjacent shapes is the
 * obvious remedy and the sharpest trap in the design: Dynamic Fog derives a wall from every shape
 * boundary, so the join becomes **a wall across the middle of a room**. So the tolerance rises and
 * every edge is refitted from the original chains — which keeps the displacement bound stated
 * against the tolerance actually ended at, rather than against the sum of every rung of the ladder.
 *
 * **Escalation is global**, because fitting is per edge and two faces sharing a wall are assembled
 * from the same fitted points; a region escalated on its own would stop matching its neighbours. The
 * cost is stated: one enormous region can coarsen every other one.
 *
 * **And it is now measured against the frozen faces rather than against a second set derived here**,
 * which is both simpler and more honest — the cap applies to what is emitted, and what is emitted is
 * the frozen graph's faces. Anything still over the cap at the ceiling is reported rather than
 * fixed; the emit path skips it and names it.
 *
 * Pure: no DOM, no SDK.
 */

import { commandCount } from "../geometry/ring";
import type { BinaryMask } from "./binarize";
import { resolveFaces, type FittedEdge } from "./faces";
import { buildFrozenFaces, type FrozenFaces } from "./frozenFaces";
import { freezeGraph, type Frozen } from "./frozenGraph";
import { labelSpace, type LabelledSpace } from "./label";
import { COMMAND_CAP, simplifyPolyline } from "./simplify";
import { thin } from "./thinning";
import { buildWallGraph, type WallGraph } from "./wallGraph";

export interface GraphRegionOptions {
  /** Douglas–Peucker tolerance in raster pixels. */
  readonly tolerance: number;
  /** Ceiling the tolerance may escalate to. */
  readonly maxTolerance: number;
  /** Overridable only so tests can drive escalation on a fixture small enough to read. */
  readonly maxCommands?: number;
}

export interface GraphRegionResult {
  /** The cleaned graph, in raster pixels. What the freeze was built from. */
  readonly graph: WallGraph;
  /**
   * Every edge's fitted polyline, aligned with `graph.edges`, at the tolerance actually used.
   *
   * The *escalated* set when the tolerance rose, which is the point: what gets frozen has to be what
   * would have been emitted, not a first attempt that did not fit the command cap.
   */
  readonly fittedEdges: readonly FittedEdge[];
  /**
   * The document, frozen here rather than by each caller.
   *
   * Escalation needs the frozen faces to count commands against, so the freeze happens inside this
   * function anyway. Handing it out means the workspace and the emit path do not each repeat it, and
   * — more to the point — cannot repeat it *differently*.
   */
  readonly frozen: Frozen;
  /** The faces of that document: what a push writes, and what the preview draws. */
  readonly faces: FrozenFaces;
  /**
   * The labelling of the skeleton, kept for the point probe alone.
   *
   * **Nothing about faces reads this any more.** It answers "which region is this point in" for the
   * probe, which is the one question that still wants a flood fill of the raster.
   */
  readonly labelled: LabelledSpace;
  /** The skeleton the graph came from. */
  readonly skeleton: BinaryMask;
  /** Sub-pixel slivers deleted from the graph, and how many rounds it took. */
  readonly sliversRemoved: number;
  readonly sliverRounds: number;
  /** Slivers still present when the round cap was reached. Expected to be zero. */
  readonly sliversLeft: number;
  /** Faces whose command count exceeds the cap even at the ceiling tolerance. */
  readonly overCap: number;
  readonly tolerance: number;
  readonly escalations: number;
  readonly timings: {
    readonly thinMs: number;
    readonly graphMs: number;
    readonly labelMs: number;
    readonly sliverMs: number;
    readonly fitMs: number;
  };
  readonly thinning: { readonly before: number; readonly after: number; readonly passes: number };
}

/** Fit every edge of the graph at one tolerance. Positionally aligned with `graph.edges`. */
function fitEdges(graph: WallGraph, tolerance: number): FittedEdge[] {
  return graph.edges.map((edge) => ({ points: simplifyPolyline(edge.points, tolerance) }));
}

/** How many faces of a frozen document would not fit the cap. */
function overCapCount(faces: FrozenFaces, cap: number): number {
  return faces.faces.filter((face) => commandCount(face.rings) > cap).length;
}

export function deriveGraphRegions(
  ink: BinaryMask,
  options: GraphRegionOptions,
): GraphRegionResult {
  const thinStarted = performance.now();
  const thinned = thin(ink);
  const thinMs = performance.now() - thinStarted;

  const graphStarted = performance.now();
  const built = buildWallGraph(thinned.mask);
  const graphMs = performance.now() - graphStarted;

  const sliverStarted = performance.now();
  const resolved = resolveFaces(built);
  const graph = resolved.graph;
  const sliverMs = performance.now() - sliverStarted;

  /*
    The labelling, for the point probe and nothing else.

    It used to be the source of face identity and the right-hand side of the area check, which is why
    it ran before the faces did. Now it answers one question for one diagnostic, and it is kept
    because that question — *which region is this point in* — is the one thing looking at the picture
    cannot answer.
  */
  const labelStarted = performance.now();
  const labelled = labelSpace(graph.framed, { minArea: 0 });
  const labelMs = performance.now() - labelStarted;

  const fitStarted = performance.now();
  const ceiling = Math.max(options.tolerance, options.maxTolerance);
  const cap = options.maxCommands ?? COMMAND_CAP;

  let tolerance = options.tolerance;
  let escalations = 0;
  let fittedEdges = fitEdges(graph, tolerance);
  let frozen = freezeGraph(graph, fittedEdges);
  let faces = buildFrozenFaces(frozen.graph);

  /*
    `tolerance > 0` is not decoration: doubling zero is zero, so a caller asking for no simplification
    at all would spin here forever on any face over the cap.
  */
  while (overCapCount(faces, cap) > 0 && tolerance > 0 && tolerance < ceiling) {
    tolerance = Math.min(tolerance * 2, ceiling);
    escalations += 1;
    fittedEdges = fitEdges(graph, tolerance);
    frozen = freezeGraph(graph, fittedEdges);
    faces = buildFrozenFaces(frozen.graph);
  }
  const fitMs = performance.now() - fitStarted;

  return {
    graph,
    fittedEdges,
    frozen,
    faces,
    labelled,
    skeleton: thinned.mask,
    sliversRemoved: resolved.sliversRemoved,
    sliverRounds: resolved.rounds,
    sliversLeft: resolved.sliversLeft,
    overCap: overCapCount(faces, cap),
    tolerance,
    escalations,
    timings: { thinMs, graphMs, labelMs, sliverMs, fitMs },
    thinning: { before: thinned.before, after: thinned.after, passes: thinned.passes },
  };
}

/** One line for the log. */
export function describeGraphRegions(result: GraphRegionResult): string {
  const { graph, faces, timings } = result;
  return (
    `${faces.faces.length} faces from ${graph.nodes.length} nodes and ${graph.edges.length} ` +
    `edges (${faces.bridges} bridges, ${result.sliversRemoved} slivers removed in ` +
    `${result.sliverRounds} rounds, ${result.sliversLeft} left); ` +
    `${faces.eulerHolds ? "Euler holds" : "EULER FAILED"}; ` +
    `tolerance ${result.tolerance.toFixed(2)}px after ${result.escalations} escalations; ` +
    `thin ${Math.round(timings.thinMs)}ms, graph ${Math.round(timings.graphMs)}ms, ` +
    `slivers ${Math.round(timings.sliverMs)}ms, label ${Math.round(timings.labelMs)}ms, ` +
    `fit ${Math.round(timings.fitMs)}ms`
  );
}
