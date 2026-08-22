/**
 * Roadmap step 8, pure half — what an emitted shape is, and how the writes are grouped.
 *
 * Split from the SDK call for the standing reason: anything importing the SDK cannot be reached
 * from a node test, because its index reads `window.location.search` at module load. So every
 * *decision* lives here and only the call itself lives next door.
 *
 * ## Proposals are staged on `DRAWING`, not written to `FOG`
 *
 * Settled in a room in step 1 and recorded in DESIGN.md §4. Fog shapes ignore their own colour, so
 * a proposal sitting on the `FOG` layer cannot be marked as a proposal by appearance — which killed
 * the cheapest review model this project ever considered. Staging is better than the thing it
 * replaced:
 *
 * - On `DRAWING` an item **does** render in its own colour, so a proposal is visibly distinct.
 * - With `visible: false` the **GM sees it ghosted and players do not see it at all**, so a staging
 *   run does not leak the dungeon's layout during prep. That flag is not optional.
 * - A ghosted staged item is still selectable and editable, so the GM can nudge it.
 * - Staged items derive **zero** walls, because Dynamic Fog filters on the `FOG` layer. A proposal
 *   is inert by construction rather than by our being careful, and that is what makes a first run
 *   in a real room safe whatever it gets wrong.
 *
 * Accepting is then a property update rather than a re-emission — layer to `FOG`, `fillOpacity` to
 * 1 — so ids survive and sixty items are one call rather than sixty. The magenta is deliberately
 * left in place, so demoting restores the marking with no extra bookkeeping.
 *
 * ## Provenance is load-bearing, not decoration
 *
 * Accept, remove and re-run all have to find exactly our items and never the GM's, and a GM's scene
 * may already hold hundreds of hand-drawn fog shapes — this project's own test scene has 419. So
 * every item carries one namespaced key, and every operation filters on it.
 *
 * Pure: no DOM, no SDK.
 */

import { ringsToCommands, type PathCommandLike } from "../geometry/ring";
import { key } from "../namespace";
import type { Point } from "../map/placement";
import type { PlacedRegion } from "../map/placeRegions";

/** Marks an item as ours. Everything downstream of emission filters on exactly this. */
export const REGION_KEY = key("region");

/**
 * Ignored entirely by fog rendering — measured in a room — and useful because of it. On `DRAWING` a
 * proposal is unmistakably magenta; promoted to `FOG` the colour stops mattering and is left alone,
 * so demoting brings the marking back for free.
 */
export const PROPOSAL_COLOUR = "#ff00ff";

/**
 * Staged fill opacity.
 *
 * Half, which is what step 1 placed and what a GM could see and select. Promotion raises it to 1,
 * and that value is **required** rather than aesthetic: a fog shape below full opacity leaves a
 * translucent tint of the fog colour over ground the party has already revealed, for players as
 * well as the GM. Owlbear's own fog tool sets 1.
 */
export const STAGED_FILL_OPACITY = 0.5;
export const ACCEPTED_FILL_OPACITY = 1;

export interface RegionProvenance {
  /** Which run produced this item. A timestamp, because its job is to be read beside a log. */
  readonly run: string;
  /** Which map it was traced from, so a re-run against a different map is recognisable. */
  readonly map: string;
  readonly region: number;
  readonly squares: number;
}

/**
 * Everything needed to build one path item, expressed without the SDK's types.
 *
 * A description rather than an item, so the decisions can be tested and only the construction is
 * beyond reach of a test.
 */
export interface FogShapeSpec {
  readonly regionId: number;
  readonly position: Point;
  readonly commands: PathCommandLike[];
  readonly name: string;
  readonly provenance: RegionProvenance;
  readonly fillOpacity: number;
  readonly strokeWidth: number;
}

export interface StageOptions {
  readonly run: string;
  readonly mapId: string;
  /** In world units. Free, including zero — measured, DESIGN.md §4 — so this is purely legibility. */
  readonly strokeWidth: number;
}

/** What a region has to carry to be staged. */
export interface StageableRegion {
  readonly id: number;
  readonly placed: PlacedRegion;
  readonly squares: number;
  readonly overCap: boolean;
}

/**
 * Build the shapes for a set of regions, and say which ones were left out.
 *
 * **Regions over the command cap are skipped rather than attempted.** Owlbear refuses an oversized
 * item, and a refusal fails the whole batch it travelled in — so attempting one known-invalid shape
 * would take a few dozen valid ones down with it. Skipping and naming them is the only option that
 * emits everything emittable.
 */
export function stageShapes(
  regions: readonly StageableRegion[],
  options: StageOptions,
): { readonly shapes: FogShapeSpec[]; readonly skipped: readonly number[] } {
  const shapes: FogShapeSpec[] = [];
  const skipped: number[] = [];

  for (const region of regions) {
    const commands = ringsToCommands(region.placed.rings);
    // Checked here as well as in simplification, because this is the last place before the SDK and
    // the two arrive by different routes. Agreeing is worth nothing; disagreeing is worth a lot.
    if (region.overCap || commands.length === 0) {
      if (region.overCap) skipped.push(region.id);
      continue;
    }

    shapes.push({
      regionId: region.id,
      position: region.placed.position,
      commands,
      // Named for Outliner, with the size in it. Hundreds of these land in one scene and a list of
      // identical names is a list nobody can use; the size is also how the outside is recognised.
      name: `Fog Nudger — region ${region.id} (${region.squares.toFixed(1)} sq)`,
      provenance: {
        run: options.run,
        map: options.mapId,
        region: region.id,
        squares: Number(region.squares.toFixed(2)),
      },
      fillOpacity: STAGED_FILL_OPACITY,
      strokeWidth: options.strokeWidth,
    });
  }

  return { shapes, skipped };
}

export interface BatchLimits {
  readonly maxItems: number;
  readonly maxCommands: number;
}

/**
 * Group shapes into batches small enough to write.
 *
 * Two limits, because they guard different things. **Item count** paces the writes against the rate
 * limiter (DESIGN.md §7), which is about how much is asked for at once. **Command count** bounds
 * the payload of a single call: a batch of thirty regions each near the 8192-entry cap is a quarter
 * of a million numbers crossing a `postMessage` boundary, and the interesting failure there is not
 * a clean refusal.
 *
 * A shape larger than `maxCommands` still gets a batch of its own rather than being dropped — the
 * command limit is a batching hint, and the thing that actually decides whether an item is legal is
 * the cap, checked before this.
 */
export function planBatches(
  shapes: readonly FogShapeSpec[],
  limits: BatchLimits,
): FogShapeSpec[][] {
  const batches: FogShapeSpec[][] = [];
  let current: FogShapeSpec[] = [];
  let commands = 0;

  for (const shape of shapes) {
    const cost = shape.commands.length;
    if (
      current.length > 0 &&
      (current.length >= limits.maxItems || commands + cost > limits.maxCommands)
    ) {
      batches.push(current);
      current = [];
      commands = 0;
    }
    current.push(shape);
    commands += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Total command-array entries a set of shapes will cost. Reported so a run can be compared. */
export function totalCommands(shapes: readonly FogShapeSpec[]): number {
  let total = 0;
  for (const shape of shapes) total += shape.commands.length;
  return total;
}
