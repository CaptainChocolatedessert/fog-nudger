/**
 * Doors: stretches of a wall segment that Dynamic Fog opens and closes at the table.
 *
 * ## A door is a property of its segment
 *
 * Stored **on** the segment it belongs to (`WallEdge.doors`), not in a list beside the graph (2026-09-29,
 * decided in the design). An edit reports only the new graph and two counts — never which old segments
 * became which new ones — so a door kept apart would have to be found again after every edit by
 * geometry, which needs a matching tolerance, and §5's identity rule forbids one. On the segment, a door
 * belongs to that wall by construction: it can never jump to another, and erasing the segment takes it.
 *
 * What that costs is that **every place that rebuilds a segment has to carry the door across**: a split,
 * a move, a merge, Straighten and compaction. `planarOps.ts` and `compactNodes` do; everything that only
 * filters the edge list keeps the objects, doors and all.
 *
 * ## Distances from the segment's `a` end
 *
 * A door is two distances along its segment, in graph units, measured from the end the segment names
 * first. Unchanged when nothing moves the segment, so an edit that does not touch a wall cannot nudge its
 * door by a rounding step; quantised with `Math.fround` like every coordinate, so the store's round trip
 * is exact. Two doors on one segment never overlap — `normaliseDoors` merges them — and a door never
 * crosses a vertex, because Dynamic Fog cannot run one across two of our line items (§10).
 *
 * ## The one rule after an edit moves a segment
 *
 * **The door keeps its place on the map and its length** (user, 2026-09-26): its midpoint is projected
 * onto what the segment has become, it keeps its length, and it is slid inward to fit — shrunk only when
 * the segment is now shorter than it. A new vertex landing strictly inside it removes it; undo brings it
 * back.
 *
 * **Twenty-four mutations** across this module, the carrying in `planarOps.ts` and the store, **twenty-four
 * caught** — one, a decoded door of no length, only after the fixture written for it. The sweep in the
 * tests checks every edit that rebuilds a segment against an oracle that works from geometry alone.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { documentCoordinate, type WallEdge, type WallGraph } from "./wallGraph";

export interface Door {
  /** Distance from the segment's `a` end to the door's nearer end, in graph units. */
  readonly start: number;
  /** Distance from the segment's `a` end to the door's farther end. Always greater than `start`. */
  readonly end: number;
}

/**
 * A door as two points in graph units, taken from its segment before an edit moves it.
 *
 * The form a door travels in through an edit: points survive a segment being moved, merged into a chord
 * or reversed, where distances from an end that has moved would not.
 */
export interface CarriedDoor {
  readonly p: Vector2;
  readonly q: Vector2;
}

/** The length of a segment, in graph units. */
export function segmentLength(a: Vector2, b: Vector2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point `distance` along the segment from `a` towards `b`. */
export function pointAlong(a: Vector2, b: Vector2, distance: number): Vector2 {
  const length = segmentLength(a, b);
  if (!(length > 0)) return { x: a.x, y: a.y };
  const t = distance / length;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** A door's two ends, in graph units. */
export function doorEnds(graph: WallGraph, edge: WallEdge, door: Door): [Vector2, Vector2] {
  const a = graph.nodes[edge.a]!;
  const b = graph.nodes[edge.b]!;
  return [pointAlong(a, b, door.start), pointAlong(a, b, door.end)];
}

/** The segment's doors as points, ready to carry through an edit. Empty when it has none. */
export function carryDoors(nodes: readonly Vector2[], edge: WallEdge): CarriedDoor[] {
  if (!edge.doors || edge.doors.length === 0) return [];
  const a = nodes[edge.a]!;
  const b = nodes[edge.b]!;
  return edge.doors.map((door) => ({ p: pointAlong(a, b, door.start), q: pointAlong(a, b, door.end) }));
}

/**
 * Doors as distances, quantised, sorted, and with every overlap merged.
 *
 * **Touching counts as overlapping**: two doors meeting end to end are one opening, and as two records
 * they would be toggled separately at the table. A door of no length is dropped.
 */
export function normaliseDoors(doors: readonly Door[]): Door[] {
  const sorted = doors
    .map((door) => ({ start: documentCoordinate(door.start), end: documentCoordinate(door.end) }))
    .filter((door) => Number.isFinite(door.start) && Number.isFinite(door.end) && door.end > door.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Door[] = [];
  for (const door of sorted) {
    const last = merged[merged.length - 1];
    if (last && door.start <= last.end) {
      if (door.end > last.end) merged[merged.length - 1] = { start: last.start, end: door.end };
    } else {
      merged.push(door);
    }
  }
  return merged;
}

/**
 * One door placed on a segment of length `length` around a centre `centre` distances from its start.
 *
 * The rule, stated once: keep the length, shrink only to the segment's own length, and slide inward
 * until it fits.
 */
export function fitDoor(centre: number, doorLength: number, length: number): Door | null {
  if (!(length > 0) || !(doorLength > 0)) return null;
  const kept = Math.min(doorLength, length);
  const start = Math.min(Math.max(centre - kept / 2, 0), length - kept);
  return { start, end: start + kept };
}

/**
 * Carried doors re-placed on a segment from `a` to `b`, by the rule in this module's header.
 *
 * Normalised on the way out, so doors from several old segments landing on one chord — which is what
 * Straighten produces — merge where they now overlap.
 */
export function placeDoors(carried: readonly CarriedDoor[], a: Vector2, b: Vector2): Door[] {
  const length = segmentLength(a, b);
  if (!(length > 0) || carried.length === 0) return [];
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const placed: Door[] = [];
  for (const { p, q } of carried) {
    const centre = ((p.x + q.x) / 2 - a.x) * ux + ((p.y + q.y) / 2 - a.y) * uy;
    const door = fitDoor(centre, segmentLength(p, q), length);
    if (door) placed.push(door);
  }
  return normaliseDoors(placed);
}

/**
 * A segment's doors divided among the pieces a split makes of it.
 *
 * `cuts` are distances along the whole segment, ascending; `pieces` holds each piece's own length, one
 * more than there are cuts. **A cut strictly inside a door removes it** — the door would otherwise cross
 * the new vertex. A cut exactly at a door's end leaves it whole on the piece it lies in. Each survivor is
 * re-measured from its piece's start and held within the piece, whose quantised ends can sit a rounding
 * step off the line it was cut from.
 */
export function cutDoors(
  doors: readonly Door[],
  cuts: readonly number[],
  pieces: readonly number[],
): Door[][] {
  const out: Door[][] = pieces.map(() => []);
  if (doors.length === 0) return out;
  const bounds = [0, ...cuts];
  for (const door of doors) {
    if (cuts.some((cut) => cut > door.start && cut < door.end)) continue;
    // The last piece whose start is not past the door's start is the one holding it.
    let piece = 0;
    for (let i = 1; i < bounds.length; i++) if (bounds[i]! <= door.start) piece = i;
    const offset = bounds[piece]!;
    const length = pieces[piece]!;
    const start = Math.max(0, door.start - offset);
    const end = Math.min(length, door.end - offset);
    if (end > start) out[piece]!.push({ start, end });
  }
  return out.map((list) => normaliseDoors(list));
}

/** A segment record, with its doors only when it has any — so a door-free graph is shaped as before. */
export function withDoors(a: number, b: number, doors: readonly Door[] | undefined): WallEdge {
  return doors && doors.length > 0 ? { a, b, doors } : { a, b };
}

/** How many doors the graph holds. */
export function doorCount(graph: WallGraph): number {
  let count = 0;
  for (const edge of graph.edges) count += edge.doors?.length ?? 0;
  return count;
}
