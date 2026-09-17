/**
 * What stage two puts on the map: the wall graph's faces, placed in the world.
 *
 * Stage one emits what the trace made of the map. Once a graph is saved, the map is no longer what the
 * rooms are made of — the GM's graph is — so the emit path needs a second *source*. This is it, and
 * it is deliberately only a source: the shapes, the wall lines, the deletion, the batching and the
 * provenance are all the existing ones, because those are where the hard-won behaviour lives.
 *
 * ## Placement reuses the raster's own path, at a raster the size of the extent
 *
 * A wall graph is stored in graph units, and `createPlacement` maps a raster linearly onto the map's
 * world bounds — so a **raster of `extent.x` by `extent.y` is exactly graph-unit space**, and the
 * ordinary placement puts a point where it belongs with no second implementation to keep in step.
 * That matters more than the lines it saves: this project's placement carries per-axis scaling and a
 * stated position on rotation, and a parallel "graph units to world" routine would be a second
 * opinion about all of it.
 *
 * Per-axis scaling is what keeps a stretched map working. A GM who drags a map out of proportion in
 * Owlbear changes its world box and not its image, so the graph's extent stays the image's and each
 * axis stretches to the box — the fog follows the map, as it did when the unit was a fraction.
 *
 * ## What cannot be done here, and is reported instead
 *
 * Stage one meets the command cap by simplifying harder and refitting everything. **Stage two must
 * not**: the vertices are the GM's, and moving them to fit a limit would edit their work to make it
 * transmissible. So an oversized face is skipped and named, which is the same answer stage one gives
 * once its ladder runs out. It should not arise — the trace stores the *escalated* fitted set, so
 * what was within the cap when it was built is within it now, and editing adds points a handful at a
 * time — but "should not arise" is not "cannot", and a silent truncation would be worse than a
 * missing room.
 *
 * Pure: no DOM, no SDK. The bounds and the grid are passed in.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { commandCount, type Ring } from "../geometry/ring";
import {
  createPlacement,
  toWorldPoint,
  type Point,
  type WorldBounds,
} from "../map/placement";
import { placeRegions } from "../map/placeRegions";
import { COMMAND_CAP } from "../trace/simplify";
import { suppressedRegions, withoutSuppressed } from "../trace/suppression";
import { buildWallFaces, wallSegments, type WallFaces } from "../trace/wallFaces";
import type { GraphExtent } from "../trace/graphUnits";
import type { WallGraph } from "../trace/wallGraph";
import type { StageableRegion } from "./fogShapes";

/** A wall the rings do not cover, in world units, as `stageWallLines` wants it. */
export interface PlacedWall {
  readonly edge: number;
  readonly points: readonly Point[];
}

export interface WallEmission {
  readonly regions: readonly StageableRegion[];
  readonly walls: readonly PlacedWall[];
  /** The traversal behind it, so the caller can log the check rather than re-deriving to find it. */
  readonly faces: WallFaces;
  /** Regions left out because a mark suppressed them. */
  readonly suppressed: number;
}

/**
 * Place the wall graph's faces and uncovered walls into the world.
 *
 * `dpi` is world units per grid square, and it only decides the size written into an item's **name**
 * and provenance. Nothing about the geometry depends on the grid, which is the standing rule — a GM
 * who never set a grid gets a wrong-looking number in a label rather than fog in the wrong place.
 *
 * `extent` is the map image's size in graph units, from the image's own pixel size.
 *
 * `marks` are the GM's suppression marks. A region holding one is not emitted, and the walls it alone
 * covered go out as lines — the bridge criterion with that region out of the emitted set, which is
 * all suppression changes here. `faces` on the result is the traversal as emitted, so its checks
 * still describe the whole graph while its regions and walls describe what was written.
 */
export function wallEmission(
  graph: WallGraph,
  bounds: WorldBounds,
  dpi: number,
  extent: GraphExtent,
  marks: readonly Vector2[] = [],
): WallEmission {
  const walked = buildWallFaces(graph);
  const suppressed = suppressedRegions(walked, marks);
  const faces = withoutSuppressed(graph, walked, suppressed);
  // A raster the size of the extent, because the rings are already in graph units. See the note above.
  const placement = createPlacement(bounds, extent.x, extent.y);

  const worldWidth = Math.abs(bounds.max.x - bounds.min.x);
  const worldHeight = Math.abs(bounds.max.y - bounds.min.y);
  // One guard, not two: the division below already refuses a non-positive square, and a second
  // check here was a branch no input could tell apart from its own absence.
  const squareArea = dpi * dpi;

  const placed = placeRegions(
    faces.faces.map((face, index) => ({ id: index, rings: face.rings })),
    placement,
  );

  const regions: StageableRegion[] = placed.map((region, index) => {
    const face = faces.faces[index]!;
    // Graph units² to world to grid squares: one graph unit is the box's width over the extent's
    // along x, and likewise along y. The doubled signed area halves, and a hole's negative term is
    // already in the sum, so a room with a courtyard reports the floor it actually has.
    const worldArea =
      (Math.abs(face.doubleArea) / 2) * (worldWidth / extent.x) * (worldHeight / extent.y);
    return {
      id: index,
      placed: region,
      squares: squareArea > 0 ? worldArea / squareArea : 0,
      overCap: commandCount(region.rings as readonly Ring[]) > COMMAND_CAP,
    };
  });

  const walls: PlacedWall[] = wallSegments(graph, faces).map((segment, index) => ({
    edge: index,
    points: segment.map((point) => toWorldPoint(placement, point.x, point.y)),
  }));

  return { regions, walls, faces, suppressed: suppressed.length };
}
