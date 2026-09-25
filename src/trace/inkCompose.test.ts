import { describe, expect, it } from "vitest";

import { countInk, type BinaryMask } from "./binarize";
import { blur, type ScalarField } from "./field";
import { field, randomInk, seededRandom } from "./fixtures";
import { removeSmallInkIslands } from "./inkIslands";
import { composeInk, readInk, type ComposeOptions, type InkPaintLayers } from "./inkCompose";
import type { PaintLayer } from "./inkPaint";
import { healSeverances, openMask, radiusForWidth } from "./morphology";
import { detectPolarity } from "./polarity";

/*
  What is under test is the **plumbing**, since the stages themselves are tested where they live: that
  each stage is handed the mask the order says it is, that the reading's ink width reaches the stroke
  filter, that the GM's paint goes on last, and that what comes back is labelled for what it is. The
  expected masks are therefore built from the same stage functions — the one restatement allowed — and
  the composition from the paint is checked pixel by pixel without `composePaint`, so the order is
  stated here rather than borrowed.

  Eleven mutations here, eleven caught (2026-09-24, run before this was written): the stroke filter
  switched off, the heal skipped, the island filter handed the reading, the paint laid on the unfiltered
  mask, the composite returned as the base, the opening returned as the island filter's input, the ink
  width replaced by a constant, the blur skipped, the field written into, the severing warning demoted
  to info, and the rounds-to-nothing line removed. Nine more in `workerProtocol.test.ts` over the job
  around this.
*/

/** Linework a few pixels thick — walls of 1 to 4 — so an opening has something to take and to leave. */
function thickInk(seed: number, width = 48, height = 36): BinaryMask {
  const random = seededRandom(seed);
  const mask = randomInk(width, height, random, 18);
  const out = new Uint8Array(mask.data);
  // Thicken about half the runs' pixels by a random amount to the right and below, so widths vary.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask.data[y * width + x]) continue;
      const grow = Math.floor(random() * 4);
      for (let dy = 0; dy <= grow; dy++) {
        for (let dx = 0; dx <= grow; dx++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < width && ty < height) out[ty * width + tx] = 1;
        }
      }
    }
  }
  return { width, height, data: out };
}

/** A layer marking a random scatter of blocks, for either paint layer. */
function blockLayer(width: number, height: number, random: () => number, blocks: number): PaintLayer {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < blocks; i++) {
    const x0 = Math.floor(random() * width);
    const y0 = Math.floor(random() * height);
    const size = 2 + Math.floor(random() * 5);
    for (let y = y0; y < Math.min(height, y0 + size); y++) {
      for (let x = x0; x < Math.min(width, x0 + size); x++) data[y * width + x] = 1;
    }
  }
  return { width, height, data };
}

/** The GM's paint composed onto a base, stated per pixel: suppression takes, added ink puts back. */
function composedByHand(base: BinaryMask, paint: InkPaintLayers): Uint8Array {
  const out = new Uint8Array(base.data.length);
  for (let i = 0; i < out.length; i++) {
    const suppressed = paint.suppress?.data[i] ? 1 : 0;
    const added = paint.ink?.data[i] ? 1 : 0;
    out[i] = (base.data[i] && !suppressed) || added ? 1 : 0;
  }
  return out;
}

/** The stages in the order the pipeline states, from the functions that own them. */
function expectedStages(reading: BinaryMask, inkWidth: number | null, options: ComposeOptions) {
  const radius = radiusForWidth(options.minStrokeInkWidths * (inkWidth ?? 0));
  const opened = openMask(reading, radius);
  const healed = healSeverances(opened, reading, radius);
  const base = removeSmallInkIslands(healed.mask, options.minIslandPx);
  return { radius, opened, healed, base };
}

function isSubset(inner: BinaryMask, outer: BinaryMask): boolean {
  for (let i = 0; i < inner.data.length; i++) if (inner.data[i] && !outer.data[i]) return false;
  return true;
}

