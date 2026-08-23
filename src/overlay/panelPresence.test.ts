/**
 * The panel-presence decision, which decides whether a third of the map is hidden.
 *
 * Both failure directions are bad and neither announces itself: a band that never lifts leaves a
 * permanent blank stripe with nothing to explain it, and a band that never appears puts ink over
 * the controls the GM is trying to use. So the staleness rule is stated here rather than left
 * implicit in a timestamp comparison.
 */

import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_MS,
  PANEL_EDGE_MARGIN,
  PRESENCE_STALE_MS,
  readPanelPresence,
  reservedWidth,
} from "./panelPresence";

describe("readPanelPresence", () => {
  it("accepts a well-formed message", () => {
    expect(readPanelPresence({ width: 500 })).toEqual({ width: 500 });
  });

  it("rejects anything else rather than trusting a number from another frame", () => {
    for (const bad of [null, undefined, 500, "500", {}, { width: "500" }, { width: 0 }, { width: -5 }, { width: Number.NaN }]) {
      expect(readPanelPresence(bad)).toBeNull();
    }
  });
});

describe("reservedWidth", () => {
  it("reserves nothing when the panel has never been heard from", () => {
    // The failing-safe case. If the broadcast does not reach a sibling iframe at all, the overlay
    // draws over the panel exactly as it did before — the previous behaviour, not a new fault.
    expect(reservedWidth(null, 0)).toBe(0);
  });

  it("reserves the panel's width plus the margin while the heartbeat is fresh", () => {
    expect(reservedWidth({ width: 500 }, 0)).toBe(500 + PANEL_EDGE_MARGIN);
  });

  it("follows the panel's reported width rather than a constant", () => {
    // So changing the popover width in the manifest moves the band with it. A second copy of the
    // number here would go stale silently the first time the manifest changed.
    expect(reservedWidth({ width: 640 }, 0)).toBe(640 + PANEL_EDGE_MARGIN);
  });

  it("releases the band once the heartbeat goes stale", () => {
    expect(reservedWidth({ width: 500 }, PRESENCE_STALE_MS)).toBe(0);
    expect(reservedWidth({ width: 500 }, PRESENCE_STALE_MS + 5000)).toBe(0);
  });

  it("holds the band across a single missed beat", () => {
    // A band that flickers is worse than one that lingers: lingering costs a moment of hidden map,
    // flickering makes the layout jump under a slider the GM is dragging.
    expect(reservedWidth({ width: 500 }, HEARTBEAT_MS * 2)).toBeGreaterThan(0);
  });

  it("keeps the stale window comfortably above two beats", () => {
    // Stated as a relationship rather than two independent numbers, so tuning one cannot silently
    // put the other into the flickering regime.
    expect(PRESENCE_STALE_MS).toBeGreaterThan(HEARTBEAT_MS * 2);
  });
});
