/**
 * Walls that no fog shape's boundary covers, emitted the way Dynamic Fog emits one.
 *
 * ## Why a `LINE` per segment, and not something tidier
 *
 * Read from Dynamic Fog's source (`createLineMode.ts`): a wall drawn with its own tool is an
 * ordinary **`LINE`** item — two points, on the `FOG` layer, taking its stroke width and colour from
 * the scene's fog settings, with the end stored relative to the item's position. There is no fill
 * anywhere, because a `LINE` has no interior *by type*. That is the property that matters: Owlbear
 * reads a fog item's interior as revealable ground, and a wall must reveal nothing.
 *
 * The tidier alternatives all fail on that same point. An open subpath inside a `PATH` risks being
 * implicitly closed for filling, which reveals a sliver of floor along every free-standing wall. And
 * leaving the wall as the zero-width slit our traversal already walks — which was proposed and
 * rejected — would put our internal representation into the scene and leave two other renderers to
 * interpret a degenerate excursion. A human drawing this in Owlbear draws the room, then draws the
 * wall; that is what we emit.
 *
 * **The cost, stated:** a fitted polyline of n points becomes n − 1 items. A wall is therefore
 * several items in the Outliner rather than one, and a GM nudging one segment moves only that
 * segment. In exchange nothing depends on undefined behaviour in someone else's renderer, and a
 * two-point item cannot have a vertex inserted into it.
 *
 * ## Vertex ids were here, and were removed — 2026-08-31
 *
 * Each segment used to carry the ids of its two ends, so that grouping emitted items by id would
 * reconstruct the graph: a stub's junction is the same id in the room's ring and in the stub's first
 * segment, and a free tip is an id used once, which is what told a stub from a doorway.
 *
 * The scheme is gone because **the scene never has to be read back** — everything the graph is
 * derived from lives in scene metadata and survives everything the scene survives, so the graph is
 * always one re-run away. `faces.ts` carries the full reasoning and, more usefully, what would bring
 * the ids back.
 *
 * Pure: no DOM, no SDK.
 */

import type { Point } from "../map/placement";
import { key } from "../namespace";
import type { DoorRecord } from "./doorRecords";

/** Marks a wall line as ours. A separate key from the regions', so the two can be handled apart. */
export const WALL_KEY = key("wall");

/*
  `ACCEPTED_WALL_STROKE`, zero, was here. A wall line takes the same stroke as a room's shape now —
  the scene's fog stroke width, never under 2 — which `fogShapes.ts` declares with the measurement
  that ended zero: at zero, an open door anywhere in the scene took the walls of most lines with it.
*/

export interface WallProvenance {
  /** Which run produced this item. A timestamp, because its job is to be read beside a log. */
  readonly run: string;
  readonly map: string;
  /** The graph edge this segment came from, so a broken chain is traceable to one wall. */
  readonly edge: number;
  /** Where along that edge, so the segments of one wall have an order. */
  readonly segment: number;
}

/** Everything needed to build one line item, expressed without the SDK's types. */
export interface WallLineSpec {
  readonly position: Point;
  /** Relative to `position`, which is how Dynamic Fog's own wall mode stores a line. */
  readonly end: Point;
  readonly name: string;
  readonly provenance: WallProvenance;
  readonly colour: string;
  readonly strokeWidth: number;
  /** Doors it carries, written into Dynamic Fog's metadata key on the item. */
  readonly doors?: readonly DoorRecord[];
}

/** One wall, placed in world coordinates. */
export interface PlacedWall {
  readonly edge: number;
  readonly points: readonly Point[];
  /**
   * Its doors, measured from its first point. Only a wall of one segment can carry them — every wall
   * the push hands in is — since a door on a line is measured along that one line item.
   */
  readonly doors?: readonly DoorRecord[];
}

export interface WallLineOptions {
  readonly run: string;
  readonly mapId: string;
  /** The colour to emit at. The push takes the scene's own fog colour, so ours match a GM's. */
  readonly colour: string;
  /** In world units. */
  readonly strokeWidth: number;
}

/**
 * Cut each wall into its segments and describe one line item per segment.
 *
 * A zero-length segment is dropped rather than emitted: it would be an item nobody can see or
 * select, and it can only arise from a fitted polyline that repeated a point.
 */
export function stageWallLines(
  walls: readonly PlacedWall[],
  options: WallLineOptions,
): { readonly lines: WallLineSpec[]; readonly dropped: number } {
  const lines: WallLineSpec[] = [];
  let dropped = 0;

  for (const wall of walls) {
    for (let i = 1; i < wall.points.length; i++) {
      const from = wall.points[i - 1]!;
      const to = wall.points[i]!;
      if (from.x === to.x && from.y === to.y) {
        dropped += 1;
        continue;
      }

      lines.push({
        position: from,
        end: { x: to.x - from.x, y: to.y - from.y },
        // Named for the Outliner. Hundreds land in one scene, and which wall a segment belongs to
        // is the only thing worth reading there.
        name: `Fog Nudger wall ${wall.edge}.${i}`,
        provenance: {
          run: options.run,
          map: options.mapId,
          edge: wall.edge,
          segment: i,
        },
        colour: options.colour,
        strokeWidth: options.strokeWidth,
        ...(wall.doors && wall.doors.length > 0 && wall.points.length === 2 ? { doors: wall.doors } : {}),
      });
    }
  }

  return { lines, dropped };
}
