import { describe, expect, it } from "vitest";

import { commandCount, doubleSignedArea, PathOp, ringsToCommands } from "./ring";
import { squareRing, squareWithHoleRings } from "../probe/fogProbeGeometry";

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

describe("commandCount", () => {
  /**
   * The cap check runs before any commands exist, so this figure has to match what the builder
   * would actually produce. A count that drifted from the builder would let an item through that
   * the SDK then refuses — and the refusal arrives at emit time, long after the decision.
   */
  it("agrees with the builder on every shape the builder handles", () => {
    for (const rings of [
      [squareRing(10)],
      squareWithHoleRings(10, 4),
      [squareRing(10), [], squareRing(4)],
      [[{ x: 0, y: 0 }, { x: 1, y: 1 }]],
      [],
    ]) {
      expect(commandCount(rings)).toBe(ringsToCommands(rings).length);
    }
  });
});

describe("doubleSignedArea", () => {
  it("is exactly twice the area, with no rounding on lattice coordinates", () => {
    expect(doubleSignedArea(squareRing(10))).toBe(200);
  });

  it("changes sign with winding direction", () => {
    const clockwise = squareRing(10);
    expect(doubleSignedArea([...clockwise].reverse())).toBe(-200);
  });

  it("is zero for a ring that encloses nothing", () => {
    expect(doubleSignedArea([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(0);
  });
});
