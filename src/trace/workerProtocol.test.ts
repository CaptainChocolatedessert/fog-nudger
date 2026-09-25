import { describe, expect, it } from "vitest";

import type { BinaryMask } from "./binarize";
import { deriveWalls, summariseDerivation, type DerivedWalls } from "./deriveWalls";
import { field, randomInk, seededRandom } from "./fixtures";
import { graphExtent } from "./graphUnits";
import { composeInk, readInk, type ComposedInk, type InkLine } from "./inkCompose";
import type { PaintLayer } from "./inkPaint";
import { measureInkProfiles } from "./inkProfile";
import {
  answerDeriveRequest,
  answerInkRequest,
  answerProfilesRequest,
  answerWorkerMessage,
  postDerive,
  postInk,
  postProfiles,
  replyTransfer,
  type InkRequest,
  type WorkerMessage,
} from "./workerProtocol";

/*
  Seven mutations, seven caught (2026-09-24): an exception let out of an answer, the dispatch reversed,
  the page's own array posted instead of a copy, one copy shared by both profile inputs, one buffer of
  two given away, a count dropped from the derive's summary, and the skeleton's edges counted as its
  nodes. The last two are why the field-by-field summary test exists: the sweep compares against the
  same summary, so run alone it passed the miscounted edges, and caught the dropped count only because
  its reach check wants an over-cap face.

  Nine more for the ink job, nine caught (2026-09-24, run before this was written): the handed ink width
  dropped, the reading taken and not returned, the reading's mask left out of the reply's transfer, a
  failed reply searched for buffers, the reply's buffers listed as found rather than once each, the
  page's own field posted, the page's own paint posted, the paint's copies not handed over, and the ink
  job dispatched as a derive. Eleven over the composition itself are in `inkCompose.test.ts`. What no
  test here can reach is `traceWorker.ts` posting the reply with its transfer list: that runs only in a
  worker, and a list it forgot would copy the masks rather than fail.
*/

/** Everything but the timings, which differ between any two runs of the same derive. */
function untimed(derived: DerivedWalls): Omit<DerivedWalls, "timings"> {
  const { timings: _timings, ...rest } = derived;
  return rest;
}

/** Random ink, and the options every derive here uses: low enough a cap that some seeds escalate. */
function deriveCase(seed: number) {
  return {
    ink: randomInk(40, 30, seededRandom(seed), 22),
    options: {
      tolerance: 0.5,
      maxTolerance: 8,
      pruneLimit: 3 / 40,
      extent: graphExtent(40, 30),
      // Random straight runs make plain rectangles, which never exceed 8 commands, so 4 it is.
      maxCommands: seed % 3 === 0 ? 4 : undefined,
    },
  };
}

/** A luminance field of dark runs on a pale ground, noisy enough that the blur changes the reading. */
function luminanceCase(seed: number, width = 50, height = 36) {
  const ink = randomInk(width, height, seededRandom(seed), 24);
  const random = seededRandom(seed * 31 + 7);
  return field(width, height, (x, y) => {
    const tone = ink.data[y * width + x] ? 0.12 : 0.88;
    return Math.min(1, Math.max(0, tone + (random() - 0.5) * 0.4));
  });
}

function paintLayer(width: number, height: number, random: () => number): PaintLayer {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = random() < 0.04 ? 1 : 0;
  return { width, height, data };
}

/**
 * An ink request of either kind. The stroke setting is high enough to bite at the widths random runs
 * measure, and the island floor low enough to leave some ink standing.
 */
function inkCase(seed: number, kind: "field" | "reading"): InkRequest {
  const luminance = luminanceCase(seed);
  const random = seededRandom(seed * 17 + 3);
  const paint = {
    suppress: seed % 3 === 0 ? null : paintLayer(luminance.width, luminance.height, random),
    ink: seed % 4 === 0 ? null : paintLayer(luminance.width, luminance.height, random),
  };
  const compose = { minStrokeInkWidths: 1 + (seed % 3) * 0.5, minIslandPx: seed % 5, pxPerSquare: 20 };
  const read = { blurSigma: seed % 2, radius: 5, k: 0.3 };
  if (kind === "field") return { source: { kind: "field", field: luminance, read }, paint, compose };
  const { reading } = readInk(luminance, read);
  // A width that is not the reading's own, so the test can tell the handed one was used.
  return {
    source: { kind: "reading", mask: reading.mask, inkWidth: (reading.inkWidth ?? 2) + 1.5 },
    paint,
    compose,
  };
}

