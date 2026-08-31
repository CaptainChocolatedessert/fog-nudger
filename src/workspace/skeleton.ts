/**
 * The skeleton: thinning the ink to centrelines, and pruning the hairs off them.
 *
 * ## A view, and only a view — step C
 *
 * Nothing here is emitted and nothing downstream reads it: the regions are still derived from the
 * ink mask. That is the whole point of building it in this order. Spur density and stub survival on
 * a real hand-drawn map are what reasoning cannot settle, and finding out this way costs a view
 * rather than a rewrite of the emit path.
 *
 * ## Two costs, split, because only one of them is expensive
 *
 * Thinning walks the ink until nothing more can be deleted, which is the slow half and depends only
 * on the mask. Pruning walks the branches of the result, which is cheap and depends on a slider a GM
 * is going to sweep. So the thinned skeleton is kept and the prune is redone on top of it — the same
 * split as the reading cache one level up, for the same reason and at a much smaller scale.
 *
 * ## Lazy, like the partition
 *
 * A new reading marks this stale; only *entering* the Walls step pays for it. A GM tuning the
 * threshold is not looking at centrelines, and thinning eight hundred thousand ink pixels on every
 * slider release to draw something nobody can see is exactly the kind of cost that arrives without
 * being decided.
 */

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import type { BinaryMask } from "../trace/binarize";
import { pruneSpurs } from "../trace/spurs";
import { thin } from "../trace/thinning";
import { resolveFaces } from "../trace/faces";
import { labelSpace } from "../trace/label";
import { buildWallGraph, type WallGraph } from "../trace/wallGraph";
import { MaskRequests, shouldPaint } from "./maskRequest";
import { onReading } from "./reading";
import { currentSettings } from "./settingsState";
import { invalidate, isClosing, say } from "./shell";

const requests = new MaskRequests();

/** The ink this skeleton is of, kept so a prune can be redone without re-thinning. */
let source: BinaryMask | null = null;
/** Thinning's own output, before pruning. */
let thinned: BinaryMask | null = null;
/** What the layer draws: thinned, then pruned to the current setting. */
let current: BinaryMask | null = null;
/**
 * The graph built from it, which is what the faces are actually made of.
 *
 * Drawn as well as the pixels, and that is the point: the weld radius is a control that can be
 * wrong — too large and it merges two genuinely distinct junctions, closing a doorway — and nothing
 * in the skeleton's pixels would show it. One node where there should be two does.
 */
let graph: WallGraph | null = null;

let watching = false;
let stale = true;

export function currentSkeleton(): BinaryMask | null {
  return current;
}

export function currentGraph(): WallGraph | null {
  return graph;
}

export function skeletonShowing(): boolean {
  return shouldPaint(requests.current());
}

/** Called when the Walls step opens or closes. Entering it is what pays for the thinning. */
export function watchSkeleton(open: boolean): void {
  watching = open;
  if (open && stale) rebuild();
}

/** The prune changed. Cheap, so it does not wait for anything. */
export function invalidateSkeleton(): void {
  requests.request();
  invalidate();
  if (watching) rebuild(thinned !== null);
}

/**
 * Rebuild what the layer draws.
 *
 * Synchronous, and that is a decision rather than an oversight. Thinning is the expensive half and it
 * is measured below; if a room reports the Walls step stalling, the answer is the same one the
 * reading has — a worker, or a crop to the visible region — and not a second implementation here.
 */
function rebuild(reuseThinned = false): void {
  if (isClosing() || !source) return;
  const generation = requests.latest();

  try {
    if (!reuseThinned || !thinned) {
      const started = performance.now();
      const result = thin(source);
      thinned = result.mask;
      devLog(
        "info",
        `workspace: thinned ${result.before} ink pixels to ${result.after} in ` +
          `${Math.round(performance.now() - started)}ms over ${result.passes} passes`,
      );
    }

    const settings = currentSettings().trace;
    const budget = settings.spurPrunePx;
    const started = performance.now();
    const pruned = pruneSpurs(thinned, budget);
    current = pruned.mask;

    /*
      The graph is cleaned before it is drawn, exactly as the derivation cleans it.

      Building it is not enough. A junction cluster leaves sub-pixel faces, and removing them merges
      nodes and joins edges — so the raw graph and the one the regions are actually made of are not
      the same graph. On this project's test map that is 762 nodes against 59. Drawing the raw one
      put marks on screen for junctions that do not exist downstream, which is the preview lying
      about the thing this step exists to judge.

      The labelling is the cost: `resolveFaces` needs it to tell a sliver from a face. It is the same
      pass the derivation runs and lands around thirty milliseconds on a map-sized raster, against
      the sixty-odd that thinning already costs here.
    */
    const graphStarted = performance.now();
    const built = buildWallGraph(current);
    const resolved = resolveFaces(built, labelSpace(built.framed, { minArea: 0 }));
    graph = resolved.graph;
    const graphMs = Math.round(performance.now() - graphStarted);
    stale = false;
    requests.fulfil(generation);
    invalidate();

    const skeletonPixels = countInk(current);
    devLog(
      "info",
      `workspace: pruned ${pruned.removed} spurs (${pruned.pixels} px) in ` +
        `${pruned.rounds} rounds, ${Math.round(performance.now() - started)}ms — ` +
        `${skeletonPixels} skeleton pixels at budget ${budget}px`,
    );
    devLog(
      "info",
      `workspace: graph — ${built.stats.chains} chains into ${built.nodes.length} nodes and ` +
        `${built.edges.length} edges, then ${resolved.sliversRemoved} sub-pixel slivers removed in ` +
        `${resolved.rounds} rounds leaving ${graph.nodes.length} nodes and ${graph.edges.length} ` +
        `edges, ${graphMs}ms (${graph.stats.orphans} orphaned pixels)`,
    );
    say(
      (budget <= 0
        ? `${skeletonPixels} skeleton pixels, unpruned`
        : `${skeletonPixels} skeleton pixels · ${pruned.removed} spurs pruned`) +
        ` · ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    );
  } catch (error) {
    const detail = describeError(error);
    requests.fail(generation);
    say(`the skeleton failed: ${detail}`, "bad");
    devLog("error", "workspace: thinning failed", detail);
    console.error("Fog Nudger — thinning failed", error);
  }
}

function countInk(mask: BinaryMask): number {
  let ink = 0;
  for (const value of mask.data) if (value === 1) ink += 1;
  return ink;
}

/**
 * A new reading is a new skeleton.
 *
 * Thinned from the **composed** ink rather than the mask that is drawn — the repaired breaks are
 * what a wall graph must treat as wall, since a repair asserts that two segments are connected, and
 * a skeleton built from the unrepaired ink would show them as two.
 */
export function registerSkeletonInvalidation(): void {
  onReading((result) => {
    source = result.composed;
    thinned = null;
    stale = true;
    requests.request();
    if (watching) rebuild();
  });
}
