/**
 * Suppress region: marks, which regions they suppress, and what is emitted without those regions.
 *
 * A GM who clicks with the tool leaves a **mark** — a point in graph units (user, 2026-09-16). A
 * region holding a mark is **suppressed**: it is not drawn as a room and not emitted as a shape, so
 * it stays fogged and can never be revealed, exactly like the outside. Its walls stay.
 *
 * ## A point, because regions have no identity
 *
 * Regions are recomputed from the walls after every edit and carry nothing that survives one, so the
 * only thing a mark can be is a place. What it suppresses is whichever region is there now, and the
 * consequences are the intent rather than a compromise (user):
 *
 * - **Merge** a suppressed region into a room — erase the wall between, or dissolve it — and the
 *   merged room holds the mark, so all of it is suppressed.
 * - **Split** one by drawing a wall through it, and only the side holding the mark stays suppressed.
 * - **Rebuild** the walls from a slider, and the mark survives, suppressing whatever region the new
 *   walls make there. Marks are not a hand edit to the walls, so placing one locks nothing.
 * - **A mark outside every region** suppresses nothing, and is kept: walls drawn round it later give
 *   it something to suppress.
 *
 * ## The emit rule does not change
 *
 * **A wall emits as a line exactly when no emitted region's boundary covers it** — the rule §3 has
 * always stated, which until now had every region in "emitted". Suppressing one takes it out of that
 * set and nothing else: a wall it shares with an emitted neighbour is still covered by the neighbour's
 * shape, and a wall it shares with nothing emitted comes out as a line. A closed room inside nothing,
 * suppressed, becomes a closed chain of lines.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { regionAt } from "./dissolve";
import type { WallFaces } from "./wallFaces";
import type { WallGraph } from "./wallGraph";

/** The regions the marks suppress, as ascending indices into `faces.faces`. */
export function suppressedRegions(faces: WallFaces, marks: readonly Vector2[]): number[] {
  const found = new Set<number>();
  for (const mark of marks) {
    const region = regionAt(faces, mark);
    if (region !== null) found.add(region);
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * The traversal as it will be emitted: suppressed regions left out, and the walls recounted.
 *
 * Everything else about the traversal is kept as it was — the checks, the counts and `sourceEdges` —
 * because they describe the graph, which suppression does not touch. **`faces` and `walls` are the
 * two fields that describe what is emitted**, and both change together here so they cannot disagree.
 *
 * `walls` is every wall of the graph that no remaining region's rings cover, ascending, which with
 * nothing suppressed is exactly the traversal's own list — segments of no length included, since no
 * ring ever covers one.
 */
export function withoutSuppressed(
  graph: WallGraph,
  faces: WallFaces,
  suppressed: readonly number[],
): WallFaces {
  if (suppressed.length === 0) return faces;
  const gone = new Set(suppressed);
  const kept = faces.faces.filter((_, index) => !gone.has(index));

  const covered = new Uint8Array(graph.edges.length);
  for (const face of kept) for (const edge of face.ringEdges) covered[edge] = 1;
  const walls: number[] = [];
  for (let edge = 0; edge < graph.edges.length; edge++) if (covered[edge] !== 1) walls.push(edge);

  return {
    ...faces,
    faces: kept,
    walls,
    degenerateFaces: kept.filter((face) => face.doubleArea === 0).length,
  };
}

/**
 * The mark within `radius` of a point, or `null` — what a click with the tool would remove.
 *
 * The nearest when several are in reach, and the lower index on a tie, so an answer does not change
 * between frames while the pointer holds still. `radius` is in graph units; the tool turns it from
 * screen pixels.
 */
export function markAt(marks: readonly Vector2[], point: Vector2, radius: number): number | null {
  let best: number | null = null;
  let bestDistance = radius * radius;
  for (let index = 0; index < marks.length; index++) {
    const dx = marks[index]!.x - point.x;
    const dy = marks[index]!.y - point.y;
    const distance = dx * dx + dy * dy;
    if (distance > bestDistance) continue;
    if (best !== null && distance === bestDistance) continue;
    best = index;
    bestDistance = distance;
  }
  return best;
}

/**
 * The marks as stored: a flat list of coordinates.
 *
 * **Quantised when a mark is placed, not here** — with `documentPoint`, as a wall's points are — so
 * the marks in memory are already the numbers storage will hand back, and a mark placed this session
 * compares equal to the same mark read next session. Plain numbers rather than a binary encoding:
 * marks are placed one click at a time, so a scene holds tens of them, not thousands.
 */
export function encodeMarks(marks: readonly Vector2[]): number[] {
  const flat: number[] = [];
  for (const mark of marks) flat.push(mark.x, mark.y);
  return flat;
}

/**
 * Marks from what was stored, or `null` when it cannot be read.
 *
 * **All or nothing**, as a wall graph is and for the same reason: a list with one pair dropped has
 * every later mark shifted by a coordinate, which is a different and entirely plausible set of marks.
 * A list of odd length fails on its last pair, whose second number is missing. Quantised again on the
 * way in, so a store written by anything else cannot put a double where a float32 is expected.
 */
export function decodeMarks(stored: unknown): Vector2[] | null {
  if (!Array.isArray(stored)) return null;
  const marks: Vector2[] = [];
  for (let at = 0; at < stored.length; at += 2) {
    const x = stored[at];
    const y = stored[at + 1];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    marks.push({ x: Math.fround(x), y: Math.fround(y) });
  }
  return marks;
}
