import { describe, expect, it } from "vitest";

import { attributeByParent, summariseItems } from "./itemCensus";

describe("attributeByParent", () => {
  const parents = [
    { id: "a", label: "baseline" },
    { id: "b", label: "hairline" },
  ];

  it("counts derived items against the parent that produced them", () => {
    expect(
      attributeByParent(
        [{ attachedTo: "a" }, { attachedTo: "a" }, { attachedTo: "b" }],
        parents,
      ),
    ).toBe("baseline×2, hairline×1");
  });

  it("merges two parents that share a label, which the census now relies on", () => {
    /*
      The counter is keyed by **label**, not by id. That reads as a bug against the promise below
      that every known parent gets its own count, and it was a latent one while every caller passed
      unique labels.

      It is now the mechanism: a pushed map has hundreds of regions, and `fogProbe.ts` passes the
      *kind* as the label above a threshold so they collapse to `region×N, wall×M` rather than
      producing a line nobody can read — which is the failure of reporting a total, one step along.
      Asserted here so the behaviour is a decision rather than an accident, and so that anyone
      "fixing" it to key by id finds the caller that depends on it.
    */
    expect(
      attributeByParent(
        [{ attachedTo: "a" }, { attachedTo: "b" }],
        [
          { id: "a", label: "region" },
          { id: "b", label: "region" },
        ],
      ),
    ).toBe("region×2");
  });

  /**
   * The point of the whole function.
   *
   * A parent that produced nothing is the most interesting result it can return — it is exactly
   * what "stroke width zero yields no walls" looks like. Omitting it would make that finding
   * indistinguishable from the parent not being checked at all.
   */
  it("reports a parent that produced nothing as zero rather than omitting it", () => {
    expect(attributeByParent([{ attachedTo: "a" }], parents)).toBe(
      "baseline×1, hairline×0",
    );
  });

  it("does not credit us with walls from someone else's fog", () => {
    // A GM's own hand-drawn fog produces walls too. Folding those into our counts would inflate
    // them invisibly, and the inflation would look like success.
    expect(
      attributeByParent([{ attachedTo: "a" }, { attachedTo: "gm-drew-this" }], parents),
    ).toBe("baseline×1, hairline×0, other-parents×1");
  });

  it("counts items attached to nothing separately", () => {
    expect(attributeByParent([{ attachedTo: undefined }, {}], parents)).toBe(
      "baseline×0, hairline×0, unattached×2",
    );
  });

  it("keeps parent order stable so two runs can be diffed", () => {
    const forwards = attributeByParent([{ attachedTo: "b" }], parents);
    const backwards = attributeByParent([{ attachedTo: "b" }], [...parents]);
    expect(forwards).toBe(backwards);
    expect(forwards.indexOf("baseline")).toBeLessThan(forwards.indexOf("hairline"));
  });

  it("says nothing misleading when there are no parents at all", () => {
    expect(attributeByParent([{ attachedTo: "a" }], [])).toBe("other-parents×1");
  });

  it("says something when there is nothing at all, rather than an empty string", () => {
    // Found in a room, 2026-09-01: on a scene with no fog of ours the census printed
    // "Walls by shape: ." — the blank line `summariseItems` has an explicit guard against, in the
    // function beside it. An empty answer and an answer that never ran must not look the same.
    expect(attributeByParent([], [])).toBe(
      "nothing of ours in the scene, and no walls derived from anything",
    );
  });
});

describe("summariseItems", () => {
  it("counts by type and layer", () => {
    expect(
      summariseItems([
        { type: "PATH", layer: "FOG" },
        { type: "PATH", layer: "FOG" },
        { type: "IMAGE", layer: "MAP" },
      ]),
    ).toBe("PATH:FOG×2, IMAGE:MAP×1");
  });

  it("separates the same type on different layers", () => {
    // The distinction the census exists for: a PATH on FOG is fog, a PATH on DRAWING is a doodle,
    // and a summary that merged them would report the pipeline working when it had emitted onto
    // the wrong layer entirely.
    expect(
      summariseItems([
        { type: "PATH", layer: "FOG" },
        { type: "PATH", layer: "DRAWING" },
      ]),
    ).toBe("PATH:DRAWING×1, PATH:FOG×1");
  });

  /**
   * An empty census and a census that never ran must not read the same in a log. A blank line is
   * exactly how that failure arrives, and this project has a standing warning about diagnostics
   * that cannot distinguish their outcomes.
   */
  it("says so when there is nothing", () => {
    expect(summariseItems([])).toBe("no items");
  });

  it("orders by count so the same scene summarises the same way twice", () => {
    const once = summariseItems([
      { type: "WALL", layer: "FOG" },
      { type: "PATH", layer: "FOG" },
      { type: "WALL", layer: "FOG" },
    ]);
    const again = summariseItems([
      { type: "PATH", layer: "FOG" },
      { type: "WALL", layer: "FOG" },
      { type: "WALL", layer: "FOG" },
    ]);
    expect(once).toBe(again);
    expect(once).toBe("WALL:FOG×2, PATH:FOG×1");
  });
});
