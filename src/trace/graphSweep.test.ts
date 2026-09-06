import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { deriveGraphRegions } from "./graphRegions";

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
  // Kept one pixel clear of the edge, because the border frame is painted along it and linework
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
    on the *fitted* graph now, past the freeze, where there is nothing to rasterise back and nothing
    to rebuild — so `deriveGraphRegions` never prunes and there is no budget to sweep. The pruning
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
        const result = deriveGraphRegions(randomInk(width, height, rng(seed), runs), {
          tolerance: 0,
          maxTolerance: 0,
        });

        // The area check. If this fails nothing downstream is real, which is why it is first.
        expect(result.faces.exact, `area check, ${where}`).toBe(result.faces.checked);

        // One step to the right of a half-edge is either its own face or the skeleton, never a
        // different face. A disagreement means the traversal turned the wrong way at a junction.
        expect(result.faces.disagreements, `handedness, ${where}`).toBe(0);

        // Every skeleton pixel has to reach the graph. One that does not is neither inside a face
        // nor on any boundary, and the identity comes up short by exactly it.
        expect(result.graph.stats.orphans, `orphans, ${where}`).toBe(0);

        /*
          Exactly one cycle has no interior: the unbounded face outside the border frame.

          Anything else is a sliver whose every bounding edge carries interior pixels, which sliver
          removal cannot take — lifting such an edge would strand those pixels, which is worse. The
          record has named that state since step D and called it never observed. It *was* observed on
          2026-09-06, by sweeping the raster spur prune, and it is unreachable again now that pruning
          does not touch the raster. This is the assertion that would say so if that changed.
        */
        expect(result.faces.unlabelled, `unlabelled cycles, ${where}`).toBe(1);

        /*
          The emitted rings must enclose exactly what the face does.

          Bridges are dropped from the rings — a slit encloses no area, so the total cannot move.
          This is the invariant that catches a ring left *discontinuous* by that drop, which the
          area check upstream cannot see: it runs on the traversal, before anything is dropped.
        */
        const byLabel = new Map(result.faces.faces.map((face) => [face.label, face.doubleArea]));
        for (const region of result.regions) {
          let doubled = 0;
          for (const ring of region.rings) {
            /*
              Unfitted, every step of an emitted ring is to an 8-neighbour — the ring is a walk along
              the skeleton, and a walk cannot teleport.

              This is the assertion that names the symptom rather than its consequence. When taking
              the bridges out of a cycle was done as a linear skip, a lollipop's stalk left the ring
              jumping from the stalk's base straight to the room on the end of it: a single segment
              across the map, and long stretches of wall missing from the outline. The area
              assertion below caught it too, but only as a number.
            */
            for (let i = 0; i < ring.length; i++) {
              const a = ring[i]!;
              const b = ring[(i + 1) % ring.length]!;
              const step = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
              expect(step, `ring of face ${region.id} steps ${step}, ${where}`).toBeLessThanOrEqual(1);
            }

            for (let i = 0; i < ring.length; i++) {
              const a = ring[i]!;
              const b = ring[(i + 1) % ring.length]!;
              doubled += a.x * b.y - b.x * a.y;
            }
          }
          expect(doubled, `rings of face ${region.id} enclose the face, ${where}`).toBe(
            byLabel.get(region.id),
          );
        }
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
      const removed = deriveGraphRegions(randomInk(40, 30, rng(seed), 22), {
        tolerance: 0.5,
        maxTolerance: 4,
      }).sliversRemoved;
      if (removed > 0) seedsWithSlivers += 1;
    }
    expect(seedsWithSlivers).toBeGreaterThan(100);
  });
});
