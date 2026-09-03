/**
 * The document: the fitted wall graph, as it is stored and as it comes back.
 *
 * Step G freezes here. Stage one is the map — tune the reading, edit pixels, generate the graph.
 * Stage two is *this*, and it never re-derives, which is what makes editing possible at all: nothing
 * is renumbered behind the GM's back, so a moved vertex is just a stored coordinate rather than a
 * thing that has to be found again in a freshly derived graph.
 *
 * ## Coordinates are FRACTIONS OF THE MAP, not raster pixels
 *
 * Changed 2026-09-03 (user), and the reason is a trap this project has already written down once.
 * `rasterPlan.ts` records that *the sibling's real trap was denominating its parameters in raster
 * pixels, which made the raster load-bearing forever* — and the raster here is an artefact of our own
 * memory budget, not of the map. A 52.9-megapixel map caps to half size for reasons that have
 * nothing to do with its content. Storing the GM's **work** in that space is the same trap one level
 * worse, because a parameter can be re-tuned and their editing cannot.
 *
 * So a node is `{ x, y }` in 0–1 of the map's own extent. That is independent of the megapixel cap,
 * independent of the source image's pixel dimensions, and converts to world at emit time from the
 * map's *current* bounds — so moving or scaling the map in Owlbear carries the fog with it, which
 * absolute world coordinates would not. The point probe already speaks in fractions of the map for
 * the same reason.
 *
 * **Stored as float32, and quantised to float32 on the way in.** `Math.fround` at every point a
 * coordinate enters the document means storing and reloading is *exact* rather than nearly so, which
 * is what lets the round-trip test assert equality instead of a tolerance. The precision is about
 * one ten-millionth of the map — a thousandth of a pixel on any map this will ever see.
 *
 * ## Nodes and SEGMENTS, not polylines
 *
 * Also 2026-09-03 (user). An edge is two node ids and nothing else, so **every vertex is a node**.
 *
 * The previous shape stored a wall as a polyline, which meant the face traversal needed the
 * invariant "a junction is always an edge endpoint" — and that invariant is violable. A wall meeting
 * another head-on at one of its middle vertices makes a junction at a point that is structurally an
 * interior point, and the walk goes straight through it without turning. That was found by mutation
 * testing and fixed by a normalisation pass; this makes it **impossible** instead, which is the
 * better of the two by this project's own standard.
 *
 * Junction-ness is then purely derived: degree 1 is a free end, 2 is a bend, 3+ is a junction. A
 * *wall* — the thing a GM thinks they are editing and the thing that emits as a run of lines — is
 * recovered by `wallRuns`, chaining through the degree-2 nodes.
 *
 * The cost is storage: a run of k segments is 2k ids rather than k+1. About twice, which on the test
 * map is tens of kilobytes against a 512KB ceiling.
 *
 * ## Refusing rather than throwing, and all-or-nothing
 *
 * `decodeFrozenGraph` returns `null` for anything it cannot read, and never throws. Metadata arrives
 * from another client, an older version of this extension, or a hand edit.
 *
 * Unlike `normaliseSettings` it does **not** degrade field by field, and that difference is
 * deliberate. Settings are independent — a bad blur can take its default while the other eleven
 * survive. A graph is not: an edge referencing a node that does not exist has no sensible fallback,
 * and a graph with an edge quietly dropped is a *corrupt document presented as a valid one*, which
 * is this project's worst failure shape. So it is a complete graph or `null`, and `null` is a
 * legitimate state — it is what a scene looks like before anything was ever frozen.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import type { FittedEdge } from "./faces";
import type { WallGraph } from "./wallGraph";

export interface FrozenGraph {
  /** Every vertex, in 0–1 of the map's extent. Position in this list is the id. */
  readonly nodes: readonly Vector2[];
  /** One segment each. A wall is a run of these, chained through degree-2 nodes. */
  readonly edges: readonly FrozenEdge[];
}

export interface FrozenEdge {
  readonly a: number;
  readonly b: number;
}