/** The log lines with their timings taken out, which differ between any two runs. */
function untimedLines(lines: readonly InkLine[]): InkLine[] {
  return lines.map((line) => ({ ...line, text: line.text.replace(/\d+ms/g, "#ms") }));
}

function untimedComposed(composed: ComposedInk) {
  return { ...composed, lines: untimedLines(composed.lines) };
}

function profilesCase(seed: number) {
  const random = seededRandom(seed);
  return {
    beforeStroke: randomInk(60, 40, random, 30),
    beforeIsland: randomInk(60, 40, random, 18),
    inkWidthPx: 3.4,
    maxInkWidths: 3,
    maxSpanPx: 40,
    spanBins: 8,
  };
}

describe("answerDeriveRequest", () => {
  /*
    The oracle is the browser's own copying.

    A worker's reply reaches the page through the structured clone, which throws on a function and
    silently drops a class's prototype — so a field that cannot cross would either kill the reply or
    arrive as something that merely looks like it. `toStrictEqual` checks prototypes, so a reply that
    survives `structuredClone` equal to itself crossed intact. And it must say what a derive on the
    page would have said, since the page runs the same function when there is no worker.
  */
  it("answers exactly what the derive says, in a form that survives the crossing", () => {
    let faces = 0;
    let pruned = 0;
    let walls = 0;
    let escalated = 0;
    let overCap = 0;

    for (let seed = 1; seed <= 60; seed++) {
      const { ink, options } = deriveCase(seed);
      const reply = answerDeriveRequest({ ink, options });
      if (!reply.ok) throw new Error(`seed ${seed} failed: ${reply.error}`);

      expect(structuredClone(reply)).toStrictEqual(reply);
      expect(untimed(reply.value)).toStrictEqual(untimed(summariseDerivation(deriveWalls(ink, options))));
      expect(reply.computeMs).toBeGreaterThanOrEqual(0);

      faces += reply.value.faces.faces.length;
      pruned += reply.value.pruning.removed;
      walls += reply.value.walls.graph.edges.length;
      escalated += reply.value.escalations;
      overCap += reply.value.overCap;
    }

    // The sweep has to reach what it claims to check, or it is a green light about nothing.
    expect(faces).toBeGreaterThan(0);
    expect(pruned).toBeGreaterThan(0);
    expect(walls).toBeGreaterThan(0);
    expect(escalated).toBeGreaterThan(0);
    expect(overCap).toBeGreaterThan(0);
  });

  /*
    The sweep above compares the reply with `summariseDerivation` run on the page, so a mistake inside
    that function would agree with itself. This states what each figure must be against the full
    derivation it came from.
  */
  it("summarises a derivation without changing a figure the trace reads", () => {
    // Seed 3, found by a probe over forty: the only one there that prunes, escalates, ends over the
    // cap and removes slivers all at once — most never escalate even at a cap of four.
    const { ink, options } = deriveCase(3);
    const derived = deriveWalls(ink, options);
    const summary = summariseDerivation(derived);

    expect(summary.walls).toBe(derived.walls);
    expect(summary.faces).toBe(derived.faces);
    expect(summary.pruning).toEqual({
      removed: derived.pruning.removed,
      segments: derived.pruning.segments,
      rounds: derived.pruning.rounds,
    });
    expect(summary.skeleton).toEqual({
      nodes: derived.graph.nodes.length,
      edges: derived.graph.edges.length,
      stats: derived.graph.stats,
    });
    expect(summary.thinning).toBe(derived.thinning);
    expect(summary.sliversRemoved).toBe(derived.sliversRemoved);
    expect(summary.sliverRounds).toBe(derived.sliverRounds);
    expect(summary.sliversLeft).toBe(derived.sliversLeft);
    expect(summary.overCap).toBe(derived.overCap);
    expect(summary.tolerance).toBe(derived.tolerance);
    expect(summary.escalations).toBe(derived.escalations);
    expect(summary.timings).toBe(derived.timings);
    // And the fixture is one where the counts are not all zero, or equality says little.
    expect(derived.pruning.removed).toBeGreaterThan(0);
    expect(derived.escalations).toBeGreaterThan(0);
    expect(derived.overCap).toBeGreaterThan(0);
    expect(derived.sliversRemoved).toBeGreaterThan(0);
  });

  it("answers a derive that throws with what went wrong, rather than throwing", () => {
    // An exception escaping the worker reaches the page as the same event a failed load does, and the
    // page would take a bug for a missing worker. So it is a reply.
    const reply = answerDeriveRequest({
      ink: null as unknown as BinaryMask,
      options: { tolerance: 1, maxTolerance: 1, pruneLimit: 0, extent: graphExtent(1, 1) },
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toContain("TypeError");
  });
});

describe("answerProfilesRequest", () => {
  it("answers exactly what the measurement says, in a form that survives the crossing", () => {
    let stroke = 0;
    let island = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const request = profilesCase(seed);
      const reply = answerProfilesRequest(request);
      if (!reply.ok) throw new Error(`seed ${seed} failed: ${reply.error}`);

      expect(structuredClone(reply)).toStrictEqual(reply);
      expect(reply.value).toStrictEqual(measureInkProfiles(request));
      stroke += reply.value.stroke.filter((point) => point.ink > 0).length;
      island += reply.value.island.filter((point) => point.ink > 0).length;
    }
    // Both shapes have to have had something in them, or equality compared empty arrays.
    expect(stroke).toBeGreaterThan(0);
    expect(island).toBeGreaterThan(0);
  });

  it("answers a measurement that throws with what went wrong, rather than throwing", () => {
    const reply = answerProfilesRequest({ ...profilesCase(1), beforeStroke: null as unknown as BinaryMask });
    expect(reply.ok).toBe(false);
  });
});

describe("answerInkRequest", () => {
  it("reads the field and composes from what it read, as the two functions do on the page", () => {
    let filtered = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const request = inkCase(seed, "field");
      if (request.source.kind !== "field") throw new Error("wrong case");
      const reply = answerInkRequest(request);
      if (!reply.ok) throw new Error(`seed ${seed} failed: ${reply.error}`);

      const read = readInk(request.source.field, request.source.read);
      const composed = composeInk(read.reading.mask, read.reading.inkWidth, request.paint, request.compose);

      expect(reply.value.read?.reading).toStrictEqual(read.reading);
      expect(untimedComposed(reply.value.composed)).toStrictEqual(untimedComposed(composed));
      if (reply.value.composed.base.data.some((v, i) => v !== read.reading.mask.data[i])) filtered += 1;
    }
    // A composition that did nothing to the reading would match a job that forgot to compose.
    expect(filtered).toBeGreaterThan(0);
  });

  it("composes from the reading and the ink width it is handed, and takes no reading of its own", () => {
    let widthMattered = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const request = inkCase(seed, "reading");
      if (request.source.kind !== "reading") throw new Error("wrong case");
      const reply = answerInkRequest(request);
      if (!reply.ok) throw new Error(`seed ${seed} failed: ${reply.error}`);

      const { mask, inkWidth } = request.source;
      expect(reply.value.read).toBeNull();
      expect(untimedComposed(reply.value.composed)).toStrictEqual(
        untimedComposed(composeInk(mask, inkWidth, request.paint, request.compose)),
      );

      // The handed width is 1.5 off the reading's own, so a job using any other width differs somewhere.
      const other = composeInk(mask, (inkWidth ?? 0) - 1.5, request.paint, request.compose);
      if (other.base.data.some((v, i) => v !== reply.value.composed.base.data[i])) widthMattered += 1;
    }
    expect(widthMattered).toBeGreaterThan(0);
  });

  it("answers a malformed request with what went wrong, rather than throwing", () => {
    const request = inkCase(1, "reading");
    const reply = answerInkRequest({
      ...request,
      source: { kind: "neither" } as unknown as InkRequest["source"],
    });
    expect(reply.ok).toBe(false);
  });
});

