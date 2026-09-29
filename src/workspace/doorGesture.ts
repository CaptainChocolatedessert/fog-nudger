/**
 * What a press means with *Create door* in hand — pure, and tested, like every gesture decider here.
 *
 * ## The gestures (user, 2026-09-29)
 *
 * - **A click on bare wall** makes a door across the whole segment. The commonest door is a doorway
 *   walled by *Span opening*, which is one segment, so the click is the whole gesture.
 * - **A drag along a wall** makes a door along the stretch dragged, held to one segment. **The segment
 *   is chosen again on every move**, from those in reach of the press, as the one nearest the pointer —
 *   so a press on a vertex pops between its segments as the drag starts, and settles once the pointer is
 *   plainly along one.
 * - **A click on a door** removes it; **a drag from either end** moves that end; **a drag from inside it**
 *   slides the whole door along its segment. A door dragged or slid over another on the same segment
 *   merges with it.
 * - **A second click on the door the first just made**, inside a double-click, is ignored — so a
 *   double-click on bare wall leaves one door rather than making it and taking it away.
 *
 * Ends are asked first, then doors, then walls: a door's end sits on its wall and inside its own
 * stretch, so any other order would make the end unreachable.
 *
 * Pure: no DOM, no SDK. Distances are in graph units; the caller turns its screen-pixel reaches into
 * them. **Seventeen mutations, seventeen caught** — one, grabbing an end at a wall's reach, only after
 * the fixture written for it.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { doorEnds, normaliseDoors, segmentLength, type Door } from "../trace/doors";
import type { WallEdge, WallGraph } from "../trace/wallGraph";

/** What is under a press, in the order it is asked. */
export type DoorTarget =
  | { readonly kind: "end"; readonly edge: number; readonly door: number; readonly end: "start" | "end" }
  | { readonly kind: "door"; readonly edge: number; readonly door: number }
  | { readonly kind: "wall"; readonly edges: readonly number[] };

/** A door as it would be placed: which segment, and where along it. */
export interface DoorPlacement {
  readonly edge: number;
  readonly door: Door;
}

function distanceToSegment(point: Vector2, a: Vector2, b: Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const t = span > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span)) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** How far along segment a→b the point falls, held within the segment. */
function along(point: Vector2, a: Vector2, b: Vector2): number {
  const length = segmentLength(a, b);
  if (!(length > 0)) return 0;
  const d = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length;
  return Math.max(0, Math.min(length, d));
}

const ends = (graph: WallGraph, edge: WallEdge): [Vector2, Vector2] => [graph.nodes[edge.a]!, graph.nodes[edge.b]!];

/**
 * What a press at `point` lands on: a door's end within `grab`, else a door within `reach`, else every
 * wall within `reach`, nearest first — or `null`, and the press pans.
 */
export function doorTargetAt(graph: WallGraph, point: Vector2, reach: number, grab: number): DoorTarget | null {
  let bestEnd: { edge: number; door: number; end: "start" | "end"; distance: number } | null = null;
  let bestDoor: { edge: number; door: number; distance: number } | null = null;
  graph.edges.forEach((edge, index) => {
    edge.doors?.forEach((door, d) => {
      const [s, e] = doorEnds(graph, edge, door);
      for (const [which, at] of [["start", s], ["end", e]] as const) {
        const distance = Math.hypot(at.x - point.x, at.y - point.y);
        if (distance <= grab && (!bestEnd || distance < bestEnd.distance)) {
          bestEnd = { edge: index, door: d, end: which, distance };
        }
      }
      const distance = distanceToSegment(point, s, e);
      if (distance <= reach && (!bestDoor || distance < bestDoor.distance)) {
        bestDoor = { edge: index, door: d, distance };
      }
    });
  });
  const end = bestEnd as { edge: number; door: number; end: "start" | "end" } | null;
  if (end) return { kind: "end", edge: end.edge, door: end.door, end: end.end };
  const door = bestDoor as { edge: number; door: number } | null;
  if (door) return { kind: "door", edge: door.edge, door: door.door };

  const walls = graph.edges
    .map((edge, index) => ({ index, distance: distanceToSegment(point, ...ends(graph, edge)) }))
    .filter((wall) => wall.distance <= reach)
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .map((wall) => wall.index);
  return walls.length > 0 ? { kind: "wall", edges: walls } : null;
}

/** A door across the whole of one segment — what a click on bare wall makes. */
export function wholeSegment(graph: WallGraph, edge: number): DoorPlacement | null {
  const segment = graph.edges[edge];
  if (!segment) return null;
  const length = segmentLength(...ends(graph, segment));
  return length > 0 ? { edge, door: { start: 0, end: length } } : null;
}

/**
 * The door a drag along a wall would make: on whichever of `edges` is nearest the pointer, from where
 * the press falls on it to where the pointer does. `null` when it would have no length.
 */
