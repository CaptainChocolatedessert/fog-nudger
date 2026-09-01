/**
 * Roadmap step 8, pure half — what an emitted shape is, and how the writes are grouped.
 *
 * Split from the SDK call for the standing reason: anything importing the SDK cannot be reached
 * from a node test, because its index reads `window.location.search` at module load. So every
 * *decision* lives here and only the call itself lives next door.
 *
 * ## Everything is written straight to `FOG`, and the four values below are why this section exists
 *
 * **This described staging until 2026-08-31, and the drift shipped a defect.** Proposals used to be
 * written to `DRAWING` at low opacity and *promoted* to `FOG` on accept. Removing staging deleted
 * the promotion step — which was where the layer and the visibility were set — and left the builders
 * writing to `DRAWING` while every comment around them, including this one, said fog. A GM found it.
 *
 * So the four values an emitted item must carry are declared **together**, below, rather than spelled
 * out at the call site: layer, visibility, fill opacity, stroke width. The next edit of this kind has
 * one place to miss instead of four, and `fogShapes.test.ts` pins all four.
 *
 * Each of the four is load-bearing and none is aesthetic:
 *
 * - **`FOG`**, because Dynamic Fog filters on the layer. An item on `DRAWING` derives no walls and
 *   fogs nothing — which was the property that made staging *safe*, and is exactly what makes it
 *   wrong now.
 * - **`visible: true`**, because on the fog layer that flag is not "can this be seen". It is the
 *   difference between a shape that **is** fog and one that has been cleared. At `false` every
 *   accepted room came back revealed, which is how this was found.
 * - **Full opacity**, because below it a fog shape leaves a translucent tint of the fog colour over
 *   ground the party has already revealed.
 * - **No stroke**, because Dynamic Fog strokes the boundary and takes the outline, so a width is the
 *   gap between the two walls it derives — a band of map nobody can ever see.
 *
 * One thing carried over from the staging design, because it is still true and still surprising: a
 * fog shape **ignores its own colour**. Marking an emitted item by appearance is not available, which
 * is why the review colours live on the workspace canvas instead.
 *
 * ## Provenance is load-bearing, not decoration
 *
 * A push and a remove both have to find exactly our items and never the GM's, and a GM's scene may
 * already hold hundreds of hand-drawn fog shapes — this project's own test scene has 419. So every
 * item carries one namespaced key, and every operation filters on it. It is also what makes a
 * partial write self-healing: whatever a stopped push left behind is ours, and the next push deletes
 * all of ours before writing.
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
 * Colours a proposal can be drawn in, cycled so that neighbouring regions differ.
 *
 * **One colour was a mistake, found in a room 2026-08-22.** Every proposal was magenta and the
 * proposals cover the whole map — the exterior is emitted like any other region — so there was
 * nothing for a fill to contrast against and the map read as one flat tint. The partition, which is
 * the only thing a GM is being asked to judge, was invisible.
 *
 * **Ignored entirely by fog rendering**, which is worth knowing for two reasons. It is what makes
 * assigning a colour free — an emitted shape renders in the scene's fog colour whatever we set. And
 * it means the palette is a *preview* affordance: the workspace canvas draws the partition in these
 * colours, and the scene does not. Preview and scene are one picture by geometry, not by colour.
 *
 * *Assigned by region index, which is a heuristic and not a graph colouring.* Two adjacent regions
 * can land on the same colour. Doing it properly needs a region-adjacency graph the pipeline does
 * not build, and the stroke separates them anyway; regions are numbered by descending area, which
 * bears no relation to position, so neighbours scatter across the palette in practice.
 */
export const PROPOSAL_COLOURS = [
  "#ff00ff",
  "#00e5ff",
  "#7cff2a",
  "#ff8a1e",
  "#b58bff",
  "#ffe600",
] as const;

/**
 * The fill an emitted fog shape carries: **full**, and required rather than aesthetic.
 *
 * A fog shape below full opacity leaves a translucent tint of the fog colour over ground the party
 * has already revealed, for players as well as the GM. Owlbear's own fog tool sets 1.
 *
 * A `STAGED_FILL_OPACITY` of 0.22 sat beside this, from when proposals were staged on the drawing
 * layer at low opacity and *promoted* to fog. Staging is gone and nothing read it but its own test.
 * The low fill it described still exists — it is how the **preview** draws the partition on the
 * workspace canvas — but that is a review setting and lives with the preview.
 */
export const ACCEPTED_FILL_OPACITY = 1;

/**
 * The outline an accepted fog shape carries: **none**.
 *
 * Dynamic Fog derives its walls by *stroking* the item's path at `style.strokeWidth` and taking the
 * outline — `WallHelpers.drawingToPolylines`. So a shape with an outline W wide puts one wall at its
 * boundary minus W/2 and another at plus W/2, and the band between them can be seen into from
 * neither side. Two adjacent rooms share a centreline, so each was revealing only to centreline
 * − W/2: the half-wall reveal the whole wall-graph pivot was for, coming up short at both edges.
 *
 * **And W was the proposal-outline setting** — a review affordance, there so a GM can tell one
 * proposal from the next, silently deciding where sight is blocked. The same shape of mistake as
 * `fillOpacity`, which is why both are declared here as emission constants rather than taken from a
 * review setting. That pairing used to happen at promotion time; with staging gone there is no later
 * moment to correct them in, which is exactly why they are constants.
 *
 * **Zero rather than merely small, and that rests on a measurement**: step 1 found `strokeWidth`
 * free, including zero, with a zero-stroke shape producing exactly as many walls as a stroked one.
 * A closed path has its own boundary to stroke, so there is something there at any width. An open
 * `LINE` does not, which is why the wall lines keep a real width — see `wallLines.ts`.
 */
export const ACCEPTED_STROKE_WIDTH = 0;

/**
 * The layer an emitted item lands on, and whether it is visible there.
 *
 * **Declared beside the other two emission constants because all four are one decision**, and
 * because splitting them once already cost a round trip: when staging was removed, the promotion
 * step that used to set the layer and visibility went with it, and the item builders were left
 * writing proposals onto `DRAWING` while everything around them said fog. Nothing caught it — the
 * builders touch the SDK, so no headless test reaches them — and the first sign was a GM saying the
 * shapes had been staged rather than put on the map.
 *
 * `FOG` is what makes an item fog at all: Dynamic Fog filters on layer plus type, so walls appear on
 * arrival.
 *
 * `visible: true` is **not** "can this be seen". On the fog layer it is the difference between a
 * shape that *is* fog and one that has been **cleared**. Emitting at false is what made every room
 * come back revealed, and the SDK expresses it nowhere else: `Item` carries only `visible`, and
 * `OBR.scene.fog`'s `filled` is scene-wide styling.
 */
export const EMITTED_LAYER = "FOG" as const;
export const EMITTED_VISIBLE = true;

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
  readonly colour: string;
}

export interface StageOptions {
  readonly run: string;
  readonly mapId: string;
  /** From the review settings the GM has set; the default lives in settings.ts. */
  readonly fillOpacity: number;
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
      fillOpacity: options.fillOpacity,
      strokeWidth: options.strokeWidth,
      colour: PROPOSAL_COLOURS[shapes.length % PROPOSAL_COLOURS.length]!,
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
