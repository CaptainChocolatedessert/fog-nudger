import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { deriveWalls } from "./deriveWalls";
import { findCrossings } from "./planarGraph";

/**
 * A randomised sweep of the whole graph derivation, and the reason it exists.
 *
 * Every hand-written fixture in this project is a shape somebody thought of. The two defects that
 * made the area check fail on a real map were both shapes nobody would think of — a pixel with four
 * neighbours falling in two contiguous runs, and a junction cluster enclosing half a pixel — and
 * neither was reachable from any fixture here. They were found by generating linework and letting
 * the area check speak, which is what this does.
 *
 * The generator draws short straight runs at random, which is the crudest thing that produces
 * junctions, free ends, enclosed rooms and staircases in the proportions a hand-drawn map has. It is
 * not trying to look like a map. It is trying to hit configurations a person would not choose.
 *
 * **The assertions are invariants, not values.** Nothing here says how many faces a seed should
 * produce, because that would pin the generator rather than the code. What it says is that whatever
 * comes out is self-consistent: the areas balance, every skeleton pixel reached the graph, and no
 * half-edge disagreed about which face it bounds.
 */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function randomInk(
  width: number,
  height: number,
  next: () => number,
  runs: number,
): BinaryMask {
  const mask = emptyMask(width, height);
  // Kept one pixel clear of the edge. The border frame that used to be painted there is gone, but
  // linework
  // fused to the frame is a different case from linework near it.
  const put = (x: number, y: number) => {
    if (x >= 1 && y >= 1 && x < width - 1 && y < height - 1) mask.data[y * width + x] = 1;
  };

  for (let i = 0; i < runs; i++) {
    let x = 2 + Math.floor(next() * (width - 4));
    let y = 2 + Math.floor(next() * (height - 4));
    const length = 3 + Math.floor(next() * 8);
    const horizontal = next() < 0.5;
    for (let step = 0; step < length; step++) {
      put(x, y);
      if (horizontal) x += 1;
      else y += 1;
    }
  }
  return mask;
}

const SHAPES = [
  { width: 18, height: 14, runs: 5, seeds: 400 },
  { width: 40, height: 30, runs: 22, seeds: 200 },
  { width: 70, height: 50, runs: 60, seeds: 100 },
] as const;

