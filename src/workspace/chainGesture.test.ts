/**
 * What a click means while a chain is being drawn.
 *
 * The four answers are append, close, join and finish, and every one of them is a way for the tool to
 * end up drawing something the GM did not ask for — a chain that will not stop, a loop that does not
 * close, a second point laid exactly on one that exists. None of them needs a DOM to pin.
 *
 * **Nine mutations on 2026-09-22, seven caught and two surviving deliberately**, at the foot of this
 * file — and three more for landing on the chain's own segments, all caught.
 */

import { describe, expect, it } from "vitest";

import { chainClick, chainRun, chainRunOntoSegment } from "./chainGesture";

const at = (x: number, y: number): { x: number; y: number } => ({ x, y });
/** Comfortably wider than the gaps used below, and narrower than the distances between points. */
const RADIUS = 0.02;

describe("chainClick", () => {
  it("appends when nothing has been placed yet", () => {
    expect(chainClick([], at(0.5, 0.5), null, RADIUS)).toEqual({ kind: "append" });
  });

  it("appends an ordinary click well away from everything", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1)];
    expect(chainClick(placed, at(0.3, 0.4), null, RADIUS)).toEqual({ kind: "append" });
  });

  /*
    The user's rule, 2026-09-22: clicking the last point placed stops the chain there.

    It also absorbs the draw tool's "too short to aim at" refusal, since the snap radius is wider than
    that minimum — so there is no click that silently does nothing.
  */
  it("finishes on the last point placed, however close the click", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1)];
    expect(chainClick(placed, at(0.3, 0.1), null, RADIUS)).toEqual({ kind: "finish" });
    expect(chainClick(placed, at(0.3005, 0.1005), null, RADIUS)).toEqual({ kind: "finish" });
  });

  /*
    Exactly at the radius counts as landing on the point, and this fixture exists because a mutation
    pass found nothing else pinned it: every other case here is comfortably inside or outside, so the
    boundary was decided by the code alone.
  */
  it("counts a click exactly at the radius as landing on the point", () => {
    /*
      Powers of two, so "exactly at the radius" is exact. Written with 0.02 first and it failed:
      `0.3 + 0.02` is not 0.02 away from `0.3` in binary, so the click was a hair outside and the
      fixture was testing its own arithmetic rather than the boundary.
    */
    const EXACT = 0.03125;
    const placed = [at(0.25, 0.25), at(0.5, 0.25)];
    expect(chainClick(placed, at(0.53125, 0.25), null, EXACT)).toEqual({ kind: "finish" });
    // And a hair beyond it is an ordinary click.
    expect(chainClick(placed, at(0.5625, 0.25), null, EXACT)).toEqual({ kind: "append" });
  });

  it("closes the shape on the first point", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.3)];
    expect(chainClick(placed, at(0.1, 0.1), null, RADIUS)).toEqual({ kind: "close" });
  });

  /*
    Two points, clicked back on the start. The last point is asked first, so this is only a close
    because the start is *not* the last — with one point placed the same click finishes instead, and
    there is no shape to close.
  */
  it("does not call a one-point chain a close", () => {
    expect(chainClick([at(0.1, 0.1)], at(0.1, 0.1), null, RADIUS)).toEqual({ kind: "finish" });
  });

  it("joins a middle point, which is a loop with a tail rather than a closed shape", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.3), at(0.15, 0.3)];
    expect(chainClick(placed, at(0.3, 0.1), null, RADIUS)).toEqual({ kind: "join", at: 1 });
  });

  /*
    A chain that doubles back has two candidates under one click, and the later one wins: the GM is
    pointing at where they are, not at where they were.
  */
  it("takes the nearest to the end when the chain doubles back on itself", () => {
    const placed = [at(0.1, 0.1), at(0.5, 0.1), at(0.5, 0.3), at(0.5005, 0.1005), at(0.2, 0.4)];
    expect(chainClick(placed, at(0.5, 0.1), null, RADIUS)).toEqual({ kind: "join", at: 3 });
  });

  it("finishes on a vertex the graph already has", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1)];
    expect(chainClick(placed, at(0.6, 0.6), 42, RADIUS)).toEqual({ kind: "finish" });
  });

  /*
    The chain's own points are asked before the graph's, and that ordering is the whole reason this is
    a function: a click that lands on both — the chain's start sitting on an existing vertex — has to
    close the shape rather than finish beside it.
  */
  it("closes on its own first point even when that point is an existing vertex", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.3)];
    expect(chainClick(placed, at(0.1, 0.1), 7, RADIUS)).toEqual({ kind: "close" });
  });
});

