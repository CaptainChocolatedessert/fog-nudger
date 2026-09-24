import { describe, expect, it, vi } from "vitest";

import { WorkerJobs, type JobReply, type JobWorker } from "./workerJobs";

/*
  Fifteen mutations, fifteen caught (2026-09-24, run on the generic runner). One of them — the abandoned
  worker's reply handler left attached — survived the first version, when this was the derive's alone,
  until the fixture for a late reply from an abandoned worker was written.
*/

/** Requests, messages and answers are opaque to the runner, so plain stand-ins do. */
type Request = { readonly job: string };
type Message = { readonly posted: string };
type Value = { readonly from: string };

const FROM_WORKER: Value = { from: "worker" };
const FROM_PAGE: Value = { from: "page" };
const request: Request = { job: "derive" };

/** A worker that does nothing until the test says what happened to it. */
class FakeWorker implements JobWorker<Message, Value> {
  onmessage: JobWorker<Message, Value>["onmessage"] = null;
  onerror: JobWorker<Message, Value>["onerror"] = null;
  onmessageerror: JobWorker<Message, Value>["onmessageerror"] = null;
  readonly posted: { message: Message; transfer: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: Message, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: JobReply<Value>): void {
    this.onmessage?.({ data });
  }
}

const BUFFER = new ArrayBuffer(4);