describe("the graph derivation over generated linework", () => {
  /*
    **There is no spur budget here any more, and that is the code changing rather than the test.**

    This sweep was briefly run at two budgets, on 2026-09-06, because until that day it had only ever
    run at zero — so the whole pruning path sat outside the only instrument that has ever found a
    defect in graph building. It found one immediately: with pruning on, more than one cycle came
    back with no interior at all.

    Pruning then left the raster entirely, which is what that finding argued for. It is an operation
    on the *fitted* graph now, past the derivation, where there is nothing to rasterise back and nothing
    to rebuild — so `deriveWalls` never prunes and there is no budget to sweep. The pruning
    that survives has its own tests in `spurs.test.ts` and needs none of this apparatus, because it
    deletes a run whole and can strand nothing.
  */
  for (const { width, height, runs, seeds } of SHAPES) {
      it(`holds every invariant on ${seeds} random ${width}x${height} skeletons`, () => {
      for (let seed = 1; seed <= seeds; seed++) {
        const where = `${width}x${height} seed ${seed}`;
        /*
          Fitting is switched off here, and that is what makes the ring-area assertion below exact.

          Douglas-Peucker moves the boundary, so a fitted ring legitimately encloses a slightly
          different area than the face — half a lattice unit at a time on a staircase. Checking the
          decomposition against the fitting at once would need a tolerance, and a tolerance would
          hide the thing being tested. So the sweep tests the derivation, and the fitting is pinned
          by its own tests, which is the same split the area check upstream already uses.
        */
        const result = deriveWalls(randomInk(width, height, rng(seed), runs), {
          tolerance: 0,
          maxTolerance: 0,
        });

        /*
          **Every skeleton pixel must reach the graph**, and this is the check that survived.

          An orphan is a skeleton pixel no chain claimed: it is ink, so it is not space, and no edge
          represents it, so it is not a wall. It has fallen out between the two representations and
          nothing downstream can say it is missing. It is also the signature of a real defect — a
          pixel with four neighbours in two contiguous runs reads as an ordinary path pixel to the
          crossing number, so the walk passes through and strands the branch it did not take.

          **The area check and the handedness check were here and are gone** (2026-09-08). Both
          compared the traversal against a raster labelling of the faces, and that stage no longer
          exists: the document is a planar graph and partitions the plane by construction. This one
          keeps its subject exactly, because the ink mode still reads a map and chains it.
        */
        expect(result.graph.stats.orphans, `orphans, ${where}`).toBe(0);

        /*
          Exactly one cycle encloses no lattice point... is NOT what this asserts, deliberately.

          Sliver removal deletes those, and it is allowed to fail to: a sliver whose every bounding
          edge carries interior pixels cannot be taken, because lifting one would strand those pixels.
          What must hold is that it *settled* — nothing left that another round could have removed.
        */
        expect(result.sliversLeft, `slivers left, ${where}`).toBe(0);

        /*
          Euler's identity over the wall graph: V − E + enclosing cycles = pieces of linework.

          The left side comes from geometry and the sign of each cycle's area, the right from a
          union-find over the same edges — independent enough to catch a missed half-edge, a cycle
          partition that does not partition, and a successor rule tracing the wrong way round. That
          last fails as soon as there are two rooms, because tracing interiors on the left leaves
          exactly one positive cycle however many rooms there are.

          It does **not** catch a crossing; planarity is the separate check below.
        */
        expect(result.faces.eulerHolds, `Euler, ${where}`).toBe(true);

        /*
          And the embedding a traversal has to be meaningful over.

          Euler is satisfied by two walls crossing at a point that is a node of neither, so this is
          not implied by the assertion above. The derivation should never produce one — chains meet
          only at nodes — which is exactly why it is worth asserting rather than assuming.
        */
        expect(findCrossings(result.walls.graph), `planarity, ${where}`).toHaveLength(0);

        /*
          Every face's rings close, and every ring is a real polygon.

          The cheapest statement of "the walk produced geometry rather than fragments", and the one
          that would catch a ring left discontinuous when the bridges were removed — the lollipop
          defect, whose symptom was a boundary jumping across the map to an unrelated vertex.
        */
        for (const face of result.faces.faces) {
          for (const ring of face.rings) {
            expect(ring.length, `ring size, ${where}`).toBeGreaterThanOrEqual(3);
          }
        }

        /*
          Nothing vanishes: every segment is either covered by a ring or emitted as a wall line.

          The invariant that stops linework disappearing from both outputs at once, which is the
          failure mode a picture cannot show — the region looks right and a wall is simply absent.
        */
        const covered = new Set<number>();
        for (const face of result.faces.faces) {
          for (const cycle of face.cycles) {
            for (const half of cycle.halfEdges) covered.add(half >> 1);
          }
        }
        for (const wall of result.faces.walls) covered.add(wall);
        expect(covered.size, `every segment accounted for, ${where}`).toBe(
          result.walls.graph.edges.length - result.faces.zeroLength,
        );
      }
      });
  }

  it("removes the sub-pixel slivers rather than merely tolerating them", () => {
    /*
      The sweep above would pass with no slivers to remove at all, which would make it a test of the
      generator. This says the cleanup is doing work on that same input.

      **A claim about the generator's coverage, and deliberately loose.** This asserted a *total* of
      more than 200 slivers across 200 seeds, which is the one place this file broke its own rule —
      the module doc says in bold that nothing here should say how many faces a seed produces,
      because that pins the generator rather than the code. Counting *seeds that produced any* says
      what the comment above actually means, and **the threshold may be lowered freely**: it is
      about how much of this generator's output exercises the cleanup, not about the cleanup.
    */
    let seedsWithSlivers = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const removed = deriveWalls(randomInk(40, 30, rng(seed), 22), {
        tolerance: 0.5,
        maxTolerance: 4,
      }).sliversRemoved;
      if (removed > 0) seedsWithSlivers += 1;
    }
    expect(seedsWithSlivers).toBeGreaterThan(100);
  });
});