describe("composeInk", () => {
  it("runs the stroke filter, the heal and the island filter in order, then the GM's paint", () => {
    let opened = 0;
    let restored = 0;
    let islandsTaken = 0;
    let suppressed = 0;
    let added = 0;

    for (let seed = 1; seed <= 80; seed++) {
      const reading = thickInk(seed);
      const random = seededRandom(seed * 7 + 1);
      const inkWidth = 1.5 + random() * 3;
      const options: ComposeOptions = {
        minStrokeInkWidths: random() * 2,
        minIslandPx: Math.floor(random() * 14),
        pxPerSquare: 20,
      };
      const paint: InkPaintLayers = {
        suppress: seed % 3 === 0 ? null : blockLayer(reading.width, reading.height, random, 6),
        ink: seed % 4 === 0 ? null : blockLayer(reading.width, reading.height, random, 4),
      };

      const composed = composeInk(reading, inkWidth, paint, options);
      const expected = expectedStages(reading, inkWidth, options);

      expect(composed.beforeIsland.data).toEqual(expected.healed.mask.data);
      expect(composed.base.data).toEqual(expected.base.mask.data);
      expect(composed.mask.data).toEqual(composedByHand(composed.base, paint));
      // Restore, never invent: nothing the filters leave was not ink in the reading.
      expect(isSubset(composed.base, reading)).toBe(true);

      if (countInk(expected.opened) < countInk(reading)) opened += 1;
      restored += expected.healed.restored;
      islandsTaken += expected.base.removed;
      const beforePaint = countInk(composed.base);
      if (paint.suppress && countInk(composed.mask) < beforePaint) suppressed += 1;
      if (paint.ink && countInk(composed.mask) > beforePaint) added += 1;
    }

    // The sweep has to reach every stage it claims to order, or it is a green light about nothing.
    expect(opened).toBeGreaterThan(10);
    expect(restored).toBeGreaterThan(0);
    expect(islandsTaken).toBeGreaterThan(0);
    expect(suppressed).toBeGreaterThan(0);
    expect(added).toBeGreaterThan(0);
    // About three seconds alone, and past the five-second default under a full suite's parallel load —
    // §8's "a long sweep needs its own timeout", where a timeout reads exactly like a real failure.
  }, 30_000);

  it("measures the stroke filter against the reading's own ink width", () => {
    // One setting, two widths: the radius is the setting times the width, so the width has to arrive.
    const reading = thickInk(5);
    const options: ComposeOptions = { minStrokeInkWidths: 1, minIslandPx: 0, pxPerSquare: 20 };
    const none = { suppress: null, ink: null };
    const thin = composeInk(reading, 1, none, options);
    const wide = composeInk(reading, 4, none, options);

    expect(thin.base.data).toEqual(expectedStages(reading, 1, options).base.mask.data);
    expect(wide.base.data).toEqual(expectedStages(reading, 4, options).base.mask.data);
    expect(countInk(wide.base)).toBeLessThan(countInk(thin.base));
  });

  it("leaves the reading as it is when nothing is set and nothing painted", () => {
    const reading = thickInk(9);
    const composed = composeInk(reading, 3, { suppress: null, ink: null }, {
      minStrokeInkWidths: 0,
      minIslandPx: 0,
      pxPerSquare: 20,
    });
    expect(composed.base.data).toEqual(reading.data);
    expect(composed.mask.data).toEqual(reading.data);
    expect(composed.beforeIsland.data).toEqual(reading.data);
  });

  it("never writes into the reading it is handed", () => {
    // The page keeps the reading for the next recompose and for the point probe.
    const reading = thickInk(11);
    const before = new Uint8Array(reading.data);
    const random = seededRandom(3);
    composeInk(
      reading,
      3,
      {
        suppress: blockLayer(reading.width, reading.height, random, 8),
        ink: blockLayer(reading.width, reading.height, random, 8),
      },
      { minStrokeInkWidths: 1.2, minIslandPx: 10, pxPerSquare: 20 },
    );
    expect(reading.data).toEqual(before);
  });

  it("says what each stage did, in order, with the shape check last", () => {
    const reading = thickInk(2);
    const random = seededRandom(8);
    const { lines } = composeInk(
      reading,
      3,
      {
        suppress: blockLayer(reading.width, reading.height, random, 6),
        ink: blockLayer(reading.width, reading.height, random, 4),
      },
      { minStrokeInkWidths: 1.2, minIslandPx: 10, pxPerSquare: 20 },
    );
    const text = lines.map((line) => line.text);

    const at = (fragment: string): number => text.findIndex((line) => line.includes(fragment));
    expect(at("minimum stroke width in")).toBeGreaterThanOrEqual(0);
    expect(lines[at("can sever a thin wall")]?.level).toBe("warn");
    expect(at("smallest ink island in")).toBeGreaterThan(at("minimum stroke width in"));
    expect(at("trace: suppression —")).toBeGreaterThan(at("smallest ink island in"));
    expect(at("trace: added ink —")).toBeGreaterThan(at("trace: suppression —"));
    expect(text[text.length - 1]).toContain("ink shape check in");
  });

  it("says so when the stroke setting is on and rounds to nothing", () => {
    // 0.3 of a 2px width is 0.6px, a radius of 0: a silence here would look like the filter working.
    const { lines } = composeInk(thickInk(4), 2, { suppress: null, ink: null }, {
      minStrokeInkWidths: 0.3,
      minIslandPx: 0,
      pxPerSquare: 20,
    });
    expect(lines.some((line) => line.text.includes("rounds to a radius of 0"))).toBe(true);
    expect(lines.some((line) => line.text.includes("minimum stroke width in"))).toBe(false);
  });
});

/** A luminance field with dark ink on a pale ground and a little noise, so a blur changes the reading. */
function inkField(seed: number): ScalarField {
  const ink = thickInk(seed, 60, 44);
  const random = seededRandom(seed * 13 + 5);
  return field(ink.width, ink.height, (x, y) => {
    const tone = ink.data[y * ink.width + x] ? 0.15 : 0.85;
    return Math.min(1, Math.max(0, tone + (random() - 0.5) * 0.5));
  });
}

describe("readInk", () => {
  it("reads what the blur and the threshold read, and leaves the field as it was", () => {
    let blurMattered = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const source = inkField(seed);
      const before = new Float32Array(source.data);
      const options = { blurSigma: seed % 2 === 0 ? 0 : 1.5, radius: 6, k: 0.3 };

      const { reading, binarizeMs } = readInk(source, options);
      const expected = detectPolarity(blur(source, options.blurSigma), { radius: 6, k: 0.3 });

      expect(reading).toStrictEqual(expected);
      expect(binarizeMs).toBeGreaterThanOrEqual(0);
      // The page keeps this field unblurred for the point probe and for the next reading.
      expect(source.data).toEqual(before);

      const other = readInk(source, { ...options, blurSigma: options.blurSigma === 0 ? 1.5 : 0 });
      if (countInk(other.reading.mask) !== countInk(reading.mask)) blurMattered += 1;
    }
    // Or a reading that ignored the blur would pass.
    expect(blurMattered).toBeGreaterThan(0);
  });
});
