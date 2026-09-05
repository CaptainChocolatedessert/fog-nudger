/**
 * The GM's two pixel layers: what they suppressed, and what they drew.
 *
 * Stage one is three layers stacked, not one filtered reading (user, 2026-09-05):
 *
 * ```
 * base ink  −  suppression  +  break repair  +  added ink
 * ```
 *
 * The base is what processing the map image produces and is decided by parameters. The other two
 * hand-made layers are *this* — a raster each, edited with a brush. They are independent inputs, so
 * any of the three can be revisited without disturbing the other two and the order they are edited
 * in does not matter. The break repair is the one term in the stack that is derived rather than
 * made, and it is expected to become a tool inside the added-ink layer, at which point the stack is
 * exactly three things.
 *
 * ## A raster, not a list of strokes
 *
 * The first design stored strokes as polylines in fractions of the map, by analogy with the frozen
 * graph. **That was the wrong analogy** (user, 2026-09-05): the rule the graph is obeying is that a
 * document belongs in the space of the thing it produces, and the graph produces geometry where
 * this produces *ink pixels*.
 *
 * What a raster buys is that the preview and the effect stop being two computations. A stroke
 * document has to be drawn once by the canvas, with its line-drawing, and stamped again by the
 * pipeline, with different arithmetic — so the GM approves one picture and the trace uses another,
 * and any divergence between them has nowhere to show up. Here the array the GM is shown **is** the
 * array that composes. Erasing also stops needing a definition: it writes zero.
 *
 * ## At the pipeline's raster, and it says which
 *
 * The layer is the size of the mask it acts on (user, 2026-09-05: *whatever the step's output ink
 * is*), so applying it is pixel for pixel with no resampling and no rule that has to differ between
 * adding ink and taking it away.
 *
 * That raster is the decoded image reduced by an integer factor to fit `MEGAPIXEL_BUDGET`, so it
 * depends on the source image's own pixels and on a constant of ours — and on nothing about the
 * scene. Moving, scaling or rotating the map in Owlbear cannot change it. What can is replacing the
 * image, or changing our own budget, and those are exactly why **the document records its own
 * dimensions**: a mismatch is then something the pipeline notices and reports, rather than a layer
 * silently applied at the wrong scale.
 *
 * ## Run-length coded, because the shape of real paint makes it cheap
 *
 * Scene metadata is 512KB and this project's test raster is 8.4 million pixels, so a bit per pixel
 * is a megabyte before encoding and the format has to earn its place.
 *
 * It does, because of how the layer is actually used. The motivating case for suppression is
 * meaningless crosshatching, and **a GM does not paint out crosshatching stroke by stroke — they
 * take a wide brush and cover the area solid** (user, 2026-09-05). Solid regions are the best case
 * for run-length coding, a couple of runs a row, and an untouched layer is a single run. The
 * expensive case is many small scattered marks, which is bounded by how much clicking a person will
 * do.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";

/**
 * One hand-made layer: a mark or no mark, at the raster it was painted at.
 *
 * Binary rather than a tri-state of suppress-and-add, because the two are *different layers* in the
 * stack rather than two values of one. Keeping them apart is what lets either be revisited without
 * touching the other, and it means neither has to encode "and this pixel is the other kind".
 *
 * `data` is one byte per pixel like every other mask here, row-major, 1 painted. A bit array would
 * be eight times smaller in memory and is not worth the indexing: what is stored is the run-length
 * encoding, and what is in memory sits beside two 34MB RGBA layers.
 */
export interface PaintLayer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A layer with nothing painted on it. */
export function emptyPaint(width: number, height: number): PaintLayer {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  return { width: w, height: h, data: new Uint8Array(w * h) };
}

/** Whether anything at all is painted, so an untouched layer can be skipped rather than applied. */
export function isPaintEmpty(layer: PaintLayer): boolean {
  return layer.data.every((value) => value === 0);
}

