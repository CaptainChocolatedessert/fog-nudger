/**
 * The two hand-made layers: what a brush does to one, what one does to a mask, and the round trip.
 *
 * Four separate claims. **A stroke is a capsule, not a row of dabs** — a pointer samples faster than
 * it moves, so a brush that stamped discs would leave a dotted line at exactly the speed people
 * draw. **Applying is pixel for pixel**, because the layer is stored at the raster it acts on, which
 * is the whole reason it is a raster rather than a list of strokes. **The round trip is exact**, so
 * a layer that comes back is the one the GM approved rather than one close to it. And **the encoding
 * fits**, which is the measurement that decided a raster was affordable at all.
 */

import { describe, expect, it } from "vitest";

import type { BinaryMask } from "./binarize";
import { maskFromRows } from "./fixtures";
import {
  addInk,
  composePaint,
  copyPaint,
  decodePaint,
  emptyPaint,
  encodePaint,
  isPaintEmpty,
  paintForRaster,
  paintRevision,
  paintPixels,
  paintStroke,
  paintedCount,
  resamplePaint,
  suppressInk,
  type PaintLayer,
} from "./inkPaint";

/** The layer as text, so a fixture reads as the shape it is. */
function rows(layer: PaintLayer): string[] {
  const out: string[] = [];
  for (let y = 0; y < layer.height; y++) {
    let line = "";
    for (let x = 0; x < layer.width; x++) line += layer.data[y * layer.width + x] ? "#" : ".";
    out.push(line);
  }
  return out;
}

/** A layer built from a text grid, the way every pipeline fixture is drawn. */
function paintFromRows(source: readonly string[]): PaintLayer {
  const mask = maskFromRows(source);
  return { width: mask.width, height: mask.height, data: Uint8Array.from(mask.data) };
}

function maskRows(mask: BinaryMask): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let line = "";
    for (let x = 0; x < mask.width; x++) line += mask.data[y * mask.width + x] ? "#" : ".";
    out.push(line);
  }
  return out;
}

