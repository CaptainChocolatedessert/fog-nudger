/**
 * Which `MAP`-layer images in a scene are plausibly *the map*.
 *
 * The problem this solves is the one in DESIGN.md §10 under "which map": a scene can hold several
 * images on the map layer, and one of them may be a GM-only overlay. Tracing that and emitting the
 * result would put GM linework onto player screens, which is the most expensive mistake available
 * here — so an ambiguous scene must be refused rather than guessed at.
 *
 * Most extra map-layer images are not a second map at all. They are a token, a note, or a decal
 * dropped on the wrong layer, and those are small. So the filter is a *share of the largest*, not
 * an absolute size: anything far smaller than the biggest image is not showing the same ground and
 * cannot be the map.
 *
 * Pure, so the interesting half needs no room. It deliberately does not decide anything — it
 * narrows, and the caller decides what to do with one candidate versus several.
 */

export interface MapCandidate {
  readonly id: string;
  readonly name: string;
  /** World-space area. Units do not matter; only the ratio between candidates is read. */
  readonly area: number;
}

/**
 * Keep anything at least this share of the largest image's area.
 *
 * A quarter is deliberately generous. Being too strict here reintroduces exactly the failure the
 * filter exists to prevent — silently discarding a real second map and then confidently tracing
 * the wrong one — while being too loose merely asks the GM a question. The asymmetry is the whole
 * reason for the number, so it should not be tightened to make a scene tidier.
 */
export const MIN_AREA_SHARE = 0.25;

/**
 * The candidates big enough to be showing the same ground as the largest.
 *
 * Returns them largest first. An empty input gives an empty result rather than throwing: a scene
 * with no map is an ordinary state, not an error.
 *
 * Zero and negative areas are dropped. A zero-area item cannot be a map, and letting one through
 * would make it the "largest" on a degenerate scene and take every real map with it.
 */
export function selectMapCandidates(
  candidates: readonly MapCandidate[],
): MapCandidate[] {
  const real = candidates.filter((candidate) => candidate.area > 0);
  if (real.length === 0) return [];

  const sorted = [...real].sort((a, b) => b.area - a.area);
  const largest = sorted[0]!.area;

  return sorted.filter((candidate) => candidate.area >= largest * MIN_AREA_SHARE);
}
