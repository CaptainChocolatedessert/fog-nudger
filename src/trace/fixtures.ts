/**
 * Test fixtures, built in code.
 *
 * A standing rule for this project rather than a convenience: nothing in the suite should require
 * looking at an image to know whether it passed (CLAUDE.md, and DESIGN.md §8). Every fixture here is
 * a small grid produced by a function, so a failure is readable as numbers.
 */

import { emptyMask, type BinaryMask } from "./binarize";
import type { PixelImage, ScalarField } from "./field";

/** A field from a shade function returning 0..1. */
export function field(
  width: number,
  height: number,
  shade: (x: number, y: number) => number,
): ScalarField {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = shade(x, y);
  }
  return { width, height, data };
}

/** An RGBA image from a grey level 0–255 and an optional alpha. */
export function greyImage(
  width: number,
  height: number,
  shade: (x: number, y: number) => readonly [number, number] | readonly [number],
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const [grey, alpha = 255] = shade(x, y);
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
      data[i + 3] = alpha;
    }
  }
  return { width, height, data };
}

/**
 * A room: a hollow rectangle of ink on a light ground, with an optional gap in one wall.
 *
 * The gap is the point of the parameter. A doorway break is what merges two regions, so every stage
 * downstream needs a fixture that has one and a fixture that does not, and a single closed box
 * cannot tell correct code from several kinds of wrong.
 */
export function rooms(options: {
  readonly width: number;
  readonly height: number;
  readonly wall: number;
  readonly ink: number;
  readonly ground: number;
  /** Where the shared wall sits, as an x coordinate. */
  readonly divide: number;
  /** Half-open y range left un-inked in the shared wall — the doorway. */
  readonly gap?: readonly [number, number];
}): ScalarField {
  const { width, height, wall, ink, ground, divide, gap } = options;

  return field(width, height, (x, y) => {
    const onOuter = x < wall || y < wall || x >= width - wall || y >= height - wall;
    const onDivide = x >= divide && x < divide + wall;
    if (gap && onDivide && !onOuter && y >= gap[0] && y < gap[1]) return ground;
    return onOuter || onDivide ? ink : ground;
  });
}

export function room(options: {
  readonly width: number;
  readonly height: number;
  readonly wall: number;
  /** Ink shade, 0..1. Below `ground` for dark ink, above it for light. */
  readonly ink: number;
  readonly ground: number;
  /** Half-open range of x along the top wall left un-inked. */
  readonly gap?: readonly [number, number];
}): ScalarField {
  const { width, height, wall, ink, ground, gap } = options;

  return field(width, height, (x, y) => {
    const onEdge =
      x < wall || y < wall || x >= width - wall || y >= height - wall;
    if (!onEdge) return ground;
    if (gap && y < wall && x >= gap[0] && x < gap[1]) return ground;
    return ink;
  });
}

/**
 * A binary mask drawn as text: `#` is ink, everything else is space.
 *
 * This exists because of a specific, expensive lesson. Two of step 4's fixtures were **wrong before
 * its code was** — a comb whose teeth were all quietly joined along the top row, and an outer wall
 * of four full-width lines that diced the *outside* into eight pieces nobody had noticed. Both were
 * built from predicates, and a predicate is exactly as readable as the reasoning that produced it,
 * which is to say not at all once it is a line long.
 *
 * A drawn grid cannot hide that class of mistake: the teeth are visibly joined or visibly not. It
 * is the same argument the project makes for the region census, applied one level down.
 *
 * Rows must all be the same length, and a ragged fixture throws rather than padding — padding would
 * silently invent the space at the end of a short row, which is precisely the kind of accident this
 * is here to prevent.
 */
export function maskFromRows(rows: readonly string[]): BinaryMask {
  const height = rows.length;
  const width = height === 0 ? 0 : rows[0]!.length;
  for (const row of rows) {
    if (row.length !== width) {
      throw new Error(
        `ragged fixture: expected every row to be ${width} wide, found one of ${row.length}`,
      );
    }
  }

  const mask = emptyMask(width, height);
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) mask.data[y * width + x] = row[x] === "#" ? 1 : 0;
  }
  return mask;
}