describe("the brush", () => {
  it("marks the pixel under a dab at the smallest radius", () => {
    const layer = emptyPaint(5, 5);
    // Deliberately **not** on the pixel's centre. A dab exactly on a centre is zero distance away
    // and would be marked even by a brush of no radius at all, so it cannot tell whether the
    // smallest brush covers its pixel — which is the thing this asserts.
    const { changed, bounds } = paintStroke(layer, { x: 2.2, y: 1.7 }, { x: 2.2, y: 1.7 }, 0, true);

    expect(changed).toBe(1);
    expect(bounds).toEqual({ left: 2, top: 1, right: 2, bottom: 1 });
    expect(rows(layer)).toEqual([".....", "..#..", ".....", ".....", "....."]);
  });

  it("covers the join between two samples rather than leaving a gap", () => {
    // Ten pixels apart with a one-pixel brush: discs stamped at the ends would leave eight pixels of
    // nothing between them, which is what a fast pointer produces.
    const layer = emptyPaint(12, 3);
    paintStroke(layer, { x: 0.5, y: 1.5 }, { x: 10.5, y: 1.5 }, 0.5, true);

    expect(rows(layer)[1]).toBe("###########.");
  });

  it("paints a disc of the radius asked for", () => {
    const layer = emptyPaint(7, 7);
    paintStroke(layer, { x: 3.5, y: 3.5 }, { x: 3.5, y: 3.5 }, 1.2, true);

    expect(rows(layer)).toEqual([
      ".......",
      ".......",
      "...#...",
      "..###..",
      "...#...",
      ".......",
      ".......",
    ]);
  });

  it("lifts what it has laid down", () => {
    const layer = emptyPaint(6, 3);
    paintStroke(layer, { x: 0.5, y: 1.5 }, { x: 5.5, y: 1.5 }, 0.5, true);
    const lifted = paintStroke(layer, { x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }, 0.5, false);

    expect(lifted.changed).toBe(2);
    // The rectangle covers the pixels that were *lifted*, not the whole stroke's reach.
    expect(lifted.bounds).toEqual({ left: 2, top: 1, right: 3, bottom: 1 });
    expect(rows(layer)[1]).toBe("##..##");
  });

  it("counts only the pixels it changed, so a second pass over the same place is free", () => {
    const layer = emptyPaint(6, 3);
    const first = paintStroke(layer, { x: 2.5, y: 1.5 }, { x: 2.5, y: 1.5 }, 0.5, true);
    const again = paintStroke(layer, { x: 2.5, y: 1.5 }, { x: 2.5, y: 1.5 }, 0.5, true);

    expect(first.changed).toBe(1);
    expect(again.changed).toBe(0);
    // No rectangle at all, so the surface has nothing to repaint rather than a stale one to redraw.
    expect(again.bounds).toBeNull();
  });

  it("clips at the edge of the raster rather than wrapping into the next row", () => {
    const layer = emptyPaint(5, 5);
    paintStroke(layer, { x: 0.5, y: 2.5 }, { x: 0.5, y: 2.5 }, 1.2, true);

    // Centred on the leftmost column, so the disc's left arm falls off the raster and is simply
    // absent — not wrapped onto the end of the row above.
    expect(rows(layer)).toEqual([".....", "#....", "##...", "#....", "....."]);
  });

  it("clips at the far edge rather than bleeding onto the next row", () => {
    /*
      The other end, and it is a different guard from the one above.

      A row is `width` pixels of one flat array, so a pixel index that runs past the end of a row
      **is** the first pixel of the row below. The left and top edges are clamped by one expression
      and the right and bottom by another, and only a stroke at the far edge exercises the second —
      a mutation pass found the near-edge test passing with the far clamp deleted.
    */
    const layer = emptyPaint(5, 5);
    paintStroke(layer, { x: 4.5, y: 2.5 }, { x: 4.5, y: 2.5 }, 1.2, true);

    expect(rows(layer)).toEqual([".....", "....#", "...##", "....#", "....."]);
  });

  it("counts only pixels that exist, at the bottom corner", () => {
    /*
      The bottom edge fails differently from the right one, which is why it needs its own assertion.

      Past the right edge an index lands on the next row and paints the wrong pixel. Past the *bottom*
      it lands outside the array altogether, where a write to a typed array is silently dropped — so
      the picture is right and only the **count** is wrong, reporting pixels it did not change. The
      count is what a stroke reports to the surface, so it has to be true.
    */
    const layer = emptyPaint(5, 5);
    const { changed, bounds } = paintStroke(layer, { x: 4.5, y: 4.5 }, { x: 4.5, y: 4.5 }, 1.2, true);

    expect(rows(layer)).toEqual([".....", ".....", ".....", "....#", "...##"]);
    expect(changed).toBe(paintedCount(layer));
    // And the rectangle stops at the raster too, or the surface would repaint rows that do not exist.
    expect(bounds).toEqual({ left: 3, top: 3, right: 4, bottom: 4 });
  });

  it("marks nothing for a stroke entirely off the raster", () => {
    const layer = emptyPaint(5, 5);
    const { changed, bounds } = paintStroke(layer, { x: -20, y: -20 }, { x: -18, y: -20 }, 1, true);

    expect(changed).toBe(0);
    expect(bounds).toBeNull();
    expect(isPaintEmpty(layer)).toBe(true);
  });

  /*
    A stroke that leaves the map paints the part that was on it, and nothing else.

    This is what the brush position being **unclamped** buys, stated from the painting side (user,
    2026-09-22: *"I would expect the brush to be able to leave the map area, but not to draw any
    pixels outside the map"*). Clamping the excursion to the edge would smear a mark along the border
    instead; clipping per pixel leaves the crossing honest — and the count has to agree with the
    picture, because a pixel outside the raster is a write that is silently dropped.
  */
  it("paints the part of a crossing stroke that is on the raster, and no more", () => {
    const layer = emptyPaint(5, 5);
    const { changed, bounds } = paintStroke(layer, { x: 2.5, y: 2.5 }, { x: 2.5, y: -40 }, 0.5, true);

    expect(rows(layer)).toEqual(["..#..", "..#..", "..#..", ".....", "....."]);
    // One mutation, caught: letting the capsule's bounds run above the raster, which drops the
    // writes silently and leaves the count claiming pixels it did not change.
    expect(changed).toBe(paintedCount(layer));
    expect(bounds).toEqual({ left: 2, top: 0, right: 2, bottom: 2 });
  });

  it("edits a copy without disturbing the original", () => {
    const original = paintFromRows(["..#..", "....."]);
    const working = copyPaint(original);
    paintStroke(working, { x: 0.5, y: 1.5 }, { x: 4.5, y: 1.5 }, 0.5, true);

    expect(rows(original)).toEqual(["..#..", "....."]);
    expect(rows(working)[1]).toBe("#####");
  });
});