describe("replyTransfer", () => {
  it("hands back every mask of an ink reply, each buffer once, and the reply survives it", () => {
    for (const seed of [1, 2, 3, 6]) {
      for (const kind of ["field", "reading"] as const) {
        const message: WorkerMessage = { kind: "ink", request: inkCase(seed, kind) };
        const reply = answerWorkerMessage(message);
        if (!reply.ok || !("composed" in reply.value)) throw new Error("the ink job failed");
        const { read, composed } = reply.value;

        const transfer = replyTransfer(message, reply);
        const expected = new Set<ArrayBufferLike>([
          composed.base.data.buffer,
          composed.mask.data.buffer,
          composed.beforeIsland.data.buffer,
          ...(read ? [read.reading.mask.data.buffer] : []),
        ]);
        expect(new Set(transfer)).toEqual(expected);
        expect(transfer).toHaveLength(expected.size);

        const base = new Uint8Array(composed.base.data);
        const mask = new Uint8Array(composed.mask.data);
        const copy = structuredClone(reply, { transfer });
        if (!copy.ok || !("composed" in copy.value)) throw new Error("the reply did not survive");
        // Arrived whole, and given away rather than copied: the worker's side is left empty.
        expect(copy.value.composed.base.data).toEqual(base);
        expect(copy.value.composed.mask.data).toEqual(mask);
        expect(composed.mask.data.length).toBe(0);
      }
    }
  });

  it("lists a buffer the masks share only once, which is what an unfiltered map sends", () => {
    // With no filter set and nothing painted, the base, the composite, the island filter's input and
    // the reading are one array — and a transfer listing it twice is refused outright.
    const luminance = luminanceCase(4);
    const message: WorkerMessage = {
      kind: "ink",
      request: {
        source: { kind: "field", field: luminance, read: { blurSigma: 1, radius: 5, k: 0.3 } },
        paint: { suppress: null, ink: null },
        compose: { minStrokeInkWidths: 0, minIslandPx: 0, pxPerSquare: 20 },
      },
    };
    const reply = answerWorkerMessage(message);
    const transfer = replyTransfer(message, reply);
    expect(transfer).toHaveLength(1);
    expect(() => structuredClone(reply, { transfer })).not.toThrow();
  });

  it("hands nothing back from the other jobs, or from a failure", () => {
    const derive: WorkerMessage = { kind: "derive", request: deriveCase(1) };
    expect(replyTransfer(derive, answerWorkerMessage(derive))).toEqual([]);
    const profiles: WorkerMessage = { kind: "profiles", request: profilesCase(1) };
    expect(replyTransfer(profiles, answerWorkerMessage(profiles))).toEqual([]);
    const broken: WorkerMessage = {
      kind: "ink",
      request: { ...inkCase(1, "reading"), source: null as unknown as InkRequest["source"] },
    };
    expect(replyTransfer(broken, answerWorkerMessage(broken))).toEqual([]);
  });
});

