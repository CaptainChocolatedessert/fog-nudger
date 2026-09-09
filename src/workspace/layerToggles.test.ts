/**
 * The one rule that makes layer visibility predictable: a tool may turn a layer on, never off.
 *
 * Everything here is about composition. Two things propose layers — the expanded groups, and the
 * tool in hand — and one small set of GM decisions subtracts from them. What must not happen is a
 * proposal quietly overriding a decision, because that is the coupling the tool strip was built to
 * remove arriving again through a different door.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  layerHidden,
  layerProposed,
  proposeLayers,
  requireLayer,
  toggleLayer,
  visibleLayers,
} from "./layerToggles";

beforeEach(() => {
  // Module state, so each case starts from a known one: nothing proposed and nothing hidden.
  proposeLayers([]);
  for (const layer of ["ink", "paint", "gaps", "regions", "graph"] as const) {
    if (layerHidden(layer)) toggleLayer(layer);
  }
});

describe("layer visibility", () => {
  it("draws what the groups ask for", () => {
    proposeLayers(["ink", "paint"]);

    expect(visibleLayers()).toEqual(["ink", "paint"]);
  });

  it("lets the GM take one away without disturbing the rest", () => {
    proposeLayers(["ink", "paint", "graph"]);
    toggleLayer("paint");

    expect(visibleLayers()).toEqual(["ink", "graph"]);
  });

  it("keeps a hidden layer proposed, which is how it comes back", () => {
    // Its switch has to stay on screen, or hiding a layer would be one-way.
    proposeLayers(["ink"]);
    toggleLayer("ink");

    expect(visibleLayers()).toEqual([]);
    expect(layerProposed("ink")).toBe(true);

    toggleLayer("ink");
    expect(visibleLayers()).toEqual(["ink"]);
  });

  it("lets a tool turn a layer on", () => {
    // You cannot edit what you cannot see, so picking a wall tool has to guarantee the graph draws.
    proposeLayers(["ink"]);
    requireLayer("graph");

    expect(visibleLayers()).toEqual(["ink", "graph"]);
  });

  it("does NOT let a tool turn one off", () => {
    /*
      The rule, stated as the thing that must not happen. `requireLayer` adds and only adds; if it
      ever replaced, picking a tool would take away whatever else the GM was looking at — and the
      failure would read as layers flickering as tools were switched, which is exactly the coupling
      the tool strip exists to remove.
    */
    proposeLayers(["ink", "paint"]);
    requireLayer("graph");

    expect(visibleLayers()).toEqual(["ink", "paint", "graph"]);
  });

  it("does not let a tool overrule a layer the GM switched off", () => {
    // The GM's answer is final. A tool asking for something they have hidden must not reveal it.
    proposeLayers(["graph"]);
    toggleLayer("graph");
    requireLayer("graph");

    expect(visibleLayers()).toEqual([]);
    expect(layerHidden("graph")).toBe(true);
  });

  it("asks for a layer only once however many times a tool wants it", () => {
    // Every tool switch re-asserts its layers, so without this the proposal grows without bound and
    // the row would list the same switch repeatedly.
    proposeLayers(["ink"]);
    requireLayer("graph");
    requireLayer("graph");
    requireLayer("graph");

    expect(visibleLayers()).toEqual(["ink", "graph"]);
  });

  it("keeps what the GM hid when the groups change underneath", () => {
    /*
      Expanding and collapsing groups replaces the proposal wholesale. The hidden set is separate
      precisely so that survives — a GM who turned the rooms off does not want them back because
      they opened a different heading.
    */
    proposeLayers(["ink", "regions"]);
    toggleLayer("regions");
    proposeLayers(["ink", "regions", "graph"]);

    expect(visibleLayers()).toEqual(["ink", "graph"]);
  });
});
