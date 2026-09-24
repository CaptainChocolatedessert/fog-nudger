/**
 * The derive, off the page: a dedicated worker that does one thing.
 *
 * **Nearly empty on purpose.** Everything it does is `answerDeriveRequest`, which is pure and tested
 * in node; this is the wiring — one request in, one reply out. `trace/deriveProtocol.ts` says why the
 * derive is here at all, and `deriveClient.ts` is the page's side.
 *
 * **It imports exactly one module, and `deriveWorker.test.ts` pins that.** A worker has no `window`
 * and the SDK reads one the moment it loads, so an import that drags the SDK in kills the worker before
 * its first message — and the page would quietly fall back to deriving on its own thread, which looks
 * like working.
 *
 * **The one entry point that does not call `setDevLogLabel`**, because it never logs. The page logs
 * every derive when the reply lands, from the timings the reply carries, so the figures reach
 * `dev.log` under the surface that asked for them.
 */

import { answerDeriveRequest, type DeriveRequest } from "./trace/deriveProtocol";

// The worker's global scope, typed by hand: the project compiles against the DOM library, where
// `self` is a window.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DeriveRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  scope.postMessage(answerDeriveRequest(event.data));
};
