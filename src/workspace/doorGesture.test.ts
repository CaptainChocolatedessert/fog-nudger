import type { Vector2 } from "@owlbear-rodeo/sdk";
import { describe, expect, it } from "vitest";

import { doorEnds } from "../trace/doors";
import { documentPoint, type WallGraph } from "../trace/wallGraph";
import {
  DOUBLE_CLICK_MS,
  doorTargetAt,
  dragDoorEnd,
  isSecondClick,
  placeDoor,
  removeDoor,
  slideDoor,
  stretchFrom,
  wholeSegment,
} from "./doorGesture";

const p = (x: number, y: number): Vector2 => documentPoint(x, y);

/*
  A corner: a horizontal wall from (0.1, 0.5) to (0.5, 0.5), and a vertical one from (0.5, 0.5) down to
  (0.5, 0.9). The horizontal one has a door from x = 0.2 to x = 0.3.
*/
const CORNER: WallGraph = {
  nodes: [p(0.1, 0.5), p(0.5, 0.5), p(0.5, 0.9)],
  edges: [
    { a: 0, b: 1, doors: [{ start: Math.fround(0.1), end: Math.fround(0.2) }] },
    { a: 1, b: 2 },
  ],
};

const REACH = 0.02;
const GRAB = 0.022;

describe("doorTargetAt", () => {
  it("finds a door's end before the door, and the door before its wall", () => {
    expect(doorTargetAt(CORNER, p(0.2, 0.505), REACH, GRAB)).toEqual({ kind: "end", edge: 0, door: 0, end: "start" });
    expect(doorTargetAt(CORNER, p(0.3, 0.5), REACH, GRAB)).toEqual({ kind: "end", edge: 0, door: 0, end: "end" });
    expect(doorTargetAt(CORNER, p(0.25, 0.51), REACH, GRAB)).toEqual({ kind: "door", edge: 0, door: 0 });
    expect(doorTargetAt(CORNER, p(0.4, 0.51), REACH, GRAB)).toEqual({ kind: "wall", edges: [0] });
  });

  it("grabs an end at its own reach, a little further than a wall's", () => {
    // 0.021 from the door's end: past a wall's reach and inside a grab. Written because a mutation
    // grabbing ends at the wall's reach survived the fixtures above.
    expect(doorTargetAt(CORNER, p(0.3, 0.521), REACH, GRAB)).toEqual({ kind: "end", edge: 0, door: 0, end: "end" });
  });

  it("offers every wall in reach, nearest first, and nothing away from them", () => {
    expect(doorTargetAt(CORNER, p(0.495, 0.51), REACH, GRAB)).toEqual({ kind: "wall", edges: [1, 0] });
    expect(doorTargetAt(CORNER, p(0.3, 0.7), REACH, GRAB)).toBeNull();
  });
});

describe("wholeSegment", () => {
  it("spans the segment from end to end", () => {
    const placed = wholeSegment(CORNER, 1)!;
    expect(placed.edge).toBe(1);
    expect(placed.door.start).toBe(0);
    expect(placed.door.end).toBeCloseTo(0.4, 6);
  });
});

describe("stretchFrom", () => {
  it("runs from the press to the pointer along the wall nearest the pointer", () => {
    const placed = stretchFrom(CORNER, [0], p(0.35, 0.51), p(0.45, 0.49))!;
    expect(placed.edge).toBe(0);
    expect(placed.door.start).toBeCloseTo(0.25, 6);
    expect(placed.door.end).toBeCloseTo(0.35, 6);
  });

  it("chooses again as the drag goes, so a press on a vertex follows the pointer's wall", () => {
    const press = p(0.5, 0.5);
    expect(stretchFrom(CORNER, [0, 1], press, p(0.4, 0.502))!.edge).toBe(0);
    expect(stretchFrom(CORNER, [0, 1], press, p(0.502, 0.6))!.edge).toBe(1);
  });

  it("stops at the segment's end, and makes nothing of a drag with no length along it", () => {
    const placed = stretchFrom(CORNER, [0], p(0.4, 0.5), p(0.9, 0.5))!;
    expect(placed.door.end).toBeCloseTo(0.4, 6);
    expect(stretchFrom(CORNER, [0], p(0.3, 0.5), p(0.3, 0.45))).toBeNull();
  });
});

