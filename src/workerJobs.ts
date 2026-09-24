/**
 * Running one kind of job in a worker: one at a time, abandoned the moment nobody wants it.
 *
 * Two kinds use it — the derive and the ink profiles — each with **its own instance and so its own
 * worker**, so the walls never queue behind the profiles and either can be abandoned without the
 * other. `pipeline.ts` makes both. It was the derive's alone (`deriveClient.ts`) until the profiles
 * joined it on 2026-09-24, and it is one class rather than two because the part that is easy to get
 * wrong — abandoning — is the same for both.
 *
 * ## Why abandoning is the point
 *
 * The work cannot be interrupted from inside — each job is one synchronous computation — so on the page
 * a job that newer input had made pointless still ran to its end. Measured on opening a busy map
 * (2026-09-24): the first derive was superseded almost as it started, ran its whole 2.4 seconds anyway,
 * and was thrown away before the one that mattered began. **Terminating the worker is the only way to
 * stop it**, so that is what a newer job or an aborted one does, and the next job starts a fresh
 * worker. A worker is otherwise kept and reused, since starting one costs a module load.
 *
 * ## Latest wins
 *
 * A job asked for while another runs abandons the other, which rejects with an `AbortError`. That is
 * `maskRequest.ts`' rule — an answer for settings the GM has left is not worth waiting for — and its
 * header anticipated exactly this: off the page, *"the in-flight one [can] be abandoned rather than
 * merely disowned."*
 *
 * ## When there is no worker
 *
 * If one cannot be created, or dies before answering, the job runs **on the page** instead — the same
 * function, so the same answer, only blocking as it always did — and workers are not tried again this
 * session. **The answer is right either way**, which is why this falls back rather than failing; what
 * would be wrong is not saying so, so `onGiveUp` is told once, and every result says where it ran.
 *
 * A job that *throws* is different: it comes back as a reply saying so, and rejects here. The worker is
 * fine and is kept, and running it again on the page would only throw again.
 *
 * **A cost, stated: a worker that dies without an `error` event leaves its job waiting for ever.**
 * Nothing here times it out, because a timeout long enough for the largest map would be no help on a
 * small one. Neither has been seen; a hung derive would show as the working strip never clearing.
 *
 * Pure: the worker is handed in by a factory, so all of the above is tested against a fake.
 */

/** A job's answer, or what went wrong. A failed job is a reply, never an escaped exception. */
export type JobReply<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
      /** The work itself, timed where it ran — which is not the round trip. */
      readonly computeMs: number;
    }
  | { readonly ok: false; readonly error: string };

/** The part of a `Worker` this uses, so a test can hand over a fake. */
export interface JobWorker<Message, Value> {
  onmessage: ((event: { readonly data: JobReply<Value> }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: Message, transfer: Transferable[]): void;
  terminate(): void;
}

/** A job's answer, and where and how fast it was made — which the log states every time. */
export interface Ran<Value> {
  readonly value: Value;
  readonly where: "worker" | "page";
  /** The work itself, timed where it ran. */
  readonly computeMs: number;
  /**
   * From asking to having the answer on the page. Beyond the work it holds copying both ways, a fresh
   * worker's start, and any wait for the page to be free to read the reply — which is why it is
   * reported whole rather than as a "crossing" with the work taken off: a busy page is not the
   * crossing's cost. Equal to `computeMs` on the page.
   */
  readonly roundTripMs: number;
}

export interface WorkerJobsParts<Request, Message, Value> {
  /** Start a worker. May throw, which counts as having none. */
  readonly spawn: () => JobWorker<Message, Value>;
  /**
   * What to post for a request, and the buffers to hand over. **Copies, never the caller's own
   * arrays**: a transferred buffer is left empty behind it, and the callers' are the pipeline's caches.
   */
  readonly post: (request: Request) => { readonly message: Message; readonly transfer: Transferable[] };
  /** The same job, on this thread. */
  readonly onPage: (request: Request) => JobReply<Value>;
  /** Told once, with the reason, when workers are given up on for the session. */
  readonly onGiveUp?: (reason: string) => void;
  readonly now?: () => number;
}

export class WorkerJobs<Request, Message, Value> {
  private worker: JobWorker<Message, Value> | null = null;
  /** Why workers were given up on, or `null` while they are still in use. */
  private givenUp: string | null = null;
  /** The job running in the worker, if one is: how to reject it from outside. */
  private job: { readonly abandon: (reason: unknown) => void } | null = null;
  private readonly now: () => number;

  constructor(private readonly parts: WorkerJobsParts<Request, Message, Value>) {
    this.now = parts.now ?? (() => performance.now());
  }

  /**
   * Run one job, in the worker if there is one.
   *
   * `signal` abandons it: the worker is terminated and the promise rejects with the signal's reason.
   * Already aborted, and nothing is started at all.
   */
  run(request: Request, signal?: AbortSignal): Promise<Ran<Value>> {
    this.job?.abandon(new DOMException("a newer job was asked for", "AbortError"));
    if (signal?.aborted) return Promise.reject(signal.reason);

    const worker = this.ready();
    if (!worker) return Promise.resolve().then(() => this.runOnPage(request));

    return new Promise<Ran<Value>>((resolve, reject) => {
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
      // The worker went, rather than the job failing: answer this one on the page, and stop trying
      // workers.
      const lost = (reason: string): void => {
        finish();
        this.drop();
        this.giveUp(reason);
        try {
          resolve(this.runOnPage(request));
        } catch (error) {
          reject(error);
        }
      };

      worker.onmessage = (event) => {
        finish();
        const reply = event.data;
        if (!reply.ok) {
          reject(new Error(`failed in the worker — ${reply.error}`));
          return;
        }
        resolve({
          value: reply.value,
          where: "worker",
          computeMs: reply.computeMs,
          roundTripMs: this.now() - started,
        });
      };
      worker.onerror = (event) => lost(event.message || "the worker failed to start or crashed");
      worker.onmessageerror = () => lost("a reply from the worker could not be read");

      this.job = { abandon };
      signal?.addEventListener("abort", onAbort, { once: true });

      const { message, transfer } = this.parts.post(request);
      worker.postMessage(message, transfer);
    });
  }

  /** The worker to use, started if need be — or `null` once workers have been given up on. */
  private ready(): JobWorker<Message, Value> | null {
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

  private runOnPage(request: Request): Ran<Value> {
    const reply = this.parts.onPage(request);
    if (!reply.ok) throw new Error(`failed — ${reply.error}`);
    return {
      value: reply.value,
      where: "page",
      computeMs: reply.computeMs,
      roundTripMs: reply.computeMs,
    };
  }
}
