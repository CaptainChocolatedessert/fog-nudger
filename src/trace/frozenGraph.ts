/**
 * The document: the fitted wall graph, as it is stored and as it comes back.
 *
 * Step G freezes here. Stage one is the map — tune the reading, edit pixels, generate the graph.
 * Stage two is *this*, and it never re-derives, which is what makes editing possible at all: nothing
 * is renumbered behind the GM's back, so a moved vertex is just a stored coordinate rather than a
 * thing that has to be found again in a freshly derived graph.
 *
 * ## Why every fitted vertex is a node
 *
 * The derived graph reserves "node" for a topologically special point — a junction or a free end —
 * because its path points are *pixels*: 43,000 of them on the test map, each referenced once.
 * Giving every one an identity would be absurd.
 *
 * After fitting that inverts. There are ~8,700 points, and what matters about a point is no longer
 * whether it is a junction but **whether it is shared**. So the structure changes at the freeze: one
 * flat node table, and edges as sequences of ids into it. Junction-ness is derived — it is how many
 * edge-ends reference an id.
 *
 * **That is the property the emitted scene throws away, and the reason editing has to live here.** A
 * stub wall emitted as fog is a run of independent `LINE` items whose endpoints merely happen to be
 * coincident; the GM's intent is that they are one point. Here, two rooms either side of a wall
 * reference the *same ids*, so their shared geometry is identical by reference — move the vertex
 * once and both follow, permanently, with no code keeping them in step.
 *
 * ## Faces are derived, not stored
 *
 * Add or delete an edge and re-run the half-edge traversal; the faces fall out. Storing shapes
 * instead would mean recovering topology by comparing geometry — finding the run of ids two
 * sequences share in order to merge them — which works until two walls coincide for an unrelated
 * reason. Faces being renumbered on every edit costs nothing, because nothing stores them and a push
 * rewrites the scene wholesale. **Node ids are the only identity that has to be stable.**
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
  /** The raster the coordinates are in. Kept so a mismatch is detectable rather than silent. */
  readonly width: number;
  readonly height: number;
  /** Every vertex, shared and unshared alike. Position in this list is the id. */
  readonly nodes: readonly Vector2[];
  readonly edges: readonly FrozenEdge[];
}

export interface FrozenEdge {
  /**
   * Ids into `nodes`, from one end of the wall to the other. At least two.
   *
   * First and last equal means a closed loop. Ids appearing in more than one edge are the shared
   * points — junctions — and nothing marks them as such, because counting is cheaper than
   * maintaining a flag that can disagree with the sequences.
   */
  readonly nodes: readonly number[];
}

/**
 * Bumped whenever the byte layout changes.
 *
 * Durable data in someone's scene, so a format change has to be *detectable*. A version that does
 * not match is refused, which costs the GM their stored graph once; reading old bytes under new
 * rules would cost them a graph that is subtly wrong and says nothing.
 */
const FORMAT_VERSION = 2;

/**
 * Build the document from a derivation.
 *
 * `fitted` is positionally aligned with `graph.edges`, and each fitted polyline runs from that
 * edge's first node to its second — `simplifyPolyline` keeps both ends, which is what makes the
 * endpoints reusable rather than approximated.
 *
 * So the shared points are exactly the derived graph's own nodes, carried over with their indices
 * intact, and each edge's *interior* fitted points become new ids belonging to that edge alone.
 */
export function freezeGraph(graph: WallGraph, fitted: readonly FittedEdge[]): FrozenGraph {
  const nodes: Vector2[] = graph.nodes.map((node) => ({ x: node.x, y: node.y }));
  const edges: FrozenEdge[] = [];

  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i]!;
    const points = fitted[i]?.points ?? edge.points;
    const ids: number[] = [edge.a];
    // Interior only: the first and last points are the two end nodes, already in the table.
    for (let p = 1; p < points.length - 1; p++) {
      ids.push(nodes.length);
      nodes.push({ x: points[p]!.x, y: points[p]!.y });
    }
    ids.push(edge.b);
    edges.push({ nodes: ids });
  }

  return { width: graph.width, height: graph.height, nodes, edges };
}

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

  /** Base-128, low bits first: one byte under 128, two under 16384. */
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
}

/**
 * FNV-1a over the body, to notice corruption the structure cannot.
 *
 * **The previous format got this for free and this one does not**, which is the reason it is here
 * rather than an excess of caution. That format stored each edge as a walk of 3-bit lattice steps,
 * so a flipped bit moved the walk off course and it failed to land on its end node. Coordinates have
 * no such redundancy: a corrupted one is simply a different, entirely plausible, coordinate.
 *
 * Structure checks still catch a great deal — a node id out of range, a truncated payload, a bad
 * length — but they cannot see a wall that has quietly moved forty pixels. This can.
 */
function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // Multiply by the FNV prime in 32-bit arithmetic, avoiding `*` so it cannot overflow to a float.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Encode the document. Base64, because the destination is a JSON string in scene metadata. */
export function encodeFrozenGraph(graph: FrozenGraph): string {
  const body = new ByteWriter();
  body.varint(graph.width);
  body.varint(graph.height);

  body.varint(graph.nodes.length);
  for (const node of graph.nodes) {
    body.varint(node.x);
    body.varint(node.y);
  }

  body.varint(graph.edges.length);
  for (const edge of graph.edges) {
    body.varint(edge.nodes.length);
    for (const id of edge.nodes) body.varint(id);
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
 * Six refusals: not base64, wrong version, a checksum that does not match, a truncated body,
 * an edge of fewer than two points, and a node id outside the table.
 */
export function decodeFrozenGraph(text: string): FrozenGraph | null {
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 5) return null;
  if (bytes[0] !== FORMAT_VERSION) return null;

  const expected =
    (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
  const body = bytes.subarray(5);
  if (checksum(body) !== expected) return null;

  const input = new ByteReader(body);
  const width = input.varint();
  const height = input.varint();
  const nodeCount = input.varint();
  if (width === null || height === null || nodeCount === null) return null;

  const nodes: Vector2[] = [];
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
    const count = input.varint();
    if (count === null || count < 2) return null;
    const ids: number[] = [];
    for (let n = 0; n < count; n++) {
      const id = input.varint();
      if (id === null || id >= nodes.length) return null;
      ids.push(id);
    }
    edges.push({ nodes: ids });
  }

  // Trailing bytes mean this is not the payload it claims to be, whatever it decoded to.
  if (!input.done) return null;

  return { width, height, nodes, edges };
}

/** The polyline an edge draws, resolved through the node table. */
export function edgePoints(graph: FrozenGraph, edge: FrozenEdge): Vector2[] {
  return edge.nodes.map((id) => graph.nodes[id]!);
}

/**
 * How many edge-ends reference each node — so degree 1 is a free end and 3+ is a junction.
 *
 * Derived rather than stored, because a stored flag can disagree with the sequences and this
 * cannot. An interior point of one edge scores 0 here: it is passed through, not met at.
 */
export function nodeDegrees(graph: FrozenGraph): number[] {
  const degrees = new Array<number>(graph.nodes.length).fill(0);
  for (const edge of graph.edges) {
    const first = edge.nodes[0]!;
    const last = edge.nodes[edge.nodes.length - 1]!;
    degrees[first] = (degrees[first] ?? 0) + 1;
    degrees[last] = (degrees[last] ?? 0) + 1;
  }
  return degrees;
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
