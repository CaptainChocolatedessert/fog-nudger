/**
 * The wall tools: moving a point, drawing a wall, erasing one.
 *
 * **The first things in this project that change the GM's own work rather than a setting.** Every
 * control before them turns a number and re-derives; these change the graph, and it stays changed
 * because stage two never re-derives. That is what the freeze is for.
 *
 * What each gesture *means* is in `dragGesture.ts` and is tested there. This file is the pointer
 * events, the tool in hand, the state line and the scene write.
 *
 * ## Three verbs, so there is a tool
 *
 * A drag can only mean one thing, and the step now has three. **A step is still the mode; the tool
 * says which verb within it** (user, 2026-09-05) — chosen over hiding draw and erase behind
 * modifiers, which would have put a destructive action on an unannounced click and left both verbs
 * undiscoverable. This surface has had that weakness since the point probe went in: nothing on it
 * says the map is interactive at all.
 *
 * ## Two of the three still decide by looking
 *
 * Move takes a press only when a vertex is under it, and erase only when a wall is. So a drag on
 * empty map still pans in both, and Ctrl still pans anywhere. **Draw is the exception and takes
 * every press**, because a wall has to be able to start on empty map — that is the case the shell's
 * brush branch already anticipated.
 *
 * ## Live walls, faces on release
 *
 * A gesture redraws the walls every frame and the rooms only when it ends (user, 2026-09-03).
 * Nothing is written to the graph while it runs: this holds *what would happen* and the layer draws
 * that, so a drag costs no graph rebuild and no crossing sweep per frame.
 *
 * ## What a failed write does
 *
 * `updateFrozen` stores the graph before it changes what is in hand, so a failed write leaves the GM
 * with the graph they had rather than one the scene does not agree with. The edit is lost and the
 * state line says so — losing one gesture is the safe direction against editing for an hour against
 * something that is not being saved.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { nearestEdge, removeEdge, type EditResult } from "../trace/planarOps";
import {
  applyDraw,
  applyDrag,
  describeDraw,
  describeEdit,
  dragTo,
  drawPoint,
  drawRelease,
  grabAt,
  type DragState,
  type DrawPoint,
  type Grab,
} from "./dragGesture";
import { invalidate, say, setGrabTarget, setMapDragHandler, type MapPoint } from "./shell";
import { frozenGraph, updateFrozen } from "./stage";

/** Which verb a press means. */
export type WallTool = "move" | "draw" | "erase";

/**
 * How close a press has to be to a vertex to grab it, to a wall to erase it, and to a vertex to
 * attach to it.
 *
 * Screen pixels. Grab is the smallest on purpose: it is a gesture the GM aims, and a generous target
 * makes it hard to pan by dragging near a wall. Snapping is one they are *shown* mid-gesture and can
 * back out of, so it can afford to reach further. Erase sits between — a wall is a long target and
 * easy to hit, and reaching too far would delete a neighbour.
 */
const GRAB_RADIUS_PX = 9;
const SNAP_RADIUS_PX = 14;
const ERASE_RADIUS_PX = 8;
/**
 * The shortest wall the draw tool will put down, in screen pixels.
 *
 * From a room: two clicks in nearly the same place made a wall too short to see and painfully hard
 * to aim the erase tool at, since a longer neighbour wins the nearest-wall query from almost
 * anywhere near it. Screen pixels rather than a fixed distance, so zooming in to draw finer detail
 * still works — the floor is on what can be *aimed at*, not on what the map is allowed to contain.
 */
const MIN_WALL_PX = 5;

let tool: WallTool = "move";

/** Moving: the vertex in hand and where it would land. */
let grab: Grab | null = null;
let dragState: DragState | null = null;
/** Drawing: the fixed end, and the end following the cursor. */
let anchor: DrawPoint | null = null;
let reach: DrawPoint | null = null;
/** Erasing, and hovering with any tool: what is under the pointer. */
let hovered: number | null = null;
let hoveredEdge: number | null = null;
/**
 * Whether the press has travelled far enough to be a drag rather than a click.
 *
 * Only the draw tool reads it, and it is what lets one tool serve both ways of drawing a line:
 * press-drag-release puts a wall down in one gesture, and press-release-move-click puts one down in
 * two. Neither is more correct — a drag is quicker and a pair of clicks lets the far end be
 * re-aimed — so supporting both costs a boolean and settles nothing arbitrarily.
 */
