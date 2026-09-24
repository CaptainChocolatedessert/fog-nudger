/**
 * Ink to a wall graph — the deriving half of step D, end to end.
 *
 * The chain is thin, chain, remove the sub-pixel slivers, fit each edge, derive. **Nothing welds** —
 * that was the sibling's fix for junction clusters, it moves points, and it is forbidden here;
 * `skeletonGraph.ts` carries the measurement that killed it.
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
 * from walking the wall graph, which is the same walk the push uses.
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
 * **And it is now measured against the wall graph's faces rather than against a second set derived here**,
 * which is both simpler and more honest — the cap applies to what is emitted, and what is emitted is
 * the wall graph's faces. Anything still over the cap at the ceiling is reported rather than
 * fixed; the emit path skips it and names it.
 *
 * ## The hairs come off on the way through — 2026-09-21
 *
 * Every derive prunes the dead ends shorter than **two measured ink widths** before it hands the
 * graph over; `autoPruneLimitPx` carries why that figure and what trusting it costs. It happens
 * inside the ladder, on every rung, so the faces escalation counts against are the ones a push
 * writes.
 *
 * Pure: no DOM, no SDK.
 */

import { commandCount } from "../geometry/ring";
import type { BinaryMask } from "./binarize";
import { resolveFaces, type FittedEdge } from "./faces";
import type { GraphExtent } from "./graphUnits";
import { buildWallFaces, type WallFaces } from "./wallFaces";
import {
  buildWallGraph,
  pruneWallGraph,
  type WallGraphBuild,
  type WallPruning,
} from "./wallGraph";
import { COMMAND_CAP, simplifyPolyline } from "./simplify";
import { thin } from "./thinning";
import { buildSkeletonGraph, type SkeletonGraph } from "./skeletonGraph";

export interface DeriveWallsOptions {
  /** Douglas–Peucker tolerance in raster pixels. */
  readonly tolerance: number;
  /**
   * The map image's size in graph units, which the wall graph is built into.
   *
   * From the **image**, not from `ink`: a capped raster is floored and can be a pixel off the image's
   * aspect, and the document is meant to describe the map rather than our raster. `graphUnits.ts`.
   */
  readonly extent: GraphExtent;
  /** Ceiling the tolerance may escalate to. */
  readonly maxTolerance: number;
  /**
   * Dead ends shorter than this go before the graph is handed over, **in graph units**, since that is
   * what the wall graph is measured in. Zero prunes nothing. The pipeline passes
   * `autoPruneLimitPx` converted by raster pixels per graph unit.
   *
   * Required rather than defaulted, so every caller says whether it wants the hairs: the randomised
   * sweeps ask for none, because they are testing the derivation's own invariants rather than this.
   */
  readonly pruneLimit: number;
  /** Overridable only so tests can drive escalation on a fixture small enough to read. */
  readonly maxCommands?: number;
}

/** How many measured ink widths a dead end may reach and still be taken as a hair. */
export const AUTO_PRUNE_INK_WIDTHS = 2;

/**
 * The longest dead end every derive removes on its own, in raster pixels.
 *
 * ## Why this is automatic now, when it was a slider that defaulted to off
 *
 * Until 2026-09-18 the limit was a setting, `spurPruneGraphUnits`, and its default was **zero**, on
 * the argument that *"pruning is also destructive out of proportion to its number … so the first
 * thing a GM should see is the graph as fitting produced it, hairs and all."* That was written about
 * a handle whose top reached the longest wall on the map, where the cascade genuinely can erode the
 * whole graph. It does not describe a figure fixed at two ink widths.
 *
 * **The argument for this figure is visibility, not measurement** (user, 2026-09-21): *"A spur the
 * size of the ink width or two almost certainly isn't a real wall."* A measurement could not settle
 * it, because it cannot say which spurs a GM wanted; what can be said is that a dead end no longer
 * than the stroke is wide is not something anyone drew as a wall. Thinning grows one off every notch
 * in a hand-drawn edge that survives binarisation, and they were reported from a room as *"a lot of
 * tiny spurs"*.
 *
 * **Deleting is allowed; inventing is not** — which is why this may be automatic where the gap repair
 * could not be. It only removes, so it cannot put anything on the map the ink did not have. **Prune
 * the dead ends** stays as the tool for more.
 *
 * ## The costs, stated
 *
 * - **It trusts the ink width**, which is an erosion estimate — biased thin, saturating at 2px, and
 *   unrepresentative on a hatched or stippled map. Accepted for now (user, same day). A map whose
 *   width reads low keeps some hairs; one whose width reads high loses stubs a little longer.
 * - **A real feature that short goes with them**: a serif across a wall's end, or the crossbar of a
 *   T-shaped door jamb, whose two arms are each a dead end. The wall it hung off stays.
 * - **A fragment between two breaks goes whole** when it is shorter than the limit, since both its
 *   ends are free. That widens the break Mend then has to bridge — the same accepted cost Mend
 *   already records for the Prune tool.
 * - **It cascades**, as every prune does: a junction left with one short arm frees it. A little star
 *   of short strokes goes entire.
 *
 * **No ink width, no pruning.** The pipeline's other fallback for a missing width is a tenth of a
 * grid square, and nothing in the pipeline may depend on the grid silently. Deleting on a guess is
 * the direction that can be wrong, so the unknown case keeps the hairs and the log says so.
 */
export function autoPruneLimitPx(inkWidth: number | null): number {
  return inkWidth !== null && inkWidth > 0 ? AUTO_PRUNE_INK_WIDTHS * inkWidth : 0;
}

