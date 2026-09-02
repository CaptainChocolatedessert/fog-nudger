/**
 * The wall graph, small enough to keep in scene metadata — and back again, exactly.
 *
 * This is what makes step G's freeze point possible. Stage two edits a graph that is never
 * re-derived, so the graph has to *survive* on its own rather than being recomputed from the
 * reading; and the only durable store this project has is scene metadata, which is JSON.
 *
 * ## Why a walk rather than coordinates
 *
 * The saving is not incidental, it is the whole reason this encoding exists. A skeleton is a **walk**
 * — `WallEdge.points` guarantees consecutive points are 8-adjacent — so every point after the first
 * is one of **eight** directions from the one before it. Three bits. Written as JSON coordinate pairs
 * the test map's ~43,000 skeleton pixels are on the order of a megabyte; as packed steps they are
 * about 16KB before base64. That is the difference between fitting in a metadata key and not.
 *
 * A raster of the same skeleton is about a megabyte too, and would additionally be *wrong* the moment
 * the megapixel cap changed the raster it was drawn against.
 *
 * ## What is deliberately not stored
 *
 * - **The framed mask.** `WallGraph.framed` is a full-raster bitmap and it is exactly recoverable by
 *   painting the edges back — see `rasterizeGraph` in `wallGraph.ts`, and the test that asserts the
 *   round trip reproduces it pixel for pixel. Storing it would be storing the megabyte this format
 *   exists to avoid.
 * - **Each edge's endpoints.** `points[0]` is `nodes[a]` and the last point is `nodes[b]`, by
 *   construction. Recomputing them rather than storing them is not just smaller: **walking the steps
 *   and checking where they land is a free integrity check**, and it is the one that catches a
 *   corrupted payload. A decode that does not land on `nodes[b]` refuses rather than returning a
 *   plausible graph.
 * - **`stats`.** It describes the run that built the graph, not the graph.
 *
 * ## Refusing rather than throwing
 *
 * `decodeGraph` returns `null` for anything it cannot read, and never throws. This parses data from
 * scene metadata, which arrives from another client, an older version of this extension, or a hand
 * edit — the same threat model `normaliseSettings` is total for. A graph that will not parse must
 * cost the GM their *editing*, not their workspace.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { WallNode } from "./wallGraph";

/**
 * A graph as it is stored: the topology and the geometry, and nothing about the run that made it.
 *
 * `WallGraph` satisfies this structurally, so the encoder takes one directly.
 */
export interface FrozenGraph {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly WallNode[];
  readonly edges: readonly FrozenEdge[];
}

export interface FrozenEdge {
  /** Node indices. Equal when the edge is a closed loop. */
  readonly a: number;
  readonly b: number;
  /** Lattice points from `a` to `b` inclusive, consecutive points 8-adjacent. */
  readonly points: readonly Vector2[];
}

/**
 * Bumped whenever the byte layout changes.
 *
 * This is durable data sitting in someone's scene, so a format change has to be *detectable*. A
 * version that does not match is refused, which costs the GM their stored graph once; reading old
 * bytes under new rules would cost them a graph that is subtly wrong and says nothing.
 */
const FORMAT_VERSION = 1;

/**
 * The eight steps, in the same clockwise-from-north order `wallGraph.ts` walks its ring in.
 *
 * The order is arbitrary as far as the format is concerned — encoder and decoder simply have to
 * agree — but matching the graph builder's own table means anyone comparing the two is reading one
 * convention rather than two.
 */
const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** Reverse of `STEPS`, keyed `dx,dy`. */
const STEP_INDEX = new Map<string, number>(STEPS.map(([dx, dy], i) => [`${dx},${dy}`, i]));

/** Grows as needed; `bytes()` returns exactly what was written. */
class ByteWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;

  push(value: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = value & 0xff;
  }

  /** Base-128, low bits first: one byte for anything under 128, two under 16384. */
  varint(value: number): void {
    let rest = Math.max(0, Math.floor(value));
    while (rest >= 0x80) {
      this.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.push(rest);
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

class ByteReader {
  private at = 0;
  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.data.length;
  }

  /** `null` past the end, which every caller treats as a refusal rather than a zero. */
  byte(): number | null {
    return this.at < this.data.length ? this.data[this.at++]! : null;
  }

  varint(): number | null {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (byte === null) return null;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 0x80;
    }
    // A varint longer than five bytes is not something this encoder writes.
    return null;
  }

  take(count: number): Uint8Array | null {
    if (count < 0 || this.at + count > this.data.length) return null;
    const slice = this.data.subarray(this.at, this.at + count);
    this.at += count;
    return slice;
  }
}