describe("answerWorkerMessage", () => {
  it("does the job the message names", () => {
    // Each answer has a field the others lack, so a dispatch the wrong way round cannot pass.
    const derive = answerWorkerMessage({ kind: "derive", request: deriveCase(1) });
    const profiles = answerWorkerMessage({ kind: "profiles", request: profilesCase(1) });
    const ink = answerWorkerMessage({ kind: "ink", request: inkCase(1, "field") });

    if (!derive.ok || !profiles.ok || !ink.ok) throw new Error("a job failed");
    expect(derive.value).toHaveProperty("walls");
    expect(derive.value).not.toHaveProperty("stroke");
    expect(derive.value).not.toHaveProperty("composed");
    expect(profiles.value).toHaveProperty("stroke");
    expect(profiles.value).not.toHaveProperty("walls");
    expect(profiles.value).not.toHaveProperty("composed");
    expect(ink.value).toHaveProperty("composed");
    expect(ink.value).not.toHaveProperty("walls");
    expect(ink.value).not.toHaveProperty("stroke");
  });
});

describe("posting", () => {
  /*
    What crosses is a copy, and the copy's buffer is what is given away. The page's masks are the
    pipeline's caches — the next derive and the point probe read them — and a transferred buffer is
    left empty behind it, which a browser confirmed (2026-09-24).
  */
  it("gives the worker a copy of the ink, never the page's own", () => {
    const { ink, options } = deriveCase(2);
    const { message, transfer } = postDerive({ ink, options });

    if (message.kind !== "derive") throw new Error("posted the wrong job");
    expect(message.request.ink.data).not.toBe(ink.data);
    expect(message.request.ink).toEqual(ink);
    expect(message.request.options).toBe(options);
    expect(transfer).toEqual([message.request.ink.data.buffer]);
  });

  it("gives the worker copies of both masks the profiles are measured from", () => {
    const request = profilesCase(2);
    const { message, transfer } = postProfiles(request);

    if (message.kind !== "profiles") throw new Error("posted the wrong job");
    const posted = message.request;
    expect(posted.beforeStroke.data).not.toBe(request.beforeStroke.data);
    expect(posted.beforeIsland.data).not.toBe(request.beforeIsland.data);
    expect(posted.beforeStroke).toEqual(request.beforeStroke);
    expect(posted.beforeIsland).toEqual(request.beforeIsland);
    expect(posted).toMatchObject({ inkWidthPx: 3.4, maxInkWidths: 3, maxSpanPx: 40, spanBins: 8 });
    expect(transfer).toEqual([posted.beforeStroke.data.buffer, posted.beforeIsland.data.buffer]);
  });

  it("gives the worker copies of the field, the reading and both paint layers, each buffer once", () => {
    for (const kind of ["field", "reading"] as const) {
      const request = inkCase(2, kind);
      const { message, transfer } = postInk(request);
      if (message.kind !== "ink") throw new Error("posted the wrong job");
      const posted = message.request;

      const pageArrays: ArrayBufferView[] = [];
      const postedArrays: ArrayBufferView[] = [];
      if (request.source.kind === "field" && posted.source.kind === "field") {
        pageArrays.push(request.source.field.data);
        postedArrays.push(posted.source.field.data);
        expect(posted.source.field).toEqual(request.source.field);
        expect(posted.source.read).toBe(request.source.read);
      } else if (request.source.kind === "reading" && posted.source.kind === "reading") {
        pageArrays.push(request.source.mask.data);
        postedArrays.push(posted.source.mask.data);
        expect(posted.source.mask).toEqual(request.source.mask);
        expect(posted.source.inkWidth).toBe(request.source.inkWidth);
      } else {
        throw new Error("posted the other kind of source");
      }
      for (const layer of ["suppress", "ink"] as const) {
        const own = request.paint[layer];
        const sent = posted.paint[layer];
        expect(sent).toEqual(own);
        if (own && sent) {
          pageArrays.push(own.data);
          postedArrays.push(sent.data);
        }
      }
      expect(posted.compose).toBe(request.compose);

      // Never the page's own arrays — they are the pipeline's caches — and every copy handed over.
      for (let i = 0; i < pageArrays.length; i++) expect(postedArrays[i]).not.toBe(pageArrays[i]);
      expect(new Set(transfer)).toEqual(new Set(postedArrays.map((array) => array.buffer)));
      expect(transfer).toHaveLength(postedArrays.length);

      const lengths = pageArrays.map((array) => array.byteLength);
      structuredClone(message, { transfer });
      expect(pageArrays.map((array) => array.byteLength)).toEqual(lengths);
    }
  });

  it("copies a mask that is both inputs twice, so each buffer is given away once", () => {
    /*
      Not hypothetical: with the stroke filter off — its default — the opening hands back the reading's
      own mask, so both inputs are one object. And a buffer listed twice in a transfer is refused
      outright (checked: *"DataCloneError: Transfer list contains duplicate ArrayBuffer"*), so copying
      once and listing it twice would fail every profile on an unfiltered map.
    */
    const mask = randomInk(20, 20, seededRandom(4), 6);
    const { message, transfer } = postProfiles({ ...profilesCase(1), beforeStroke: mask, beforeIsland: mask });
    expect(transfer).toHaveLength(2);
    expect(transfer[0]).not.toBe(transfer[1]);
    expect(() => structuredClone(message, { transfer })).not.toThrow();
  });
});