describe("applying a layer to a mask", () => {
  const MASK = [
    ".####.",
    ".#..#.",
    ".####.",
  ];

  it("takes suppressed pixels out", () => {
    const mask = maskFromRows(MASK);
    const layer = paintFromRows([
      "......",
      "......",
      ".####.",
    ]);

    expect(maskRows(suppressInk(mask, layer))).toEqual([".####.", ".#..#.", "......"]);
  });

  it("puts drawn pixels in", () => {
    const mask = maskFromRows(MASK);
    const layer = paintFromRows([
      "......",
      "..##..",
      "......",
    ]);

    expect(maskRows(addInk(mask, layer))).toEqual([".####.", ".####.", ".####."]);
  });

  it("returns the mask itself when the layer marks nothing", () => {
    const mask = maskFromRows(MASK);
    const empty = emptyPaint(6, 3);

    // Identity, not equality: an untouched layer is the common case and must not cost a copy of the
    // whole raster on every recompose.
    expect(suppressInk(mask, empty)).toBe(mask);
    expect(addInk(mask, empty)).toBe(mask);
    expect(suppressInk(mask, null)).toBe(mask);
  });

  it("returns the mask itself when every painted pixel already reads that way", () => {
    const mask = maskFromRows(MASK);
    // Painted over ground, and suppression only ever writes ground.
    const overGround = paintFromRows(["#.....", "......", "......"]);

    expect(suppressInk(mask, overGround)).toBe(mask);
  });

  it("does not write back into the layer it was given", () => {
    const mask = maskFromRows(MASK);
    const layer = paintFromRows(["......", "..##..", "......"]);
    addInk(mask, layer);

    expect(rows(layer)).toEqual(["......", "..##..", "......"]);
    expect(maskRows(mask)).toEqual(MASK);
  });
});

describe("the whole stack, composed", () => {
  const MASK = [
    ".####.",
    ".#..#.",
    ".####.",
  ];

  it("takes suppression out and puts added ink in", () => {
    const mask = maskFromRows(MASK);
    const composed = composePaint(mask, {
      suppress: paintFromRows(["......", "......", ".####."]),
      ink: paintFromRows(["......", "..##..", "......"]),
    });

    expect(maskRows(composed)).toEqual([".####.", ".####.", "......"]);
  });

  it("lets added ink win where the two layers cover the same pixel", () => {
    /*
      **The order, and the only assertion that can catch it being wrong.**

      Added ink composes last, so a pixel the GM suppressed and then drew back over is ink. Reverse
      the two and it is ground — which is the same picture everywhere else on the map, so nothing but
      an overlap distinguishes them.

      This is what could not be tested until 2026-09-05. The order lived inline in `composeInk`,
      behind the SDK boundary, with the gap repair sitting between the two terms so it could not be
      pulled out. The repair became a tool, the middle term went, and the order became one function.
    */
    const mask = maskFromRows([".##.", ".##."]);
    const both = paintFromRows([".#..", "...."]);

    const composed = composePaint(mask, { suppress: both, ink: both });

    expect(maskRows(composed)).toEqual([".##.", ".##."]);
  });

  it("is the mask itself when neither layer has anything on it", () => {
    const mask = maskFromRows(MASK);

    expect(composePaint(mask, { suppress: null, ink: null })).toBe(mask);
  });
});