/** How many pixels carry a mark. */
export function paintedCount(layer: PaintLayer): number {
  let total = 0;
  for (let i = 0; i < layer.data.length; i++) if (layer.data[i] !== 0) total += 1;
  return total;
}

/** A copy that can be edited without disturbing the original — what entering a paint mode takes. */
export function copyPaint(layer: PaintLayer): PaintLayer {
  return { width: layer.width, height: layer.height, data: Uint8Array.from(layer.data) };
}

/**
 * The narrowest brush, in raster pixels of radius.
 *
 * A brush thinner than a pixel still has to mark the pixel it is over, or the smallest setting would
 * paint nothing at all and read as the tool being broken. Half a pixel is the radius at which the
 * disc covers exactly the pixel whose centre it sits on.
 */
const MIN_BRUSH_RADIUS = 0.5;

/** The rectangle a stroke actually changed, inclusive on all four sides. */
export interface StrokeBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What a stroke did, which is what the surface needs to redraw only what moved. */
export interface StrokeResult {
  /** How many pixels changed value. Zero for a stroke over ground it had already covered. */
  readonly changed: number;
  /**
   * The rectangle those pixels lie in, or `null` when none changed.
   *
   * **The pixels that actually changed, not the brush's reach.** The surface repaints this rectangle
   * out of the layer, so a bound that was merely generous would cost work and a bound that was tight
   * in the wrong place would leave paint on the canvas that the layer does not have. Tracking what
   * was written means the two cannot disagree — there is only one computation.
   */
  readonly bounds: StrokeBounds | null;
}

/**
 * Lay one segment of a stroke down, or lift it, and say what changed.
 *
 * **A capsule, not a row of discs.** A pointer delivers positions, not a continuous path, so a
 * stroke arrives as segments between successive samples — and stamping a disc at each sample leaves
 * a dotted line whenever the pointer moves faster than the brush is wide. Testing each pixel's
 * distance to the *segment* covers the join by construction, at the cost of a bounding-box walk that
 * is small because the segments are short.
 *
 * Coordinates are continuous raster coordinates, matching the rest of the pipeline: pixel `(x, y)`
 * covers `[x, x+1) × [y, y+1)`, so its centre — what the distance is measured to — is at
 * `(x + 0.5, y + 0.5)`. That is the same convention `readPoint` floors a fraction into.
 *
 * Mutates, deliberately. This runs per pointer sample against a layer the GM is holding in a mode,
 * and copying eight megabytes per sample to stay pure would make the brush unusable for no gain —
 * the copy that matters is taken once, when the mode is entered.
 */
