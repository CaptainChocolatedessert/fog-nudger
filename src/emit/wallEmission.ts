/**
 * What stage two puts on the map: the wall graph's faces, placed in the world.
 *
 * Stage one emits what the trace made of the map. Once a graph is saved, the map is no longer what the
 * rooms are made of — the GM's graph is — so the emit path needs a second *source*. This is it, and
 * it is deliberately only a source: the shapes, the wall lines, the deletion, the batching and the
 * provenance are all the existing ones, because those are where the hard-won behaviour lives.
 *
 * ## Placement reuses the raster's own path, at a raster of one by one
 *
 * A wall graph is stored in fractions of the map's extent, and `createPlacement` maps a raster
 * linearly onto the map's world bounds — so a **1×1 raster is exactly fraction space**, and the
 * ordinary placement puts a fraction where it belongs with no second implementation to keep in step.
 * That matters more than the lines it saves: this project's placement carries per-axis scaling and a
 * stated position on rotation, and a parallel "fractions to world" routine would be a second opinion
 * about all of it. The workspace's partition layer already leans on the same identity.
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

import { commandCount, type Ring } from "../geometry/ring";
import {
  createPlacement,
  toWorldPoint,
  type Point,
  type WorldBounds,
} from "../map/placement";
import { placeRegions } from "../map/placeRegions";
import { COMMAND_CAP } from "../trace/simplify";
import { buildWallFaces, wallSegments, type WallFaces } from "../trace/wallFaces";
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
}

/**
 * Place the wall graph's faces and uncovered walls into the world.
 *
 * `dpi` is world units per grid square, and it only decides the size written into an item's **name**
 * and provenance. Nothing about the geometry depends on the grid, which is the standing rule — a GM
 * who never set a grid gets a wrong-looking number in a label rather than fog in the wrong place.
 */
export function wallEmission(
  graph: WallGraph,
  bounds: WorldBounds,
  dpi: number,
): WallEmission {
  const faces = buildWallFaces(graph);
  // One by one, because the rings are already fractions of the map. See the note above.
  const placement = createPlacement(bounds, 1, 1);

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
    // Fraction² to world to grid squares. The doubled signed area halves, and a hole's negative
    // term is already in the sum, so a room with a courtyard reports the floor it actually has.
    const worldArea = (Math.abs(face.doubleArea) / 2) * worldWidth * worldHeight;
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

  return { regions, walls, faces };
}