let travelled = false;
/** Whether a wall was already part-drawn when this press landed — the second click of a pair. */
let armedBeforePress = false;
let pressedAt: { u: number; v: number } | null = null;
/**
 * Map fractions per screen pixel, from the last event that carried one.
 *
 * Kept because the release has no position of its own — the tool has been told where the far end is
 * on every move, and handing `end` a fresh point would invite a second, subtly different answer
 * about where the wall lands. The scale is the one thing it still needs from screen space, and it
 * cannot have changed since the last move without a move to report it.
 */
let lastPerPixel = 0;
/** A write is in flight, so nothing new may start on top of it. */
let busy = false;

export function currentTool(): WallTool {
  return tool;
}

/** Switch tools, abandoning anything half-done. A half-drawn wall is not a thing to carry across. */
export function setTool(next: WallTool): void {
  tool = next;
  clearGesture();
  hovered = null;
  hoveredEdge = null;
  setGrabTarget(false);
  invalidate();
}

/** The vertex being dragged and where it currently sits, for the layer that draws it. */
export function draggedNode(): { readonly id: number; readonly at: Vector2 } | null {
  return grab === null || dragState === null ? null : { id: grab.id, at: dragState.at };
}

/** The vertex a release would merge into, for the layer to make evident before it happens. */
export function snapTarget(): number | null {
  return dragState?.snapTo ?? null;
}

/** The vertex under the pointer with no gesture running, so it can be shown as grabbable. */
export function hoveredNode(): number | null {
  return hovered;
}

/** The wall a click would erase, for the layer to mark before it goes. */
export function hoveredWall(): number | null {
  return hoveredEdge;
}

/** The wall being drawn: the fixed end and the end following the cursor, or `null`. */
export function pendingWall(): { readonly from: DrawPoint; readonly to: DrawPoint } | null {
  return anchor && reach ? { from: anchor, to: reach } : null;
}

function clearGesture(): void {
  grab = null;
  dragState = null;
  anchor = null;
  reach = null;
  travelled = false;
  armedBeforePress = false;
  pressedAt = null;
}

function start(point: MapPoint): boolean {
  if (busy) return false;
  const graph = frozenGraph();
  if (!graph) return false;

  pressedAt = { u: point.u, v: point.v };
  travelled = false;
  armedBeforePress = anchor !== null;
  lastPerPixel = point.perPixel;

  if (tool === "move") {
    const found = grabAt(graph, point.u, point.v, GRAB_RADIUS_PX * point.perPixel);
    if (!found) return false;
    grab = found;
    dragState = { at: graph.nodes[found.id]!, snapTo: null };
    hovered = null;
    setGrabTarget(true);
    invalidate();
    return true;
  }

  if (tool === "erase") {
    const found = nearestEdge(graph, { x: point.u, y: point.v }, ERASE_RADIUS_PX * point.perPixel);
    if (found === null) return false;
    hoveredEdge = found;
    invalidate();
    return true;
  }

  // Draw takes every press: a wall has to be able to start on empty map.
  const landed = drawPoint(graph, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.modifier);
  if (!anchor) {
    anchor = landed;
    reach = landed;
  } else {
    reach = landed;
  }
  setGrabTarget(true);
  invalidate();
  return true;
}

function move(point: MapPoint): void {
  const graph = frozenGraph();
  if (!graph) return;
  lastPerPixel = point.perPixel;
  if (pressedAt && (Math.abs(point.u - pressedAt.u) > 0.002 || Math.abs(point.v - pressedAt.v) > 0.002)) {
    travelled = true;
  }

  if (tool === "move") {
    if (!grab) return;
    dragState = dragTo(graph, grab, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.modifier);
    invalidate();
    return;
  }

  if (tool === "erase") {
    hoveredEdge = nearestEdge(
      graph,
      { x: point.u, y: point.v },
      ERASE_RADIUS_PX * point.perPixel,
    );
    invalidate();
    return;
  }

  if (!anchor) return;
  reach = drawPoint(graph, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.modifier);
  invalidate();
}

function cancel(): void {
  clearGesture();
  setGrabTarget(false);
  invalidate();
}

