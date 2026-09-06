/**
 * The skeleton layer: centrelines over the ink they came from.
 *
 * Drawn as a bitmap rather than paths, because at this point in the chain that is what it is — a
 * one-pixel-wide mask. Step D turns it into vectors *downstream* of here, and the regions layer
 * draws the faces those make; rasterising it here is honest about the fact that what this layer shows
 * is still pixels.
 *
 * ## A colour that is not the ink's
 *
 * The ink is a GM-chosen colour and the skeleton must not be mistaken for it, so this one is fixed —
 * the same reasoning as the break marks. Green, which is the one hue neither the ink swatches nor
 * the break purple sits on by default.
 *
 * Zoomed out, a one-pixel skeleton over a whole map is close to invisible however it is coloured.
 * That is a real limitation of drawing it at map resolution and the reason to zoom in when judging
 * it; the alternative — a screen-space dilation — would make a hairy skeleton look tidy by drawing
 * everything the same width.
 */

import { paintMask, parseColour } from "../../overlay/maskImage";
import { bitmapFrom, type Bitmap } from "../bitmap";
import { currentGraph, currentSkeleton, skeletonShowing } from "../skeleton";
import { addPainter, type Painter } from "../shell";

/** Kept in step with `.skeleton-key` in the page's stylesheet by hand. */
const SKELETON_COLOUR = "#00ff88";
/** A node mark, in screen pixels. Distinct from the centreline's green so the two do not blend. */
const NODE_COLOUR = "#ffcc00";
const NODE_RADIUS = 2.5;
/**
 * Past this many nodes the marks stop being a picture and become a wash.
 *
 * A hairy skeleton has a free end everywhere the ink was ragged, and every one of them is a node.
 * Silently drawing forty thousand dots would hide the junctions the marks exist to show — so above
 * the cap nothing is drawn, and the count on the state line is what remains to read.
 */
const MAX_NODE_MARKS = 4000;

let painted: Bitmap | null = null;
/** The mask the bitmap was made from, so a repaint only happens when the skeleton changes. */
let paintedFrom: unknown = null;

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const skeleton = currentSkeleton();
  if (!skeleton || !skeletonShowing()) return;

  if (paintedFrom !== skeleton) {
    const colour = parseColour(SKELETON_COLOUR);
    if (!colour) return;
    const buffer = paintMask(skeleton, colour, painted?.buffer);
    const bitmap = bitmapFrom(buffer, skeleton.width, skeleton.height, painted);
    if (!bitmap) return;
    painted = bitmap;
    paintedFrom = skeleton;
  }

  if (!painted) return;
  context.drawImage(painted.canvas, view.x, view.y, drawWidth, drawHeight);

  paintNodes(context, view, drawWidth, drawHeight, skeleton.width, skeleton.height);
};

/**
 * The graph's nodes, as marks in **screen** space.
 *
 * Built as the visual channel the weld radius owed under §8: a radius large enough to merge two
 * genuinely distinct junctions — closing a doorway — changed nothing about the skeleton's own pixels,
 * so only the nodes could show it. **Welding was deleted for moving points**, so nothing is relying
 * on that channel now. These stay on the weaker justification that a picture of where the graph
 * thinks its junctions are is worth having while judging a skeleton.
 *
 * Screen-space rather than map-space, for the same reason the break rings are: a node is a single
 * pixel with a whole map on the canvas, and a mark that scales with the zoom is invisible at exactly
 * the moment it is wanted. Capped, because a hairy skeleton on a real map has thousands of free ends
 * and drawing every one of them at zoom-out is a wash of dots rather than a picture.
 */
function paintNodes(
  context: CanvasRenderingContext2D,
  view: { x: number; y: number },
  drawWidth: number,
  drawHeight: number,
  rasterWidth: number,
  rasterHeight: number,
): void {
  const graph = currentGraph();
  if (!graph || rasterWidth === 0 || rasterHeight === 0) return;
  if (graph.nodes.length > MAX_NODE_MARKS) return;

  const scaleX = drawWidth / rasterWidth;
  const scaleY = drawHeight / rasterHeight;

  context.save();
  context.fillStyle = NODE_COLOUR;
  for (const node of graph.nodes) {
    const x = view.x + (node.x + 0.5) * scaleX;
    const y = view.y + (node.y + 0.5) * scaleY;
    // Off-canvas nodes are the common case on a zoomed-in map, and the arc is the expensive part.
    if (x < -NODE_RADIUS || y < -NODE_RADIUS) continue;
    if (x > context.canvas.width + NODE_RADIUS || y > context.canvas.height + NODE_RADIUS) continue;
    context.beginPath();
    context.arc(x, y, NODE_RADIUS, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

/** Wire the layer up. Registered after the ink, so centrelines sit over the strokes they came from. */
export function registerSkeletonLayer(): void {
  addPainter("skeleton", paint);
}
