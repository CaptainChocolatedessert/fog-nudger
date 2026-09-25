/**
 * What the page and the trace worker say to each other, and the whole of the worker's side of it.
 *
 * ## The three jobs
 *
 * - **The derive** — ink to a wall graph. About 1.1 to 2.4 seconds on the busiest map tried, and while
 *   it held the page nothing painted, no pointer moved, and a derive a newer reading had already made
 *   pointless could not be stopped.
 * - **The ink profiles** — the shapes drawn on the two ink filters' rails, about 1.4 seconds after
 *   every reading while their drawer is open (2026-09-24). On the page they held back the very frame
 *   that showed the new ink, and the derive behind it.
 * - **The ink** — the reading and the recompose, `inkCompose.ts`: 0.8 to 1.7 seconds on the page for
 *   every ink slider released, the freeze left once the other two had moved (2026-09-24).
 *
 * In a worker any of them can be abandoned — terminating it is the one way to stop a synchronous
 * computation — and the page stays live meanwhile. `workerJobs.ts` is the page's side, and the page
 * keeps **one worker per job**, so the walls never wait behind the profiles and neither waits behind
 * the ink.
 *
 * ## Why the worker's side is here rather than in the worker's file
 *
 * So it can be tested. `answerWorkerMessage` is everything the worker does, and a worker cannot be
 * started in node; this module can be imported. `traceWorker.ts` is the wiring alone, and the page runs
 * the same answers when a worker cannot be had, so the two paths are one implementation.
 *
 * **Nothing here may reach the SDK**, and it is load-bearing rather than a habit: the SDK reads
 * `window` the moment it loads, a worker has no `window`, and the worker would die before its first
 * message. Node has no `window` either, so a test importing this module is the check.
 *
 * Pure: no DOM, no SDK.
 */

import type { JobReply } from "../workerJobs";
import type { BinaryMask } from "./binarize";
import {
  deriveWalls,
  summariseDerivation,
  type DeriveWallsOptions,
  type DerivedWalls,
} from "./deriveWalls";
import type { ScalarField } from "./field";
import {
  composeInk,
  readInk,
  type ComposeOptions,
  type ComposedInk,
  type InkPaintLayers,
  type InkReading,
  type ReadOptions,
} from "./inkCompose";
import { measureInkProfiles, type InkProfileInputs, type InkProfileShapes } from "./inkProfile";
import type { PaintLayer } from "./inkPaint";

/** One derive: the composed ink, and how to fit it. */
export interface DeriveRequest {
  readonly ink: BinaryMask;
  readonly options: DeriveWallsOptions;
}

/** One pair of profiles: each filter's input, and the tracks to place them on. */
export type ProfilesRequest = InkProfileInputs;

/**
 * One ink job: a reading when the page has none for these settings, then the composition.
 *
 * **One job rather than two**, because a reading is never wanted without the composition after it,
 * and two jobs on one worker would have the second abandon the first. The page sends the luminance
 * field when the reading's settings moved, and the reading it already holds when only a filter or the
 * paint did.
 */
export interface InkRequest {
  readonly source:
    | { readonly kind: "field"; readonly field: ScalarField; readonly read: ReadOptions }
    | { readonly kind: "reading"; readonly mask: BinaryMask; readonly inkWidth: number | null };
  readonly paint: InkPaintLayers;
  readonly compose: ComposeOptions;
}

export interface InkAnswer {
  /** The reading this job took, or `null` when it was handed one. */
  readonly read: InkReading | null;
  readonly composed: ComposedInk;
}

/** What crosses to the worker: which job, and its request. Plain data, because it is posted. */
export type WorkerMessage =
  | { readonly kind: "derive"; readonly request: DeriveRequest }
  | { readonly kind: "profiles"; readonly request: ProfilesRequest }
  | { readonly kind: "ink"; readonly request: InkRequest };

/**
 * Run a job and say how it went, never throwing.
 *
 * **A failed job is a reply, not a worker error**, and that distinction is what lets the page tell a
 * bug from a worker that never started. The first is an answer to report; the second means the job
 * should run on the page instead. An exception left to escape would reach the page as the same
 * `error` event a failed load does.
 */
function answer<Value>(work: () => Value): JobReply<Value> {
  const started = performance.now();
  try {
    const value = work();
    return { ok: true, value, computeMs: performance.now() - started };
  } catch (error) {
    // The stack where there is one: the page cannot reach the worker's console to find it.
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error),
    };
  }
}

export function answerDeriveRequest(request: DeriveRequest): JobReply<DerivedWalls> {
  return answer(() => summariseDerivation(deriveWalls(request.ink, request.options)));
}

export function answerProfilesRequest(request: ProfilesRequest): JobReply<InkProfileShapes> {
  return answer(() => measureInkProfiles(request));
}

