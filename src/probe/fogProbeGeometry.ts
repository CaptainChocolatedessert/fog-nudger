/**
 * Geometry for the step 1 fog-shape probe. Pure, and therefore testable.
 *
 * The ring and path-command machinery it used to hold moved to `geometry/ring.ts` when the trace
 * pipeline needed the same types; what is left is the hand-built shapes the probe places.
 *
 * **NOT a candidate for an unreferenced-module sweep, and it looks like one.** The probe's spec
 * table is unwired, so a reachability walk from the entry points finds nothing here — but
 * `geometry/ring.test.ts` uses both functions as the fixtures for eleven assertions about
 * `ringsToCommands`, `commandCount` and `doubleSignedArea`, all live emit-path code. The module has
 * two jobs and only one of them is retired.
 */

import type { Ring } from "../geometry/ring";

/** An axis-aligned square centred on the origin, wound clockwise. */
export function squareRing(size: number): Ring {
  const h = size / 2;
  return [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ];
}

/**
 * A square with a square hole — a room with a pillar in the middle.
 *
 * The two rings wind the *same* way deliberately. Under even-odd that still cuts a hole, and a
 * probe that quietly wound them oppositely would pass whether or not the fill rule was honoured,
 * which is exactly the diagnostic that cannot distinguish its outcomes.
 */
export function squareWithHoleRings(size: number, holeSize: number): readonly Ring[] {
  return [squareRing(size), squareRing(holeSize)];
}