export function paintStroke(
  layer: PaintLayer,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  radius: number,
  on: boolean,
): StrokeResult {
  const { width, height, data } = layer;
  if (width <= 0 || height <= 0) return NOTHING_CHANGED;

  const r = Math.max(MIN_BRUSH_RADIUS, radius);
  const value = on ? 1 : 0;

  // The capsule's bounds, clamped to the raster. `floor`/`ceil` rather than rounding, so a pixel
  // whose centre is only just inside the reach is still considered.
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - r));
  const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + r));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - r));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + r));
  if (left > right || top > bottom) return NOTHING_CHANGED;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const rSquared = r * r;

  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let py = top; py <= bottom; py++) {
    const cy = py + 0.5;
    const row = py * width;
    for (let px = left; px <= right; px++) {
      const cx = px + 0.5;
      // Distance from the pixel centre to the segment, squared. A zero-length segment — a stroke
      // that has not moved yet, which is every stroke's first sample — falls out as distance to the
      // point, which is what a single dab of the brush should be.
      let t = 0;
      if (lengthSquared > 0) {
        t = ((cx - from.x) * dx + (cy - from.y) * dy) / lengthSquared;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const ox = cx - (from.x + t * dx);
      const oy = cy - (from.y + t * dy);
      if (ox * ox + oy * oy > rSquared) continue;
      const at = row + px;
      if (data[at] === value) continue;
      data[at] = value;
      changed += 1;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (changed === 0) return NOTHING_CHANGED;
  return { changed, bounds: { left: minX, top: minY, right: maxX, bottom: maxY } };
}

const NOTHING_CHANGED: StrokeResult = { changed: 0, bounds: null };

/**
 * The layer at the raster the mask is in, resampling only if it has to.
 *
 * The ordinary answer is the layer itself: it was painted at the pipeline's raster and the raster is
 * a function of the image's own pixels and our budget, neither of which moves in normal use. The
 * caller reports the other case rather than swallowing it — see `resamplePaint` for what it costs.
 */
export function paintForRaster(layer: PaintLayer, width: number, height: number): PaintLayer {
  if (layer.width === width && layer.height === height) return layer;
  return resamplePaint(layer, width, height);
}

/**
 * The layer at a different raster, by nearest neighbour.
 *
 * **Nearest rather than "any painted source pixel" or "all of them", and the neutrality is the
 * point.** Those two alternatives grow and shrink the painted area systematically, and which of them
 * is the *safe* direction is opposite for the two layers: more added ink keeps rooms apart, more
 * suppression merges them. A rule that had to differ per layer would be a rule to get wrong.
 * Nearest neither grows nor shrinks, and at the factor of two that a capped map produces it moves an
 * edge by at most one pixel of a mark the GM can see drawn.
 *
 * Only reachable when the source image has been replaced or `MEGAPIXEL_BUDGET` has changed, which is
 * why the caller says so in the log rather than letting it pass as ordinary.
 */
export function resamplePaint(layer: PaintLayer, width: number, height: number): PaintLayer {
  const out = emptyPaint(width, height);
  if (out.width === 0 || out.height === 0 || layer.width === 0 || layer.height === 0) return out;

  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(layer.height - 1, Math.floor(((y + 0.5) * layer.height) / out.height));
    const sourceRow = sy * layer.width;
    const row = y * out.width;
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(layer.width - 1, Math.floor(((x + 0.5) * layer.width) / out.width));
      out.data[row + x] = layer.data[sourceRow + sx]!;
    }
  }
  return out;
}

/**
 * Take the suppressed pixels out of a mask.
 *
 * Returns the mask itself when the layer marks nothing, so an untouched layer costs no allocation —
 * the same shape `applyGapFill` uses, and for the same reason: this runs on every recompose whether
 * or not the GM has ever painted.
 */
export function suppressInk(mask: BinaryMask, layer: PaintLayer | null): BinaryMask {
  return combine(mask, layer, 0);
}

/**
 * Put the drawn pixels into a mask.
 *
 * Last in the stack, which is what makes added ink immune to the stroke-width opening and the island
 * filter. That is not a rule to remember here — it is where the caller puts this call.
 */
export function addInk(mask: BinaryMask, layer: PaintLayer | null): BinaryMask {
  return combine(mask, layer, 1);
}

/** Both of the GM's layers, as everything that composes them takes them. */
export interface PaintPair {
  readonly suppress: PaintLayer | null;
  readonly ink: PaintLayer | null;
}

/**
 * The whole stack, composed: base ink, less suppression, plus added ink.
 *
 * **One statement of the order, and that is the point of the function existing.** The order is not
 * free — suppression before anything else so a later stage works on ink the GM already corrected,
 * added ink last so no filter can second-guess a line drawn deliberately — and until 2026-09-05 it
 * lived inline in `composeInk`, which sits behind the SDK boundary where no headless test can reach
 * it. The pieces were each tested and their *order* was checked by reading.
 *
 * It could be pulled out because the break repair stopped being a term in the middle. While it was
 * derived it had to run between the two, so the composition was not one expression; as a tool that
 * writes into the added-ink layer, it is not part of this at all. That was the user's argument for
 * the three-layer stack, and this is where it pays.
 *
 * The two callers are the pipeline, which composes what becomes walls, and the break tool, which
 * needs the same composite to search for breaks in. Two implementations of that would be the
 * harness-versus-room failure this project has already paid for once.
 */