describe("landing on the chain's own segment", () => {
  /*
    The room's case: a click aimed at a line the GM is drawing. Without this it became an ordinary
    point a hair past the line, and the run crossed itself — *"it overshot a bit and created a little
    triangle on the other side"*.
  */
  const SEGMENT_RADIUS = 0.01;
  /** Powers of two, so the point *on* the segment is exact and the fixture is about the rule. */
  const placed = [at(0.125, 0.125), at(0.625, 0.125), at(0.625, 0.5)];

  it("lands on the segment under the click, at the point on it", () => {
    const answer = chainClick(placed, at(0.375, 0.13), null, RADIUS, SEGMENT_RADIUS);
    expect(answer).toEqual({ kind: "onSegment", at: 0, point: { x: 0.375, y: 0.125 } });
  });

  it("is off when no segment radius is given, which is how a point-only click is asked", () => {
    expect(chainClick(placed, at(0.375, 0.13), null, RADIUS)).toEqual({ kind: "append" });
  });

  it("appends when the click is further from the segment than its radius", () => {
    expect(chainClick(placed, at(0.375, 0.16), null, RADIUS, SEGMENT_RADIUS)).toEqual({ kind: "append" });
  });

  /*
    A point beats a segment when both are in reach, and here the point is a middle one — so the answer
    is a join at that point, not a landing on either segment meeting it.
  */
  it("gives a point the answer when both a point and a segment are in reach", () => {
    expect(chainClick(placed, at(0.625, 0.13), null, RADIUS, SEGMENT_RADIUS)).toEqual({ kind: "join", at: 1 });
  });

  /*
    **Both runs in reach at once**, which is what makes this about *nearest* rather than *first*: the
    two horizontal segments are 0.0625 apart and the radius is 0.05, so a click between them can reach
    either. A mutation pass found the earlier fixture had only one segment in reach, where first and
    nearest cannot differ.
  */
  it("takes the nearest segment when a chain doubles back over itself", () => {
    const doubled = [at(0.125, 0.125), at(0.625, 0.125), at(0.625, 0.1875), at(0.125, 0.1875)];
    const answer = chainClick(doubled, at(0.375, 0.17), null, 0.005, 0.05);
    expect(answer).toEqual({ kind: "onSegment", at: 2, point: { x: 0.375, y: 0.1875 } });
  });

  it("builds a run that puts the landing in the segment and at the end", () => {
    const run = chainRunOntoSegment(placed, 0, at(0.375, 0.125));
    expect(run).toEqual([
      at(0.125, 0.125),
      at(0.375, 0.125),
      at(0.625, 0.125),
      at(0.625, 0.5),
      at(0.375, 0.125),
    ]);
  });

  it("has no run for a segment index that names nothing", () => {
    expect(chainRunOntoSegment(placed, 5, at(0.375, 0.125))).toBeNull();
    expect(chainRunOntoSegment(placed, -1, at(0.375, 0.125))).toBeNull();
  });
});

describe("chainRun", () => {
  it("has nothing to draw from fewer than two points", () => {
    expect(chainRun([], false)).toBeNull();
    expect(chainRun([at(0.1, 0.1)], false)).toBeNull();
    expect(chainRun([at(0.1, 0.1)], true)).toBeNull();
  });

  it("runs through the points it was given", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.3)];
    expect(chainRun(placed, false)).toEqual(placed);
  });

  /*
    A closed chain repeats its first point, which is how a run is told to shut: `insertEdge` takes the
    points in order and shares a vertex by exact coordinate, so the ring's corners are shared by
    construction rather than by two coordinates happening to agree. The map frame goes in the same way.
  */
  it("repeats the first point to shut a closed chain", () => {
    const placed = [at(0.1, 0.1), at(0.3, 0.1), at(0.3, 0.3)];
    expect(chainRun(placed, true)).toEqual([...placed, at(0.1, 0.1)]);
  });
});

/*
  **The mutations, 2026-09-22 — nine run, seven caught, two surviving deliberately.**

  The four that survived the first pass were each answered rather than explained: the close's length
  guard was **deleted** as unreachable, the radius boundary got a **fixture**, and the middle sweep's
  two bounds are **kept and surviving on purpose** — a landing on the first or last point is answered
  before the sweep, so widening it would not change an answer, and the narrow bounds say what the step
  means. The list, with what each one does:

  1. Delete the check on the last point, so a one-point chain closes instead of finishing.
  2. Delete the close check, so a click on the start never shuts the shape.
  3. Walk the middle points from the start rather than the end, so a doubled-back chain joins the
     wrong one.
  4. Include the last point in the middle sweep — **survives**, unreachable, see above.
  5. Include the first point in the middle sweep — **survives**, unreachable, see above.
  6. Compare against the radius with `<` rather than `<=`, so a click exactly at the radius appends.
  7. Ignore `onNode`, so a click on an existing vertex appends instead of finishing.
  8. Let `chainRun` return a single point rather than null.
  9. Leave the repeat off a closed run, so the shape never shuts.

  A tenth was run and retired rather than recorded: the close's `placed.length > 1` guard, which
  survived because it could not fire. It is deleted, so there is nothing left to mutate.

  **Landing on the chain's own segments — three more, all caught:** asking the segments before the
  points; taking the first segment in reach rather than the nearest; and leaving the landing out of the
  segment it fell on, so the run ends at it without splitting there. The second of those **survived its
  first fixture**, which had only one segment within reach — where first and nearest cannot differ. The
  fixture now puts two runs 0.0625 apart with a radius of 0.05.
*/
