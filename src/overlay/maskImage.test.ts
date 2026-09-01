/**
 * What the stage-one overlay actually paints.
 *
 * Worth testing rather than eyeballing in a room, because the two ways this fails both look like
 * something else entirely. Ink painted at the wrong offset reads as the *pipeline* having found the
 * wall in the wrong place, which is the exact misreading the whole blank-and-restore design exists
 * to prevent — and a stale alpha left in a reused buffer paints the previous run's ink over the
 * current map, which reads as a working overlay that is simply wrong.
 *
 * Fixtures are text grids, per the standing rule that nothing in this suite needs an image looked
 * at to know whether it passed.
 */

import { describe, expect, it } from "vitest";

import { maskFromRows } from "../trace/fixtures";
import { paintGaps, paintMask, parseColour } from "./maskImage";

const RED = { r: 255, g: 32, b: 32 };

/** The RGBA quad at one pixel, so a failure reads as four numbers rather than an offset. */
function pixel(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const p = (y * width + x) * 4;
  return [data[p]!, data[p + 1]!, data[p + 2]!, data[p + 3]!];
}

describe("parseColour", () => {
  it("reads the three channels in order", () => {
    expect(parseColour("#ff2020")).toEqual({ r: 255, g: 32, b: 32 });
    expect(parseColour("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColour("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("does not confuse red with blue", () => {
    // The mistake that survives every test written with a grey. A channel swap on #ff2020 is
    // invisible against #202020 and obvious against this.
    expect(parseColour("#102030")).toEqual({ r: 16, g: 32, b: 48 });
  });

  it("accepts either case", () => {
    expect(parseColour("#FF2020")).toEqual(parseColour("#ff2020"));
  });

  it("refuses anything else rather than substituting a colour", () => {
    // Returning a fallback here would make a malformed stored value indistinguishable from the
    // picker not working, so the caller is made to decide.
    for (const bad of ["", "#fff", "ff2020", "#gggggg", "#ff20200", "red", "rgb(1,2,3)"]) {
      expect(parseColour(bad)).toBeNull();
    }
  });
});

describe("paintMask", () => {
  it("paints ink in the colour and leaves ground fully transparent", () => {
    const mask = maskFromRows([".#.", "###", ".#."]);
    const data = paintMask(mask, RED);

    expect(pixel(data, 3, 1, 0)).toEqual([255, 32, 32, 255]);
    expect(pixel(data, 3, 1, 1)).toEqual([255, 32, 32, 255]);
    // Ground is transparent, not merely dark. A black opaque ground would hide the map everywhere
    // the pipeline found nothing, which is most of it.
    expect(pixel(data, 3, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(data, 3, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it("puts ink where the mask puts it, in row-major order", () => {
    // An asymmetric fixture, because a transposed write passes any test using a symmetric one — and
    // a transposed overlay is exactly what would be read as the trace being wrong.
    const mask = maskFromRows(["#...", "....", "..#."]);
    const data = paintMask(mask, RED);

    expect(pixel(data, 4, 0, 0)[3]).toBe(255);
    expect(pixel(data, 4, 2, 2)[3]).toBe(255);
    expect(pixel(data, 4, 0, 2)[3]).toBe(0);
    expect(pixel(data, 4, 2, 0)[3]).toBe(0);
  });

  it("writes no alpha between 0 and 255", () => {
    // Opacity is applied at draw time, to the whole image at once. Anything soft here would mean it
    // had been baked in, which is both wrong and 8.4 million pixels of wasted work per drag.
    const mask = maskFromRows(["#.#", ".#.", "#.#"]);
    const data = paintMask(mask, RED);
    for (let p = 3; p < data.length; p += 4) {
      expect([0, 255]).toContain(data[p]);
    }
  });

  it("allocates the right size", () => {
    const mask = maskFromRows(["##", "##", "##"]);
    expect(paintMask(mask, RED).length).toBe(2 * 3 * 4);
  });

  it("reuses a buffer of the right size", () => {
    const mask = maskFromRows(["#.", ".#"]);
    const buffer = new Uint8ClampedArray(2 * 2 * 4);
    expect(paintMask(mask, RED, buffer)).toBe(buffer);
  });

  it("clears stale pixels when reusing a buffer", () => {
    // The failure this is really aimed at: recolouring or re-reading reuses the buffer, and a pixel
    // that was ink last time and is ground now must stop being painted. Leaving it would show the
    // previous reading's ink over the current map, which looks like an overlay that works.
    const first = maskFromRows(["##", "##"]);
    const buffer = paintMask(first, RED);
    expect(pixel(buffer, 2, 0, 0)[3]).toBe(255);

    const second = maskFromRows(["..", ".."]);
    paintMask(second, RED, buffer);
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      expect(pixel(buffer, 2, x, y)).toEqual([0, 0, 0, 0]);
    }
  });

  it("replaces the colour of pixels that stay ink", () => {
    const mask = maskFromRows(["#"]);
    const buffer = paintMask(mask, RED);
    paintMask(mask, { r: 0, g: 128, b: 255 }, buffer);
    expect(pixel(buffer, 1, 0, 0)).toEqual([0, 128, 255, 255]);
  });

  it("allocates a new buffer when the one offered is the wrong size", () => {
    const mask = maskFromRows(["##", "##"]);
    const tooSmall = new Uint8ClampedArray(4);
    const out = paintMask(mask, RED, tooSmall);
    expect(out).not.toBe(tooSmall);
    expect(out.length).toBe(2 * 2 * 4);
  });

  it("handles an empty mask without throwing", () => {
    expect(paintMask(maskFromRows([]), RED).length).toBe(0);
  });
});

describe("paintGaps", () => {
  const OPEN = { r: 150, g: 80, b: 255 };
  const FILLED = { r: 40, g: 210, b: 120 };
  const labels = (data: number[]) => ({ width: data.length, height: 1, data: Uint8Array.from(data) });

  it("paints the two states in their own colours and leaves the rest transparent", () => {
    const out = paintGaps(labels([0, 1, 2]), OPEN, FILLED);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.slice(4, 8)]).toEqual([150, 80, 255, 255]);
    expect([...out.slice(8, 12)]).toEqual([40, 210, 120, 255]);
  });

  it("leaves an unrepaired break unpainted when no colour is given for it", () => {
    // What the workspace asks for. A break the search could not finish examining has no invented
    // pixels, and painting it like a repair would claim ink was added where none was — it draws as
    // a ring with nothing inside instead.
    const out = paintGaps(labels([1, 2]), null, FILLED);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.slice(4, 8)]).toEqual([40, 210, 120, 255]);
  });

  it("clears a reused buffer rather than leaving last run's marks behind", () => {
    // A break that has been filled, or has gone away entirely, must stop being drawn. Stale alpha
    // here would show breaks the current settings do not have, which is worse than showing none.
    const first = paintGaps(labels([1, 1, 1]), OPEN, FILLED);
    const second = paintGaps(labels([0, 2, 0]), OPEN, FILLED, first);
    expect(second).toBe(first);
    expect([...second.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...second.slice(4, 8)]).toEqual([40, 210, 120, 255]);
    expect([...second.slice(8, 12)]).toEqual([0, 0, 0, 0]);
  });

  it("allocates when the buffer offered is the wrong size", () => {
    const wrong = new Uint8ClampedArray(4);
    const out = paintGaps(labels([1, 2]), OPEN, FILLED, wrong);
    expect(out).not.toBe(wrong);
    expect(out.length).toBe(8);
  });
});
