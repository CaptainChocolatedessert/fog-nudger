import { describe, expect, it } from "vitest";

import { maskFromRows } from "./fixtures";
import { describeInkBlobs, findInkBlobs } from "./inkBlobs";

/**
 * One grid square is four pixels across in these fixtures, so a square is sixteen pixels, and the
 * linework is one pixel thick — which makes three pixels "several stroke widths" at this scale.
 */
const options = { pxPerSquare: 4, minSquares: 0.2, minFill: 0.55, minThickness: 3 };

/** A room big enough that its own outline is unmistakably thin against its bounding box. */
const room = [
  "####################",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "####################",
];

describe("findInkBlobs", () => {
  it("finds a filled shape", () => {
    const blobs = findInkBlobs(
      maskFromRows([
        "..........",
        "..........",
        "...####...",
        "...####...",
        "...####...",
        "...####...",
        "..........",
        "..........",
      ]),
      options,
    );

    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.area).toBe(16);
    expect(blobs[0]!.fill).toBe(1);
    expect(blobs[0]!.squares).toBe(1);
    expect(blobs[0]!.x).toBe(4.5);
    expect(blobs[0]!.y).toBe(3.5);
  });

  it("ignores a wall, which is the whole point", () => {
    // A room's outline is ink and must not be reported. It wanders across its bounding box and
    // fills almost none of it, which is what "thin" means measured without reference to stroke
    // width.
    expect(findInkBlobs(maskFromRows(room), options)).toEqual([]);
  });

  it("ignores a straight stroke, which fills its whole bounding box", () => {
    // The case that breaks bounding-box fill on its own, and the reason thickness is the measure
    // that carries this. A forty-by-one wall occupies 100% of its box — the same score as a solid
    // square — so only its narrow side tells them apart. Most linework on an architectural map is
    // straight, so getting this wrong would have flagged every wall on every map.
    const rows = Array.from({ length: 3 }, (_, y) => (y === 1 ? "#".repeat(40) : ".".repeat(40)));
    const wall = maskFromRows(rows);

    expect(findInkBlobs(wall, options)).toEqual([]);
    // And it really does score a perfect fill, so it is the thickness rule doing the excluding.
    expect(findInkBlobs(wall, { ...options, minThickness: 0 })[0]!.fill).toBe(1);
  });

  it("ignores a speck below the minimum area", () => {
    const blobs = findInkBlobs(
      maskFromRows(["........", "...##...", "...##...", "........"]),
      options,
    );
    expect(blobs).toEqual([]);
  });

  it("misses a blob drawn against a wall, and that is a stated limitation", () => {
    // Asserted so it is a decision rather than a surprise. A filled shape touching the linework
    // joins its connected component, and the component as a whole is thin — so a feature drawn
    // against a wall is invisible to this. Free-standing features are the common case, and are what
    // a room actually reported.
    const freeStanding = [...room];
    freeStanding[2] = "#......######......#";
    freeStanding[3] = "#......######......#";
    freeStanding[4] = "#......######......#";
    expect(findInkBlobs(maskFromRows(freeStanding), options)).toHaveLength(1);

    const attached = [...room];
    attached[1] = "#......######......#";
    attached[2] = "#......######......#";
    attached[3] = "#......######......#";
    expect(findInkBlobs(maskFromRows(attached), options)).toEqual([]);
  });

  it("orders blobs largest first", () => {
    const blobs = findInkBlobs(
      maskFromRows([
        "................",
        "..###....####...",
        "..###....####...",
        "..###....####...",
        ".........####...",
        "................",
      ]),
      options,
    );
    expect(blobs.map((blob) => blob.area)).toEqual([16, 9]);
  });

  it("returns nothing for a raster with no ink at all", () => {
    expect(findInkBlobs(maskFromRows(["....", "...."]), options)).toEqual([]);
  });

  it("does not divide by a degenerate grid", () => {
    expect(findInkBlobs(maskFromRows(["####", "####"]), { pxPerSquare: 0 })).toEqual([]);
  });
});

describe("describeInkBlobs", () => {
  it("says so when there are none, which is the good case", () => {
    // The case most at risk of being written as silence, and silence here cannot be told apart from
    // the diagnostic never having run.
    expect(describeInkBlobs([], 100, 100)).toContain("no solid ink blobs");
  });

  it("gives a position a GM can find on the map", () => {
    const line = describeInkBlobs(
      findInkBlobs(
        maskFromRows([
          "..........",
          "..........",
          "...####...",
          "...####...",
          "...####...",
          "...####...",
          "..........",
          "..........",
        ]),
        options,
      ),
      10,
      8,
    );
    expect(line).toContain("45% across");
    expect(line).toContain("44% down");
  });
});
