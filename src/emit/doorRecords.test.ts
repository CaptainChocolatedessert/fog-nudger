import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import { PathOp, type PathCommandLike } from "../geometry/ring";
import { createPlacement, toWorldPoint, type Point, type WorldBounds } from "../map/placement";
import { doorEnds, normaliseDoors, segmentLength, type Door } from "../trace/doors";
import { randomWallGraph, seededRandom } from "../trace/fixtures";
import type { GraphExtent } from "../trace/graphUnits";
import { documentPoint, type WallEdge, type WallGraph } from "../trace/wallGraph";
import type { DoorRecord } from "./doorRecords";
import { stageShapes } from "./fogShapes";
import { stageWallLines } from "./wallLines";
import { wallEmission } from "./wallEmission";

/*
  ## The oracle: Dynamic Fog's own measure, restated

  Dynamic Fog finds a door by walking the drawing's path with CanvasKit's `ContourMeasureIter(path, false,
  1)`: contours in order, a new one at each move, a closed contour measured round its closing side too,
  and a contour of no length skipped. `pointAt` does exactly that over the commands the push writes —
  never over the rings or the graph — and the check is that the two distances in each record land on the
  two ends of a door in the graph, placed in the world the way the push places everything.

  The map is placed out of proportion, twice as stretched across as down, so a record measured in graph
  units rather than world units would miss.
*/

const BOUNDS: WorldBounds = { min: { x: 300, y: -200 }, max: { x: 2700, y: 700 } };
const EXTENT: GraphExtent = { x: 1, y: Math.fround(0.75) };
const DPI = 150;
const placement = createPlacement(BOUNDS, EXTENT.x, EXTENT.y);
const world = (point: Vector2): Point => toWorldPoint(placement, point.x, point.y);

/** The contours of a written path, as lists of points, a closed one ending back at its start. */
function contoursOf(position: Point, commands: readonly PathCommandLike[]): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] | null = null;
  for (const command of commands) {
    if (command[0] === PathOp.MOVE) {
      if (current) contours.push(current);
      current = [{ x: position.x + command[1]!, y: position.y + command[2]! }];
    } else if (command[0] === PathOp.LINE) {
      current!.push({ x: position.x + command[1]!, y: position.y + command[2]! });
    } else if (command[0] === PathOp.CLOSE) {
      current!.push(current![0]!);
      contours.push(current!);
      current = null;
    }
  }
  if (current) contours.push(current);
  // A contour of no length is skipped by the iterator, so it takes no index.
  return contours.filter((points) => lengthOf(points) > 0);
}

function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

function pointAt(points: readonly Point[], distance: number): Point {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= step || i === points.length - 1) {
      const t = step > 0 ? left / step : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= step;
  }
  return points[0]!;
}

function withRandomDoors(graph: WallGraph, next: () => number): WallGraph {
  const edges: WallEdge[] = graph.edges.map((edge) => {
    const length = segmentLength(graph.nodes[edge.a]!, graph.nodes[edge.b]!);
    if (next() > 0.4 || !(length > 0.02)) return edge;
    // Now and then the whole segment, which is what a click makes and what reaches a ring's closing side.
    if (next() < 0.25) return { a: edge.a, b: edge.b, doors: normaliseDoors([{ start: 0, end: length }]) };
    const s = next() * length;
    const e = next() * length;
    const doors: Door[] = [{ start: Math.min(s, e), end: Math.max(s, e) }];
    const normalised = normaliseDoors(doors).filter((door) => door.end <= length && door.end - door.start > 1e-3);
    return normalised.length > 0 ? { a: edge.a, b: edge.b, doors: normalised } : edge;
  });
  return { nodes: graph.nodes, edges };
}

// A thousandth of a world unit: a door's ends are float32 distances in graph units, which at this
// map's scale is a few ten-thousandths of a world unit at worst.
const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= 1e-3;

