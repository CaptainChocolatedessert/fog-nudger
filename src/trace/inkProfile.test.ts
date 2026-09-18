/**
 * The two profiles, each against an oracle that shares none of its reasoning.
 *
 * **The stroke oracle is the definition of an opening rather than its implementation.** A pixel
 * survives an opening at radius `r` exactly when some `(2r+1)` square containing it is entirely ink,
 * so the oracle tries every such square by brute force. The implementation is two separable
 * running-count passes; an error in a running total, a window edge or the erode/dilate pairing
 * cannot be made the same way by a search over squares.
 *
 * **The island oracle is a flood from a different direction**: it grows components with a queue and
 * a `Set`, where the shared walk uses a preallocated index stack and a label array.
 *
 * **Thirteen mutations, thirteen caught — and the oracles earned their keep three times over.**
 *
 * - The **clamping** rule: the first stroke oracle only considered squares lying wholly inside the
 *   image and disagreed with the implementation on every random mask. The implementation was right;
 *   `morphology.ts` counts off-image as ink so a wall along the border is not eroded off it.
 * - The **binning convention**: a mutation swapping in a different formula survived, because this
 *   oracle walked islands independently and then binned them with a copy of the expression under
 *   test. Rewriting the oracle to scan the band boundaries — saying what a band *means* rather than
 *   restating how one is computed — then failed against the implementation, and the implementation
 *   was the wrong one. It offset every island by one span, which also made a genuine overflow guard
 *   look like dead code.
 * - The **generator**: at 62% random density a 7x7 all-ink window essentially never occurs, so the
 *   sweep agreed about nothing surviving, 120 times. The reach assertions caught it.
 *
 * One survivor was answered by deletion rather than by a test: a `Math.min` clamp on the bin index,
 * unreachable once islands beyond the track are skipped.
 *
 * Also worth recording because the opposite was asserted first: **chaining each opening off the last
 * gives the same answer**. Openings by squares compose as a granulometry, so that mutation is
 * equivalent rather than uncaught, and the fixture written to catch it cannot.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows, seededRandom } from "./fixtures";
import { islandPoints, islandProfile, strokePoints, strokeProfile } from "./inkProfile";
import type { BinaryMask } from "./binarize";

/**
 * Ink surviving an opening at `radius`, by the definition rather than by a separable pass.
 *
 * **The window is clamped at the image edge**, which is `morphology.ts`'s deliberate choice and not
 * an implementation detail to model away: off-image counts as ink, so a wall drawn along the border
 * is not eroded off it. The first version of this oracle only considered squares lying wholly inside
 * the image, disagreed with the implementation on every random mask, and was wrong — the fixture
 * that first caught it had a block resting on the bottom edge.
 */
function survivorsByDefinition(mask: BinaryMask, radius: number): number {
  const { width, height, data } = mask;
  if (radius <= 0) {
    let all = 0;
    for (let i = 0; i < data.length; i++) if (data[i] === 1) all += 1;
    return all;
  }

  const ink = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height || data[y * width + x] === 1;

  // Every position whose clamped window is entirely ink, brute force.
  const eroded = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let solid = data[y * width + x] === 1;
      for (let dy = -radius; dy <= radius && solid; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (!ink(x + dx, y + dy)) {
            solid = false;
            break;
          }
        }
      }
      if (solid) eroded[y * width + x] = 1;
    }
  }

  // Then everything within the radius of one of those.
  let survivors = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let covered = false;
      for (let dy = -radius; dy <= radius && !covered; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (eroded[ny * width + nx] === 1) {
            covered = true;
            break;
          }
        }
      }
      if (covered) survivors += 1;
    }
  }
  return survivors;
}

