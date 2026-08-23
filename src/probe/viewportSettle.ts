/**
 * When a polled viewport counts as moving, and when it counts as still.
 *
 * Pulled out of the overlay probe and kept pure because it is the one piece of that page whose
 * being wrong is invisible in a room. A canvas that draws badly is *seen*; a threshold that is
 * backwards produces a sheet that never appears, or one that never blanks — and both look like
 * "the modal does not work" rather than "the arithmetic is wrong". Getting that wrong wastes a
 * session in a room, which is the expensive resource here.
 *
 * No DOM, no SDK.
 */

/** A point in screen coordinates, as `OBR.viewport.transformPoint` returns one. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Where two fixed world points currently sit on screen.
 *
 * Two points fully determine the mapping when nothing is rotated, which is the assumption the trace
 * pipeline already makes and reports on. They do double duty: a difference between polls means the
 * view moved, and when they hold still they *are* the transform an overlay would draw with. The
 * polling is the drawing's input rather than a cost paid on top of it.
 */
export interface ScreenPair {
  readonly a: ScreenPoint;
  readonly b: ScreenPoint;
}

/**
 * How far a corner may drift between polls and still count as still, in screen pixels.
 *
 * Not zero. A transform round-tripped through the message bus can jitter fractionally while
 * genuinely nothing is happening, and a sheet that blanks on noise is a sheet that is blank
 * permanently — which would read as the modal being broken.
 *
 * One pixel is also the right *size* rather than merely a safe one: a registration overlay is being
 * compared against ink about five pixels wide, so a sub-pixel discrepancy is invisible against the
 * thing it is being judged on.
 */
export const STILL_PIXELS = 1;

/**
 * Whether the view moved between two polls.
 *
 * `null` for the previous reading means the first poll of a run, which counts as movement — there
 * is nothing to have been still relative to, and starting blank is the safe direction.
 */
export function viewMoved(previous: ScreenPair | null, next: ScreenPair): boolean {
  if (!previous) return true;
  return (
    Math.abs(previous.a.x - next.a.x) > STILL_PIXELS ||
    Math.abs(previous.a.y - next.a.y) > STILL_PIXELS ||
    Math.abs(previous.b.x - next.b.x) > STILL_PIXELS ||
    Math.abs(previous.b.y - next.b.y) > STILL_PIXELS
  );
}

/**
 * Whether the sheet should be painted, given how long the view has been still.
 *
 * Split from `viewMoved` because the two answer different questions and only one of them is about
 * arithmetic. Blanking happens the instant movement is seen; *showing* waits, so a pan made of many
 * small steps does not flicker the sheet back in between them.
 */
export function shouldShow(stillForMs: number, settleMs: number): boolean {
  return stillForMs >= settleMs;
}