export interface WallDerivation {
  /** The cleaned skeleton graph, in raster pixels. What the wall graph was built from. */
  readonly graph: SkeletonGraph;
  /**
   * Every edge's fitted polyline, aligned with `graph.edges`, at the tolerance actually used.
   *
   * The *escalated* set when the tolerance rose, which is the point: what gets stored has to be what
   * would have been emitted, not a first attempt that did not fit the command cap.
   */
  readonly fittedEdges: readonly FittedEdge[];
  /**
   * The wall graph, built here rather than by each caller.
   *
   * Escalation needs the wall graph's faces to count commands against, so the build happens inside this
   * function anyway. Handing it out means the workspace and the emit path do not each repeat it, and
   * — more to the point — cannot repeat it *differently*.
   */
  readonly walls: WallGraphBuild;
  /**
   * What the automatic prune took on the way through, at the tolerance actually used. `walls.graph` is
   * the graph **after** it; the build's own counts — collinear, coincident, no length — are from before.
   */
  readonly pruning: WallPruning;
  /** The faces of that document: what a push writes, and what the preview draws. */
  readonly faces: WallFaces;
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
    readonly sliverMs: number;
    readonly fitMs: number;
  };
  readonly thinning: { readonly before: number; readonly after: number; readonly passes: number };
}

/** Fit every edge of the graph at one tolerance. Positionally aligned with `graph.edges`. */
function fitEdges(graph: SkeletonGraph, tolerance: number): FittedEdge[] {
  return graph.edges.map((edge) => ({ points: simplifyPolyline(edge.points, tolerance) }));
}

/** How many faces of a saved document would not fit the cap. */
function overCapCount(faces: WallFaces, cap: number): number {
  return faces.faces.filter((face) => commandCount(face.rings) > cap).length;
}

/**
 * Build the wall graph from one fit, prune its hairs, and walk its faces.
 *
 * One function because the ladder runs it on every rung, and the faces it counts against the cap have
 * to be the faces of the graph that is handed over — so the prune cannot be a step after the ladder.
 */
function buildPruned(
  graph: SkeletonGraph,
  fittedEdges: readonly FittedEdge[],
  options: DeriveWallsOptions,
): { walls: WallGraphBuild; pruning: WallPruning; faces: WallFaces } {
  const built = buildWallGraph(graph, fittedEdges, options.extent);
  const pruning = pruneWallGraph(built.graph, options.pruneLimit);
  const walls = pruning.removed === 0 ? built : { ...built, graph: pruning.graph };
  return { walls, pruning, faces: buildWallFaces(walls.graph) };
}

export function deriveWalls(
  ink: BinaryMask,
  options: DeriveWallsOptions,
): WallDerivation {
  const thinStarted = performance.now();
  const thinned = thin(ink);
  const thinMs = performance.now() - thinStarted;

  const graphStarted = performance.now();
  const skeletonGraph = buildSkeletonGraph(thinned.mask);
  const graphMs = performance.now() - graphStarted;

  const sliverStarted = performance.now();
  const resolved = resolveFaces(skeletonGraph);
  const graph = resolved.graph;
  const sliverMs = performance.now() - sliverStarted;

  /*
    A space labelling was made here until 2026-09-24, for the point probe and nothing else, on the
    ground that *which region is this point in* is the one thing looking at the picture cannot answer.
    The workspace draws every room in its own fill, so it can — and the labelling was a partition of
    the raster rather than of the wall graph, which told a click on the outside that it was emitted.
    It was over 40% of a derive on a real map. `probePoint.ts` says what the probe answers instead.
  */
  const fitStarted = performance.now();
  const ceiling = Math.max(options.tolerance, options.maxTolerance);
  const cap = options.maxCommands ?? COMMAND_CAP;

  let tolerance = options.tolerance;
  let escalations = 0;
  let fittedEdges = fitEdges(graph, tolerance);
  let { walls, pruning, faces } = buildPruned(graph, fittedEdges, options);

  /*
    `tolerance > 0` is not decoration: doubling zero is zero, so a caller asking for no simplification
    at all would spin here forever on any face over the cap.
  */
  while (overCapCount(faces, cap) > 0 && tolerance > 0 && tolerance < ceiling) {
    tolerance = Math.min(tolerance * 2, ceiling);
    escalations += 1;
    fittedEdges = fitEdges(graph, tolerance);
    ({ walls, pruning, faces } = buildPruned(graph, fittedEdges, options));
  }
  const fitMs = performance.now() - fitStarted;

  return {
    graph,
    fittedEdges,
    walls,
    pruning,
    faces,
    skeleton: thinned.mask,
    sliversRemoved: resolved.sliversRemoved,
    sliverRounds: resolved.rounds,
    sliversLeft: resolved.sliversLeft,
    overCap: overCapCount(faces, cap),
    tolerance,
    escalations,
    timings: { thinMs, graphMs, sliverMs, fitMs },
    thinning: { before: thinned.before, after: thinned.after, passes: thinned.passes },
  };
}

/** One line for the log. */
export function describeWallDerivation(result: WallDerivation): string {
  const { graph, faces, timings } = result;
  return (
    `${faces.faces.length} faces from ${graph.nodes.length} nodes and ${graph.edges.length} ` +
    `edges (${faces.bridges} bridges, ${result.sliversRemoved} slivers removed in ` +
    `${result.sliverRounds} rounds, ${result.sliversLeft} left); ` +
    `${faces.eulerHolds ? "Euler holds" : "EULER FAILED"}; ` +
    `tolerance ${result.tolerance.toFixed(2)}px after ${result.escalations} escalations; ` +
    `thin ${Math.round(timings.thinMs)}ms, graph ${Math.round(timings.graphMs)}ms, ` +
    `slivers ${Math.round(timings.sliverMs)}ms, ` +
    `fit ${Math.round(timings.fitMs)}ms`
  );
}