describe("door records, measured the way Dynamic Fog measures them", () => {
  it("puts every door on exactly one item, at the right place along the right contour", () => {
    const next = seededRandom(31);
    const reached = { line: 0, ring: 0, hole: 0, closingSide: 0, shared: 0, suppressed: 0 };
    let doors = 0;
    for (let seed = 0; seed < 400; seed++) {
      const graph = withRandomDoors(randomWallGraph(next, 3 + Math.floor(next() * 7)), next);
      // A cross now and then, so some walls a room would carry go out as lines instead.
      const marks = next() < 0.3 ? [documentPoint(next(), next() * 0.75)] : [];
      const emission = wallEmission(graph, BOUNDS, DPI, EXTENT, marks);
      if (!emission.faces.eulerHolds) continue;
      if (marks.length > 0 && emission.suppressed > 0) reached.suppressed += 1;
      const { shapes, skipped } = stageShapes(emission.regions, { run: "t", mapId: "m", fillOpacity: 1, strokeWidth: 0 });
      expect(skipped).toHaveLength(0);
      const { lines } = stageWallLines(emission.walls, { run: "t", mapId: "m", colour: "#000", strokeWidth: 0 });

      // Every door in the graph, as its two ends in the world.
      const expected: [Point, Point][] = [];
      for (const edge of graph.edges) {
        for (const door of edge.doors ?? []) {
          const [p, q] = doorEnds(graph, edge, door);
          expected.push([world(p), world(q)]);
        }
      }
      doors += expected.length;
      expect(emission.doors.unplaced).toBe(0);

      const found: [Point, Point][] = [];
      const check = (record: DoorRecord, contours: Point[][]) => {
        expect(record.start.index).toBe(record.end.index);
        expect(record.start.distance).toBeLessThanOrEqual(record.end.distance);
        expect(record.open).toBe(false);
        const contour = contours[record.start.index]!;
        expect(contour).toBeDefined();
        const length = lengthOf(contour);
        expect(record.end.distance).toBeLessThanOrEqual(length + 1e-6);
        // Within one side: Dynamic Fog would carry a door across a vertex, and ours never cross one.
        let before = 0;
        let oneSide = false;
        for (let i = 1; i < contour.length; i++) {
          const step = Math.hypot(contour[i]!.x - contour[i - 1]!.x, contour[i]!.y - contour[i - 1]!.y);
          if (record.start.distance >= before - 1e-9 && record.end.distance <= before + step + 1e-9) oneSide = true;
          before += step;
        }
        expect(oneSide).toBe(true);
        if (Math.abs(record.end.distance - length) < 1e-6 && contours.length > 0 && contour.length > 2) {
          reached.closingSide += 1;
        }
        found.push([pointAt(contour, record.start.distance), pointAt(contour, record.end.distance)]);
      };
      for (const shape of shapes) {
        const contours = contoursOf(shape.position, shape.commands);
        for (const record of shape.doors ?? []) {
          check(record, contours);
          reached.ring += 1;
          if (record.start.index > 0) reached.hole += 1;
        }
      }
      for (const line of lines) {
        const contour = [line.position, { x: line.position.x + line.end.x, y: line.position.y + line.end.y }];
        for (const record of line.doors ?? []) {
          expect(record.start.index).toBe(0);
          check(record, [contour]);
          reached.line += 1;
        }
      }

      // Matched one for one, ends either way round.
      expect(found).toHaveLength(expected.length);
      const left = [...found];
      for (const [p, q] of expected) {
        const at = left.findIndex(([a, b]) => (near(a, p) && near(b, q)) || (near(a, q) && near(b, p)));
        expect(at, `a door from (${p.x}, ${p.y}) to (${q.x}, ${q.y})`).toBeGreaterThanOrEqual(0);
        left.splice(at, 1);
      }

      // A wall two rooms share carries its door once, on one of them.
      graph.edges.forEach((edge, index) => {
        if (!edge.doors) return;
        const rooms = emission.faces.faces.filter((face) => face.ringEdges.includes(index)).length;
        if (rooms > 1) reached.shared += 1;
      });
    }
    expect(doors).toBeGreaterThan(500);
    for (const [kind, count] of Object.entries(reached)) expect(count, kind).toBeGreaterThan(10);
  });

  it("writes nothing when there are no doors", () => {
    const next = seededRandom(5);
    const emission = wallEmission(randomWallGraph(next, 6), BOUNDS, DPI, EXTENT);
    expect(emission.doors).toEqual({ placed: 0, unplaced: 0 });
    expect(emission.regions.every((region) => region.doors === undefined)).toBe(true);
    expect(emission.walls.every((wall) => wall.doors === undefined)).toBe(true);
  });
});