/** Islands by a queue and a Set, which is a different walk from the one under test. */
function islandsByFlood(mask: BinaryMask): { span: number; area: number }[] {
  const { width, height, data } = mask;
  const seen = new Set<number>();
  const found: { span: number; area: number }[] = [];

  for (let start = 0; start < data.length; start++) {
    if (data[start] !== 1 || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    let area = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (queue.length > 0) {
      const at = queue.shift()!;
      const x = at % width;
      const y = (at - x) / width;
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (data[next] !== 1 || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    found.push({ span: Math.max(maxX - minX + 1, maxY - minY + 1), area });
  }
  return found;
}

describe("strokeProfile", () => {
  it("puts a stroke's ink in the band that removes it", () => {
    // A 3px bar: opening at radius 1 keeps it (a 3x3 square fits), radius 2 takes all of it.
    const bar = maskFromRows([
      "..........",
      ".########.",
      ".########.",
      ".########.",
      "..........",
    ]);
    const profile = strokeProfile(bar, 3);
    expect(profile.total).toBe(24);
    expect(profile.bands[0]).toBe(0);
    expect(profile.bands[1]).toBe(24);
    expect(profile.bands[2]).toBe(0);
  });

  it("separates two widths into two bands, which is the whole point of the picture", () => {
    // Inset from every edge on purpose. Resting the block on the bottom row instead puts it under
    // the clamping rule above, where it survives a radius that would otherwise take it — which is
    // how the first draft of this fixture managed to assert the wrong band.
    const both = maskFromRows([
      "###########",
      "...........",
      ".#########.",
      ".#########.",
      ".#########.",
      ".#########.",
      ".#########.",
      "...........",
    ]);
    const profile = strokeProfile(both, 3);
    // The hairline goes at radius 1; the five-high block survives to radius 3.
    expect(profile.bands[0]).toBe(11);
    expect(profile.bands[1]).toBe(0);
    expect(profile.bands[2]).toBe(45);
  });

  it("bands a stepped shape the way a brute-force opening does", () => {
    /*
      Written to catch a chained implementation and it does not, because there is nothing to catch:
      openings by squares compose as a granulometry, so opening at 1 then 2 *is* opening at 2. The
      mutation survived this and 120 random masks. Kept because agreeing with the oracle on a shape
      whose corners round away at each radius is worth an assertion on its own.
    */
    const stepped = maskFromRows([
      ".#####.",
      "######.",
      "#######",
      "#######",
      "#######",
      "######.",
      ".#####.",
    ]);
    const profile = strokeProfile(stepped, 3);
    let running = profile.total;
    for (let radius = 1; radius <= 3; radius++) {
      running -= profile.bands[radius - 1]!;
      expect(running, `radius ${radius}`).toBe(survivorsByDefinition(stepped, radius));
    }
  });

  it("agrees with a brute-force opening over random masks, and meets both ends", () => {
    const next = seededRandom(20260918);
    let sawKept = 0;
    let sawRemoved = 0;

    for (let run = 0; run < 120; run++) {
      /*
        **Blobs, not noise**, and the first version was noise.

        At 62% density a 7x7 all-ink window essentially never occurs, so a radius-3 opening emptied
        every mask and the sweep agreed with the oracle about nothing surviving, 120 times. The reach
        assertion below caught it — which is the §8 rule working: a sweep has to be shown to meet its
        case, not only to pass.
      */
      const width = 10 + Math.floor(next() * 8);
      const height = 10 + Math.floor(next() * 8);
      const cells: boolean[][] = [];
      for (let y = 0; y < height; y++) cells.push(new Array<boolean>(width).fill(false));
      const blobs = 1 + Math.floor(next() * 4);
      for (let blob = 0; blob < blobs; blob++) {
        const w = 1 + Math.floor(next() * 9);
        const h = 1 + Math.floor(next() * 9);
        const left = Math.floor(next() * Math.max(1, width - w));
        const top = Math.floor(next() * Math.max(1, height - h));
        for (let y = top; y < Math.min(height, top + h); y++) {
          for (let x = left; x < Math.min(width, left + w); x++) cells[y]![x] = true;
        }
      }
      const rows = cells.map((row) => row.map((on) => (on ? "#" : ".")).join(""));
      const mask = maskFromRows(rows);
      const profile = strokeProfile(mask, 3);

      let running = profile.total;
      for (let radius = 1; radius <= 3; radius++) {
        running -= profile.bands[radius - 1]!;
        expect(running).toBe(survivorsByDefinition(mask, radius));
      }
      if (running > 0) sawKept++;
      if (running < profile.total) sawRemoved++;
    }

    // A sweep that only ever emptied the mask, or only ever kept it, would agree trivially.
    expect(sawKept).toBeGreaterThan(20);
    expect(sawRemoved).toBeGreaterThan(100);
  });

  it("keeps a stroke lying along the image edge, where the window is clamped", () => {
    /*
      `morphology.ts` counts off-image as ink when filtering, so a wall drawn along the border is not
      eroded off it — the opposite of `erosionCounts`, which counts it as ground because there the
      safe direction is to look *thinner*. Two rules, both right, and this pins the one that decides
      what the profile reports.
    */
    // Five rows each, so radius 2 keeps both and radius 3 is where they part. A three-row bar was
    // the first draft and parts them at radius 2 instead, which tests the same thing one stop early
    // and made the assertion below wrong.
    const onEdge = maskFromRows([
      "...........",
      "...........",
      "###########",
      "###########",
      "###########",
      "###########",
      "###########",
    ]);
    const inset = maskFromRows([
      "...........",
      "###########",
      "###########",
      "###########",
      "###########",
      "###########",
      "...........",
    ]);
    expect(strokeProfile(inset, 3).bands[2]).toBe(55);
    expect(strokeProfile(onEdge, 3).bands[2]).toBe(0);
  });

  it("is empty for no ink and for a radius below one", () => {
    // The whole result, not just the bands: reporting a real total beside no bands is a profile that
    // says it measured something and then shows nothing, and a mutation dropping the radius guard
    // survived an assertion that only read `bands`.
    const blank = maskFromRows(["...", "..."]);
    expect(strokeProfile(blank, 3)).toEqual({ bands: [], total: 0 });
    expect(strokeProfile(maskFromRows(["##"]), 0)).toEqual({ bands: [], total: 0 });
  });
});

describe("islandProfile", () => {
  it("bins by span and values by area", () => {
    const marks = maskFromRows([
      "#.........",
      "..........",
      "..####....",
      "..####....",
      "..........",
      "..........",
    ]);
    // Spans 1 and 4, over a 10px range in 5 bins of 2: bin 0 holds the dot, bin 1 the block.
    // Bands of two spans each. The dot spans 1 and the block spans 4, and 4 sits exactly on the
    // boundary between the second and third bands — where it belongs to the second, because an
    // island of span 4 still survives a setting of 4.
    const profile = islandProfile(marks, 10, 5);
    expect(profile.total).toBe(9);
    expect(profile.bands).toEqual([1, 8, 0, 0, 0]);

    // Two bins over a span of four: 1 and 2 belong to the lower half, 3 and 4 to the upper. The
    // block spans 4 and the dot 1, and a rule that put a span of 3 in the lower half would still
    // agree with every other case in this file — so the fixture has to reach exactly that span.
    const three = maskFromRows(["###", "#..", "#.."]);
    expect(islandProfile(three, 4, 2).bands).toEqual([0, 5]);
  });

  it("leaves out an island longer than the track can reach", () => {
    /*
      The wall-network case, and the reason the plot is legible at all. On a real map one island
      spans most of the raster and holds most of the ink, while the control's track stops far short
      of it — folding it into the last bin would put every decoration on the floor.
    */
    const withNetwork = maskFromRows([
      "##########",
      "..........",
      "..##......",
      "..##......",
    ]);
    const profile = islandProfile(withNetwork, 4, 4);
    expect(profile.total).toBe(14);
    // The 10-wide network is beyond the track; only the 2x2 block is placed.
    expect(profile.bands.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("agrees with a flood-fill oracle over random masks", () => {
    const next = seededRandom(917);
    let sawExcluded = 0;

    for (let run = 0; run < 120; run++) {
      const width = 6 + Math.floor(next() * 10);
      const height = 6 + Math.floor(next() * 10);
      const rows: string[] = [];
      for (let y = 0; y < height; y++) {
        let row = "";
        for (let x = 0; x < width; x++) row += next() < 0.3 ? "#" : ".";
        rows.push(row);
      }
      const mask = maskFromRows(rows);

      // Varied, because a single pair can make two different binning rules agree by coincidence.
      const [maxSpan, binCount] = [
        [4, 4],
        [4, 2],
        [10, 3],
        [7, 5],
      ][run % 4] as [number, number];
      const profile = islandProfile(mask, maxSpan, binCount);

      const theirs = islandsByFlood(mask);
      const expectedTotal = theirs.reduce((sum, island) => sum + island.area, 0);
      const expectedBands = new Array<number>(binCount).fill(0);
      for (const island of theirs) {
        if (island.span > maxSpan) {
          continue;
        }
        /*
          **The bin is found by scanning the boundaries, not by the implementation's formula.**

          This oracle walked islands independently and then binned them with a copy of the expression
          under test, so a binning error was invisible to it — a mutation swapping in a different
          formula that agrees at these parameters survived the whole sweep. Walking the edges says
          what a bin *means* — the spans it covers — rather than restating how one is computed.
        */
        let bin = binCount - 1;
        for (let b = 0; b < binCount; b++) {
          // Integer comparison, so a span sitting exactly on a boundary is not decided by a binary
          // fraction. It belongs to the band below, because it survives that stop of the filter.
          if (island.span * binCount <= (b + 1) * maxSpan) {
            bin = b;
            break;
          }
        }
        expectedBands[bin] = expectedBands[bin]! + island.area;
      }

      expect(profile.total).toBe(expectedTotal);
      expect(profile.bands).toEqual(expectedBands);
      if (theirs.some((island) => island.span > maxSpan)) sawExcluded++;
    }

    // The exclusion is the rule this is here to check, so assert the sweep reached it.
    expect(sawExcluded).toBeGreaterThan(40);
  });

  it("is empty for a track with no width and for no bins", () => {
    const marks = maskFromRows(["#.#"]);
    expect(islandProfile(marks, 0, 4).bands).toEqual([]);
    expect(islandProfile(marks, 10, 0).bands).toEqual([]);
  });
});

describe("placing bands on a track", () => {
  it("puts a stroke band at the width where its radius first applies", () => {
    // Ink 4px, track 0..3 ink widths, so 0..12px. Radius 1 first applies at 1px, radius 2 at 3px.
    const points = strokePoints({ bands: [10, 20], total: 30 }, 4, 3);
    expect(points).toEqual([
      { at: 1 / 12, ink: 0.5 },
      { at: 3 / 12, ink: 1 },
    ]);
  });

  it("drops a stroke band the track cannot reach, rather than piling it on the last stop", () => {
    // Ink 1px: radius 3 first applies at 5px, which is past a track ending at 3 ink widths.
    const points = strokePoints({ bands: [4, 4, 4], total: 12 }, 1, 3);
    expect(points.map((point) => point.at)).toEqual([1 / 3, 1]);
  });

  it("puts an island band at the top of its own slice", () => {
    const points = islandPoints({ bands: [1, 3, 0, 2], total: 6 });
    expect(points.map((point) => point.at)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(points.map((point) => point.ink)).toEqual([1 / 3, 1, 0, 2 / 3]);
  });

  it("gives nothing back when every band is empty, rather than dividing by zero", () => {
    expect(islandPoints({ bands: [0, 0], total: 0 })).toEqual([]);
    expect(strokePoints({ bands: [], total: 0 }, 4, 3)).toEqual([]);
    expect(strokePoints({ bands: [5], total: 5 }, 0, 3)).toEqual([]);
  });
});

describe("the floor under a band that has any ink", () => {
  it("draws a band far below the tallest at a visible height, and an empty one at nothing", () => {
    const points = islandPoints({ bands: [1000, 1, 0], total: 1001 });
    expect(points.map((point) => point.ink)).toEqual([1, 0.14, 0]);
  });

  it("leaves a band above the floor at its true share", () => {
    const points = islandPoints({ bands: [100, 50, 20], total: 170 });
    expect(points.map((point) => point.ink)).toEqual([1, 0.5, 0.2]);
  });
});
