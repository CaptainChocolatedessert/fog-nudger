/**
 * What the page and the derive worker say to each other, and the whole of the worker's side of it.
 *
 * ## Why the derive runs in a worker
 *
 * It is the costliest step the surface waits on — about 1.1 to 2.4 seconds on the busiest map tried —
 * and while it held the page nothing painted, no pointer moved, and a derive that a newer reading had
 * already made pointless could not be stopped, because the work it would cancel held the thread. In a
 * worker it can be abandoned: terminating the worker is the one way to stop a synchronous
 * computation, and the page stays live meanwhile. `deriveClient.ts` is the page's side.
 *
 * ## Why the worker's side is here rather than in the worker's file
 *
 * So it can be tested. `answerDeriveRequest` is everything the worker does, and a worker cannot be
 * started in node; this module can be imported. `deriveWorker.ts` is the wiring alone, and the page
 * runs this same function when a worker cannot be had, so the two paths are one implementation.
 *
 * **Nothing here may reach the SDK**, and it is load-bearing rather than a habit: the SDK reads
 * `window` the moment it loads, a worker has no `window`, and the worker would die before its first
 * message. Node has no `window` either, so a test importing this module is the check.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import {
  deriveWalls,
  summariseDerivation,
  type DeriveWallsOptions,
  type DerivedWalls,
} from "./deriveWalls";

/** One derive: the composed ink, and how to fit it. Plain data, because it is posted. */
export interface DeriveRequest {
  readonly ink: BinaryMask;
  readonly options: DeriveWallsOptions;
}

/**
 * The answer, or what went wrong.
 *
 * **A failed derive is a reply, not a worker error**, and that distinction is what lets the page tell
 * a bug in the derive from a worker that never started. The first is an answer to report; the second
 * means the derive should run on the page instead. An exception left to escape would reach the page
 * as the same `error` event a failed load does.
 */
export type DeriveReply =
  | {
      readonly ok: true;
      readonly derived: DerivedWalls;
      /** The derive itself, timed where it ran — so the page can take it off the round trip. */
      readonly computeMs: number;
    }
  | { readonly ok: false; readonly error: string };

/** Run one derive and say how it went, never throwing. */
export function answerDeriveRequest(request: DeriveRequest): DeriveReply {
  const started = performance.now();
  try {
    const derived = summariseDerivation(deriveWalls(request.ink, request.options));
    return { ok: true, derived, computeMs: performance.now() - started };
  } catch (error) {
    // The stack where there is one: the page cannot reach the worker's console to find it.
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error),
    };
  }
}
