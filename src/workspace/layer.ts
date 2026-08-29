/**
 * A map-space layer: pixels rasterised once, drawn every frame by a `drawImage`.
 *
 * Every painter that draws something the size of the map wants the same thing — an offscreen canvas
 * at the map's own resolution, holding an RGBA buffer it can rewrite in place. Rasterising once and
 * then transforming is what makes a view change a tenth of a millisecond instead of a repaint of
 * eight million pixels, which the probe measured with two map-sized layers in flight.
 *
 * The buffer is kept beside its canvas so a recolour can rewrite the same allocation rather than
 * asking for another 34MB. No SDK; DOM only for the canvas.
 */

/** A mask rasterised into RGBA once, so a view change is a `drawImage` rather than a repaint. */
export interface Layer {
  readonly canvas: HTMLCanvasElement;
  readonly buffer: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Put an already-painted RGBA buffer into a canvas of that size, reusing one if it is offered.
 *
 * Returns `null` when the browser will not give a 2D context, which at these sizes means the
 * allocation failed. The caller decides what to say about it — a painter that silently drew nothing
 * would be a blank surface with no explanation, which is the one thing this surface must never be.
 */
export function layerFrom(
  buffer: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  reusing: Layer | null,
): Layer | null {
  const target = reusing?.canvas ?? document.createElement("canvas");
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (!context) return null;

  context.putImageData(new ImageData(buffer, width, height), 0, 0);
  return { canvas: target, buffer };
}