function harness(spawnThrows = false) {
  const workers: FakeWorker[] = [];
  const gaveUp: string[] = [];
  let spawns = 0;
  let clock = 0;
  const onPage = vi.fn((): JobReply<Value> => ({ ok: true, value: FROM_PAGE, computeMs: 7 }));
  const post = vi.fn((asked: Request) => ({
    message: { posted: asked.job },
    transfer: [BUFFER] as Transferable[],
  }));
  const jobs = new WorkerJobs<Request, Message, Value>({
    spawn: () => {
      spawns += 1;
      if (spawnThrows) throw new Error("workers are not allowed here");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    post,
    onPage,
    onGiveUp: (reason: string) => gaveUp.push(reason),
    now: () => clock,
  });
  return {
    jobs,
    workers,
    gaveUp,
    onPage,
    post,
    spawns: () => spawns,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const worked: JobReply<Value> = { ok: true, value: FROM_WORKER, computeMs: 80 };

describe("WorkerJobs", () => {
  it("posts exactly what the job's own post step made, buffers and all", () => {
    // The post step is where the copies are made (`workerProtocol.ts`); the runner must hand those
    // over, not the request, or the caller's own arrays would be transferred and left empty.
    const { jobs, workers, post } = harness();
    void jobs.run(request);

    expect(post).toHaveBeenCalledWith(request);
    expect(workers[0]!.posted).toEqual([{ message: { posted: "derive" }, transfer: [BUFFER] }]);
  });

  it("answers with the worker's value, the work's own time, and the whole round trip", async () => {
    // The round trip is reported whole: beyond the copying it holds any wait for the page to be free
    // to read the reply, which is not the crossing's cost and was once reported as though it were.
    const { jobs, workers, tick } = harness();
    const pending = jobs.run(request);
    tick(100);
    workers[0]!.reply(worked);

    await expect(pending).resolves.toEqual({
      value: FROM_WORKER,
      where: "worker",
      computeMs: 80,
      roundTripMs: 100,
    });
  });

  it("keeps one worker for job after job", async () => {
    // Starting a worker is a module load, so it is paid once rather than per job.
    const { jobs, workers } = harness();
    const first = jobs.run(request);
    workers[0]!.reply(worked);
    await first;
    const second = jobs.run(request);
    workers[0]!.reply(worked);
    await second;

    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(false);
  });

  it("abandons a running job for a newer one, on a fresh worker", async () => {
    const { jobs, workers } = harness();
    const older = jobs.run(request);
    const newer = jobs.run(request);

    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);

    // A reply the old worker had already sent cannot land on the new job.
    workers[0]!.reply({ ok: true, value: FROM_PAGE, computeMs: 1 });
    workers[1]!.reply(worked);
    await expect(newer).resolves.toMatchObject({ value: FROM_WORKER });
  });

  it("lets a reply from an abandoned worker change nothing, even for a job asked for later", async () => {
    /*
      Whether a browser can still deliver a message from a worker it has terminated is not something
      measured here, so the runner does not rely on it. If the old worker's handler were still
      attached, its late reply would mark the *newer* job finished — and a third job would then neither
      abandon the second nor wait for its worker, leaving the second's promise unsettled for ever and
      the busy worker handed a second job.
    */
    const { jobs, workers } = harness();
    void jobs.run(request).catch(() => undefined);
    const second = jobs.run(request);
    workers[0]!.reply({ ok: true, value: FROM_PAGE, computeMs: 1 });

    const third = jobs.run(request);
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[1]!.terminated).toBe(true);
    expect(workers).toHaveLength(3);

    workers[2]!.reply(worked);
    await expect(third).resolves.toMatchObject({ value: FROM_WORKER });
  });

  it("terminates the worker and rejects with the reason when the job is aborted", async () => {
    const { jobs, workers } = harness();
    const controller = new AbortController();
    const pending = jobs.run(request, controller.signal);
    controller.abort("a newer reading");

    await expect(pending).rejects.toBe("a newer reading");
    expect(workers[0]!.terminated).toBe(true);

    void jobs.run(request);
    expect(workers).toHaveLength(2);
  });

  it("starts nothing for a signal that is already aborted", async () => {
    const { jobs, onPage, spawns, post } = harness();
    const controller = new AbortController();
    controller.abort("too late");

    await expect(jobs.run(request, controller.signal)).rejects.toBe("too late");
    expect(spawns()).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
  });

  it("stops listening to a signal once its job has finished", async () => {
    // Otherwise aborting a controller long after would kill whatever the worker is doing next.
    const { jobs, workers } = harness();
    const controller = new AbortController();
    const pending = jobs.run(request, controller.signal);
    workers[0]!.reply(worked);
    await pending;

    controller.abort();
    expect(workers[0]!.terminated).toBe(false);
  });

  it("rejects a job that failed in the worker, and keeps the worker", async () => {
    // The worker is fine; the job threw. Running it again on the page would only throw again.
    const { jobs, workers, gaveUp, onPage } = harness();
    const pending = jobs.run(request);
    workers[0]!.reply({ ok: false, error: "RangeError: too deep" });

    await expect(pending).rejects.toThrow("RangeError: too deep");
    expect(workers[0]!.terminated).toBe(false);
    expect(gaveUp).toEqual([]);
    expect(onPage).not.toHaveBeenCalled();

    void jobs.run(request);
    expect(workers).toHaveLength(1);
  });

  it("answers on the page when the worker dies, and stops trying workers", async () => {
    const { jobs, workers, gaveUp, onPage, spawns } = harness();
    const pending = jobs.run(request);
    workers[0]!.onerror?.({ message: "NetworkError when attempting to fetch resource" });

    await expect(pending).resolves.toEqual({
      value: FROM_PAGE,
      where: "page",
      computeMs: 7,
      roundTripMs: 7,
    });
    // The caller's own request, since nothing crosses on the page.
    expect(onPage).toHaveBeenCalledWith(request);
    expect(workers[0]!.terminated).toBe(true);
    expect(gaveUp).toEqual(["NetworkError when attempting to fetch resource"]);

    await expect(jobs.run(request)).resolves.toMatchObject({ where: "page" });
    expect(spawns()).toBe(1);
    expect(gaveUp).toHaveLength(1);
  });

  it("still says something when the worker dies without a message", async () => {
    const { jobs, workers, gaveUp } = harness();
    const pending = jobs.run(request);
    workers[0]!.onerror?.({});
    await pending;
    expect(gaveUp).toEqual(["the worker failed to start or crashed"]);
  });

  it("treats a reply it cannot read as a worker lost", async () => {
    const { jobs, workers, gaveUp } = harness();
    const pending = jobs.run(request);
    workers[0]!.onmessageerror?.();

    await expect(pending).resolves.toMatchObject({ where: "page" });
    expect(gaveUp).toEqual(["a reply from the worker could not be read"]);
  });

  it("runs on the page when a worker cannot be created, and does not ask again", async () => {
    const { jobs, gaveUp, spawns } = harness(true);

    await expect(jobs.run(request)).resolves.toMatchObject({ where: "page" });
    expect(gaveUp).toEqual(["the worker could not be created — workers are not allowed here"]);

    await jobs.run(request);
    expect(spawns()).toBe(1);
  });

  it("rejects a job that fails on the page", async () => {
    const { jobs, onPage } = harness(true);
    onPage.mockReturnValueOnce({ ok: false, error: "TypeError: no ink" });
    await expect(jobs.run(request)).rejects.toThrow("TypeError: no ink");
  });

  it("keeps two runners' workers apart, so abandoning one job costs the other nothing", async () => {
    /*
      The pipeline runs the derive and the profiles on separate instances, so the walls never queue
      behind the profiles. The whole of that is that a runner's state is its own.
    */
    const derive = harness();
    const profiles = harness();
    const walls = derive.jobs.run(request);
    const shapes = profiles.jobs.run(request);
    void profiles.jobs.run(request);

    expect(profiles.workers[0]!.terminated).toBe(true);
    expect(derive.workers[0]!.terminated).toBe(false);
    await expect(shapes).rejects.toMatchObject({ name: "AbortError" });
    derive.workers[0]!.reply(worked);
    await expect(walls).resolves.toMatchObject({ value: FROM_WORKER });
  });
});