export function composePaint(base: BinaryMask, paint: PaintPair): BinaryMask {
  return addInk(suppressInk(base, paint.suppress), paint.ink);
}

/**
 * Lay a set of raster indices into a layer, and say how many changed.
 *
 * What accepting a break does: the search hands over exactly the pixels of one channel, and they
 * become added ink indistinguishable from a brush stroke over the same ground. Indices rather than a
 * mask, because a channel is a few hundred pixels scattered in an eight-million-pixel raster and
 * walking the raster to find them would cost more than the accept.
 *
 * Out-of-range indices are skipped rather than trusted. They cannot arise from a search run against
 * this layer's own raster, and silently writing past the end of a typed array is a no-op that would
 * make a real mismatch look like it worked.
 *
 * Reports the same `StrokeResult` a brush stroke does, so the surface repaints an accepted break the
 * way it repaints a stroke — which is what "an accepted break is added ink like any other" has to
 * mean in the code as well as in the prose.
 */
export function paintPixels(layer: PaintLayer, indices: ArrayLike<number>): StrokeResult {
  const { width, height, data } = layer;
  const limit = width * height;
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < indices.length; i++) {
    const at = indices[i]!;
    if (at < 0 || at >= limit || data[at] === 1) continue;
    data[at] = 1;
    changed += 1;
    const x = at % width;
    const y = (at - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (changed === 0) return NOTHING_CHANGED;
  return { changed, bounds: { left: minX, top: minY, right: maxX, bottom: maxY } };
}

function combine(mask: BinaryMask, layer: PaintLayer | null, value: 0 | 1): BinaryMask {
  if (!layer) return mask;
  const at = paintForRaster(layer, mask.width, mask.height);

  // Whether any painted pixel would actually change the mask. Nothing to do is the common case
  // before a GM has painted, and it must not cost a copy of the whole raster.
  let changes = false;
  for (let i = 0; i < at.data.length; i++) {
    if (at.data[i] !== 0 && mask.data[i] !== value) {
      changes = true;
      break;
    }
  }
  if (!changes) return mask;

  const out: BinaryMask = {
    width: mask.width,
    height: mask.height,
    data: Uint8Array.from(mask.data),
  };
  for (let i = 0; i < at.data.length; i++) if (at.data[i] !== 0) out.data[i] = value;
  return out;
}

/**
 * Bumped whenever the byte layout changes.
 *
 * Durable data in someone's scene, so a format change has to be detectable. A version that does not
 * match is refused, which costs the GM that layer once; reading old bytes under new rules would cost
 * them a layer that is subtly wrong and says nothing.
 */
const FORMAT_VERSION = 1;

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
    /*
      Five groups, of which any legal payload needs at most four.

      The longest possible run is the whole raster, and the largest raster the dimension guard below
      admits is well under 2^28 — which four groups of seven bits already covers. **So the fifth
      group is unreachable from a payload this decoder accepts**, and a mutation shortening the loop
      to four is not caught by anything. Stated rather than left looking covered, and kept at five to
      match `frozenGraph.ts` so the two readers are not subtly different.
    */
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
 * The structure catches a great deal here — a run count that does not add up to the raster, a
 * truncated payload, dimensions that are not numbers. What it cannot catch is a corrupted *run
 * length*, which is simply a different and entirely plausible run. This can.
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

/**
 * What identifies this layer's *content*, for the mask cache.
 *
 * Content-derived rather than a revision counter, because the pipeline is reached from two iframes
 * with independent module state and a counter agreeing with itself in one of them says nothing about
 * the other. The cost is a walk of the raster, which the caller pays once when the layer changes
 * rather than on every cache check.
 */
export function paintRevision(layer: PaintLayer | null): string {
  if (!layer) return "-";
  return `${layer.width}x${layer.height}:${checksum(layer.data).toString(36)}`;
}

/**
 * Encode the layer. Base64, because the destination is a JSON string in scene metadata.
 *
 * Alternating run lengths over the whole raster, starting with unpainted. An untouched layer is one
 * run; a solid blob in a corner is a large leading run and then a couple of runs a row. A run of
 * zero is legitimate and is what a layer beginning with a painted pixel emits.
 */
export function encodePaint(layer: PaintLayer): string {
  const body = new ByteWriter();
  body.varint(layer.width);
  body.varint(layer.height);

  const total = layer.width * layer.height;
  let at = 0;
  let painted = 0;
  while (at < total) {
    let run = 0;
    while (at + run < total && (layer.data[at + run] !== 0 ? 1 : 0) === painted) run += 1;
    body.varint(run);
    at += run;
    painted = painted === 0 ? 1 : 0;
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
 * Decode the layer, or `null` if it is not one this version wrote and can vouch for.
 *
 * All or nothing, like the frozen graph and unlike the settings. A settings field can take its
 * default while the others survive; a layer with some of its runs dropped is every mark after the
 * fault in the wrong place, which is a corrupt document presented as a valid one.
 *
 * Seven refusals: not base64, a payload too short to hold a header, wrong version, a checksum that
 * does not match, dimensions that are not a sane raster, runs that do not land exactly on the end of
 * the raster, and trailing bytes after the last one.
 */
export function decodePaint(text: string): PaintLayer | null {
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 5) return null;
  if (bytes[0] !== FORMAT_VERSION) return null;

  const expected = (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
  const body = bytes.slice(5);
  if (checksum(body) !== expected) return null;

  const input = new ByteReader(body);
  const width = input.varint();
  const height = input.varint();
  if (width === null || height === null) return null;
  // A layer larger than anything the budget can produce is not one this build wrote. The guard is
  // against allocating gigabytes from a corrupted length, not against a map we have not met.
  if (width <= 0 || height <= 0 || width * height > MAX_PAINT_PIXELS) return null;

  const layer = emptyPaint(width, height);
  const total = width * height;
  let at = 0;
  let painted = 0;
  while (at < total) {
    const run = input.varint();
    if (run === null) return null;
    // `fill` clamps its own indices, so an overlong run cannot write past the array. What it must
    // not do is pass unnoticed, which the landing check below is for.
    if (painted === 1) layer.data.fill(1, at, at + run);
    at += run;
    painted = painted === 0 ? 1 : 0;
  }
  /*
    The runs must land exactly on the end, and this one check is the whole of that claim.

    There was a second guard inside the loop refusing `at + run > total`, and a mutation pass found
    it could never be the check that fired: the loop only continues while `at < total`, so a run
    that stops short simply asks for another and is refused by the reader running out, and a run that
    overshoots exits the loop and is refused here. A guard that cannot be reached is one a reader
    assumes is load-bearing, so it is gone rather than kept and excused.
  */
  if (at !== total) return null;
  if (!input.done) return null;

  return layer;
}

/**
 * The largest raster a decoded layer may claim.
 *
 * `MEGAPIXEL_BUDGET` is 16 million and is not imported here — this module is pure geometry and the
 * budget belongs to the raster planner. The margin is deliberate: this is a guard against a
 * corrupted length asking for a gigabyte, not a second statement of the budget that could drift out
 * of step with the first and start refusing layers a live map produced.
 */
const MAX_PAINT_PIXELS = 64_000_000;

/**
 * Base64 over bytes, chunked.
 *
 * `String.fromCharCode(...bytes)` in one call overflows the argument limit on a real map's worth of
 * runs — a crash rather than a wrong answer, and only on layers big enough that nobody tested it.
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
