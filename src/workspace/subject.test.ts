/**
 * The dimming decision, which is the one part of it a desk can check.
 *
 * Everything else about dimming is a canvas alpha and a room's judgement about how faint is too
 * faint over a particular map. What is a **contract** is the table: which layer belongs to which
 * side, whether it is total, and whether the two always-on subject layers are the ones that move.
 *
 * **Twelve mutations, twelve caught**: the room fills joining a side, each of the two dimmable
 * layers dropping out, both dropping out together, the two figures collapsing to one, a dimmed
 * layer drawn at full, the subject's own side dimming as well, start-up ignoring the document,
 * start-up refusing to move back off the walls, a press about neither side moving the subject,
 * View counting as the wall side, and the map dropping off the ink side.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { LAYERS, type LayerId } from "../steps";
import {
  alphaFor,
  currentSide,
  DIM,
  dimmableLayers,
  sideOfStep,
  startOn,
  workOn,
  type Side,
} from "./subject";

const SIDES: readonly Side[] = ["ink", "walls"];

describe("what a side turns down", () => {
  it("classifies every layer there is", () => {
    /*
      Totality, asked through the behaviour rather than by reading the table, so the test cannot be
      satisfied by a lookup returning `undefined` and the arithmetic quietly carrying on. A layer
      with no entry would produce `NaN` from `DIM[undefined]` and draw nothing at all — the exact
      failure `steps.test.ts` guards one layer up, where a parameter with no step is a control a GM
      simply cannot reach.
    */
    expect(LAYERS.length).toBeGreaterThan(0);
    for (const layer of LAYERS) {
      for (const side of SIDES) {
        const alpha = alphaFor(layer, side);
        expect(Number.isFinite(alpha), `${layer} on the ${side} side`).toBe(true);
        expect(alpha, `${layer} on the ${side} side`).toBeGreaterThan(0);
        expect(alpha, `${layer} on the ${side} side`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("dims exactly the two always-on subject layers, and there are some", () => {
    /*
      **Non-empty first**, or the check is satisfied by a table of nothing but `null` — which is a
      dimming feature that dims nothing, passes every assertion below, and looks live.

      The rest fall out rather than being exceptions: `regions` never dims by the user's decision,
      and the four tool layers are drawn only while a tool of their own side is armed, so a tool
      layer can never *be* the dimmed side.
    */
    const dimmable = dimmableLayers();
    expect(dimmable.length).toBeGreaterThan(0);
    expect([...dimmable].sort()).toEqual(["graph", "ink"]);
  });

  it("leaves the subject's own side alone", () => {
    expect(alphaFor("ink", "ink")).toBe(1);
    expect(alphaFor("graph", "walls")).toBe(1);
  });

  it("turns the other side down to its own figure", () => {
    // Each layer carries the figure of the side it belongs to, so the two are not a scale: the ink
    // is a flat area fill and the centrelines are cased, and one number would take the walls out
    // before it touched the ink.
    expect(alphaFor("ink", "walls")).toBe(DIM.ink);
    expect(alphaFor("graph", "ink")).toBe(DIM.walls);
    expect(DIM.ink).not.toBe(DIM.walls);
  });

  it("never dims the room fills, whichever side is the subject", () => {
    // The user's decision, and it is the one entry that is a judgement rather than a consequence:
    // the fills are already faint, and the crowding this exists for is at the stroke.
    for (const side of SIDES) expect(alphaFor("regions", side)).toBe(1);
  });

  it("never dims a tool's own layer", () => {
    // These are drawn only while a tool of their side is armed, which is the side that is *not*
    // dimmed. Pinned so that filing one under a side later has to be argued for here.
    for (const layer of ["paint", "gaps", "mends", "speckles", "delta"] as LayerId[]) {
      for (const side of SIDES) expect(alphaFor(layer, side)).toBe(1);
    }
  });
});

describe("which side a press is about", () => {
  it("puts the map and the ink on the ink side and the walls on the walls side", () => {
    expect(sideOfStep("map")).toBe("ink");
    expect(sideOfStep("ink")).toBe("ink");
    expect(sideOfStep("walls")).toBe("walls");
  });

  it("says nothing about View, which is about neither", () => {
    // `null` rather than a side, and `workOn` ignores it — turning the preview fill down is not a
    // statement about which half of the work you are on.
    expect(sideOfStep("view")).toBeNull();
  });
});

describe("where the map opens", () => {
  /*
    Order matters in this block: the subject is module state, so each test leaves it where the next
    one expects to find it. Written as a sequence deliberately rather than with a reset helper — a
    reset would be a second way to set the subject, and this module's whole point is that there is
    one.
  */
  it("opens on the ink when the walls hold nothing of the GM's", () => {
    startOn(false);
    expect(currentSide()).toBe("ink");
  });

  it("opens on the walls when they do, since the ink half is under the cover", () => {
    startOn(true);
    expect(currentSide()).toBe("walls");
  });

  it("moves back when a map with no edits is loaded after one that had them", () => {
    // `startOn` is not `workOn`: it is the document speaking rather than the GM, so it has to be
    // able to move the subject in both directions. Loading a clean map after an edited one is the
    // case, and it is reachable by nominating a different image.
    startOn(true);
    startOn(false);
    expect(currentSide()).toBe("ink");
  });

  it("follows what the GM touches afterwards", () => {
    startOn(false);
    workOn("walls");
    expect(currentSide()).toBe("walls");
    workOn("ink");
    expect(currentSide()).toBe("ink");
  });

  it("ignores a press that is about neither side", () => {
    workOn("walls");
    workOn(null);
    expect(currentSide()).toBe("walls");
  });
});
