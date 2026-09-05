/**
 * What a brush gesture means, with no DOM and no scene.
 *
 * The claim worth pinning hardest is the third: **one stroke never joins to the next.** Both defects
 * a room found in the wall tools were sequencing, and a brush has the same one available — a line
 * drawn from where the last gesture ended to where this one began, straight across whatever lies
 * between, which on a suppression layer would take out a wall the GM never touched.
 */

import { describe, expect, it } from "vitest";

import { emptyPaint, paintStroke } from "../trace/inkPaint";
import { brushRadius, rasterPoint, strokeSegment, verbFor } from "./paintGesture";

describe("where a sample lands", () => {
  const layer = emptyPaint(400, 200);

  it("scales a map fraction into the layer's own raster", () => {
    expect(rasterPoint(0.5, 0.25, layer)).toEqual({ x: 200, y: 50 });
  });

  it("keeps a position outside the map rather than clamping it to the edge", () => {
    // A stroke that leaves the map and comes back has to draw the part that crossed. Clamped, the
    // excursion would smear along the border instead.
    expect(rasterPoint(-0.25, 1.5, layer)).toEqual({ x: -100, y: 300 });
  });
});

describe("the brush radius", () => {
  it("is half the width, because the control is a width", () => {
    expect(brushRadius(24)).toBe(12);
  });

  it("covers what its readout claims", () => {
    // The reason halving happens in one place: a readout saying "24px across" and a brush painting
    // 24px of radius would differ by a factor of two, and nothing but measuring would show it.
    const layer = emptyPaint(41, 3);
    paintStroke(layer, { x: 20.5, y: 1.5 }, { x: 20.5, y: 1.5 }, brushRadius(21), true);

    let across = 0;
    for (let x = 0; x < layer.width; x++) if (layer.data[layer.width + x]) across += 1;
    expect(across).toBe(21);
  });
});

describe("what one sample lays down", () => {
  it("dabs when a stroke begins, so a click that never moves still paints", () => {
    expect(strokeSegment(null, { x: 5, y: 7 })).toEqual({
      from: { x: 5, y: 7 },
      to: { x: 5, y: 7 },
    });
  });

  it("bridges from the previous sample of the same stroke", () => {
    expect(strokeSegment({ x: 1, y: 2 }, { x: 9, y: 4 })).toEqual({
      from: { x: 1, y: 2 },
      to: { x: 9, y: 4 },
    });
  });

  it("lays nothing when the pointer has not moved", () => {
    expect(strokeSegment({ x: 3, y: 3 }, { x: 3, y: 3 })).toBeNull();
  });

  it("cannot join one stroke to the next, because it is never told where the last one ended", () => {
    /*
      The sequencing claim, asserted as the shape of the interface rather than as behaviour.

      A press hands `null`, and `null` is a dab. So the first sample of a gesture paints one mark
      wherever it landed, and there is no argument by which this function could reach back to the
      previous gesture's last point — the caller would have to pass it deliberately.
    */
    const endOfLastStroke = { x: 300, y: 20 };
    const startOfNext = { x: 10, y: 180 };

    expect(strokeSegment(null, startOfNext)).toEqual({ from: startOfNext, to: startOfNext });
    expect(strokeSegment(null, startOfNext)).not.toEqual({ from: endOfLastStroke, to: startOfNext });
  });
});

describe("which verb a press means", () => {
  it("is the tool in hand with no modifier", () => {
    expect(verbFor("paint", false)).toBe("paint");
    expect(verbFor("erase", false)).toBe("erase");
  });

  it("is inverted by the modifier, in both directions", () => {
    // Inverting rather than meaning "erase" is what makes the modifier do something in both tools.
    expect(verbFor("paint", true)).toBe("erase");
    expect(verbFor("erase", true)).toBe("paint");
  });
});