export function answerInkRequest(request: InkRequest): JobReply<InkAnswer> {
  return answer(() => {
    const { source } = request;
    const read = source.kind === "field" ? readInk(source.field, source.read) : null;
    const mask = read ? read.reading.mask : source.kind === "reading" ? source.mask : null;
    const inkWidth = read ? read.reading.inkWidth : source.kind === "reading" ? source.inkWidth : null;
    // Unreachable by the type, and said rather than asserted past: a message is posted data, and a
    // malformed one should come back as a failed reply rather than as a crash in `composeInk`.
    if (!mask) throw new Error(`an ink request with no source to compose from`);
    return { read, composed: composeInk(mask, inkWidth, request.paint, request.compose) };
  });
}

export type WorkerReply = JobReply<DerivedWalls> | JobReply<InkProfileShapes> | JobReply<InkAnswer>;

/** The worker's whole job: whichever was asked for. */
export function answerWorkerMessage(message: WorkerMessage): WorkerReply {
  switch (message.kind) {
    case "derive":
      return answerDeriveRequest(message.request);
    case "profiles":
      return answerProfilesRequest(message.request);
    case "ink":
      return answerInkRequest(message.request);
  }
}

/**
 * The buffers a reply can hand back rather than have copied — **each once**.
 *
 * Only an ink reply has any worth the trouble: up to four masks the size of the raster, 9.4MB each on
 * the busiest map, which a structured clone would copy on the way out. **Each buffer once**, and that
 * is load-bearing rather than tidy: with no filter set and no paint, the base, the composite and the
 * reading's own mask are one array, and a buffer listed twice in a transfer is refused outright — the
 * same trap `postProfiles` answers on the way in.
 */
export function replyTransfer(message: WorkerMessage, reply: WorkerReply): Transferable[] {
  if (message.kind !== "ink" || !reply.ok) return [];
  const { read, composed } = (reply as JobReply<InkAnswer> & { ok: true }).value;
  const buffers = new Set<ArrayBufferLike>([
    composed.base.data.buffer,
    composed.mask.data.buffer,
    composed.beforeIsland.data.buffer,
  ]);
  if (read) buffers.add(read.reading.mask.data.buffer);
  return [...buffers] as Transferable[];
}

/**
 * A mask the page can give away: a copy, whose buffer is handed over rather than copied a second time.
 *
 * Never the caller's own array. The masks posted here are the pipeline's caches — the one the next
 * derive and the point probe read — and a transferred buffer is left empty behind it.
 */
function copied(mask: BinaryMask): { readonly mask: BinaryMask; readonly buffer: ArrayBuffer } {
  const data = new Uint8Array(mask.data);
  return { mask: { width: mask.width, height: mask.height, data }, buffer: data.buffer };
}

export function postDerive(request: DeriveRequest): {
  readonly message: WorkerMessage;
  readonly transfer: Transferable[];
} {
  const ink = copied(request.ink);
  return {
    message: { kind: "derive", request: { ink: ink.mask, options: request.options } },
    transfer: [ink.buffer],
  };
}

/** A paint layer the page can give away, as `copied` is for a mask. */
function copiedLayer(
  layer: PaintLayer | null,
): { readonly layer: PaintLayer | null; readonly buffers: ArrayBuffer[] } {
  if (!layer) return { layer: null, buffers: [] };
  const data = new Uint8Array(layer.data);
  return { layer: { ...layer, data }, buffers: [data.buffer] };
}

export function postInk(request: InkRequest): {
  readonly message: WorkerMessage;
  readonly transfer: Transferable[];
} {
  const suppress = copiedLayer(request.paint.suppress);
  const ink = copiedLayer(request.paint.ink);
  const transfer: Transferable[] = [...suppress.buffers, ...ink.buffers];

  let source: InkRequest["source"];
  if (request.source.kind === "field") {
    // The page keeps its own: the unblurred field is what the point probe and the next reading read.
    const data = new Float32Array(request.source.field.data);
    transfer.push(data.buffer);
    source = { ...request.source, field: { ...request.source.field, data } };
  } else {
    const mask = copied(request.source.mask);
    transfer.push(mask.buffer);
    source = { ...request.source, mask: mask.mask };
  }

  return {
    message: {
      kind: "ink",
      request: { ...request, source, paint: { suppress: suppress.layer, ink: ink.layer } },
    },
    transfer,
  };
}

export function postProfiles(request: ProfilesRequest): {
  readonly message: WorkerMessage;
  readonly transfer: Transferable[];
} {
  const beforeStroke = copied(request.beforeStroke);
  const beforeIsland = copied(request.beforeIsland);
  return {
    message: {
      kind: "profiles",
      request: { ...request, beforeStroke: beforeStroke.mask, beforeIsland: beforeIsland.mask },
    },
    transfer: [beforeStroke.buffer, beforeIsland.buffer],
  };
}
