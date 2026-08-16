import { describe, expect, it } from "vitest";

import { emptyMask, type BinaryMask } from "./binarize";
import { labelSpace } from "./label";

/** `ink` returns true where the pixel is a wall; everything else is space to be labelled. */
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

const labelAt = (l: ReturnType<typeof labelSpace>, x: number, y: number) =>
  l.labels[y * l.width + x]!;

describe("labelSpace", () => {
  it("labels open space as one region", () => {
    const labelled = labelSpace(mask(10, 10, () => false));
    expect(labelled.regions).toHaveLength(1);
    expect(labelled.regions[0]!.area).toBe(100);
  });

  it("separates two rooms divided by a wall", () => {
    const labelled = labelSpace(mask(11, 5, (x) => x === 5));
    expect(labelled.regions).toHaveLength(2);
    expect(labelAt(labelled, 0, 2)).not.toBe(labelAt(labelled, 10, 2));
  });

  it("joins two rooms through a gap in the wall", () => {
    // The doorway case, and the one the whole project is arranged around: a break in the ink means
    // revealing one room reveals the other.
    const labelled = labelSpace(mask(11, 5, (x, y) => x === 5 && y !== 2));
    expect(labelled.regions).toHaveLength(1);
    expect(labelAt(labelled, 0, 2)).toBe(labelAt(labelled, 10, 2));
  });

  it("does NOT leak space through a diagonal touch of ink", () => {
    // The connectivity pairing, and the reason it is a correctness requirement rather than a
    // preference. Ink runs corner to corner; with 8-connected space the two halves would join
    // through the diagonal while the ink also joins — the paradox from DESIGN.md §5. Space must be
    // 4-connected so the ink's diagonal counts as a seal.
    //
    //   . . # .        ink on a diagonal from top-left to bottom-right
    //   . # . .
    //   # . . .
    const size = 7;
    const labelled = labelSpace(mask(size, size, (x, y) => x + y === size - 1));

    expect(labelled.regions).toHaveLength(2);
    expect(labelAt(labelled, 0, 0)).not.toBe(labelAt(labelled, size - 1, size - 1));
  });

  it("keeps a room inside a room separate from its surroundings", () => {
    // A pillar, or a sealed vault. Two regions, and the inner one must not merge with the outer
    // through the ring of ink around it.
    const labelled = labelSpace(
      mask(21, 21, (x, y) => {
        const ring = x >= 6 && x <= 14 && y >= 6 && y <= 14;
        const inner = x >= 8 && x <= 12 && y >= 8 && y <= 12;
        return ring && !inner;
      }),
    );
    expect(labelled.regions).toHaveLength(2);
    expect(labelAt(labelled, 10, 10)).not.toBe(labelAt(labelled, 0, 0));
  });

  it("orders regions largest first and numbers them from 1", () => {
    const labelled = labelSpace(mask(11, 5, (x) => x === 3));
    expect(labelled.regions.map((r) => r.id)).toEqual([1, 2]);
    expect(labelled.regions[0]!.area).toBeGreaterThan(labelled.regions[1]!.area);
    // The ids must actually index the label map, not merely look tidy in the list.
    expect(labelAt(labelled, 10, 2)).toBe(1);
    expect(labelAt(labelled, 0, 2)).toBe(2);
  });

  it("records bounding boxes and border contact", () => {
    const labelled = labelSpace(
      mask(20, 20, (x, y) => x < 5 || y < 5 || x > 14 || y > 14),
    );
    const [only] = labelled.regions;
    expect(only!.minX).toBe(5);
    expect(only!.minY).toBe(5);
    expect(only!.maxX).toBe(14);
    expect(only!.maxY).toBe(14);
    expect(only!.touchesBorder).toBe(false);
  });

  it("notices a region that reaches the raster edge", () => {
    const labelled = labelSpace(mask(10, 10, () => false));
    expect(labelled.regions[0]!.touchesBorder).toBe(true);
  });

  it("drops regions below the minimum area and reports what it dropped", () => {
    // One big room and one speck, separated. The speck goes, and it is counted rather than
    // silently vanishing — a filter that does not say what it ate cannot be tuned.
    const labelled = labelSpace(
      mask(20, 10, (x, y) => x === 15 || (x > 15 && y !== 5)),
      { minArea: 10 },
    );
    expect(labelled.regions).toHaveLength(1);
    expect(labelled.discarded).toBe(1);
    expect(labelled.discardedArea).toBeGreaterThan(0);
  });

  it("zeroes the labels of dropped regions rather than leaving them dangling", () => {
    const labelled = labelSpace(
      mask(20, 10, (x, y) => x === 15 || (x > 15 && y !== 5)),
      { minArea: 10 },
    );
    expect(labelAt(labelled, 18, 5)).toBe(0);
  });

  it("returns nothing for an all-ink mask", () => {
    const labelled = labelSpace(mask(8, 8, () => true));
    expect(labelled.regions).toHaveLength(0);
    expect(labelled.discarded).toBe(0);
  });

  it("handles a degenerate mask", () => {
    const labelled = labelSpace(emptyMask(0, 0));
    expect(labelled.regions).toHaveLength(0);
    expect(labelled.labels).toHaveLength(0);
  });

  it("merges a U shape whose arms only meet at the far end", () => {
    // Exercises the union half of union-find: the two arms get different provisional labels on the
    // first rows and are only discovered to be the same region much later. A labeller that never
    // resolved its equivalences would report two regions here and look perfectly plausible doing it.
    const labelled = labelSpace(
      mask(11, 11, (x, y) => x >= 4 && x <= 6 && y < 8),
    );
    expect(labelled.regions).toHaveLength(1);
    expect(labelAt(labelled, 0, 0)).toBe(labelAt(labelled, 10, 0));
  });

  it("labels parallel corridors as separate regions", () => {
    const teeth = 60;
    const labelled = labelSpace(mask(teeth * 2 + 1, 40, (x) => x % 2 === 1));
    expect(labelled.regions).toHaveLength(teeth + 1);
  });

  it("gives every cell of a checkerboard its own region", () => {
    // Two things at once. It is the connectivity pairing at its starkest — under 8-connected space
    // every light cell would join into one region through the diagonals, so this single number
    // separates the correct rule from the wrong one. And it allocates several thousand provisional
    // labels, which pushes the union-find well past its initial capacity and would expose a growth
    // step that dropped equivalences.
    const size = 61;
    const labelled = labelSpace(mask(size, size, (x, y) => (x + y) % 2 === 1));

    const cells = Math.ceil((size * size) / 2);
    expect(labelled.regions).toHaveLength(cells);
    expect(labelled.regions.every((region) => region.area === 1)).toBe(true);
  });
});