/** How many bytes `count` three-bit steps occupy, padded to a byte boundary. */
function packedStepBytes(count: number): number {
  return Math.ceil((count * 3) / 8);
}

/**
 * Encode a graph.
 *
 * Returns base64, because the destination is a JSON string in scene metadata. The steps are padded
 * to a byte boundary **per edge** rather than packed continuously across the whole graph: it costs
 * under a byte an edge — a few hundred bytes on a real map — and it means a decoder can read one
 * edge without having tracked a bit offset through every edge before it.
 */
export function encodeGraph(graph: FrozenGraph): string {
  const out = new ByteWriter();
  out.push(FORMAT_VERSION);
  out.varint(graph.width);
  out.varint(graph.height);

  out.varint(graph.nodes.length);
  for (const node of graph.nodes) {
    out.varint(node.x);
    out.varint(node.y);
  }

  out.varint(graph.edges.length);
  for (const edge of graph.edges) {
    const steps = Math.max(0, edge.points.length - 1);
    out.varint(edge.a);
    out.varint(edge.b);
    out.varint(steps);

    let accumulator = 0;
    let bits = 0;
    for (let i = 1; i < edge.points.length; i++) {
      const from = edge.points[i - 1]!;
      const to = edge.points[i]!;
      const index = STEP_INDEX.get(`${to.x - from.x},${to.y - from.y}`);
      // A non-adjacent pair cannot be expressed. It would mean the graph broke its own invariant,
      // so it is written as a zero step and the decoder's landing check refuses the result — which
      // is the loud failure, rather than silently emitting a graph that teleports.
      accumulator |= (index ?? 0) << bits;
      bits += 3;
      while (bits >= 8) {
        out.push(accumulator & 0xff);
        accumulator >>>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) out.push(accumulator & 0xff);
  }

  return toBase64(out.bytes());
}

/**
 * Decode a graph, or `null` if the text is not one this version wrote.
 *
 * Every structural claim is checked rather than trusted: the version, that the counts fit the bytes
 * that follow, that node indices are in range, and — the one that catches a corrupted middle — that
 * walking each edge's steps from `nodes[a]` arrives exactly at `nodes[b]`.
 */
export function decodeGraph(text: string): FrozenGraph | null {
  const bytes = fromBase64(text);
  if (!bytes) return null;

  const input = new ByteReader(bytes);
  if (input.byte() !== FORMAT_VERSION) return null;

  const width = input.varint();
  const height = input.varint();
  const nodeCount = input.varint();
  if (width === null || height === null || nodeCount === null) return null;

  const nodes: WallNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const x = input.varint();
    const y = input.varint();
    if (x === null || y === null) return null;
    nodes.push({ x, y });
  }

  const edgeCount = input.varint();
  if (edgeCount === null) return null;

  const edges: FrozenEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = input.varint();
    const b = input.varint();
    const steps = input.varint();
    if (a === null || b === null || steps === null) return null;
    if (a >= nodes.length || b >= nodes.length) return null;

    const packed = input.take(packedStepBytes(steps));
    if (!packed) return null;

    const start = nodes[a]!;
    const points: Vector2[] = [{ x: start.x, y: start.y }];
    let x = start.x;
    let y = start.y;
    for (let step = 0; step < steps; step++) {
      const bit = step * 3;
      const byte = bit >> 3;
      // A step can straddle two bytes, so read a 16-bit window and shift the offset out of it.
      const window = (packed[byte] ?? 0) | ((packed[byte + 1] ?? 0) << 8);
      const [dx, dy] = STEPS[(window >> (bit & 7)) & 0x7]!;
      x += dx;
      y += dy;
      points.push({ x, y });
    }

    // The integrity check the format is shaped around. A flipped bit anywhere in the steps moves the
    // walk off course and it does not come back, so this catches corruption that a length check
    // cannot see.
    const end = nodes[b]!;
    if (x !== end.x || y !== end.y) return null;

    edges.push({ a, b, points });
  }

  // Trailing bytes mean this is not the payload it claims to be, whatever it decoded to.
  if (!input.done) return null;

  return { width, height, nodes, edges };
}

/**
 * Base64 over bytes, chunked.
 *
 * `String.fromCharCode(...bytes)` in one call overflows the argument limit on a real map's worth of
 * steps, which is a crash rather than a wrong answer but only on maps large enough that nobody would
 * have tested it.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // Not base64 at all. The one case where refusing is easier than checking.
    return null;
  }
}
