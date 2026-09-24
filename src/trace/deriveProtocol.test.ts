import { describe, expect, it } from "vitest";

import type { BinaryMask } from "./binarize";
import { answerDeriveRequest } from "./deriveProtocol";
import { deriveWalls, summariseDerivation, type DerivedWalls } from "./deriveWalls";
import { randomInk, seededRandom } from "./fixtures";
import { graphExtent } from "./graphUnits";

/*
  Three mutations, three caught (2026-09-24): an exception let out of the worker's answer, a count
  dropped from the summary, and the skeleton's edges counted as its nodes. The last two are why the
  field-by-field test exists: the sweep compares against the same summary, so run alone it passed the
  miscounted edges, and caught the dropped count only because its reach check wants an over-cap face.
*/

/** Everything but the timings, which differ between any two runs of the same derive. */
function untimed(derived: DerivedWalls): Omit<DerivedWalls, "timings"> {
  const { timings: _timings, ...rest } = derived;
  return rest;
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
      const ink = randomInk(40, 30, seededRandom(seed), 22);
      const options = {
        tolerance: 0.5,
        maxTolerance: 8,
        pruneLimit: 3 / 40,
        extent: graphExtent(40, 30),
        // Low enough that some seeds climb the ladder, so escalation's fields cross too. Random straight
        // runs make plain rectangles, which never exceed 8 commands, so 4 it is.
        maxCommands: seed % 3 === 0 ? 4 : undefined,
      };

      const reply = answerDeriveRequest({ ink, options });
      if (!reply.ok) throw new Error(`seed ${seed} failed: ${reply.error}`);

      expect(structuredClone(reply)).toStrictEqual(reply);
      expect(untimed(reply.derived)).toStrictEqual(
        untimed(summariseDerivation(deriveWalls(ink, options))),
      );
      expect(reply.computeMs).toBeGreaterThanOrEqual(0);

      faces += reply.derived.faces.faces.length;
      pruned += reply.derived.pruning.removed;
      walls += reply.derived.walls.graph.edges.length;
      escalated += reply.derived.escalations;
      overCap += reply.derived.overCap;
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
    const derived = deriveWalls(randomInk(40, 30, seededRandom(3), 22), {
      tolerance: 0.5,
      maxTolerance: 8,
      pruneLimit: 3 / 40,
      extent: graphExtent(40, 30),
      maxCommands: 4,
    });
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