describe("laying a set of pixels down", () => {
  it("marks exactly the indices given, and reports the rectangle they lie in", () => {
    const layer = emptyPaint(6, 4);
    const result = paintPixels(layer, [1 * 6 + 2, 1 * 6 + 3, 2 * 6 + 2]);

    expect(result.changed).toBe(3);
    expect(result.bounds).toEqual({ left: 2, top: 1, right: 3, bottom: 2 });
    expect(rows(layer)).toEqual(["......", "..##..", "..#...", "......"]);
  });

  it("counts only what it changed, so accepting the same gap twice adds nothing", () => {
    const layer = emptyPaint(6, 4);
    paintPixels(layer, [8, 9]);
    const again = paintPixels(layer, [8, 9]);

    expect(again.changed).toBe(0);
    expect(again.bounds).toBeNull();
  });

  it("skips an index outside the raster rather than writing past the end", () => {
    // Cannot arise from a search run against this layer's own raster. Silently writing past the end
    // of a typed array is a no-op, which would make a real mismatch look like it had worked.
    const layer = emptyPaint(4, 2);
    const result = paintPixels(layer, [-1, 3, 99]);

    expect(result.changed).toBe(1);
    expect(rows(layer)).toEqual(["...#", "...."]);
  });
});

describe("a layer at a different raster", () => {
  it("is the layer itself when the dimensions already match", () => {
    const layer = paintFromRows(["..#..", "....."]);

    expect(paintForRaster(layer, 5, 2)).toBe(layer);
  });

  it("samples nearest when the raster halves", () => {
    const layer = paintFromRows([
      "##..",
      "##..",
      "..##",
      "..##",
    ]);

    expect(rows(resamplePaint(layer, 2, 2))).toEqual(["#.", ".#"]);
  });

  it("samples from the middle of a destination pixel, not its corner", () => {
    /*
      Three across into two, which is the smallest ratio where the two disagree.

      Sampling the destination pixel's *centre* maps column 1 back to source column 2; sampling its
      leading edge maps it to column 1. On any whole-number ratio — the only kind a capped map
      produces — both give the same answer, so nothing else here can tell them apart.
    */
    const layer = paintFromRows(["#.#"]);

    expect(rows(resamplePaint(layer, 2, 1))).toEqual(["##"]);
  });

  it("samples nearest when the raster doubles", () => {
    const layer = paintFromRows(["#.", ".#"]);

    expect(rows(resamplePaint(layer, 4, 4))).toEqual(["##..", "##..", "..##", "..##"]);
  });

  it("applies through a mismatch rather than refusing", () => {
    const mask = maskFromRows(["....", "....", "....", "...."]);
    const layer = paintFromRows(["#.", ".."]);

    expect(maskRows(addInk(mask, layer))).toEqual(["##..", "##..", "....", "...."]);
  });
});

