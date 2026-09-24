/**
 * Running the derive in a worker: one at a time, abandoned the moment nobody wants it.
 *
 * ## Why abandoning is the point
 *
 * A derive cannot be interrupted from inside — it is one synchronous computation — so on the page a
 * derive that a newer reading had made pointless still ran to its end. Measured on opening a busy map
 * (2026-09-24): the first derive was superseded almost as it started, ran its whole 2.4 seconds anyway,
 * and was thrown away before the one that mattered began. **Terminating the worker is the only way to
 * stop it**, so that is what a newer derive or an aborted one does, and the next derive starts a fresh
 * worker. A worker is otherwise kept and reused, since starting one costs a module load.
 *
 * ## Latest wins
 *
 * A derive asked for while another runs abandons the other, which rejects with an `AbortError`. That
 * is `maskRequest.ts`' rule — an answer for settings the GM has left is not worth waiting for — and
 * its header anticipated exactly this: off the page, *"the in-flight one [can] be abandoned rather than
 * merely disowned."*
 *
 * ## When there is no worker
 *
 * If one cannot be created, or dies before answering, the derive runs **on the page** instead — the
 * same function, so the same walls, only blocking as it always did — and workers are not tried again
 * this session. **The walls are right either way**, which is why this falls back rather than failing;
 * what would be wrong is not saying so, so `onGiveUp` is told once, and every result says where it
 * ran. Whether Owlbear's iframe lets a worker start at all has not been measured, and that log line is
 * what will say.
 *
 * A derive that *throws* is different: it comes back as a reply saying so, and rejects here. The
 * worker is fine and is kept, and running it again on the page would only throw again.
 *
 * **A cost, stated: a worker that dies without an `error` event leaves its derive waiting for ever.**
 * Nothing here times it out, because a timeout long enough for the largest map would be no help on a
 * small one. Neither has been seen; a hung derive would show as the working strip never clearing.
 *
 * Pure: the worker is handed in by a factory, so all of the above is tested against a fake.
 */

import type { BinaryMask } from "./trace/binarize";
import type { DeriveReply, DeriveRequest } from "./trace/deriveProtocol";
import type { DeriveWallsOptions, DerivedWalls } from "./trace/deriveWalls";

/** The part of a `Worker` the client uses, so a test can hand over a fake. */
export interface DeriveWorker {
  onmessage: ((event: { readonly data: DeriveReply }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: DeriveRequest, transfer: Transferable[]): void;
  terminate(): void;
}

/** A derivation, and where and how fast it was made — which the log states on every derive. */
export interface Derived {
  readonly derived: DerivedWalls;
  readonly where: "worker" | "page";
  /** The derive itself, timed where it ran. */
  readonly computeMs: number;
  /** The round trip less the derive: posting the ink and copying the reply back. 0 on the page. */
  readonly crossingMs: number;
}

export interface DeriveClientParts {
  /** Start a worker. May throw, which counts as having none. */
  readonly spawn: () => DeriveWorker;
  /** The same derive, on this thread. `answerDeriveRequest` in production. */
  readonly onPage: (request: DeriveRequest) => DeriveReply;
  /** Told once, with the reason, when workers are given up on for the session. */
  readonly onGiveUp?: (reason: string) => void;
  readonly now?: () => number;
}

export class DeriveClient {
  private worker: DeriveWorker | null = null;
  /** Why workers were given up on, or `null` while they are still in use. */
  private givenUp: string | null = null;
  /** The derive running in the worker, if one is: how to reject it from outside. */
  private job: { readonly abandon: (reason: unknown) => void } | null = null;
  private readonly now: () => number;

  constructor(private readonly parts: DeriveClientParts) {
    this.now = parts.now ?? (() => performance.now());
  }

  /**
   * Derive walls from `ink`, in the worker if there is one.
   *
   * `signal` abandons the derive: the worker is terminated and the promise rejects with the signal's
   * reason. Already aborted, and nothing is started at all.
   */
  derive(ink: BinaryMask, options: DeriveWallsOptions, signal?: AbortSignal): Promise<Derived> {
    this.job?.abandon(new DOMException("a newer derive was asked for", "AbortError"));
    if (signal?.aborted) return Promise.reject(signal.reason);

    const worker = this.ready();
    if (!worker) return Promise.resolve().then(() => this.runOnPage({ ink, options }));

    return new Promise<Derived>((resolve, reject) => {
      const started = this.now();

      const finish = (): void => {
        this.job = null;
        signal?.removeEventListener("abort", onAbort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      const abandon = (reason: unknown): void => {
        finish();
        this.drop();
        reject(reason);
      };
      const onAbort = (): void => abandon(signal?.reason);
      // The worker went, rather than the derive failing: answer this one on the page, and stop
      // trying workers.
      const lost = (reason: string): void => {
        finish();
        this.drop();
        this.giveUp(reason);
        try {
          resolve(this.runOnPage({ ink, options }));
        } catch (error) {
          reject(error);
        }
      };

      worker.onmessage = (event) => {
        finish();
        const reply = event.data;
        if (!reply.ok) {
          reject(new Error(`the derive failed in the worker — ${reply.error}`));
          return;
        }
        resolve({
          derived: reply.derived,
          where: "worker",
          computeMs: reply.computeMs,
          crossingMs: Math.max(0, this.now() - started - reply.computeMs),
        });
      };
      worker.onerror = (event) => lost(event.message || "the worker failed to start or crashed");
      worker.onmessageerror = () => lost("a reply from the worker could not be read");

      this.job = { abandon };
      signal?.addEventListener("abort", onAbort, { once: true });

      /*
        A copy, and the copy's buffer is handed over rather than copied a second time.

        Not the caller's own array: that is the pipeline's cached mask, which the next derive and the
        point probe both read, and a transferred buffer is left empty behind it.
      */
      const data = new Uint8Array(ink.data);
      worker.postMessage({ ink: { width: ink.width, height: ink.height, data }, options }, [
        data.buffer,
      ]);
    });
  }

  /** The worker to use, started if need be — or `null` once workers have been given up on. */
  private ready(): DeriveWorker | null {
    if (this.givenUp !== null) return null;
    if (this.worker) return this.worker;
    try {
      this.worker = this.parts.spawn();
    } catch (error) {
      this.giveUp(`the worker could not be created — ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return this.worker;
  }

  private drop(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  /** Once a session, with no guard needed: nothing tries a worker after this. */
  private giveUp(reason: string): void {
    this.givenUp = reason;
    this.parts.onGiveUp?.(reason);
  }

  private runOnPage(request: DeriveRequest): Derived {
    const reply = this.parts.onPage(request);
    if (!reply.ok) throw new Error(`the derive failed — ${reply.error}`);
    return { derived: reply.derived, where: "page", computeMs: reply.computeMs, crossingMs: 0 };
  }
}
