import { describe, expect, it, vi } from "vitest";

import { DeriveClient, type DeriveWorker } from "./deriveClient";
import type { DeriveReply, DeriveRequest } from "./trace/deriveProtocol";
import type { DerivedWalls } from "./trace/deriveWalls";
import { graphExtent } from "./trace/graphUnits";
import { maskFromRows } from "./trace/fixtures";

/*
  Fifteen mutations, fifteen caught (2026-09-24) — one only after the fixture for a late reply from an
  abandoned worker was written, since until then leaving that worker's handler attached passed.
*/

/** Stand-ins: the client never looks inside a derivation, so identity is all a test needs. */
const FROM_WORKER = { from: "worker" } as unknown as DerivedWalls;
const FROM_PAGE = { from: "page" } as unknown as DerivedWalls;

const ink = maskFromRows(["....", ".##.", "...."]);
const options = { tolerance: 1, maxTolerance: 4, pruneLimit: 0, extent: graphExtent(4, 3) };

/** A worker that does nothing until the test says what happened to it. */
class FakeWorker implements DeriveWorker {
  onmessage: DeriveWorker["onmessage"] = null;
  onerror: DeriveWorker["onerror"] = null;
  onmessageerror: DeriveWorker["onmessageerror"] = null;
  readonly posted: { message: DeriveRequest; transfer: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: DeriveRequest, transfer: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: DeriveReply): void {
    this.onmessage?.({ data });
  }
}

