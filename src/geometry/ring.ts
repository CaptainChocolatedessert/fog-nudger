/**
 * Closed rings, and the path commands they become.
 *
 * A *ring* is one closed contour with no repeated closing point. A region is a list of them: one
 * outer boundary, plus one further ring per hole. Under an even-odd fill rule — which is what we
 * emit, and which Dynamic Fog maps onto Skia's even-odd (DESIGN.md §4) — an inner ring cuts a hole
 * whichever way it winds, so nothing downstream has to get winding direction right.
 *
 * ## Why the path commands are built from bare numbers
 *
 * The SDK's `Command` is a TypeScript **enum**, which is a runtime value rather than a type. A
 * value import pulls in the SDK's index, which reads `window.location.search` at module load and
 * dies in a node test — so importing it here would make this module untestable, and the whole
 * pipeline hangs off it.
 *
 * The numbers are mirrored locally instead, and the module that *does* import the SDK asserts at
 * compile time that they still match the enum (see `probe/fogProbe.ts`). A renumbered enum
 * therefore breaks the build rather than silently emitting the wrong path.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

/**
 * Mirrors the SDK's `Command` enum. Only the three we need.
 * Checked against the real enum in `probe/fogProbe.ts`.
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

/** A ring of fewer than this encloses nothing, and is dropped rather than emitted. */
export const MIN_RING_POINTS = 3;

/**
 * Turn closed rings into path commands.
 *
 * Every ring becomes `MOVE` to its first point, `LINE` to each subsequent point, then `CLOSE`.
 * The close matters for more than tidiness: an unclosed subpath leaves the final edge missing when
 * the path is stroked, and Dynamic Fog derives walls by stroking (see DESIGN.md §3), so a wall
 * would simply be absent along one side of a room.
 */
export function ringsToCommands(rings: readonly Ring[]): PathCommandLike[] {
  const commands: PathCommandLike[] = [];
  for (const ring of rings) {
    const first = ring[0];
    // A degenerate subpath fills as nothing and strokes as a stray mark, which is worse than
    // omitting it.
    if (!first || ring.length < MIN_RING_POINTS) continue;
    commands.push([PathOp.MOVE, first.x, first.y]);
    for (let i = 1; i < ring.length; i++) {
      const point = ring[i];
      if (point) commands.push([PathOp.LINE, point.x, point.y]);
    }
    commands.push([PathOp.CLOSE]);
  }
  return commands;
}

/**
 * How many command-array entries `ringsToCommands` would produce.
 *
 * Counted rather than measured because the 8192-entry cap (DESIGN.md §7) has to be checked while
 * simplification is still deciding what to do, which is long before any commands are built. It
 * must therefore agree with `ringsToCommands` exactly, including on the rings that function skips.
 */
export function commandCount(rings: readonly Ring[]): number {
  let total = 0;
  for (const ring of rings) {
    if (ring.length < MIN_RING_POINTS) continue;
    total += ring.length + 1; // MOVE, a LINE per further point, CLOSE
  }
  return total;
}

/**
 * Twice the signed area of a ring, by the shoelace sum.
 *
 * Doubled deliberately: every ring this project traces has integer lattice coordinates, so the
 * doubled figure is an exact integer and comparisons against it never meet a half-pixel rounding
 * question. Halve it at the point where an area in pixels is what is wanted.
 *
 * The **sign** is the useful part. Tracing keeps the region on a fixed side, so an outer boundary
 * comes out positive and a hole negative, and no separate containment test is needed to tell them
 * apart.
 */
export function doubleSignedArea(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}
