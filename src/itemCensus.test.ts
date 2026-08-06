import { describe, expect, it } from "vitest";

import { summariseItems } from "./itemCensus";

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
