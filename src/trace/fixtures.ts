/**
 * Test fixtures, built in code.
 *
 * A standing rule for this project rather than a convenience: nothing in the suite should require
 * looking at an image to know whether it passed (CLAUDE.md, and DESIGN.md §8). Every fixture here is
 * a small grid produced by a function, so a failure is readable as numbers.
 */

import { emptyMask, type BinaryMask } from "./binarize";
import type { PixelImage, ScalarField } from "./field";
import { insertEdge } from "./planarOps";
import type { WallGraph } from "./wallGraph";

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
 * The gap is the point of the parameter. A doorway gap is what merges two regions, so every stage
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
 * is the same argument that eventually deleted the region census, applied one level down — a picture
 * you can look at beats a number standing in for one.
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

/** A repeatable stream of numbers in [0, 1) from a seed, so a sweep fails the same way twice. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Straight one-pixel runs of ink, horizontal or vertical, kept off the border — what the derivation's
 * sweeps thin and chain. Runs cross and end in the open, so the skeleton has junctions and dead ends
 * in plenty, which is what the prune sweep needs; it rarely nests one room inside another, which is
 * why Dissolve region's sweep also has `randomWallGraph` below.
 */
export function randomInk(
  width: number,
  height: number,
  next: () => number,
  runs: number,
): BinaryMask {
  const mask = emptyMask(width, height);
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

/**
 * Random rectangles, triangles and single walls on a coarse lattice, added the way Draw adds them.
 *
 * **Not the derivation's generator, and the reason is measured** (2026-09-16). Written for Dissolve
 * region's sweep, where skeletons of random ink runs gave 510 maps' worth of regions and not one wall
 * kept — linework thinned from pixels almost never puts a closed room inside another, so the sweep
 * agreed with its oracle without once reaching the rule that tool exists for. Shapes on an eleven-point lattice nest and share corners, and small
 * triangles hung off an existing vertex are what make the joined inner room common: shapes placed
 * anywhere kept 14 walls from an outer cycle in 400 seeds, and hanging them kept 83. At 1,500 seeds,
 * 1,303 usable, the sweep checks 9,446 regions, keeps 283 walls, and 201 of those are from an outer
 * cycle — the case "the outer cycle goes" gets wrong.
 *
 * An addition that overlaps an existing wall is skipped: a collinear overlap is a legal state to pass
 * through, but not one a traversal describes.
 */
export function randomWallGraph(next: () => number, shapes: number): WallGraph {
  const coordinate = () => Math.floor(next() * 11) / 10;
  const point = (): [number, number] => [coordinate(), coordinate()];
  // An existing vertex, so a shape can hang off the linework already there — a stem, or a room
  // touching another at one point. Without these a joined inner room is a coincidence.
  const existing = (graph: WallGraph): [number, number] => {
    const node = graph.nodes[Math.floor(next() * graph.nodes.length)]!;
    return [node.x, node.y];
  };
  // A point a short way from another, so a hanging shape stays small enough to fit inside a room.
  const near = ([x, y]: [number, number]): [number, number] => [
    x + (Math.floor(next() * 7) - 3) * 0.05,
    y + (Math.floor(next() * 7) - 3) * 0.05,
  ];
  let graph: WallGraph = { nodes: [], edges: [] };
  for (let i = 0; i < shapes; i++) {
    const kind = graph.nodes.length === 0 ? next() * 0.4 : next();
    let points: [number, number][];
    if (kind < 0.3) {
      const [x1, x2] = [coordinate(), coordinate()].sort((a, b) => a - b) as [number, number];
      const [y1, y2] = [coordinate(), coordinate()].sort((a, b) => a - b) as [number, number];
      if (x1 === x2 || y1 === y2) continue;
      points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
    } else if (kind < 0.4) {
      const corners = [point(), point(), point()];
      points = [...corners, corners[0]!];
    } else if (kind < 0.7) {
      const anchor = existing(graph);
      points = [anchor, near(anchor), near(anchor), anchor];
    } else if (kind < 0.85) {
      const anchor = existing(graph);
      points = [anchor, near(anchor)];
    } else {
      points = [point(), point()];
    }
    const result = insertEdge(graph, points.map(([x, y]) => ({ x, y })));
    if (result.overlaps > 0) continue;
    graph = result.graph;
  }
  return graph;
}