export function stretchFrom(
  graph: WallGraph,
  edges: readonly number[],
  press: Vector2,
  pointer: Vector2,
): DoorPlacement | null {
  let chosen: number | null = null;
  let nearest = Infinity;
  for (const index of edges) {
    const segment = graph.edges[index];
    if (!segment) continue;
    const distance = distanceToSegment(pointer, ...ends(graph, segment));
    // Ties keep the earlier, which is the one nearer the press.
    if (distance < nearest) {
      nearest = distance;
      chosen = index;
    }
  }
  if (chosen === null) return null;
  const [a, b] = ends(graph, graph.edges[chosen]!);
  const from = along(press, a, b);
  const to = along(pointer, a, b);
  if (from === to) return null;
  return { edge: chosen, door: { start: Math.min(from, to), end: Math.max(from, to) } };
}

/**
 * The door with one end dragged to the pointer, held within its segment.
 *
 * **Never shorter than `minLength`**, kept on the side the end started: dragging an end back past the
 * other stops there rather than turning the door inside out (decided while building, 2026-09-29).
 */
export function dragDoorEnd(
  graph: WallGraph,
  edge: number,
  door: number,
  end: "start" | "end",
  pointer: Vector2,
  minLength: number,
): DoorPlacement | null {
  const segment = graph.edges[edge];
  const current = segment?.doors?.[door];
  if (!segment || !current) return null;
  const [a, b] = ends(graph, segment);
  const length = segmentLength(a, b);
  const shortest = Math.min(minLength, length);
  const at = along(pointer, a, b);
  if (end === "end") {
    const start = Math.min(current.start, length - shortest);
    return { edge, door: { start, end: Math.max(at, start + shortest) } };
  }
  const stop = Math.max(current.end, shortest);
  return { edge, door: { start: Math.min(at, stop - shortest), end: stop } };
}

/** The door slid along its segment by as far as the pointer has moved along it since the press. */
export function slideDoor(
  graph: WallGraph,
  edge: number,
  door: number,
  press: Vector2,
  pointer: Vector2,
): DoorPlacement | null {
  const segment = graph.edges[edge];
  const current = segment?.doors?.[door];
  if (!segment || !current) return null;
  const [a, b] = ends(graph, segment);
  const length = segmentLength(a, b);
  // Unclamped along the line, so the slide follows the pointer past the segment's ends and stops there.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const shift = length > 0 ? ((pointer.x - press.x) * dx + (pointer.y - press.y) * dy) / length : 0;
  const size = current.end - current.start;
  const start = Math.max(0, Math.min(length - size, current.start + shift));
  return { edge, door: { start, end: start + size } };
}

/** The graph with one segment's doors replaced, every other segment kept as the same object. */
function withSegmentDoors(graph: WallGraph, edge: number, doors: readonly Door[]): WallGraph {
  const segment = graph.edges[edge]!;
  const normalised = normaliseDoors(doors);
  const replaced: WallEdge =
    normalised.length > 0 ? { a: segment.a, b: segment.b, doors: normalised } : { a: segment.a, b: segment.b };
  return { nodes: graph.nodes, edges: graph.edges.map((e, i) => (i === edge ? replaced : e)) };
}

/**
 * The graph with a door placed, merging with any it overlaps on that segment — and, for a drag of an
 * existing door, with that door taken off first so it is moved rather than copied.
 */
export function placeDoor(graph: WallGraph, placement: DoorPlacement, replacing?: number): WallGraph {
  const segment = graph.edges[placement.edge];
  if (!segment) return graph;
  const kept = (segment.doors ?? []).filter((_, index) => index !== replacing);
  return withSegmentDoors(graph, placement.edge, [...kept, placement.door]);
}

/** The graph with one door taken away. */
export function removeDoor(graph: WallGraph, edge: number, door: number): WallGraph {
  const segment = graph.edges[edge];
  if (!segment?.doors?.[door]) return graph;
  return withSegmentDoors(
    graph,
    edge,
    segment.doors.filter((_, index) => index !== door),
  );
}

/**
 * The door a click just made, remembered so the second click of a double-click can be recognised.
 *
 * By its two ends in graph units rather than by index, since the save compacts and renumbers.
 */
export interface MadeDoor {
  readonly time: number;
  readonly ends: readonly [Vector2, Vector2];
}

/**
 * How long after a click another counts as its second, in milliseconds.
 *
 * **Ours, and it was meant not to be** (2026-09-29): the design took the browser's own click count, but a
 * pointer press does not carry one — the Pointer Events specification sets `detail` to 0 on
 * `pointerdown` — and a page cannot read the system's setting. 500 is Windows' default.
 */
export const DOUBLE_CLICK_MS = 500;

/**
 * Whether a press is the second click of a double-click on the door the first just made — which is
 * ignored rather than taken as a click that removes it.
 */
export function isSecondClick(
  graph: WallGraph,
  made: MadeDoor | null,
  now: number,
  target: DoorTarget | null,
): boolean {
  if (!made || now - made.time > DOUBLE_CLICK_MS || !target || target.kind === "wall") return false;
  const segment = graph.edges[target.edge];
  const door = segment?.doors?.[target.door];
  if (!segment || !door) return false;
  const [s, e] = doorEnds(graph, segment, door);
  const same = (p: Vector2, q: Vector2) => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-6;
  return (
    (same(s, made.ends[0]) && same(e, made.ends[1])) || (same(s, made.ends[1]) && same(e, made.ends[0]))
  );
}
