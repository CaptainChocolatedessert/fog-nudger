/**
 * The trace's heavy jobs, off the page: a dedicated worker that answers one message at a time.
 *
 * **Nearly empty on purpose.** Everything it does is `answerWorkerMessage` — the derive, or the ink
 * profiles — which is pure and tested in node; this is the wiring, one message in and one reply out.
 * `trace/workerProtocol.ts` says why those two jobs are here, and `workerJobs.ts` is the page's side,
 * which starts one of these per job.
 *
 * **It imports exactly one module, and `traceWorker.test.ts` pins that.** A worker has no `window` and
 * the SDK reads one the moment it loads, so an import that drags the SDK in kills the worker before its
 * first message — and the page would quietly fall back to doing the work on its own thread, which looks
 * like working.
 *
 * **The one entry point that does not call `setDevLogLabel`**, because it never logs. The page logs
 * every job when the reply lands, from the timings the reply carries, so the figures reach `dev.log`
 * under the surface that asked for them.
 */

import { answerWorkerMessage, type WorkerMessage } from "./trace/workerProtocol";

// The worker's global scope, typed by hand: the project compiles against the DOM library, where
// `self` is a window.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  scope.postMessage(answerWorkerMessage(event.data));
};
