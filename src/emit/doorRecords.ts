/**
 * Doors as Dynamic Fog stores them, on the shapes and lines a push writes.
 *
 * ## Dynamic Fog's record, read from its source
 *
 * A door is not an item. It is an entry in the `rodeo.owlbear.dynamic-fog/doors` list in the metadata
 * of the fog drawing it was cut into: `{ open, start, end }`, each end `{ index, distance }` — which
 * contour of the drawing's own path, and how far along it. Dynamic Fog finds that contour with CanvasKit's
 * `ContourMeasureIter(path, false, 1)`, takes the stretch between the two distances (the smaller first),
 * strokes it at the drawing's stroke width plus 20 with butt ends, and while the door is open subtracts
 * that from every wall in the scene — whichever drawing the wall came from. Two ends naming different
 * contours are refused with a console warning (`PathHelpers.getSkPathBetween`).
 *
 * So a push writes each door **exactly as Dynamic Fog would**, on the item that carries its wall
 * (user, 2026-09-26): a GM editing it at the table meets an ordinary door. Written **closed**, every
 * push, since nothing is read back.
 *
 * ## Which item, and where along it
 *
 * - **A wall that goes out as a line** carries its doors itself: contour 0, measured from the line's start,
 *   which is its segment's `a` end.
 * - **A wall on a room's outline** carries them on the first emitted room whose rings cover it. One record
 *   is enough for a wall two rooms share, because the cut is global.
 * - **The contour is the ring's place among the room's subpaths**, counting only the rings
 *   `ringsToCommands` writes, and **the distance runs from the ring's first point** along its sides,
 *   closing side included — `ContourMeasureIter` measures it because every ring ends in `CLOSE`. A
 *   door never crosses a vertex, so it never crosses a ring's start either, and a door on the closing
 *   side simply runs up to the ring's full length.
 *
 * Distances are in the item's own units, which are world units: our items sit at scale 1, and a
 * path's commands are relative to its position, which moves the ring and measures nothing.
 *
 * **Twelve mutations, eleven caught and one equivalent** — one caught only after a fixture for the
 * order walls are numbered in. The equivalent one counts every ring as a contour: the traversal already
 * drops the rings `ringsToCommands` would, so the guard here decides nothing today and is kept so the
 * two agree across a module boundary if either ever moves.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { MIN_RING_POINTS } from "../geometry/ring";
import type { Point } from "../map/placement";
import { doorEnds } from "../trace/doors";
import type { WallFaces } from "../trace/wallFaces";
import type { WallGraph } from "../trace/wallGraph";

/** Where Dynamic Fog keeps a drawing's doors. Its key, not ours: the one place this writes into it. */
export const DYNAMIC_FOG_DOORS_KEY = "rodeo.owlbear.dynamic-fog/doors";

/** One end of a door: which contour of the drawing's path, and how far along it. */
export interface ContourMarker {
  readonly index: number;
  readonly distance: number;
}

/** One door, in Dynamic Fog's shape. */
export interface DoorRecord {
  readonly open: boolean;
  readonly start: ContourMarker;
  readonly end: ContourMarker;
}

export interface EmittedDoors {
  /** By the emitted room's index among the faces handed in. */
  readonly regions: ReadonlyMap<number, DoorRecord[]>;
  /** By the graph segment a wall line carries. */
  readonly walls: ReadonlyMap<number, DoorRecord[]>;
  /** Doors whose wall no emitted item carries — which should not happen, and is counted if it does. */
  readonly unplaced: number;
}

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Every door in the graph as a Dynamic Fog record, on the item that will carry its wall.
 *
 * `faces` is the traversal **as emitted** — suppressed rooms already out — and `toWorld` places a point
 * in graph units into the world, as the push places everything else.
 */
export function doorRecords(
  graph: WallGraph,
  faces: WallFaces,
  toWorld: (point: Vector2) => Point,
): EmittedDoors {
  const regions = new Map<number, DoorRecord[]>();
  const walls = new Map<number, DoorRecord[]>();

  const hasDoors = graph.edges.some((edge) => edge.doors && edge.doors.length > 0);
  if (!hasDoors) return { regions, walls, unplaced: 0 };

  const asLine = new Set(faces.walls);
  const placed = new Set<number>();

  // Walls that go out as lines: contour 0, from the segment's `a` end, which is where the line starts.
  for (const index of asLine) {
    const edge = graph.edges[index];
    if (!edge?.doors || edge.doors.length === 0) continue;
    const from = toWorld(graph.nodes[edge.a]!);
    const length = distance(from, toWorld(graph.nodes[edge.b]!));
    const records = edge.doors.map((door) => {
      const [p, q] = doorEnds(graph, edge, door).map(toWorld) as [Point, Point];
      return record(0, 0, length, distance(from, p), distance(from, q));
    });
    walls.set(index, records);
    placed.add(index);
  }

  // Walls on a room's outline: the first room, in emitted order, whose rings cover them.
  faces.faces.forEach((face, faceIndex) => {
    let contour = 0;
    face.rings.forEach((ring, r) => {
      // The rings `ringsToCommands` leaves out are no contour of the written path.
      if (ring.length < MIN_RING_POINTS) return;
      const halves = face.ringHalfEdges[r]!;
      const world = ring.map(toWorld);
      let along = 0;
      for (let i = 0; i < world.length; i++) {
        const from = world[i]!;
        const to = world[(i + 1) % world.length]!;
        const side = distance(from, to);
        const half = halves[i]!;
        const index = faces.sourceEdges[half >> 1]!;
        const edge = graph.edges[index]!;
        if (edge.doors && edge.doors.length > 0 && !placed.has(index)) {
          const list = regions.get(faceIndex) ?? [];
          for (const door of edge.doors) {
            const [p, q] = doorEnds(graph, edge, door).map(toWorld) as [Point, Point];
            // Measured from the side's own start, which is the segment's `a` end walked forward and its
            // `b` end walked back — so no direction has to be worked out, only a distance.
            list.push(record(contour, along, side, distance(from, p), distance(from, q)));
          }
          regions.set(faceIndex, list);
          placed.add(index);
        }
        along += side;
      }
      contour += 1;
    });
  });

  let unplaced = 0;
  graph.edges.forEach((edge, index) => {
    if (edge.doors && edge.doors.length > 0 && !placed.has(index)) unplaced += edge.doors.length;
  });
  return { regions, walls, unplaced };
}

/**
 * One record, for a door `from` and `to` along a side of length `side` that starts `along` into its
 * contour.
 *
 * **Held within the side.** A door's end is a float32 distance, which can round a hair past the vertex
 * it reaches — and a record running past a vertex runs into the next side, which is exactly what a door
 * may not do. Found by the oracle, at three millionths of a world unit.
 */
function record(index: number, along: number, side: number, from: number, to: number): DoorRecord {
  const within = (d: number) => along + Math.max(0, Math.min(side, d));
  return {
    open: false,
    start: { index, distance: within(Math.min(from, to)) },
    end: { index, distance: within(Math.max(from, to)) },
  };
}
