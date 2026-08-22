import { describe, expect, it } from "vitest";

import { PathOp, type Ring } from "../geometry/ring";
import type { PlacedRegion } from "../map/placeRegions";
import { NAMESPACE } from "../namespace";
import {
  planBatches,
  REGION_KEY,
  PROPOSAL_COLOURS,
  stageShapes,
  STAGED_FILL_OPACITY,
  totalCommands,
  type FogShapeSpec,
  type StageableRegion,
} from "./fogShapes";

function square(size: number): Ring {
  return [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
}

function placed(rings: readonly Ring[]): PlacedRegion {
  return {
    id: 1,
    position: { x: 100, y: 200 },
    rings,
    bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
  };
}

function region(overrides: Partial<StageableRegion> = {}): StageableRegion {
  return {
    id: 1,
    placed: placed([square(10)]),
    squares: 4.25,
    overCap: false,
    ...overrides,
  };
}

const options = { run: "2026-08-22T12:00:00.000Z", mapId: "map-1", strokeWidth: 3 };

describe("stageShapes", () => {
  it("carries the region's position through untouched", () => {
    // Commands are relative to position (measured in a room, DESIGN.md §4). Losing the position
    // here would place every region one map-width from where it belongs, and the commands would
    // still look perfectly reasonable.
    const [shape] = stageShapes([region()], options).shapes;
    expect(shape!.position).toEqual({ x: 100, y: 200 });
  });

  it("turns each ring into a move, lines and a close", () => {
    const [shape] = stageShapes([region()], options).shapes;
    expect(shape!.commands[0]).toEqual([PathOp.MOVE, 0, 0]);
    expect(shape!.commands.at(-1)).toEqual([PathOp.CLOSE]);
  });

  it("keeps a hole as a second subpath rather than a second item", () => {
    // One shape per region is the architecture. A hole emitted as its own item would be a second
    // boundary, and Dynamic Fog derives a wall from every boundary — so a pillar would gain a wall
    // ring around it and the room would gain one where nothing is drawn.
    const withPillar = region({ placed: placed([square(10), square(3)]) });
    const [shape] = stageShapes([withPillar], options).shapes;
    expect(shape!.commands.filter((c) => c[0] === PathOp.MOVE)).toHaveLength(2);
  });

  it("marks every item as ours, under the one namespace", () => {
    // Accept, remove and re-run all filter on exactly this, in scenes that already hold hundreds of
    // hand-drawn fog shapes — the test scene has 419. A key that differed by a character would mean
    // finding none of ours and, worse, is indistinguishable from having emitted none.
    const [shape] = stageShapes([region()], options).shapes;
    expect(REGION_KEY.startsWith(NAMESPACE)).toBe(true);
    expect(shape!.provenance).toEqual({
      run: "2026-08-22T12:00:00.000Z",
      map: "map-1",
      region: 1,
      squares: 4.25,
    });
  });

  it("names an item so a list of hundreds is still readable", () => {
    const [shape] = stageShapes([region()], options).shapes;
    expect(shape!.name).toBe("Fog Nudger — region 1 (4.3 sq)");
  });

  it("stages below full opacity, which promotion later raises", () => {
    const [shape] = stageShapes([region()], options).shapes;
    expect(shape!.fillOpacity).toBe(STAGED_FILL_OPACITY);
    expect(shape!.fillOpacity).toBeLessThan(1);
  });

  it("gives consecutive regions different colours", () => {
    // One colour was a mistake found in a room: proposals cover the whole map, so a single fill has
    // nothing to contrast against and the partition — the only thing a GM is judging — is
    // invisible. Neighbouring regions differing is what makes it legible.
    const many = Array.from({ length: PROPOSAL_COLOURS.length + 2 }, (_, i) =>
      region({ id: i + 1 }),
    );
    const colours = stageShapes(many, options).shapes.map((shape) => shape.colour);

    for (let i = 1; i < colours.length; i++) {
      expect(colours[i]).not.toBe(colours[i - 1]);
    }
    expect(new Set(colours).size).toBe(PROPOSAL_COLOURS.length);
  });

  it("assigns colours by emitted order, so a skipped region does not repeat one", () => {
    // Indexing on the region id instead would leave a gap in the cycle wherever a region was
    // skipped, and a gap of exactly the palette length puts two neighbours on the same colour.
    const some = [region({ id: 1 }), region({ id: 2, overCap: true }), region({ id: 3 })];
    const colours = stageShapes(some, options).shapes.map((shape) => shape.colour);

    expect(colours).toEqual([PROPOSAL_COLOURS[0], PROPOSAL_COLOURS[1]]);
  });

  it("skips a region over the cap and names it, rather than attempting it", () => {
    // Owlbear refuses an oversized item, and the refusal fails the whole batch it travelled in —
    // so attempting one known-invalid shape takes a few dozen valid ones down with it.
    const result = stageShapes(
      [region({ id: 1 }), region({ id: 2, overCap: true }), region({ id: 3 })],
      options,
    );
    expect(result.shapes.map((shape) => shape.regionId)).toEqual([1, 3]);
    expect(result.skipped).toEqual([2]);
  });

  it("drops a region with no drawable geometry without calling it a cap failure", () => {
    // Two different things that must not be reported as one: nothing to draw is a quiet skip, being
    // too big to draw is a finding.
    const result = stageShapes([region({ placed: placed([]) })], options);
    expect(result.shapes).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe("planBatches", () => {
  function shapes(count: number, commandsEach: number): FogShapeSpec[] {
    return Array.from({ length: count }, (_, i) => ({
      regionId: i + 1,
      position: { x: 0, y: 0 },
      commands: Array.from({ length: commandsEach }, () => [PathOp.CLOSE] as const),
      name: `r${i}`,
      provenance: { run: "r", map: "m", region: i + 1, squares: 1 },
      fillOpacity: 0.5,
      strokeWidth: 1,
      colour: "#ff00ff",
    }));
  }

  it("splits on the item limit", () => {
    const batches = planBatches(shapes(10, 5), { maxItems: 4, maxCommands: 10_000 });
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 2]);
  });

  it("splits on the command limit before the item limit is reached", () => {
    // The payload guard. Thirty regions near the 8192-entry cap is a quarter of a million numbers
    // crossing a postMessage boundary in one call, and that failure is not a clean refusal.
    const batches = planBatches(shapes(6, 100), { maxItems: 50, maxCommands: 250 });
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 2]);
  });

  it("gives an oversized shape a batch of its own rather than dropping it", () => {
    // The command limit is a batching hint. What decides whether an item is legal at all is the
    // 8192 cap, checked before this — and a batcher that silently ate anything above its own
    // threshold would lose exactly the largest region on the map, which is usually the outside.
    const batches = planBatches(
      [...shapes(1, 20), ...shapes(1, 5_000), ...shapes(1, 20)],
      { maxItems: 50, maxCommands: 100 },
    );
    expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(batches.flat()).toHaveLength(3);
  });

  it("loses nothing, whatever the limits", () => {
    const all = shapes(37, 11);
    for (const limits of [
      { maxItems: 1, maxCommands: 1 },
      { maxItems: 5, maxCommands: 40 },
      { maxItems: 1000, maxCommands: 1_000_000 },
    ]) {
      const batched = planBatches(all, limits).flat();
      expect(batched).toEqual(all);
    }
  });

  it("returns nothing for nothing, rather than one empty batch", () => {
    // An empty batch would become a write call asking Owlbear to add no items — a request that
    // spends a rate-limit allowance to accomplish nothing.
    expect(planBatches([], { maxItems: 4, maxCommands: 10 })).toEqual([]);
  });
});

describe("totalCommands", () => {
  it("adds up what the scene will be asked to hold", () => {
    const [shape] = stageShapes([region({ placed: placed([square(10), square(3)]) })], options)
      .shapes;
    // Two rings of four points: a MOVE, three LINEs and a CLOSE each, so five apiece.
    expect(totalCommands([shape!])).toBe(10);
  });
});
