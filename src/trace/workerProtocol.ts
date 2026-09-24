/**
 * What the page and the trace worker say to each other, and the whole of the worker's side of it.
 *
 * ## The two jobs
 *
 * - **The derive** — ink to a wall graph. About 1.1 to 2.4 seconds on the busiest map tried, and while
 *   it held the page nothing painted, no pointer moved, and a derive a newer reading had already made
 *   pointless could not be stopped.
 * - **The ink profiles** — the shapes drawn on the two ink filters' rails, about 1.4 seconds after
 *   every reading while their drawer is open (2026-09-24). On the page they held back the very frame
 *   that showed the new ink, and the derive behind it.
 *
 * In a worker either can be abandoned — terminating it is the one way to stop a synchronous
 * computation — and the page stays live meanwhile. `workerJobs.ts` is the page's side, and the page
 * keeps **one worker per job**, so the walls never wait behind the profiles.
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
import { measureInkProfiles, type InkProfileInputs, type InkProfileShapes } from "./inkProfile";

/** One derive: the composed ink, and how to fit it. */
export interface DeriveRequest {
  readonly ink: BinaryMask;
  readonly options: DeriveWallsOptions;
}

/** One pair of profiles: each filter's input, and the tracks to place them on. */
export type ProfilesRequest = InkProfileInputs;

/** What crosses to the worker: which job, and its request. Plain data, because it is posted. */
export type WorkerMessage =
  | { readonly kind: "derive"; readonly request: DeriveRequest }
  | { readonly kind: "profiles"; readonly request: ProfilesRequest };

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

/** The worker's whole job: whichever was asked for. */
export function answerWorkerMessage(
  message: WorkerMessage,
): JobReply<DerivedWalls> | JobReply<InkProfileShapes> {
  return message.kind === "derive"
    ? answerDeriveRequest(message.request)
    : answerProfilesRequest(message.request);
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
