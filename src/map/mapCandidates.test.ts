import { describe, expect, it } from "vitest";

import { MIN_AREA_SHARE, selectMapCandidates } from "./mapCandidates";

const candidate = (id: string, area: number) => ({ id, name: id, area });

describe("selectMapCandidates", () => {
  it("returns nothing for an empty scene", () => {
    expect(selectMapCandidates([])).toEqual([]);
  });

  it("keeps a single map", () => {
    expect(selectMapCandidates([candidate("map", 1000)]).map((c) => c.id)).toEqual(["map"]);
  });

  it("drops a token stranded on the map layer", () => {
    // The case this filter exists for. A token is orders of magnitude smaller than the map, so it
    // cannot be showing the same ground, and keeping it would make the scene look ambiguous and
    // block a trace that was never actually ambiguous.
    const kept = selectMapCandidates([candidate("map", 4_000_000), candidate("token", 22_500)]);
    expect(kept.map((c) => c.id)).toEqual(["map"]);
  });

  it("keeps two comparable maps, so the caller can refuse", () => {
    // A GM overlay is usually the *same* size as the map it covers, which is precisely why this
    // must not resolve to one of them: refusing and asking is recoverable, tracing the overlay is
    // not.
    const kept = selectMapCandidates([candidate("map", 4_000_000), candidate("overlay", 4_000_000)]);
    expect(kept).toHaveLength(2);
  });

  it("returns candidates largest first", () => {
    const kept = selectMapCandidates([
      candidate("small", 1_000_000),
      candidate("big", 4_000_000),
      candidate("mid", 2_000_000),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["big", "mid", "small"]);
  });

  it("keeps something exactly on the threshold", () => {
    // Boundary stated explicitly, because a strict comparison here would silently discard a real
    // second map on a scene where the two happen to be a clean ratio apart.
    const kept = selectMapCandidates([
      candidate("big", 1000),
      candidate("edge", 1000 * MIN_AREA_SHARE),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["big", "edge"]);
  });

  it("ignores zero and negative areas", () => {
    // A zero-area item would otherwise become the "largest" on a degenerate scene and take every
    // real map with it.
    const kept = selectMapCandidates([
      candidate("zero", 0),
      candidate("negative", -5),
      candidate("map", 900),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["map"]);
  });
});