/**
 * Bumped whenever the byte layout changes.
 *
 * Durable data in someone's scene, so a format change has to be *detectable*. A version that does
 * not match is refused, which costs the GM their stored graph once; reading old bytes under new
 * rules would cost them a graph that is subtly wrong and says nothing.
 *
 * Version 1 was a lattice walk of the pixel-chain graph; version 2 was polylines in raster pixels.
 * Neither was ever deployed or written to a scene, so nothing needs migrating from them.
 */
const FORMAT_VERSION = 3;

/**
 * A coordinate as the document holds it.
 *
 * `Math.fround` because the store writes float32: quantising on the way *in* is what makes the round
 * trip exact rather than nearly exact, so nothing downstream has to carry a tolerance for storage
 * having changed a number slightly.
 */
export function documentCoordinate(value: number): number {
  return Math.fround(value);
}

/** A point in map fractions, quantised the way the document holds them. */
export function documentPoint(x: number, y: number): Vector2 {
  return { x: documentCoordinate(x), y: documentCoordinate(y) };
}

/**
 * Build the document from a derivation.
 *
 * `fitted` is positionally aligned with `graph.edges`, and each fitted polyline runs from that edge's
 * first node to its second — `simplifyPolyline` keeps both ends, which is what makes the endpoints
 * reusable rather than approximated. So the shared points are exactly the derived graph's own nodes,
 * and each fitted polyline becomes a run of segments between them.
 *
 * Raster pixels go in and map fractions come out; `graph.width`/`height` are the raster that gives
 * the division, and are not stored, because the whole point is that the document does not know what
 * raster it came from.
 */
export function freezeGraph(graph: WallGraph, fitted: readonly FittedEdge[]): FrozenGraph {
  const width = Math.max(1, graph.width);
  const height = Math.max(1, graph.height);
  const nodes: Vector2[] = graph.nodes.map((node) =>
    documentPoint(node.x / width, node.y / height),
  );
  const edges: FrozenEdge[] = [];

  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i]!;
    const points = fitted[i]?.points ?? edge.points;
    // The two ends are the derived graph's own nodes, reused by id. Everything between them is new.
    let previous = edge.a;
    for (let p = 1; p < points.length - 1; p++) {
      const id = nodes.length;
      nodes.push(documentPoint(points[p]!.x / width, points[p]!.y / height));
      edges.push({ a: previous, b: id });
      previous = id;
    }
    edges.push({ a: previous, b: edge.b });
  }

  return { nodes, edges };
}

/**
 * How many edges meet at each node — 1 a free end, 2 a bend, 3+ a junction.
 *
 * Derived rather than stored, because a stored flag can disagree with the edges and this cannot. A
 * self-loop counts twice, which is right: it arrives and leaves.
 */
export function nodeDegrees(graph: FrozenGraph): number[] {
  const degrees = new Array<number>(graph.nodes.length).fill(0);
  for (const edge of graph.edges) {
    degrees[edge.a] = (degrees[edge.a] ?? 0) + 1;
    degrees[edge.b] = (degrees[edge.b] ?? 0) + 1;
  }
  return degrees;
}

/**
 * The walls: runs of segments chained through their degree-2 nodes.
 *
 * This is what the polyline used to be, recovered rather than stored — the thing a GM points at and
 * the thing that emits as a run of `LINE` items. Each run is a list of node ids, ends first.
 *
 * A run starts at every node that is *not* degree 2, because that is where a wall genuinely begins.
 * Anything left over after those is a closed loop with no junction anywhere on it, and is walked from
 * an arbitrary point on it — which is the same thing the derived graph does with such a chain.
 */
export function wallRuns(graph: FrozenGraph): number[][] {
  const neighbours = new Map<number, { edge: number; to: number }[]>();
  for (let i = 0; i < graph.edges.length; i++) {
    const { a, b } = graph.edges[i]!;
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push({ edge: i, to: b });
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push({ edge: i, to: a });
  }

  const degrees = nodeDegrees(graph);
  const used = new Uint8Array(graph.edges.length);
  const runs: number[][] = [];

  const walk = (from: number, first: { edge: number; to: number }): void => {
    const run = [from];
    let step: { edge: number; to: number } | undefined = first;
    let at = from;
    while (step && !used[step.edge]) {
      used[step.edge] = 1;
      run.push(step.to);
      at = step.to;
      if (degrees[at] !== 2) break;
      step = neighbours.get(at)?.find((n) => !used[n.edge]);
    }
    if (run.length > 1) runs.push(run);
  };

  for (let id = 0; id < graph.nodes.length; id++) {
    if (degrees[id] === 2) continue;
    for (const step of neighbours.get(id) ?? []) {
      if (!used[step.edge]) walk(id, step);
    }
  }
  // Whatever is left is a loop of degree-2 nodes with no end to start from.
  for (let i = 0; i < graph.edges.length; i++) {
    if (!used[i]) walk(graph.edges[i]!.a, { edge: i, to: graph.edges[i]!.b });
  }
  return runs;
}

