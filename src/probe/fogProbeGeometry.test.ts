import { describe, expect, it } from "vitest";

import {
  PathOp,
  ringsToCommands,
  squareRing,
  squareWithHoleRings,
} from "./fogProbeGeometry";

describe("squareRing", () => {
  it("is centred on the origin and has the requested side length", () => {
    expect(squareRing(10)).toEqual([
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 },
    ]);
  });

  it("does not repeat the first point as the last", () => {
    // Closing is the CLOSE command's job. A repeated point would put a zero-length edge in the
    // path, which strokes into a dot at one corner of every room.
    const ring = squareRing(10);
    expect(ring[ring.length - 1]).not.toEqual(ring[0]);
  });
});

describe("ringsToCommands", () => {
  it("opens with a move, lines to the rest, and closes", () => {
    expect(ringsToCommands([squareRing(2)])).toEqual([
      [PathOp.MOVE, -1, -1],
      [PathOp.LINE, 1, -1],
      [PathOp.LINE, 1, 1],
      [PathOp.LINE, -1, 1],
      [PathOp.CLOSE],
    ]);
  });

  /**
   * An unclosed subpath fills the same but strokes with its final edge missing — and Dynamic Fog
   * derives walls by stroking, so the wall would simply be absent along one side of a room. The
   * failure is invisible in the fog and only appears as sight leaking through a wall in play.
   */
  it("closes every ring, not just the last", () => {
    const commands = ringsToCommands(squareWithHoleRings(10, 4));
    const closes = commands.filter((command) => command[0] === PathOp.CLOSE);
    expect(closes).toHaveLength(2);
  });

  it("emits exactly one move per ring", () => {
    // The failure this catches is emitting MOVE for every point, which produces a path of
    // disconnected dots that fills as nothing at all.
    const commands = ringsToCommands(squareWithHoleRings(10, 4));
    expect(commands.filter((command) => command[0] === PathOp.MOVE)).toHaveLength(2);
    expect(commands.filter((command) => command[0] === PathOp.LINE)).toHaveLength(6);
  });

  it("keeps the hole ring rather than dropping it", () => {
    const withHole = ringsToCommands(squareWithHoleRings(10, 4));
    const withoutHole = ringsToCommands([squareRing(10)]);
    expect(withHole.length).toBeGreaterThan(withoutHole.length);
  });

  it("skips rings that enclose nothing", () => {
    // Fewer than three points is a degenerate subpath: it fills as nothing and strokes as a stray
    // mark on the map. Silently dropping it is right; emitting it is a visible artefact.
    expect(ringsToCommands([[]])).toEqual([]);
    expect(ringsToCommands([[{ x: 0, y: 0 }]])).toEqual([]);
    expect(ringsToCommands([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toEqual([]);
  });

  it("drops only the degenerate ring, keeping its neighbours", () => {
    const commands = ringsToCommands([squareRing(10), [], squareRing(4)]);
    expect(commands.filter((command) => command[0] === PathOp.MOVE)).toHaveLength(2);
  });
});

describe("squareWithHoleRings", () => {
  /**
   * The two rings wind the same way on purpose. Under even-odd that still cuts a hole, so the probe
   * tests the fill rule rather than accidentally relying on winding — a fixture that wound them
   * oppositely would pass whether or not the fill rule was honoured, and could not tell the two
   * outcomes apart.
   */
  it("winds the hole the same way as the outer ring", () => {
    const [outer, hole] = squareWithHoleRings(10, 4);
    expect(outer).toBeDefined();
    expect(hole).toBeDefined();
    expect(signedArea(outer!)).toBeGreaterThan(0);
    expect(signedArea(hole!)).toBeGreaterThan(0);
  });

  it("puts the hole inside the outer ring", () => {
    const [outer, hole] = squareWithHoleRings(10, 4);
    expect(Math.abs(signedArea(hole!))).toBeLessThan(Math.abs(signedArea(outer!)));
  });
});

function signedArea(ring: readonly { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
