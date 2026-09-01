/**
 * A map-space bitmap: pixels rasterised once, drawn every frame by a `drawImage`.
 *
 * Named a bitmap rather than a layer on purpose. A **layer** is a thing the canvas stack draws and a
 * step asks for by name — ink, breaks, linework and faces. This is the pixels one of
 * them happens to be made of, and conflating the two would make "which layers does this step show"
 * read as a question about allocation.
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
export interface Bitmap {
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
export function bitmapFrom(
  buffer: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  reusing: Bitmap | null,
): Bitmap | null {
  const target = reusing?.canvas ?? document.createElement("canvas");
  target.width = width;
  target.height = height;
  const context = target.getContext("2d");
  if (!context) return null;

  context.putImageData(new ImageData(buffer, width, height), 0, 0);
  return { canvas: target, buffer };
}
