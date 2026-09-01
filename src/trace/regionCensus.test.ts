import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { labelSpace } from "./label";
import { censusStats, describeCensus } from "./regionCensus";

/**
 * A predicate fixture rather than a text grid, and the choice is deliberate rather than drift.
 *
 * The standing rule is grids, because a predicate can be wrong before the code is — and `twoRooms`
 * below is exactly that risk, which is why it carries five lines explaining what its perimeter has
 * to be. What keeps it a predicate is size: at 40x20 a grid is a wall of text nobody proofreads,
 * and the fixtures that matter here are about *areas*, which a reader checks by arithmetic rather
 * than by looking. `label.test.ts`'s small fixtures went the other way, to grids, on 2026-09-01.
 */
function mask(
  width: number,
  height: number,
  ink: (x: number, y: number) => boolean,
): BinaryMask {
  const out = emptyMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.data[y * width + x] = ink(x, y) ? 1 : 0;
  }
  return out;
}

/**
 * Two rooms of clearly different sizes sharing a wall, inside a closed rectangle, with the space
 * outside it as a third region.
 *
 * The outer wall has to be the *perimeter* of a rectangle rather than four full-width lines. Four
 * lines spanning the whole raster cut the outside into eight separate pieces, which is correct
 * labelling of a fixture that does not mean what it looks like — and is exactly why DESIGN.md §9
 * insists the fixtures include two rooms sharing a wall rather than one box.
 */
const twoRooms = () =>
  labelSpace(
    mask(40, 20, (x, y) => {
      const insideRect = x >= 2 && x <= 37 && y >= 2 && y <= 17;
      const onPerimeter = x === 2 || x === 37 || y === 2 || y === 17;
      const divide = x === 12 && y > 2 && y < 17;
      return insideRect && (onPerimeter || divide);
    }),
  );

describe("censusStats", () => {
  it("counts regions and their shares largest first", () => {
    const stats = censusStats(twoRooms(), { pxPerSquare: 10 });
    expect(stats.count).toBe(3);
    expect(stats.topShares[0]!).toBeGreaterThan(stats.topShares[1]!);
    expect(stats.topShares[1]!).toBeGreaterThan(stats.topShares[2]!);
  });

  it("reports coverage below 1, since ink holds the rest", () => {
    const stats = censusStats(twoRooms(), { pxPerSquare: 10 });
    expect(stats.coverage).toBeGreaterThan(0.8);
    expect(stats.coverage).toBeLessThan(1);
  });

  it("counts only room-sized regions against the grid", () => {
    // The count that is worth watching across runs. Total region count is dominated by speckle;
    // this one is not, because a grid square is a floor a genuine room clears and noise does not.
    const labelled = labelSpace(mask(60, 30, (x) => x === 30));
    const stats = censusStats(labelled, { pxPerSquare: 10 });
    expect(stats.count).toBe(2);
    expect(stats.roomSized).toBe(2);

    // At a much coarser grid the same regions no longer clear a square.
    expect(censusStats(labelled, { pxPerSquare: 100 }).roomSized).toBe(0);
  });

  it("averages the two middle regions when there is an even number of them", () => {
    // Four ground runs of 9, 5, 3 and 1 pixels, each in its own row of an otherwise solid raster.
    // The median is 4 — the mean of the middle pair. Taking the upper-middle entry alone, which is
    // what this did until 2026-09-01, gives 3. The figure is quoted in the record as a measurement
    // of a real map, so it has to be the thing it is called.
    const runs = [1, 3, 5, 9];
    const labelled = labelSpace(
      mask(12, 8, (x, y) => {
        const run = runs[(y - 1) / 2];
        if (y % 2 === 0 || run === undefined) return true;
        return !(x >= 1 && x <= run);
      }),
    );
    expect(labelled.regions.map((r) => r.area)).toEqual([9, 5, 3, 1]);
    expect(censusStats(labelled, { pxPerSquare: 1 }).medianSquares).toBeCloseTo(4, 6);
  });

  it("reports areas in grid squares, not pixels", () => {
    const labelled = labelSpace(mask(20, 20, () => false));
    expect(censusStats(labelled, { pxPerSquare: 10 }).medianSquares).toBeCloseTo(4, 6);
  });

  // "carries the filter's droppings through" was here. The census no longer reports what a minimum
  // dropped, because the only labelling it is ever handed passes `minArea: 0` — the clause printed
  // "dropped 0" on every map, which reads as evidence that nothing was dropped rather than as
  // evidence that nothing could be. `labelSpace` still counts them; `label.test.ts` still pins that.

  it("does not divide by zero when the grid is unknown", () => {
    // A dpi of zero is a real state for a scene with no grid, and a NaN here would propagate into
    // the log as the word "NaN" beside numbers that look fine.
    const stats = censusStats(twoRooms(), { pxPerSquare: 0 });
    expect(Number.isFinite(stats.medianSquares)).toBe(true);
    expect(stats.roomSized).toBe(0);
  });

  it("survives having no regions", () => {
    const stats = censusStats(labelSpace(mask(8, 8, () => true)), { pxPerSquare: 10 });
    expect(stats.count).toBe(0);
    expect(stats.coverage).toBe(0);
    expect(Number.isFinite(stats.medianSquares)).toBe(true);
  });
});

describe("describeCensus", () => {
  it("says so when there are no regions at all", () => {
    // An empty census and a census that never ran must not look the same in a log. This project has
    // already been bitten once by a silent surface, in the map picker.
    const stats = censusStats(labelSpace(mask(8, 8, () => true)), { pxPerSquare: 10 });
    expect(describeCensus(stats)).toMatch(/no regions at all/);
  });

  it("leads with the count and the shares", () => {
    const line = describeCensus(censusStats(twoRooms(), { pxPerSquare: 10 }));
    // "faces", not "regions", and it names what the remainder is. The figure's complement used to be
    // the ink and is now the one-pixel skeleton, so a line inviting the old comparison misleads.
    expect(line).toMatch(/^3 faces covering/);
    expect(line).toContain("centreline skeleton");
    expect(line).toMatch(/largest first/);
    // Nothing about the border: the census is only handed the labelling of a *framed* skeleton, whose
    // outer row and column are ink, so no labelled pixel can touch the raster edge and the count was
    // always zero.
    expect(line).not.toMatch(/touch the border/);
    expect(line).not.toMatch(/below the minimum/);
  });
});
