/**
 * Regions from the wall graph — the deriving half of step D, end to end.
 *
 * Ink in, simplified rings out, by way of the skeleton rather than the space between the strokes.
 * The chain is thin, prune, chain-and-weld, label, walk the faces, filter, fit.
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
 * ## The smallest-room filter, and what happens to a hole
 *
 * A face below the minimum is not emitted. A hole is kept only when the face on the other side of it
 * survives, which is the same containment rule the region-first pipeline used and for the same
 * reason: a hole's area includes the wall around whatever is inside it, so a size test on a hole
 * means something different from a size test on a room.
 *
 * **Stated limitation:** containment is checked one step across, not transitively. A discarded face
 * that itself contains a surviving one leaves its hole filled. Nothing on the test map produces that
 * shape, and the honest fix is a containment walk rather than a bigger threshold.
 *
 * Pure: no DOM, no SDK.
 */

import { commandCount, doubleSignedArea, MIN_RING_POINTS, type Ring } from "../geometry/ring";
import type { BinaryMask } from "./binarize";
import { fitFaces, resolveFaces, type GraphFace, type GraphFaces } from "./faces";
import { labelSpace, type LabelledSpace } from "./label";
import { COMMAND_CAP } from "./simplify";
import { pruneSpurs } from "./spurs";
import { thin } from "./thinning";
import { buildWallGraph, type WallGraph } from "./wallGraph";

export interface GraphRegionOptions {
  /** Longest dead-end branch to prune from the skeleton, in pixels walked. Zero is off. */
  readonly spurPrunePx: number;
  /** Smallest face kept, in pixels. */
  readonly minArea: number;
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
   * Carried so the census and the point probe read the *same* partition the faces came from rather
   * than a second one derived beside it. Its `discarded` counts are the faces the filter dropped,
   * not anything the labelling itself refused — labelling runs with no minimum, because the area
   * identity compares against a pixel count and a filtered count would have holes in it.
   */
  readonly labelled: LabelledSpace;
  readonly regions: readonly GraphRegion[];
  /** The skeleton the graph came from, before the border frame was painted on. */
  readonly skeleton: BinaryMask;
  readonly discarded: number;
  readonly discardedArea: number;
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

/** Pixels a face covers, from its doubled signed area. */
function faceArea(face: GraphFace): number {
  return face.doubleArea / 2;
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

  const survives = new Set<number>();
  let discarded = 0;
  let discardedArea = 0;
  for (const face of faces.faces) {
    if (faceArea(face) >= options.minArea) survives.add(face.label);
    else {
      discarded += 1;
      // The labelling's pixel count rather than the polygon's area, so the figure means the same
      // thing as every other area in the census.
      discardedArea += face.interior;
    }
  }

  // Carried out with the survivors only, so the census and the probe describe what was emitted.
  const filteredLabelling: LabelledSpace = {
    ...labelled,
    regions: labelled.regions.filter((region) => survives.has(region.id)),
    discarded,
    discardedArea,
  };

  // Which face sits on the other side of a cycle, so the hole rule has something to ask.
  const faceOfHalfEdge = new Map<number, number>();
  for (const face of faces.faces) {
    for (const cycle of face.cycles) {
      for (const half of cycle.halfEdges) faceOfHalfEdge.set(half, face.label);
    }
  }

  // The bridge criterion: an edge with the same face on both sides is a wall no region boundary
  // can ever cover, because there is only one region there. Step E emits these as lines.
  let bridges = 0;
  for (let edge = 0; edge < graph.edges.length; edge += 1) {
    const left = faceOfHalfEdge.get(edge * 2);
    const right = faceOfHalfEdge.get(edge * 2 + 1);
    if (left !== undefined && left === right) bridges += 1;
  }

  const kept = faces.faces.filter((face) => survives.has(face.label));

  const fitStarted = performance.now();
  const ceiling = Math.max(options.tolerance, options.maxTolerance);
  const cap = options.maxCommands ?? COMMAND_CAP;

  let tolerance = options.tolerance;
  let escalations = 0;
  let built = assemble(graph, kept, faceOfHalfEdge, survives, tolerance);

  // `tolerance > 0` is not decoration: doubling zero is zero, so a caller asking for no
  // simplification at all would spin here forever on any region over the cap.
  while (built.regions.some((region) => region.commands > cap) && tolerance > 0 && tolerance < ceiling) {
    tolerance = Math.min(tolerance * 2, ceiling);
    escalations += 1;
    built = assemble(graph, kept, faceOfHalfEdge, survives, tolerance);
  }
  const fitMs = performance.now() - fitStarted;

  return {
    graph,
    faces,
    labelled: filteredLabelling,
    regions: built.regions.map((region) => ({ ...region, overCap: region.commands > cap })),
    skeleton: pruned.mask,
    discarded,
    discardedArea,
    bridges,
    degenerateCycles: built.degenerateCycles,
    filledHoles: built.filledHoles,
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
  tolerance: number,
): {
  regions: Omit<GraphRegion, "overCap">[];
  degenerateCycles: number;
  filledHoles: number;
} {
  const { rings: fittedRings } = fitFaces(graph, kept, tolerance);
  const regions: Omit<GraphRegion, "overCap">[] = [];
  let degenerateCycles = 0;
  let filledHoles = 0;

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
        // A hole. Kept only when the face on its far side survived the minimum.
        const inside = cycle.halfEdges
          .map((half) => faceOfHalfEdge.get(half ^ 1))
          .filter((label): label is number => label !== undefined && label !== face.label);
        if (inside.length > 0 && !inside.some((label) => survives.has(label))) {
          filledHoles += 1;
          return;
        }
      }

      const fitted = fittedRings[index]![cycleIndex]!;
      // A ring small against the tolerance collapses to two points and stops being a shape at all,
      // which for a region means the room vanishes. Vertices are the cheap thing here and a room is
      // not, so the original is kept instead.
      if (fitted.length < MIN_RING_POINTS) {
        preserved += 1;
        rings.push([...cycle.points]);
      } else {
        rings.push(fitted);
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

  return { regions, degenerateCycles, filledHoles };
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
    `edges (${result.discarded} below the minimum, ${result.bridges} bridges, ` +
    `${result.sliversRemoved} slivers removed in ${result.sliverRounds} rounds, ` +
    `${result.filledHoles} holes filled); ${exact}; tolerance ${result.tolerance.toFixed(2)}px ` +
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
