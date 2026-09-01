/**
 * The unnominated-map rule, which had no test until 2026-09-01.
 *
 * It lived in `mapImage.ts`, which imports the SDK and is therefore unreachable from a Node test —
 * so the one rule the project describes as "one rule, two callers, because a picker showing one
 * image selected while the trace read a different one would be a lie" was the least covered thing
 * in the file. The split is what these assert against.
 */

import { describe, expect, it } from "vitest";

import { defaultMapId, largestByArea } from "./mapChoice";

const map = (id: string, area: number) => ({ id, area });

describe("largestByArea", () => {
  it("picks the largest", () => {
    expect(largestByArea([map("a", 10), map("b", 40), map("c", 25)])?.id).toBe("b");
  });

  it("skips a zero area rather than letting it win", () => {
    // The stated reason: a degenerate item cannot be a map, and letting one win would trace nothing
    // while claiming to have chosen.
    expect(largestByArea([map("degenerate", 0), map("real", 3)])?.id).toBe("real");
  });

  it("skips a negative area too", () => {
    expect(largestByArea([map("mirrored", -100), map("real", 3)])?.id).toBe("real");
  });

  it("returns null when nothing has any area", () => {
    expect(largestByArea([map("a", 0), map("b", -1)])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(largestByArea([])).toBeNull();
  });

  it("gives a tie to the first", () => {
    // Load-bearing rather than incidental: the picker lists in z-order, so "the first" is the one
    // lower in the stack — the base map rather than whatever was laid on top of it.
    expect(largestByArea([map("under", 50), map("over", 50)])?.id).toBe("under");
  });
});

describe("defaultMapId", () => {
  it("agrees with largestByArea whenever there is more than one map", () => {
    expect(defaultMapId([map("a", 10), map("b", 40)])).toBe("b");
    expect(defaultMapId([map("a", 0), map("b", 0)])).toBeNull();
  });

  it("marks a lone map even when it has no area", () => {
    // The whole reason this function is separate. `resolveTraceMap` returns a single map without
    // measuring it, so the area guard would have the picker show nothing selected while the trace
    // read that map — a list disagreeing with the trace, which is what the shared rule prevents.
    expect(defaultMapId([map("only", 0)])).toBe("only");
    expect(defaultMapId([map("only", -5)])).toBe("only");
  });

  it("has nothing to mark on an empty scene", () => {
    expect(defaultMapId([])).toBeNull();
  });
});