function harness(spawnThrows = false) {
  const workers: FakeWorker[] = [];
  const gaveUp: string[] = [];
  let spawns = 0;
  let clock = 0;
  const onPage = vi.fn((): DeriveReply => ({ ok: true, derived: FROM_PAGE, computeMs: 7 }));
  const client = new DeriveClient({
    spawn: () => {
      spawns += 1;
      if (spawnThrows) throw new Error("workers are not allowed here");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onPage,
    onGiveUp: (reason) => gaveUp.push(reason),
    now: () => clock,
  });
  return {
    client,
    workers,
    gaveUp,
    onPage,
    spawns: () => spawns,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const worked: DeriveReply = { ok: true, derived: FROM_WORKER, computeMs: 80 };

describe("DeriveClient", () => {
  it("posts a copy of the ink and gives the copy away, leaving the caller's mask intact", () => {
    // The caller's array is the pipeline's cached mask. A transferred buffer is emptied behind it, so
    // handing over the original would leave the next derive and the point probe reading nothing.
    const { client, workers } = harness();
    void client.derive(ink, options);

    const [{ message, transfer }] = workers[0]!.posted as [{ message: DeriveRequest; transfer: Transferable[] }];
    expect(message.ink.data).not.toBe(ink.data);
    expect(Array.from(message.ink.data)).toEqual(Array.from(ink.data));
    expect(message.ink.width).toBe(4);
    expect(message.ink.height).toBe(3);
    expect(message.options).toBe(options);
    expect(transfer).toEqual([message.ink.data.buffer]);
    expect(ink.data.byteLength).toBe(12);
  });

  it("answers with the worker's derivation, and takes the derive's own time off the round trip", async () => {
    const { client, workers, tick } = harness();
    const pending = client.derive(ink, options);
    tick(100);
    workers[0]!.reply(worked);

    await expect(pending).resolves.toEqual({
      derived: FROM_WORKER,
      where: "worker",
      computeMs: 80,
      crossingMs: 20,
    });
  });

  it("keeps one worker for derive after derive", async () => {
    // Starting a worker is a module load, so it is paid once rather than per derive.
    const { client, workers } = harness();
    const first = client.derive(ink, options);
    workers[0]!.reply(worked);
    await first;
    const second = client.derive(ink, options);
    workers[0]!.reply(worked);
    await second;

    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(false);
  });

  it("abandons a running derive for a newer one, on a fresh worker", async () => {
    const { client, workers } = harness();
    const older = client.derive(ink, options);
    const newer = client.derive(ink, options);

    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);

    // A reply the old worker had already sent cannot land on the new derive.
    workers[0]!.reply({ ok: true, derived: FROM_PAGE, computeMs: 1 });
    workers[1]!.reply(worked);
    await expect(newer).resolves.toMatchObject({ derived: FROM_WORKER });
  });

  it("lets a reply from an abandoned worker change nothing, even for a derive asked for later", async () => {
    /*
      Whether a browser can still deliver a message from a worker it has terminated is not something
      measured here, so the client does not rely on it. If the old worker's handler were still
      attached, its late reply would mark the *newer* derive finished — and a third derive would then
      neither abandon the second nor wait for its worker, leaving the second's promise unsettled for
      ever and the busy worker handed a second job.
    */
    const { client, workers } = harness();
    void client.derive(ink, options).catch(() => undefined);
    const second = client.derive(ink, options);
    workers[0]!.reply({ ok: true, derived: FROM_PAGE, computeMs: 1 });

    const third = client.derive(ink, options);
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[1]!.terminated).toBe(true);
    expect(workers).toHaveLength(3);

    workers[2]!.reply(worked);
    await expect(third).resolves.toMatchObject({ derived: FROM_WORKER });
  });

  it("terminates the worker and rejects with the reason when the derive is aborted", async () => {
    const { client, workers } = harness();
    const controller = new AbortController();
    const pending = client.derive(ink, options, controller.signal);
    controller.abort("a newer reading");

    await expect(pending).rejects.toBe("a newer reading");
    expect(workers[0]!.terminated).toBe(true);

    void client.derive(ink, options);
    expect(workers).toHaveLength(2);
  });

  it("starts nothing for a signal that is already aborted", async () => {
    const { client, onPage, spawns } = harness();
    const controller = new AbortController();
    controller.abort("too late");

    await expect(client.derive(ink, options, controller.signal)).rejects.toBe("too late");
    expect(spawns()).toBe(0);
    expect(onPage).not.toHaveBeenCalled();
  });

  it("stops listening to a signal once its derive has finished", async () => {
    // Otherwise aborting a controller long after would kill whatever the worker is doing next.
    const { client, workers } = harness();
    const controller = new AbortController();
    const pending = client.derive(ink, options, controller.signal);
    workers[0]!.reply(worked);
    await pending;

    controller.abort();
    expect(workers[0]!.terminated).toBe(false);
  });

  it("rejects a derive that failed in the worker, and keeps the worker", async () => {
    // The worker is fine; the derive threw. Running it again on the page would only throw again.
    const { client, workers, gaveUp, onPage } = harness();
    const pending = client.derive(ink, options);
    workers[0]!.reply({ ok: false, error: "RangeError: too deep" });

    await expect(pending).rejects.toThrow("RangeError: too deep");
    expect(workers[0]!.terminated).toBe(false);
    expect(gaveUp).toEqual([]);
    expect(onPage).not.toHaveBeenCalled();

    void client.derive(ink, options);
    expect(workers).toHaveLength(1);
  });

  it("answers on the page when the worker dies, and stops trying workers", async () => {
    const { client, workers, gaveUp, onPage, spawns } = harness();
    const pending = client.derive(ink, options);
    workers[0]!.onerror?.({ message: "NetworkError when attempting to fetch resource" });

    await expect(pending).resolves.toEqual({
      derived: FROM_PAGE,
      where: "page",
      computeMs: 7,
      crossingMs: 0,
    });
    // The caller's own mask, since nothing crosses on the page.
    expect(onPage).toHaveBeenCalledWith({ ink, options });
    expect(workers[0]!.terminated).toBe(true);
    expect(gaveUp).toEqual(["NetworkError when attempting to fetch resource"]);

    await expect(client.derive(ink, options)).resolves.toMatchObject({ where: "page" });
    expect(spawns()).toBe(1);
    expect(gaveUp).toHaveLength(1);
  });

  it("still says something when the worker dies without a message", async () => {
    const { client, workers, gaveUp } = harness();
    const pending = client.derive(ink, options);
    workers[0]!.onerror?.({});
    await pending;
    expect(gaveUp).toEqual(["the worker failed to start or crashed"]);
  });

  it("treats a reply it cannot read as a worker lost", async () => {
    const { client, workers, gaveUp } = harness();
    const pending = client.derive(ink, options);
    workers[0]!.onmessageerror?.();

    await expect(pending).resolves.toMatchObject({ where: "page" });
    expect(gaveUp).toEqual(["a reply from the worker could not be read"]);
  });

  it("derives on the page when a worker cannot be created, and does not ask again", async () => {
    const { client, gaveUp, spawns } = harness(true);

    await expect(client.derive(ink, options)).resolves.toMatchObject({ where: "page" });
    expect(gaveUp).toEqual(["the worker could not be created — workers are not allowed here"]);

    await client.derive(ink, options);
    expect(spawns()).toBe(1);
  });

  it("rejects a derive that fails on the page", async () => {
    const { client, onPage } = harness(true);
    onPage.mockReturnValueOnce({ ok: false, error: "TypeError: no ink" });
    await expect(client.derive(ink, options)).rejects.toThrow("TypeError: no ink");
  });
});
