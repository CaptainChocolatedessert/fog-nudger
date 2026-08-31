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

/** Marks a wall line as ours. A separate key from the regions', so the two can be handled apart. */
export const WALL_KEY = key("wall");

/**
 * The stroke an accepted wall line carries: **none**, and this is an experiment.
 *
 * Dynamic Fog strokes the item at `style.strokeWidth` and takes the outline, so the width is the
 * distance between the two walls it derives — and the band between them can be seen into from
 * neither side.
 *
 * **The earlier reasoning here was wrong** (user, 2026-08-30). It said that band was the wall's own
 * thickness and read correctly as a dark stripe where the map has a wall. It does not: the party
 * should see **half the wall as drawn** from each side, meeting at the centreline. A band of fog W
 * wide down the middle of a wall is not the wall, it is a strip of the map nobody can ever see, and
 * it is unrelated to how thick the wall was actually drawn.
 *
 * At zero the two derived walls coincide *on* the centreline, each side reveals up to it, and the
 * whole drawn wall is visible between them. That is the same thing accepted shapes do, so every
 * emitted item ends up with its walls exactly on the centreline — one rule rather than two.
 *
 * **What is unmeasured, and it is the reason this is called an experiment.** A closed path has its
 * own boundary to stroke at any width, which is why zero is settled for shapes — step 1 measured it.
 * An open `LINE` has no interior and no boundary of its own, so what Skia's stroker returns at width
 * zero is genuinely unknown: possibly the line itself, which would give one wall exactly where it is
 * wanted, and possibly nothing, which would give no wall at all.
 *
 * **If it is nothing, the failure is silent** — no error, no warning, just sight passing through a
 * free-standing wall. So it wants looking at in a room before it is trusted: reveal a room with a
 * stub in it and check that the stub still blocks. Raising this to a small positive number is the
 * whole of the fix if it does not.
 */
export const ACCEPTED_WALL_STROKE = 0;

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
}

/** One wall, placed in world coordinates. */
export interface PlacedWall {
  readonly edge: number;
  readonly points: readonly Point[];
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
        name: `Fog Nudger — wall ${wall.edge}.${i}`,
        provenance: {
          run: options.run,
          map: options.mapId,
          edge: wall.edge,
          segment: i,
        },
        colour: options.colour,
        strokeWidth: options.strokeWidth,
      });
    }
  }

  return { lines, dropped };
}