/**
 * Abandon whatever is half-done, and say whether there was anything to abandon.
 *
 * The answer is what stops Escape closing the workspace mid-wall: the shell asks first and only
 * closes when nothing was consumed. Right-click asks the same question, which is the gesture most
 * drawing tools use for "not that one".
 */
function escape(): boolean {
  if (!anchor && !grab) return false;
  cancel();
  say("cancelled");
  return true;
}

function end(): void {
  const graph = frozenGraph();
  if (!graph) {
    clearGesture();
    return;
  }

  if (tool === "move") {
    const held = grab;
    const landed = dragState;
    clearGesture();
    // The pointer has not moved, so whatever was under it still is: a plain move leaves the dragged
    // vertex there and a merge leaves the one it was folded into. A release ends the gesture, not
    // the hovering, and clearing the hint here made the cursor fall back mid-aim.
    hovered = held && landed ? landed.snapTo ?? held.id : null;
    setGrabTarget(hovered !== null);
    invalidate();
    if (!held || !landed) return;
    const result = applyDrag(graph, held, landed);
    if (!result) return;
    commit(result, describeEdit(landed.snapTo !== null, result.splits, result.overlaps));
    return;
  }

  if (tool === "erase") {
    const target = hoveredEdge;
    clearGesture();
    invalidate();
    if (target === null) return;
    commit(removeEdge(graph, target), "erased a wall");
    hoveredEdge = null;
    return;
  }

  /*
    Drawing finishes on the release only when the press actually travelled.

    A press that went nowhere leaves the wall *armed* — the anchor stays and the far end follows the
    cursor until the next click. So one gesture draws a wall by dragging, and two clicks draw one
    with the far end re-aimable in between, from the same code.
  */
  if (!anchor || !reach) return;
  if (drawRelease(armedBeforePress, travelled) === "arm") {
    pressedAt = null;
    return;
  }
  const from = anchor;
  const to = reach;
  clearGesture();
  setGrabTarget(false);
  invalidate();
  const result = applyDraw(graph, from, to, MIN_WALL_PX * lastPerPixel);
  if (!result) {
    say("too short to be a wall, so nothing was added");
    return;
  }
  commit(result, describeDraw(result.splits, result.overlaps));
}

/**
 * Save an edit, and say what it did.
 *
 * One place, because every tool ends the same way and the failure handling is the part that must not
 * differ between them: the graph is stored before what is in hand changes, so a failed write leaves
 * the GM with what they had.
 */
function commit(result: EditResult, message: string): void {
  busy = true;
  say("saving…", "working");
  void updateFrozen(result.graph)
    .then(() => {
      say(message);
    })
    .catch((error: unknown) => {
      const detail = describeError(error);
      say(`the edit was not saved and has been undone: ${detail}`, "bad");
      devLog("error", "workspace: saving a wall edit failed", detail);
      console.error("Fog Nudger — saving a wall edit failed", error);
    })
    .finally(() => {
      busy = false;
      invalidate();
    });
}

function hover(point: MapPoint | null): void {
  const graph = frozenGraph();
  if (!point || !graph) {
    if (hovered === null && hoveredEdge === null) return;
    hovered = null;
    hoveredEdge = null;
    setGrabTarget(false);
    invalidate();
    return;
  }

  lastPerPixel = point.perPixel;
  if (tool === "erase") {
    const found = nearestEdge(graph, { x: point.u, y: point.v }, ERASE_RADIUS_PX * point.perPixel);
    if (found === hoveredEdge) return;
    hoveredEdge = found;
    setGrabTarget(found !== null);
    invalidate();
    return;
  }

  if (tool === "draw") {
    // The far end keeps following even between clicks, which is what makes the two-click form
    // legible: the wall being drawn is on screen the whole time rather than only while a button is
    // held.
    if (anchor) {
      reach = drawPoint(graph, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.modifier);
      invalidate();
    }
    const near = drawPoint(graph, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.modifier);
    setGrabTarget(near.onNode !== null);
    return;
  }

  const found = grabAt(graph, point.u, point.v, GRAB_RADIUS_PX * point.perPixel)?.id ?? null;
  if (found === hovered) return;
  hovered = found;
  setGrabTarget(found !== null);
  invalidate();
}

/** Wire the tools up. The step declares that a drag means this; the shell offers it every press. */
export function registerWallEdit(): void {
  setMapDragHandler({ start, move, end, cancel, hover, escape });
}
