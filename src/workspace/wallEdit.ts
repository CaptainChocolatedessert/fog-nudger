/**
 * Dragging a vertex: the pointer events, the state line, and the scene write.
 *
 * **The first thing on this surface that changes the GM's own work rather than a setting.** Every
 * control before it turns a number and re-derives; this moves a point, and the point stays moved
 * because stage two never re-derives. That is what the freeze is for.
 *
 * What the gesture *means* is in `dragGesture.ts` and is tested there — which vertex a press takes,
 * where it sits while the cursor moves, whether a release joins or moves, and whether anything
 * happened. This file is what those decisions are wired to: it holds the gesture in progress, tells
 * the canvas to redraw, and writes the result.
 *
 * ## The gesture is taken by looking, not by a mode
 *
 * A press is offered here before panning is decided, and it is taken only when there is a vertex
 * under it. So a drag on empty map still pans, Ctrl still pans anywhere, and the GM never has to put
 * the surface into a state before they can look around. Editing a graph is mostly looking.
 *
 * ## Live walls, faces on release
 *
 * The drag redraws the walls every frame and the rooms only when it ends (user, 2026-09-03) — the
 * cheapest thing that cannot be too slow, and moving to live faces later is a local change. Nothing
 * is written to the graph while the gesture runs: this holds *where the vertex would be* and the
 * layer draws that, so a drag costs no graph rebuild and no crossing sweep per frame. The sweep runs
 * once, on release, which is also when the scene is written.
 *
 * ## What a failed write does
 *
 * `updateFrozen` stores the graph before it changes what is in hand, so a failed write leaves the GM
 * with the graph they had rather than one the scene does not agree with. The edit is lost and the
 * state line says so in as many words — losing one drag is the safe direction against editing for an
 * hour against something that is not being saved.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { applyDrag, describeEdit, dragTo, grabAt, type DragState, type Grab } from "./dragGesture";
import { invalidate, say, setMapDragHandler, type MapPoint } from "./shell";
import { frozenGraph, updateFrozen } from "./stage";

/**
 * How close a press has to be to a vertex to grab it, and a drag to a vertex to merge with it.
 *
 * Screen pixels. The grab radius is the smaller of the two on purpose: grabbing is a gesture the GM
 * aims, and a generous target would make it hard to pan by dragging near a wall. Merging is one they
 * are *shown* mid-drag and can back out of by moving away or holding ALT, so it can afford to reach
 * further.
 */
const GRAB_RADIUS_PX = 9;
const SNAP_RADIUS_PX = 14;

let grab: Grab | null = null;
let state: DragState | null = null;
let hovered: number | null = null;
/** A write is in flight, so nothing new may start on top of it. */
let busy = false;

/** The vertex being dragged and where it currently sits, for the layer that draws it. */
export function draggedNode(): { readonly id: number; readonly at: Vector2 } | null {
  return grab === null || state === null ? null : { id: grab.id, at: state.at };
}

/** The vertex a release would merge into, for the layer to make evident before it happens. */
export function snapTarget(): number | null {
  return state?.snapTo ?? null;
}

/** The vertex under the pointer with no gesture running, so it can be shown as grabbable. */
export function hoveredNode(): number | null {
  return hovered;
}

function start(point: MapPoint): boolean {
  if (busy) return false;
  const graph = frozenGraph();
  if (!graph) return false;

  const found = grabAt(graph, point.u, point.v, GRAB_RADIUS_PX * point.perPixel);
  if (!found) return false;

  grab = found;
  state = { at: graph.nodes[found.id]!, snapTo: null };
  hovered = null;
  invalidate();
  return true;
}

function move(point: MapPoint): void {
  const graph = frozenGraph();
  if (!grab || !graph) return;
  state = dragTo(graph, grab, point.u, point.v, SNAP_RADIUS_PX * point.perPixel, point.altKey);
  invalidate();
}

function cancel(): void {
  grab = null;
  state = null;
  invalidate();
}

function end(): void {
  const graph = frozenGraph();
  const held = grab;
  const landed = state;
  grab = null;
  state = null;
  invalidate();
  if (!held || !landed || !graph) return;

  const result = applyDrag(graph, held, landed);
  // A press and release that went nowhere. Nothing to write, and nothing to say either — the point
  // probe is deliberately not fired for a gesture this tool took, so silence is the whole response.
  if (!result) return;

  const merged = landed.snapTo !== null;
  busy = true;
  say(merged ? "joining the points…" : "moving the point…", "working");
  void updateFrozen(result.graph)
    .then(() => {
      say(describeEdit(merged, result.splits, result.overlaps));
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
  const found =
    point && graph ? grabAt(graph, point.u, point.v, GRAB_RADIUS_PX * point.perPixel)?.id ?? null : null;
  if (found === hovered) return;
  hovered = found;
  invalidate();
}

/** Wire the tool up. The step declares that a drag means this; the shell offers it every press. */
export function registerWallEdit(): void {
  setMapDragHandler({ start, move, end, cancel, hover });
}