/** Grows as needed; `bytes()` returns exactly what was written. */
class ByteWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;
  private readonly scratch = new DataView(new ArrayBuffer(4));

  push(value: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = value & 0xff;
  }

  /** Base-128, low bits first: one byte under 128, two under 16384. */
  varint(value: number): void {
    let rest = Math.max(0, Math.floor(value));
    while (rest >= 0x80) {
      this.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.push(rest);
  }

  float32(value: number): void {
    this.scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.push(this.scratch.getUint8(i));
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

class ByteReader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get done(): boolean {
    return this.at >= this.data.length;
  }

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
    return null;
  }

  float32(): number | null {
    if (this.at + 4 > this.data.length) return null;
    const value = this.view.getFloat32(this.at, true);
    this.at += 4;
    return value;
  }
}

/**
 * FNV-1a over the body, to notice corruption the structure cannot.
 *
 * Structure checks catch a great deal — a node id out of range, a truncated payload, a bad length —
 * but they cannot see a wall that has quietly moved, because a corrupted coordinate is simply a
 * different and entirely plausible coordinate. This can.
 */
function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // The FNV prime by shifts, so 32-bit arithmetic cannot overflow into a float.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Encode the document. Base64, because the destination is a JSON string in scene metadata. */
export function encodeFrozenGraph(graph: FrozenGraph): string {
  const body = new ByteWriter();
  body.varint(graph.nodes.length);
  for (const node of graph.nodes) {
    body.float32(node.x);
    body.float32(node.y);
  }
  body.varint(graph.edges.length);
  for (const edge of graph.edges) {
    body.varint(edge.a);
    body.varint(edge.b);
  }

  const bytes = body.bytes();
  const out = new ByteWriter();
  out.push(FORMAT_VERSION);
  const sum = checksum(bytes);
  // Four plain bytes rather than a varint: a fixed width means a corrupted checksum cannot change
  // where the body starts.
  out.push(sum & 0xff);
  out.push((sum >>> 8) & 0xff);
  out.push((sum >>> 16) & 0xff);
  out.push((sum >>> 24) & 0xff);
  for (const byte of bytes) out.push(byte);
  return toBase64(out.bytes());
}

/**
 * Decode the document, or `null` if it is not one this version wrote and can vouch for.
 *
 * Six refusals: not base64, wrong version, a checksum that does not match, a truncated body, a node
 * id outside the table, and trailing bytes.
 */
export function decodeFrozenGraph(text: string): FrozenGraph | null {
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 5) return null;
  if (bytes[0] !== FORMAT_VERSION) return null;

  const expected = (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
  const body = bytes.slice(5);
  if (checksum(body) !== expected) return null;

  const input = new ByteReader(body);
  const nodeCount = input.varint();
  if (nodeCount === null) return null;

  const nodes: Vector2[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const x = input.float32();
    const y = input.float32();
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    nodes.push({ x, y });
  }

  const edgeCount = input.varint();
  if (edgeCount === null) return null;

  const edges: FrozenEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = input.varint();
    const b = input.varint();
    if (a === null || b === null || a >= nodes.length || b >= nodes.length) return null;
    edges.push({ a, b });
  }

  // Trailing bytes mean this is not the payload it claims to be, whatever it decoded to.
  if (!input.done) return null;

  return { nodes, edges };
}

/**
 * Base64 over bytes, chunked.
 *
 * `String.fromCharCode(...bytes)` in one call overflows the argument limit on a real map's worth of
 * nodes — a crash rather than a wrong answer, but only on maps big enough that nobody tested it.
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
    return null;
  }
}
