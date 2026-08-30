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
  for (const { width, height, runs, seeds } of SHAPES) {
    it(`holds every invariant on ${seeds} random ${width}x${height} skeletons`, () => {
      for (let seed = 1; seed <= seeds; seed++) {
        const where = `${width}x${height} seed ${seed}`;
        const result = deriveGraphRegions(randomInk(width, height, rng(seed), runs), {
          spurPrunePx: 0,
          minArea: 0,
          tolerance: 0.5,
          maxTolerance: 4,
        });

        // The area check. If this fails nothing downstream is real, which is why it is first.
        expect(result.faces.exact, `area check, ${where}`).toBe(result.faces.checked);

        // One step to the right of a half-edge is either its own face or the skeleton, never a
        // different face. A disagreement means the traversal turned the wrong way at a junction.
        expect(result.faces.disagreements, `handedness, ${where}`).toBe(0);

        // Every skeleton pixel has to reach the graph. One that does not is neither inside a face
        // nor on any boundary, and the identity comes up short by exactly it.
        expect(result.graph.stats.orphans, `orphans, ${where}`).toBe(0);

        // Exactly one cycle legitimately has no interior: the unbounded face outside the frame.
        // Anything else would be a sliver that survived the cleanup.
        expect(result.faces.unlabelled, `unlabelled cycles, ${where}`).toBe(1);
      }
    });
  }

  it("removes the sub-pixel slivers rather than merely tolerating them", () => {
    // The sweep above would pass with no slivers to remove at all, which would make it a test of
    // the generator. This says the cleanup is doing work on that same input.
    let removed = 0;
    for (let seed = 1; seed <= 200; seed++) {
      removed += deriveGraphRegions(randomInk(40, 30, rng(seed), 22), {
        spurPrunePx: 0,
        minArea: 0,
        tolerance: 0.5,
        maxTolerance: 4,
      }).sliversRemoved;
    }
    expect(removed).toBeGreaterThan(200);
  });
});
