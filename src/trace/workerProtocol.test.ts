import { describe, expect, it } from "vitest";

import type { BinaryMask } from "./binarize";
import { deriveWalls, summariseDerivation, type DerivedWalls } from "./deriveWalls";
import { randomInk, seededRandom } from "./fixtures";
import { graphExtent } from "./graphUnits";
import { measureInkProfiles } from "./inkProfile";
import {
  answerDeriveRequest,
  answerProfilesRequest,
  answerWorkerMessage,
  postDerive,
  postProfiles,
} from "./workerProtocol";

/*
  Seven mutations, seven caught (2026-09-24): an exception let out of an answer, the dispatch reversed,
  the page's own array posted instead of a copy, one copy shared by both profile inputs, one buffer of
  two given away, a count dropped from the derive's summary, and the skeleton's edges counted as its
  nodes. The last two are why the field-by-field summary test exists: the sweep compares against the
  same summary, so run alone it passed the miscounted edges, and caught the dropped count only because
  its reach check wants an over-cap face.
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

describe("answerWorkerMessage", () => {
  it("does the job the message names", () => {
    // Each answer has a field the other lacks, so a dispatch the wrong way round cannot pass.
    const derive = answerWorkerMessage({ kind: "derive", request: deriveCase(1) });
    const profiles = answerWorkerMessage({ kind: "profiles", request: profilesCase(1) });

    if (!derive.ok || !profiles.ok) throw new Error("a job failed");
    expect(derive.value).toHaveProperty("walls");
    expect(derive.value).not.toHaveProperty("stroke");
    expect(profiles.value).toHaveProperty("stroke");
    expect(profiles.value).not.toHaveProperty("walls");
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
