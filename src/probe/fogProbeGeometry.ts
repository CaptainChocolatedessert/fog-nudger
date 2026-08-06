/**
 * Geometry for the step 1 fog-shape probe. Pure, and therefore testable.
 *
 * ## Why the path commands are built from bare numbers
 *
 * The SDK's `Command` is a TypeScript **enum**, which is a runtime value rather than a type. A
 * value import pulls in the SDK's index, which reads `window.location.search` at module load and
 * dies in a node test — so importing it here would make this module untestable, which is the whole
 * reason it is split out.
 *
 * The numbers are mirrored locally instead, and the module that *does* import the SDK asserts at
 * compile time that they still match the enum (see `fogProbe.ts`). A renumbered enum therefore
 * breaks the build rather than silently emitting the wrong path.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

/**
 * Mirrors the SDK's `Command` enum. Only the three we need.
 * Checked against the real enum in `fogProbe.ts`.
 */
export const PathOp = {
  MOVE: 0,
  LINE: 1,
  CLOSE: 5,
} as const;

/** One closed contour. An outer boundary, or — for a region with a pillar in it — a hole. */
export type Ring = readonly Vector2[];

/**
 * A path command in the SDK's shape, expressed without importing its enum.
 * Cast to `PathCommand[]` at the single SDK boundary.
 */
export type PathCommandLike = readonly [number, ...number[]];

/**
 * Turn closed rings into path commands.
 *
 * Every ring becomes `MOVE` to its first point, `LINE` to each subsequent point, then `CLOSE`.
 * The close matters for more than tidiness: an unclosed subpath leaves the final edge missing when
 * the path is stroked, and Dynamic Fog derives walls by stroking (see DESIGN.md §3), so a wall
 * would simply be absent along one side of a room.
 *
 * Holes are just further rings. With `fillRule` set to even-odd — which Dynamic Fog maps onto
 * Skia's even-odd fill type — an inner ring makes a hole regardless of which way it winds, so
 * winding direction is not something this has to get right.
 */
export function ringsToCommands(rings: readonly Ring[]): PathCommandLike[] {
  const commands: PathCommandLike[] = [];
  for (const ring of rings) {
    const first = ring[0];
    // A ring of fewer than three points encloses nothing. Emitting it would produce a degenerate
    // subpath that fills as nothing and strokes as a stray mark, which is worse than omitting it.
    if (!first || ring.length < 3) continue;
    commands.push([PathOp.MOVE, first.x, first.y]);
    for (let i = 1; i < ring.length; i++) {
      const point = ring[i];
      if (point) commands.push([PathOp.LINE, point.x, point.y]);
    }
    commands.push([PathOp.CLOSE]);
  }
  return commands;
}

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