describe("the round trip", () => {
  const cases: Record<string, readonly string[]> = {
    "an untouched layer": ["....", "....", "...."],
    "a solid layer": ["####", "####", "####"],
    "paint starting at the very first pixel": ["#...", "....", "...."],
    "paint ending at the very last pixel": ["....", "....", "...#"],
    "a blob in one corner": ["##..", "##..", "...."],
    "scattered marks": ["#.#.", ".#.#", "#..#"],
  };

  for (const [name, source] of Object.entries(cases)) {
    it(`survives ${name}`, () => {
      const layer = paintFromRows(source);
      const back = decodePaint(encodePaint(layer));

      expect(back).not.toBeNull();
      expect(back!.width).toBe(layer.width);
      expect(back!.height).toBe(layer.height);
      expect(rows(back!)).toEqual(source);
    });
  }

  it("keeps a raster that is one pixel wide", () => {
    const layer = paintFromRows(["#", ".", "#"]);

    expect(rows(decodePaint(encodePaint(layer))!)).toEqual(["#", ".", "#"]);
  });

  it("survives a raster the size of a real map", () => {
    /*
      Two million pixels in a single run, which is what an untouched layer at a real raster is.

      Named for what it is rather than for the varint width it exercises: a mutation pass showed that
      four groups of seven bits already cover any run the dimension guard admits, so no round trip
      can reach the fifth. The thing worth pinning is that a raster of this size round-trips at all —
      the encoder walks every pixel and the multi-byte lengths are only incidental.
    */
    const layer = emptyPaint(1500, 1400);
    const back = decodePaint(encodePaint(layer));

    expect(back).not.toBeNull();
    expect(back!.width).toBe(1500);
    expect(paintedCount(back!)).toBe(0);
  });
});

describe("what it refuses", () => {
  const layer = paintFromRows(["##..", "..#.", "...."]);

  it("refuses text that is not base64", () => {
    expect(decodePaint("not base64 !!!")).toBeNull();
  });

  it("refuses a payload that is too short to have a header", () => {
    expect(decodePaint(btoa("ab"))).toBeNull();
  });

  it("refuses another version's bytes", () => {
    const bytes = Uint8Array.from(atob(encodePaint(layer)), (c) => c.charCodeAt(0));
    bytes[0] = 99;

    expect(decodePaint(btoa(String.fromCharCode(...bytes)))).toBeNull();
  });

  it("refuses a body that does not match its checksum", () => {
    /*
      A corruption **only** the checksum can see, which took two attempts to write.

      The first version flipped a bit in the last run's length — and that changes the total, so the
      landing check refused it and the checksum was never the thing that fired. This is the same
      shape of mistake the record already carries once, where a corruption test was being caught by
      a range check.

      So: a structurally perfect body whose runs total exactly the raster, carrying the checksum of a
      *different* structurally perfect body. Both describe a 4x3 layer; they differ by one pixel of
      paint, which is precisely the corruption a run length can suffer without arithmetic noticing.
    */
    const impostor = runBody(4, 3, [1, 2, 9]);
    const wrong = sumOf(runBody(4, 3, [2, 2, 8]));

    expect(decodePaint(assemble(impostor, wrong))).toBeNull();
    // And the same body with its own checksum is accepted, or the test above would pass for the
    // wrong reason — a body nothing could ever read.
    expect(decodePaint(assemble(impostor, sumOf(impostor)))).not.toBeNull();
  });

  it("refuses runs that do not add up to the raster", () => {
    // Built by hand rather than corrupted, so the checksum agrees and only the arithmetic can
    // refuse it: a 4x3 raster whose runs cover 13 pixels.
    expect(decodePaint(handMade(4, 3, [0, 13]))).toBeNull();
  });

  it("refuses runs that stop short of the raster", () => {
    expect(decodePaint(handMade(4, 3, [0, 5]))).toBeNull();
  });

  it("refuses trailing bytes after the last run", () => {
    expect(decodePaint(handMade(4, 3, [0, 12, 7]))).toBeNull();
  });

  it("refuses dimensions that are not a raster", () => {
    expect(decodePaint(handMade(0, 3, []))).toBeNull();
  });

  it("refuses a raster too large to be one we produced", () => {
    expect(decodePaint(handMade(20000, 20000, [400_000_000]))).toBeNull();
  });
});