describe("dragDoorEnd", () => {
  it("moves the one end and leaves the other", () => {
    const placed = dragDoorEnd(CORNER, 0, 0, "end", p(0.35, 0.52), 0.01)!;
    expect(placed.door.start).toBeCloseTo(0.1, 6);
    expect(placed.door.end).toBeCloseTo(0.25, 6);
  });

  it("stops at the segment's end", () => {
    expect(dragDoorEnd(CORNER, 0, 0, "start", p(0, 0.5), 0.01)!.door.start).toBe(0);
  });

  it("never turns the door inside out, holding it at the shortest length on its own side", () => {
    const placed = dragDoorEnd(CORNER, 0, 0, "end", p(0.1, 0.5), 0.01)!;
    expect(placed.door.start).toBeCloseTo(0.1, 6);
    expect(placed.door.end).toBeCloseTo(0.11, 6);
    const back = dragDoorEnd(CORNER, 0, 0, "start", p(0.45, 0.5), 0.01)!;
    expect(back.door.end).toBeCloseTo(0.2, 6);
    expect(back.door.start).toBeCloseTo(0.19, 6);
  });
});

describe("slideDoor", () => {
  it("moves the whole door by how far the pointer moved along the wall", () => {
    const placed = slideDoor(CORNER, 0, 0, p(0.25, 0.5), p(0.3, 0.55))!;
    expect(placed.door.start).toBeCloseTo(0.15, 6);
    expect(placed.door.end).toBeCloseTo(0.25, 6);
  });

  it("stops at either end of the segment, keeping its length", () => {
    const placed = slideDoor(CORNER, 0, 0, p(0.25, 0.5), p(0.9, 0.5))!;
    expect(placed.door.end).toBeCloseTo(0.4, 6);
    expect(placed.door.end - placed.door.start).toBeCloseTo(0.1, 6);
    expect(slideDoor(CORNER, 0, 0, p(0.25, 0.5), p(-0.5, 0.5))!.door.start).toBe(0);
  });
});

describe("placeDoor and removeDoor", () => {
  it("merges a new door with one it overlaps, and leaves every other segment as the same object", () => {
    const next = placeDoor(CORNER, { edge: 0, door: { start: 0.15, end: 0.3 } });
    expect(next.edges[0]!.doors).toEqual([{ start: Math.fround(0.1), end: Math.fround(0.3) }]);
    expect(next.edges[1]).toBe(CORNER.edges[1]);
  });

  it("moves a door it replaces rather than copying it", () => {
    const next = placeDoor(CORNER, { edge: 0, door: { start: 0.25, end: 0.35 } }, 0);
    expect(next.edges[0]!.doors).toEqual([{ start: Math.fround(0.25), end: Math.fround(0.35) }]);
  });

  it("removes a door, and a segment left with none carries no door list", () => {
    const next = removeDoor(CORNER, 0, 0);
    expect(next.edges[0]).toEqual({ a: 0, b: 1 });
    expect(removeDoor(CORNER, 1, 0)).toBe(CORNER);
  });
});

describe("isSecondClick", () => {
  const ends = doorEnds(CORNER, CORNER.edges[0]!, CORNER.edges[0]!.doors![0]!);
  const made = { time: 1000, ends };

  it("takes a click on the door just made, inside the interval, as the second click", () => {
    expect(isSecondClick(CORNER, made, 1000 + DOUBLE_CLICK_MS - 1, { kind: "door", edge: 0, door: 0 })).toBe(true);
    expect(
      isSecondClick(CORNER, { time: 1000, ends: [ends[1], ends[0]] }, 1100, { kind: "end", edge: 0, door: 0, end: "start" }),
    ).toBe(true);
  });

  it("takes anything later, anywhere else, or on bare wall as a click of its own", () => {
    expect(isSecondClick(CORNER, made, 1000 + DOUBLE_CLICK_MS + 1, { kind: "door", edge: 0, door: 0 })).toBe(false);
    expect(isSecondClick(CORNER, made, 1100, { kind: "wall", edges: [0] })).toBe(false);
    expect(isSecondClick(CORNER, null, 1100, { kind: "door", edge: 0, door: 0 })).toBe(false);
    const other = { time: 1000, ends: [p(0.1, 0.5), p(0.15, 0.5)] as const };
    expect(isSecondClick(CORNER, other, 1100, { kind: "door", edge: 0, door: 0 })).toBe(false);
  });
});