describe("the revision", () => {
  it("differs when a single pixel differs", () => {
    const a = paintFromRows(["##..", "...."]);
    const b = paintFromRows(["##.#", "...."]);

    expect(paintRevision(a)).not.toBe(paintRevision(b));
  });

  it("agrees for two layers with the same content", () => {
    const a = paintFromRows(["##..", "...."]);
    const b = paintFromRows(["##..", "...."]);

    expect(paintRevision(a)).toBe(paintRevision(b));
  });

  it("differs between an empty layer and no layer at all", () => {
    expect(paintRevision(emptyPaint(4, 2))).not.toBe(paintRevision(null));
  });
});

/**
 * What real paint costs in scene metadata, which is what decided a raster was affordable.
 *
 * Scene metadata is 512KB and the test map's raster is 3300x2550 — 8.4 million pixels, a megabyte at
 * a bit each before any encoding. These are the shapes a GM actually paints, at that raster.
 *
 * The bounds are deliberately generous: this is a guard against the encoding silently becoming
 * quadratic in something, not a target to tune against.
 */
describe("what it costs at a real raster", () => {
  const WIDTH = 3300;
  const HEIGHT = 2550;
  const BUDGET = 512 * 1024;

  it("stores an untouched layer in a handful of bytes", () => {
    expect(encodePaint(emptyPaint(WIDTH, HEIGHT)).length).toBeLessThan(64);
  });

  it("stores a hall painted out solid in well under the budget", () => {
    // The motivating case: crosshatching covered with a wide brush rather than traced line by line.
    const layer = emptyPaint(WIDTH, HEIGHT);
    for (let y = 800; y < 1600; y++) {
      layer.data.fill(1, y * WIDTH + 700, y * WIDTH + 1900);
    }

    expect(encodePaint(layer).length).toBeLessThan(BUDGET / 8);
  });

  it("stores a hundred brush strokes in well under the budget", () => {
    const layer = emptyPaint(WIDTH, HEIGHT);
    for (let i = 0; i < 100; i++) {
      const y = 200 + i * 20;
      paintStroke(layer, { x: 300, y }, { x: 900, y: y + 40 }, 12, true);
    }

    expect(encodePaint(layer).length).toBeLessThan(BUDGET / 4);
  });

  it("stores the worst case anyone would sit and paint under the budget", () => {
    // Small scattered dabs — the pattern run-length coding is worst at. Five hundred of them is far
    // more separate marks than a GM would place by hand.
    const layer = emptyPaint(WIDTH, HEIGHT);
    for (let i = 0; i < 500; i++) {
      const x = 100 + ((i * 137) % (WIDTH - 200));
      const y = 100 + ((i * 89) % (HEIGHT - 200));
      paintStroke(layer, { x, y }, { x, y }, 9, true);
    }

    expect(encodePaint(layer).length).toBeLessThan(BUDGET);
  });
});

/**
 * A body with chosen dimensions and chosen runs, so the guards can be aimed at one at a time.
 *
 * Split from the checksum and the header on purpose: pairing one body with another's checksum is the
 * only way to corrupt a payload that nothing but the checksum can catch.
 */
function runBody(width: number, height: number, runs: readonly number[]): number[] {
  const body: number[] = [];
  const varint = (value: number): void => {
    let rest = value;
    while (rest >= 0x80) {
      body.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    body.push(rest);
  };
  varint(width);
  varint(height);
  for (const run of runs) varint(run);
  return body;
}

/** FNV-1a, computed here rather than imported so a broken implementation cannot agree with itself. */
function sumOf(body: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash ^= byte;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function assemble(body: readonly number[], sum: number): string {
  const out = [1, sum & 0xff, (sum >>> 8) & 0xff, (sum >>> 16) & 0xff, (sum >>> 24) & 0xff, ...body];
  return btoa(String.fromCharCode(...out));
}

/** A complete, self-consistent payload with chosen runs. */
function handMade(width: number, height: number, runs: readonly number[]): string {
  const body = runBody(width, height, runs);
  return assemble(body, sumOf(body));
}
