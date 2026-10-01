/**
 * The wall tools: moving a point, drawing a wall, erasing one, mending a gap, collapsing a small
 * region, dissolving a region, suppressing one, spanning an opening, spanning one with a door,
 * creating a door, and opening or closing one.
 *
 * **The first things in this project that change the GM's own work rather than a setting.** Every
 * control before them turns a number and re-derives; these change the graph, and it stays changed
 * because stage two never re-derives. That is what the derivation is for.
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
 * ## All but two decide by looking
 *
 * Move takes a press only when a vertex is under it, Erase only when a wall is, Mend, Prune and Collapse
 * small regions only inside a ring, Dissolve only inside a region and the two Spans only where they have a wall to place. So a drag anywhere
 * else still pans, and Ctrl still pans anywhere. **Draw and Suppress region take every press**: a wall
 * has to be able to start on empty map, and a mark can go anywhere — the case the shell's brush branch
 * already anticipated.
 *
 * ## Live walls, faces on release
 *
 * A gesture redraws the walls every frame and the rooms only when it ends (user, 2026-09-03).
 * Nothing is written to the graph while it runs: this holds *what would happen* and the layer draws
 * that, so a drag costs no graph rebuild and no crossing sweep per frame.
 *
 * ## What a failed write does
 *
 * `saveEditedWalls` stores the graph before it changes what is in hand, so a failed write leaves the GM
 * with the graph they had rather than one the scene does not agree with. The edit is lost and the
 * state line says so — losing one gesture is the safe direction against editing for an hour against
 * something that is not being saved.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { compactNodes, documentPoint, type WallGraph } from "../trace/wallGraph";
import { markAt } from "../trace/suppression";
import { applySpan, applySpanDoor, findSpan, type Span } from "../trace/span";
import { nearestEdge, nearestNode, removeEdge, removeEdges, type EditResult } from "../trace/planarOps";
import { connectedEdges } from "../trace/connected";
import { chainClick, chainRun, chainRunOntoSegment } from "./chainGesture";
import { insertEdge } from "../trace/planarOps";
import { applyMends, type Mend } from "../trace/mends";
import { applyCollapses, collapseAll, type Collapse } from "../trace/collapse";
import { applyPrunePieces, type PrunePiece } from "../trace/prunePieces";
import { dissolutionAt, type Dissolution } from "../trace/dissolve";
import { buildWallFaces, type WallFaces } from "../trace/wallFaces";
import {
  applyDraw,
  applyDrag,
  describeDraw,
  describeEdit,
  dragTo,
  drawPoint,
  drawRelease,
  grabAt,
  splitForLandings,
  type DragState,
  type DrawPoint,
  type Grab,
} from "./dragGesture";
import { describeMends, mendAt } from "./mendGesture";
import {
  doorTargetAt,
  dragDoorEnd,
  isSecondClick,
  placeDoor,
  removeDoor,
  slideDoor,
  stretchFrom,
  toggleDoor,
  wholeSegment,
  type DoorPlacement,
  type DoorTarget,
  type MadeDoor,
} from "./doorGesture";
import { pointAlong } from "../trace/doors";
import { describeCollapses, describePrunes, ringAt } from "./ringGesture";
import {
  currentPrunePieces,
  pieceAtFreeClick,
  pruneLength,
  setHoveredFreePiece,
  startPruneSearch,
  stopPruneSearch,
} from "./pruneSearch";
import {
  collapseAtPoint,
  collapseSize,
  currentCollapses,
  setHoveredFreeCollapse,
  startCollapseSearch,
  stopCollapseSearch,
} from "./collapseSearch";
import {
  currentMends,
  mendForFreeClick,
  mendSearchActive,
  refreshMendSearch,
  setHoveredFreeMend,
  startMendSearch,
  stopMendSearch,
} from "./mendSearch";
import { currentMarkStates, editableGraph } from "./regions";
import { currentMarks, saveMarks } from "./regionMarks";
import { clampToExtent } from "../trace/graphUnits";
import { invalidate, mapExtent, say, setGrabTarget, setMapDragHandler, whileWorking, type MapPoint } from "./shell";
import { saveEditedWalls } from "./stage";

/*
  `editableGraph` lives in `regions.ts`. The tool strip needs the same answer to decide whether to
  offer these tools at all, and two copies of "which graph is on screen" is exactly the pair this
  project has already been bitten by.
*/

/** Which verb a press means. */
export type WallTool =
  | "move"
  | "draw"
  | "drawChain"
  | "erase"
  | "eraseChain"
  | "mend"
  | "prune"
  | "collapse"
  | "dissolve"
  | "suppressRegion"
  | "span"
  | "spanDoor"
  | "door"
  | "doorToggle";

/**
 * Whether the tool in hand searches for a span: *Span opening*, or *Span door*, which places the same
 * wall and makes it a door. Everything about finding and previewing the wall is shared; only the
 * release differs.
 */
const spans = (tool: WallTool): boolean => tool === "span" || tool === "spanDoor";

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
 * How close a press has to be to a **wall** to land on it rather than beside it.
 *
 * **Tighter than the vertex snap, deliberately** (user, 2026-09-22: *"Tighter, 8px"*). A vertex is a
 * point and deserves a generous reach; a wall is a long target, and at the vertex radius almost any
 * click on a real map would be within reach of one — which would make placing a free point in a
 * corridor hard. Erase's radius, because it is the same question: did the GM aim at this wall.
 */
const LAND_RADIUS_PX = 8;
/**
 * The shortest wall the draw tool will put down, in screen pixels.
 *
 * From a room: two clicks in nearly the same place made a wall too short to see and painfully hard
 * to aim the erase tool at, since a longer neighbour wins the nearest-wall query from almost
 * anywhere near it. Screen pixels rather than a fixed distance, so zooming in to draw finer detail
 * still works — the floor is on what can be *aimed at*, not on what the map is allowed to contain.
 */
const MIN_WALL_PX = 5;

/** What Collapse, Prune and Mend say when picked up with no walls to search — one copy for three. */
const NO_WALLS = "No walls to search.";

let tool: WallTool = "move";

/** Moving: the vertex in hand and where it would land. */
let grab: Grab | null = null;
let dragState: DragState | null = null;
/** Drawing: the fixed end, and the end following the cursor. */
let anchor: DrawPoint | null = null;
let reach: DrawPoint | null = null;
/**
 * Drawing a chain: the points placed so far, and whether the run is to be shut.
 *
 * **Nothing is written until it ends**, which is what makes a chain one act: one crossing sweep, one
 * scene write, one undo entry. It also sidesteps a defect the per-wall version would have had — a
 * press is refused while a write is in flight, so clicking briskly along a chain would have landed
 * some clicks as pans.
 */
let chain: DrawPoint[] = [];
let chainClosed = false;
/** Where a chain ended on one of its own segments, if it did. */
let chainOnSegment: { at: number; point: Vector2 } | null = null;
/**
 * Where a click **would** land on the chain's own run, drawn before the press.
 *
 * Without it the answer is invisible until the click has already been made — which is how the room
 * found the rule missing (user, 2026-09-22: a click meant for a line *"overshot a bit and created a
 * little triangle on the other side"*).
 */
let chainLanding: Vector2 | null = null;

/** Erasing, and hovering with any tool: what is under the pointer. */
let hovered: number | null = null;
let hoveredEdge: number | null = null;
/**
 * Where the draw tool would put its next point, before any press.
 *
 * **The snap indication belongs on the canvas rather than in the cursor** (user, 2026-09-05). Draw
 * marked nothing until after the first click, so whether a line would *attach* to the vertex under
 * the pointer was invisible at the moment it was being decided — and attaching is the whole
 * difference between closing a gap and drawing a line that merely ends near one. The mark is the
 * same green the drag's merge target uses, which is the channel that already carries "this will
 * join" on this surface.
 */
let drawHover: DrawPoint | null = null;
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
let pressedAt: { x: number; y: number } | null = null;
/**
 * Graph units per screen pixel, from the last event that carried one.
 *
 * Kept because the release has no position of its own — the tool has been told where the far end is
 * on every move, and handing `end` a fresh point would invite a second, subtly different answer
 * about where the wall lands. The scale is the one thing it still needs from screen space, and it
 * cannot have changed since the last move without a move to report it.
 */
let lastPerPixel = 0;
/**
 * Where the pointer last was, so what is under it can be re-asked after an edit.
 *
 * Compacting the node table renumbers everything, and the answer to "hold no ids across it" is not
 * to translate them but to stop holding them — so after an edit the hover is worked out again from
 * the pointer rather than carried over. That is also the more correct answer: the graph just
 * changed, and what is under the cursor may genuinely be something else now.
 */
let lastPointer: { u: number; v: number; x: number; y: number } | null = null;
/** A write is in flight, so nothing new may start on top of it. */
let busy = false;
/** The mend a press landed on, and the walls it was found on. Accepted on release. */
let pressedMend: { readonly mend: Mend; readonly graph: WallGraph } | null = null;
/** Whether the pointer is inside a mend's ring, so the cursor changes only when that does. */
let hoveredMend = false;
/**
 * The free end a free-click preview is currently keyed on, or `"ring"` inside an ordinary ring — so a
 * hover moving between two un-rung ends, or into and out of a ring, is told from "nothing changed"
 * and repaints the preview it owns in `mendSearch.ts`.
 */
let hoveredMendFreeKey: number | "ring" | null = null;
/** The small region a press landed on, and the walls it was found on. Collapsed on release. */
let pressedCollapse: { readonly collapse: Collapse; readonly graph: WallGraph } | null = null;
/** Whether the pointer is inside a small region's ring. */
let hoveredCollapse = false;
/** The same key as Mend's, by the region's own face index. */
let hoveredCollapseFreeKey: number | "ring" | null = null;
/** The dead-end piece a press landed on, and the walls it was found on. Taken on release. */
let pressedPrune: { readonly piece: PrunePiece; readonly graph: WallGraph } | null = null;
/** Whether the pointer is inside a dead end's ring. */
let hoveredPrune = false;
/** The same key as Mend's, by the wall under the pointer. */
let hoveredPruneFreeKey: number | "ring" | null = null;
/**
 * Dissolving: the region under the pointer, the walls a click would remove, and the graph they were
 * found on. Removed on release, as an erase is, so the highlight is exactly what goes.
 */
let hoveredRegion: HoveredRegion | null = null;

interface HoveredRegion {
  readonly dissolution: Dissolution;
  readonly graph: WallGraph;
}

/**
 * The regions of the graph a dissolve aims at, traversed once per graph rather than per pointer move.
 *
 * Keyed on the graph object, which an edit or a derive replaces rather than mutates, so a traversal
 * can never be asked about a graph it was not built from — its half-edge ids would name other walls.
 */
let regionsOf: { readonly graph: WallGraph; readonly faces: WallFaces } | null = null;

/**
 * How close a press has to be to a mark to remove it, in screen pixels.
 *
 * The same reach as Erase's: a mark is a small target, and a press that misses one places another
 * beside it, which is visible at once and one undo from gone.
 */
const MARK_RADIUS_PX = 8;

/**
 * Suppressing: what a click would do where the pointer is — remove the mark under it, or place one.
 *
 * Every press is taken, because a mark can go anywhere (user, 2026-09-16) — outside every region too,
 * where it suppresses nothing until walls are drawn round it. So the tool acts on release, and a press
 * that travelled is a drag rather than a click and does nothing; Ctrl pans.
 */
export type MarkTarget = { readonly remove: number } | { readonly place: Vector2 };

let markTarget: MarkTarget | null = null;

function markTargetAt(point: MapPoint): MarkTarget {
  const index = markAt(currentMarks(), { x: point.x, y: point.y }, MARK_RADIUS_PX * point.perPixel);
  // Quantised here, where a mark is made, so the marks in memory are the numbers storage returns.
  return index === null ? { place: documentPoint(point.x, point.y) } : { remove: index };
}

function sameMarkTarget(left: MarkTarget | null, right: MarkTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if ("remove" in left) return "remove" in right && left.remove === right.remove;
  return "place" in right && left.place.x === right.place.x && left.place.y === right.place.y;
}

/**
 * How near the click a span may pass instead of through it, in screen pixels (user, 2026-09-16).
 *
 * Fixed, as the two-thirds rule in `trace/span.ts` is: the wall a click would place is on screen
 * before the click, so there is nothing for a setting to tune that is not already visible.
 */
const SPAN_NEAR_PX = 12;

/** Spanning: the wall a click would place where the pointer is, and the graph it was found on. */
let spanTarget: { readonly span: Span; readonly graph: WallGraph } | null = null;
/** The pointer position waiting for the next frame's span search, and whether one is booked. */
let spanPoint: MapPoint | null = null;
let spanFrame = 0;

/**
 * Creating a door: what the press landed on, where, and the graph it was found on.
 *
 * `doorGesture.ts` decides what each press means; this holds the gesture while it runs. Nothing is
 * written until the release, as with every wall tool, and the layer draws what would happen meanwhile.
 */
let doorPress: { readonly target: DoorTarget; readonly at: Vector2; readonly graph: WallGraph } | null = null;
/** The door a drag would leave, and which door on that segment it replaces, if any. */
let doorDrag: { readonly placement: DoorPlacement; readonly replacing: number | null } | null = null;
/**
 * Whether the press has travelled far enough to be a drag: the shortest door, 5 screen pixels — Draw's
 * shortest wall — so a smaller movement is a click.
 */
let doorTravelled = false;
/** The second click of a double-click on the door the first just made: taken, and ignored. */
let doorEcho = false;
/** What is under the pointer with no press, and the graph it was found on — for the preview. */
let doorHover: { readonly target: DoorTarget; readonly graph: WallGraph } | null = null;
/** The door the last click made, so the second click of a double-click can be recognised. */
let madeDoor: MadeDoor | null = null;

/**
 * Toggle door: the door under the pointer, and the one a press landed on — each with the graph it was
 * found on. A press is taken only on a door, its ends counted as the door, and the door is toggled on
 * release; anywhere else the press pans.
 */
interface ToggleTarget {
  readonly graph: WallGraph;
  readonly edge: number;
  readonly door: number;
}
let toggleHover: ToggleTarget | null = null;
let togglePress: ToggleTarget | null = null;

/** The door *Toggle door* would act on where the pointer is, by *Create door*'s own hit test. */
function toggleTargetAt(graph: WallGraph, point: MapPoint): ToggleTarget | null {
  const target = doorTargetAt(
    graph,
    { x: point.x, y: point.y },
    LAND_RADIUS_PX * point.perPixel,
    GRAB_RADIUS_PX * point.perPixel,
  );
  if (!target || target.kind === "wall") return null;
  return { graph, edge: target.edge, door: target.door };
}

/**
 * The door a click with *Toggle door* would open or close, for the layer to mark — its marker's rim in
 * the highlight a grabbable vertex wears, which says *this one* and nothing about its state (user,
 * 2026-09-30, over drawing the state a click would leave).
 */
export function doorToToggle(): ToggleTarget | null {
  if (tool !== "doorToggle") return null;
  return togglePress ?? toggleHover;
}

/** What the door tool would do where the pointer is, for the layer to draw before it happens. */
export interface DoorView {
  readonly graph: WallGraph;
  /** A door a click would remove, drawn red. */
  readonly removing: { readonly edge: number; readonly door: number } | null;
  /** The door a click or drag would leave, drawn dashed, and the door on its segment it replaces. */
  readonly placing: { readonly placement: DoorPlacement; readonly replacing: number | null } | null;
  /** The end of a door the pointer would take hold of, drawn grown. */
  readonly end: { readonly edge: number; readonly door: number; readonly end: "start" | "end" } | null;
}

/** What a click on `target` would do, drawn: a whole segment, a removal, or an end to take hold of. */
function doorViewOf(graph: WallGraph, target: DoorTarget): DoorView {
  if (target.kind === "wall") {
    const placed = wholeSegment(graph, target.edges[0]!);
    return { graph, removing: null, placing: placed ? { placement: placed, replacing: null } : null, end: null };
  }
  // A click on an end removes the door as a click inside it does, so it is drawn red there too.
  return {
    graph,
    removing: { edge: target.edge, door: target.door },
    placing: null,
    end: target.kind === "end" ? target : null,
  };
}

/** What the door tool would do, or `null` with another tool in hand or nothing under the pointer. */
export function doorView(): DoorView | null {
  if (tool !== "door") return null;
  if (doorPress) {
    if (doorDrag) {
      const target = doorPress.target;
      return { graph: doorPress.graph, removing: null, placing: doorDrag, end: target.kind === "end" ? target : null };
    }
    return doorTravelled ? null : doorViewOf(doorPress.graph, doorPress.target);
  }
  return doorHover ? doorViewOf(doorHover.graph, doorHover.target) : null;
}

/** Whether the door tool is in hand, which is when every door's ends are marked as things to grab. */
export function doorToolInHand(): boolean {
  return tool === "door";
}

function sameDoorTarget(left: DoorTarget | null, right: DoorTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === "wall" || right.kind === "wall") {
    return left.kind === "wall" && right.kind === "wall" && left.edges[0] === right.edges[0];
  }
  return (
    left.kind === right.kind &&
    left.edge === right.edge &&
    left.door === right.door &&
    (left.kind !== "end" || right.kind !== "end" || left.end === right.end)
  );
}

/** Save a door edit — a graph with one segment's doors changed — through the path every wall edit takes. */
function commitDoor(next: WallGraph, message: string, undoLabel: string, from: WallGraph): void {
  if (next === from) return;
  commit({ graph: next, splits: 0, overlaps: 0 }, message, undoLabel, from);
}

function spanAt(graph: WallGraph, point: MapPoint): { readonly span: Span; readonly graph: WallGraph } | null {
  const span = findSpan(
    graph,
    { x: point.x, y: point.y },
    { near: SPAN_NEAR_PX * point.perPixel, minLength: MIN_WALL_PX * point.perPixel },
  );
  return span ? { span, graph } : null;
}

/**
 * Search for the span under the pointer at most once a frame.
 *
 * The search is milliseconds where a wall runs through the click and can be a hundred where none does,
 * out in open space (`trace/span.ts` has the figures). Pointer moves arrive faster than frames, so
 * searching on each would queue work behind itself; this keeps only the latest position and searches
 * for that when the frame comes.
 */
function scheduleSpan(point: MapPoint): void {
  spanPoint = point;
  if (spanFrame !== 0) return;
  spanFrame = requestAnimationFrame(() => {
    spanFrame = 0;
    const latest = spanPoint;
    spanPoint = null;
    if (!latest || !spans(tool)) return;
    const graph = editableGraph();
    spanTarget = graph ? spanAt(graph, latest) : null;
    setGrabTarget(spanTarget !== null);
    invalidate();
  });
}

function dropSpan(): void {
  spanTarget = null;
  spanPoint = null;
  if (spanFrame !== 0) cancelAnimationFrame(spanFrame);
  spanFrame = 0;
}

/**
 * The wall a click with either Span would place, for the layer to draw before the click — and whether
 * it would be a door, which is how the layer draws it.
 */
export function pendingSpan(): { readonly span: Span; readonly graph: WallGraph; readonly door: boolean } | null {
  return spanTarget && { ...spanTarget, door: tool === "spanDoor" };
}

/** What a click with Suppress region would do where the pointer is, for the layer to show first. */
export function pendingMark(): MarkTarget | null {
  return markTarget;
}

/** Place or remove a mark, and say what it did. The marks' own document, not the walls'. */
function commitMark(target: MarkTarget): void {
  const marks = currentMarks();
  const removing = "remove" in target;
  const next = removing
    ? marks.filter((_, index) => index !== target.remove)
    : [...marks, target.place];
  busy = true;
  // A *cross* to the GM (text rules, 2026-09-29), which gave *mark* to the map's own drawing.
  void saveMarks(next, removing ? "removing a cross" : "placing a cross")
    .then(() => {
      if (removing) {
        say("Cross removed.");
        return;
      }
      // The marks listener has re-applied them by now, so the newest mark's state is current.
      const placed = currentMarkStates()[next.length - 1];
      say(placed?.active ? "Region suppressed." : "Cross placed outside every region.");
    })
    .catch((error: unknown) => {
      const detail = describeError(error);
      say(`Cross not saved: ${detail}.`, "bad");
      devLog("error", "workspace: saving a mark failed", detail);
      console.error("Fog Nudger — saving a suppression mark failed", error);
    })
    .finally(() => {
      busy = false;
      markTarget = null;
      if (lastPointer) hover({ ...lastPointer, perPixel: lastPerPixel, modifier: false });
      invalidate();
    });
}

/**
 * Point Erase chain at whatever is under the pointer.
 *
 * **Re-walked only when the wall under the pointer changes**, which is the cheap half of the cost:
 * the search for that wall is a radius query the erase tool already runs every move, and the walk
 * behind it is what costs the millisecond. Moving along one wall of a chain therefore costs nothing
 * after the first frame.
 */
/**
 * End a chain and write it, as one act.
 *
 * **One `insertEdge` for the whole run**, which is what makes it one crossing sweep and one undo
 * entry. A closed chain repeats its first point, the same way the map frame's ring goes in, so the
 * corners are shared vertices by construction rather than by coordinates agreeing.
 *
 * A chain of one point writes nothing: that is a press followed straight away by a finish, and there
 * is no wall in it.
 */
function finishChain(graph: WallGraph): void {
  const placed = chain;
  const points = chain.map((point) => point.at);
  const run = chainOnSegment
    ? chainRunOntoSegment(points, chainOnSegment.at, chainOnSegment.point)
    : chainRun(points, chainClosed);
  const walls = run ? run.length - 1 : 0;
  clearGesture();
  invalidate();
  if (!run) return;
  // Split what the points landed on first, then add the run by those same coordinates — the rule
  // every tool that can end on a wall follows, and the reason a landing is a shared vertex.
  const split = splitForLandings(graph, placed);
  const added = insertEdge(split.graph, run);
  commit(
    { ...added, splits: added.splits + split.splits },
    `Drew a chain of ${walls} wall${walls === 1 ? "" : "s"}.`,
    "drawing a chain",
    graph,
  );
}

function aimChain(graph: WallGraph, point: MapPoint): void {
  const found = nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel);
  if (found === null) {
    if (!chainTarget) return;
    chainTarget = null;
    setGrabTarget(false);
    invalidate();
    return;
  }
  setGrabTarget(true);
  // Already in the set we are showing, on the same graph: the answer cannot have changed.
  if (chainTarget && chainTarget.graph === graph && chainTarget.edges.includes(found)) return;
  chainTarget = { graph, edges: connectedEdges(graph, found) };
  invalidate();
}

function regionUnder(graph: WallGraph, point: MapPoint): HoveredRegion | null {
  if (regionsOf?.graph !== graph) regionsOf = { graph, faces: buildWallFaces(graph) };
  const dissolution = dissolutionAt(graph, regionsOf.faces, { x: point.x, y: point.y });
  return dissolution ? { dissolution, graph } : null;
}

export function currentTool(): WallTool {
  return tool;
}

/** Switch tools, abandoning anything half-done. A half-drawn wall is not a thing to carry across. */
export function setTool(next: WallTool): void {
  tool = next;
  clearGesture();
  hovered = null;
  hoveredEdge = null;
  hoveredMend = false;
  hoveredCollapse = false;
  hoveredPrune = false;
  hoveredRegion = null;
  markTarget = null;
  doorHover = null;
  madeDoor = null;
  toggleHover = null;
  dropSpan();
  setGrabTarget(false);
  /*
    The search runs from the moment the tool is picked up, as the ink tool's does: it has one thing to
    show and no reason to make the GM ask for it. Putting the tool down drops the rings, so none is
    ever on screen while something else is in hand and cannot act on it.
  */
  hoveredMendFreeKey = null;
  hoveredCollapseFreeKey = null;
  hoveredPruneFreeKey = null;
  if (next === "mend") {
    const found = startMendSearch();
    say(found === null ? NO_WALLS : describeMends(found));
  } else {
    stopMendSearch();
  }
  /*
    The same for the small regions, at the size the handle starts at — which is **every** time the
    tool is picked up, since arming it is opening its drawer and the size is not stored (user,
    2026-09-21).
  */
  if (next === "collapse") {
    const found = startCollapseSearch();
    say(found === null ? NO_WALLS : describeCollapses(found));
  } else {
    stopCollapseSearch();
  }
  // And the dead ends, at four ink widths, every time the tool is picked up.
  if (next === "prune") {
    const found = startPruneSearch();
    say(found === null ? NO_WALLS : describePrunes(found));
  } else {
    stopPruneSearch();
  }
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

/**
 * Where a release would land the dragged vertex **on a wall**, or `null`.
 *
 * Drawn like a merge target, because that is what it becomes: the wall is split there and the vertex
 * is folded into the new point, so a release joins them rather than leaving one resting on the other.
 */
export function dragLanding(): Vector2 | null {
  return dragState?.landOn?.at ?? null;
}

/** The vertex under the pointer with no gesture running, so it can be shown as grabbable. */
export function hoveredNode(): number | null {
  return hovered;
}

/**
 * Everything joined to the wall under the pointer, and the graph those indices belong to.
 *
 * **Held rather than recomputed per frame**, like the region under Dissolve's cursor: the walk is
 * 0.65ms median and 2.19ms worst on a graph three times denser than a real map, which is inside a
 * frame but not free, and the answer cannot change while the pointer is still.
 */
let chainTarget: { readonly graph: WallGraph; readonly edges: readonly number[] } | null = null;

/** The wall a click would erase, for the layer to mark before it goes. */
export function hoveredWall(): number | null {
  return hoveredEdge;
}

/**
 * The walls a click would remove, and the graph they are indices into — so the layer can refuse to
 * mark them against any other.
 *
 * **One accessor for both siblings**, because the layer's question is the same for each: *what would
 * this press take*. Erase loop answers with the walls around the region under the pointer, Erase
 * chain with everything joined to the wall under it. Only one can be armed, so only one can answer.
 */
export function condemnedWalls(): { readonly graph: WallGraph; readonly edges: readonly number[] } | null {
  if (chainTarget) return chainTarget;
  return hoveredRegion && { graph: hoveredRegion.graph, edges: hoveredRegion.dissolution.edges };
}

/** Where a click would land on the chain's own run, or `null`. */
export function chainLandingMark(): Vector2 | null {
  return chainLanding;
}

/**
 * The chain being drawn: the points placed, and the end following the cursor.
 *
 * Drawn dashed by the graph layer, like the single wall being drawn and for the same reason — it is
 * the one thing on the canvas the document does not hold yet, and a solid stroke would claim
 * otherwise.
 */
export function pendingChain(): { readonly points: readonly DrawPoint[]; readonly to: DrawPoint | null } | null {
  return chain.length > 0 ? { points: chain, to: reach } : null;
}

/** The wall being drawn: the fixed end and the end following the cursor, or `null`. */
export function pendingWall(): { readonly from: DrawPoint; readonly to: DrawPoint } | null {
  return anchor && reach ? { from: anchor, to: reach } : null;
}

/** Where a press would put the next point, with no wall started yet. */
export function pendingPoint(): DrawPoint | null {
  return anchor ? null : drawHover;
}

function clearGesture(): void {
  grab = null;
  dragState = null;
  anchor = null;
  reach = null;
  drawHover = null;
  travelled = false;
  armedBeforePress = false;
  pressedAt = null;
  pressedMend = null;
  pressedCollapse = null;
  pressedPrune = null;
  chainTarget = null;
  chain = [];
  chainClosed = false;
  chainOnSegment = null;
  chainLanding = null;
  doorPress = null;
  doorDrag = null;
  doorTravelled = false;
  doorEcho = false;
  togglePress = null;
}

function start(point: MapPoint): boolean {
  if (busy) return false;
  const graph = editableGraph();
  if (!graph) return false;

  pressedAt = { x: point.x, y: point.y };
  lastPointer = { u: point.u, v: point.v, x: point.x, y: point.y };
  travelled = false;
  armedBeforePress = anchor !== null;
  lastPerPixel = point.perPixel;

  if (tool === "move") {
    const found = grabAt(graph, point.x, point.y, GRAB_RADIUS_PX * point.perPixel);
    if (!found) return false;
    grab = found;
    dragState = { at: graph.nodes[found.id]!, snapTo: null, landOn: null };
    hovered = null;
    setGrabTarget(true);
    invalidate();
    return true;
  }

  if (tool === "erase") {
    const found = nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel);
    if (found === null) return false;
    hoveredEdge = found;
    invalidate();
    return true;
  }

  if (tool === "suppressRegion") {
    markTarget = markTargetAt(point);
    invalidate();
    return true;
  }

  /*
    Create door takes a press on a door's end, a door, or a wall, in that order, and pans anywhere else
    — `doorGesture.ts` has the order and why. The second click of a double-click on the door the first
    just made is taken and ignored, so it neither pans nor removes what the first made.
  */
  if (tool === "door") {
    const target = doorTargetAt(
      graph,
      { x: point.x, y: point.y },
      LAND_RADIUS_PX * point.perPixel,
      GRAB_RADIUS_PX * point.perPixel,
    );
    if (!target) return false;
    if (isSecondClick(graph, madeDoor, performance.now(), target)) {
      madeDoor = null;
      doorEcho = true;
      return true;
    }
    doorPress = { target, at: { x: point.x, y: point.y }, graph };
    invalidate();
    return true;
  }

  // A press on a door is taken and toggles it on release; anywhere else the press pans.
  if (tool === "doorToggle") {
    togglePress = toggleTargetAt(graph, point);
    if (!togglePress) return false;
    invalidate();
    return true;
  }

  // Searched now rather than on the next frame: the press decides between spanning and panning.
  if (spans(tool)) {
    spanTarget = spanAt(graph, point);
    invalidate();
    return spanTarget !== null;
  }

  if (tool === "drawChain") {
    const landed = drawPoint(
      graph,
      point.x,
      point.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    const answer = chainClick(
      chain.map((placed) => placed.at),
      landed.at,
      landed.onNode,
      SNAP_RADIUS_PX * point.perPixel,
      LAND_RADIUS_PX * point.perPixel,
    );
    switch (answer.kind) {
      case "append":
        chain.push(landed);
        reach = landed;
        break;
      case "close":
        chainClosed = true;
        finishChain(graph);
        return true;
      case "join":
        // A loop with a tail: the run ends on a point it already holds, sharing that vertex rather
        // than laying a second one on it.
        chain.push(chain[answer.at]!);
        finishChain(graph);
        return true;
      case "onSegment":
        // Landed part-way along one of its own segments: that segment gains a vertex there and the
        // run ends on it. `finishChain` builds the run; this only says where.
        chainOnSegment = { at: answer.at, point: answer.point };
        finishChain(graph);
        return true;
      case "finish":
        if (landed.onNode !== null && chain.length > 0) chain.push(landed);
        finishChain(graph);
        return true;
    }
    setGrabTarget(true);
    invalidate();
    return true;
  }

  /*
    Erase chain takes a press only on a wall, as Erase does — off the linework there is nothing joined
    to anything, so the press declines and pans.
  */
  if (tool === "eraseChain") {
    const found = nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel);
    if (found === null) return false;
    chainTarget = { graph, edges: connectedEdges(graph, found) };
    invalidate();
    return true;
  }

  // Outside every region there is nothing to dissolve, so the press declines and pans.
  if (tool === "dissolve") {
    const found = regionUnder(graph, point);
    if (!found) return false;
    hoveredRegion = found;
    invalidate();
    return true;
  }

  /*
    Mend, Prune and Collapse take a press only inside a ring or on a free target, and the accept
    happens on release, as an erase does — so a press that turns into a drag is still a click on the
    target rather than the start of something. Anywhere else declines, and the press pans.

    **A ring is a suggestion, not the whole of what a click may take** (2026-09-24). Below the
    threshold's own rings, each of these three falls back to the same live question a ring answers
    for a smaller stretch: is there a genuine target *here*, the current setting aside. Declining
    that too is declining altogether, exactly as Erase does off a wall.
  */

  // Prune's rings, the same way: a press inside one is taken, and the piece goes on release.
  if (tool === "prune") {
    const pieces = currentPrunePieces();
    const index = ringAt(pieces.map((piece) => piece.points), point.x, point.y, point.perPixel);
    if (index !== null) {
      pressedPrune = { piece: pieces[index]!, graph };
      return true;
    }
    // A wall too long a dead end to be rung at the current length — the length ignored entirely.
    const edge = nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel);
    if (edge === null) return false;
    const piece = pieceAtFreeClick(edge);
    if (piece === null) return false;
    pressedPrune = { piece, graph };
    return true;
  }

  // The same shape as Mend's: a press inside a ring is taken, and collapses on release.
  if (tool === "collapse") {
    const collapses = currentCollapses();
    const index = ringAt(collapses.map((c) => c.outline), point.x, point.y, point.perPixel);
    if (index !== null) {
      pressedCollapse = { collapse: collapses[index]!, graph };
      return true;
    }
    // A region bigger than the drawer's current size — the size ignored entirely.
    const collapse = collapseAtPoint({ x: point.x, y: point.y });
    if (collapse === null) return false;
    pressedCollapse = { collapse, graph };
    return true;
  }

  if (tool === "mend") {
    const mends = currentMends();
    const index = mendAt(mends, point.x, point.y, point.perPixel);
    if (index !== null) {
      pressedMend = { mend: mends[index]!, graph };
      return true;
    }
    // A free end whose true best match is farther than the current reach — the reach ignored, the
    // same-wall distance kept exactly as set.
    const end = nearestNode(graph, { x: point.x, y: point.y }, SNAP_RADIUS_PX * point.perPixel);
    if (end === null) return false;
    const mend = mendForFreeClick(end);
    if (mend === null) return false;
    pressedMend = { mend, graph };
    return true;
  }

  // Draw takes every press: a wall has to be able to start on empty map.
  const landed = drawPoint(
      graph,
      point.x,
      point.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
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

/**
 * Where a dragged position is allowed to be: on the map, and no further.
 *
 * **Only the two tools that *store* a position ask for this** — Move's vertex and Draw's far end.
 * Every press and hover is already refused off the map, so a drag is the only way past the edge, and
 * the shell hands a drag the true position on purpose: a brush that left the map would otherwise
 * smear a mark along the border instead of leaving, and it clips per pixel so nothing lands outside
 * anyway. A vertex is different because it is written into the document.
 *
 * **With no map there is nothing to clamp to**, and the position stands — the same answer the rest of
 * this module gives when it cannot know something, rather than inventing a bound.
 */
function onMap(point: MapPoint): { readonly x: number; readonly y: number } {
  const extent = mapExtent();
  return extent ? clampToExtent(point.x, point.y, extent) : { x: point.x, y: point.y };
}

function move(point: MapPoint): void {
  const graph = editableGraph();
  if (!graph) return;
  lastPerPixel = point.perPixel;
  lastPointer = { u: point.u, v: point.v, x: point.x, y: point.y };
  if (pressedAt && (Math.abs(point.x - pressedAt.x) > 0.002 || Math.abs(point.y - pressedAt.y) > 0.002)) {
    travelled = true;
  }

  /*
    The chain's far end follows a held press too, not only a free pointer. The shell hands a gesture in
    progress to `move` and a free pointer to `hover`, so without this the run froze between press and
    release — which on a quick click is a flicker and on a slow one looks like the tool has stopped.
  */
  if (tool === "drawChain") {
    if (chain.length === 0) return;
    const held = onMap(point);
    reach = drawPoint(
      graph,
      held.x,
      held.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    invalidate();
    return;
  }

  if (tool === "move") {
    if (!grab) return;
    const held = onMap(point);
    dragState = dragTo(
      graph,
      grab,
      held.x,
      held.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    invalidate();
    return;
  }

  if (tool === "erase") {
    hoveredEdge = nearestEdge(
      graph,
      { x: point.x, y: point.y },
      ERASE_RADIUS_PX * point.perPixel,
    );
    invalidate();
    return;
  }

  if (tool === "eraseChain") {
    aimChain(graph, point);
    return;
  }

  if (tool === "dissolve") {
    hoveredRegion = regionUnder(graph, point);
    invalidate();
    return;
  }

  if (tool === "suppressRegion") {
    markTarget = markTargetAt(point);
    invalidate();
    return;
  }

  if (spans(tool)) {
    scheduleSpan(point);
    return;
  }

  if (tool === "door") {
    const press = doorPress;
    if (!press || press.graph !== graph) return;
    const at = { x: point.x, y: point.y };
    const shortest = MIN_WALL_PX * point.perPixel;
    if (!doorTravelled && Math.hypot(at.x - press.at.x, at.y - press.at.y) < shortest) return;
    doorTravelled = true;
    const target = press.target;
    const placement =
      target.kind === "wall"
        ? stretchFrom(graph, target.edges, press.at, at)
        : target.kind === "end"
          ? dragDoorEnd(graph, target.edge, target.door, target.end, at, shortest)
          : slideDoor(graph, target.edge, target.door, press.at, at);
    doorDrag = placement ? { placement, replacing: target.kind === "wall" ? null : target.door } : null;
    invalidate();
    return;
  }

  if (!anchor) return;
  const held = onMap(point);
  reach = drawPoint(
      graph,
      held.x,
      held.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
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
  if (chain.length > 0) {
    // A chain in progress is the one thing here that has two endings, and this is the one that keeps
    // Escape's meaning: nothing was written, so nothing has to be taken back.
    cancel();
    say("Chain cancelled.");
    return true;
  }
  if (!anchor && !grab && !pressedMend && !pressedCollapse && !pressedPrune && !doorPress && !togglePress) {
    return false;
  }
  cancel();
  say("Cancelled.");
  return true;
}

/**
 * A right-click, where it means something other than abandoning.
 *
 * **Only Draw chain has a second verb**, and this is it: finish what is drawn. Everything else
 * returns false and the shell asks `escape` instead, which is what a right-click has always done.
 */
function rightClick(): boolean {
  if (tool !== "drawChain" || chain.length === 0) return false;
  const graph = editableGraph();
  if (!graph) return false;
  finishChain(graph);
  return true;
}

function end(): void {
  const graph = editableGraph();
  if (!graph) {
    clearGesture();
    return;
  }

  if (tool === "move") {
    const held = grab;
    const landed = dragState;
    clearGesture();
    /*
      The pointer has not moved, so whatever was under it still is — a release ends the gesture, not
      the hovering, and clearing the hint here made the cursor fall back mid-aim.

      Held by *position* rather than by id, because `commit` compacts the node table and every id
      from before it is meaningless afterwards. `hover` re-asks against the new graph once the write
      lands; this keeps the crosshair steady in the moment between.
    */
    setGrabTarget(true);
    invalidate();
    if (!held || !landed) return;
    const result = applyDrag(graph, held, landed);
    if (!result) return;
    commit(
      result,
      describeEdit(landed.snapTo !== null, result.overlaps),
      "moving a point",
      graph,
      result.overlaps > 0,
    );
    return;
  }

  if (tool === "erase") {
    const target = hoveredEdge;
    clearGesture();
    invalidate();
    if (target === null) return;
    commit(removeEdge(graph, target), "Erased a wall segment.", "erasing a wall segment", graph);
    hoveredEdge = null;
    return;
  }

  if (tool === "eraseChain") {
    const target = chainTarget;
    clearGesture();
    invalidate();
    // Found on walls a derive has since replaced: its indices name walls that are no longer drawn.
    if (!target || target.graph !== graph) return;
    const count = target.edges.length;
    commit(
      removeEdges(graph, target.edges),
      `Erased a chain of ${count} wall segment${count === 1 ? "" : "s"}.`,
      "erasing a chain",
      graph,
    );
    return;
  }

  if (tool === "dissolve") {
    const target = hoveredRegion;
    clearGesture();
    invalidate();
    // Found on walls a derive has since replaced: its indices name walls that are no longer drawn.
    if (!target || target.graph !== graph) return;
    const count = target.dissolution.edges.length;
    commit(
      removeEdges(graph, target.dissolution.edges),
      `Erased a loop of ${count} wall segment${count === 1 ? "" : "s"}.`,
      "erasing a loop",
      graph,
    );
    hoveredRegion = null;
    return;
  }

  if (tool === "span") {
    const target = spanTarget;
    const dragged = travelled;
    clearGesture();
    invalidate();
    // A press that travelled was a drag; and a span found on walls a derive has since replaced names
    // walls that are no longer drawn.
    if (!target || dragged || target.graph !== graph) return;
    commit(applySpan(graph, target.span), "Spanned an opening.", "spanning an opening", graph);
    dropSpan();
    return;
  }

  /*
    Span door: Span opening's wall, made a door from end to end in the same edit — one write, one step
    of undo (user, 2026-09-29). The same guards as Span's, and one more: a wall that did not come out
    as one segment places nothing, since a door cannot cross a vertex. No span the search offers has
    been seen to (`trace/span.ts`).
  */
  if (tool === "spanDoor") {
    const target = spanTarget;
    const dragged = travelled;
    clearGesture();
    invalidate();
    if (!target || dragged || target.graph !== graph) return;
    const placed = applySpanDoor(graph, target.span);
    dropSpan();
    if (!placed) {
      say("Span door failed: wall would be split.", "bad");
      devLog("warn", "workspace: a span door did not come out as one segment, so nothing was placed");
      return;
    }
    commit(placed, "Spanned a door.", "spanning a door", graph);
    return;
  }

  /*
    Toggle door: the door the press landed on opens if it was closed and closes if it was open — one
    edit, one step of undo, saved like every other. A press that travelled was a drag, as with Span.
  */
  if (tool === "doorToggle") {
    const target = togglePress;
    const dragged = travelled;
    clearGesture();
    invalidate();
    if (!target || dragged || target.graph !== graph) return;
    const opening = graph.edges[target.edge]?.doors?.[target.door]?.open !== true;
    commitDoor(
      toggleDoor(graph, target.edge, target.door),
      opening ? "Opened a door." : "Closed a door.",
      opening ? "opening a door" : "closing a door",
      graph,
    );
    return;
  }

  if (tool === "door") {
    const press = doorPress;
    const drag = doorDrag;
    const dragged = doorTravelled;
    const echo = doorEcho;
    clearGesture();
    invalidate();
    // The second click of a double-click, or a press on walls a derive has since replaced.
    if (echo || !press || press.graph !== graph) return;
    const target = press.target;
    if (!dragged) {
      if (target.kind === "wall") {
        const placed = wholeSegment(graph, target.edges[0]!);
        if (!placed) return;
        const edge = graph.edges[placed.edge]!;
        const a = graph.nodes[edge.a]!;
        const b = graph.nodes[edge.b]!;
        madeDoor = {
          time: performance.now(),
          ends: [pointAlong(a, b, placed.door.start), pointAlong(a, b, placed.door.end)],
        };
        commitDoor(placeDoor(graph, placed), "Created a door.", "creating a door", graph);
      } else {
        commitDoor(removeDoor(graph, target.edge, target.door), "Removed a door.", "removing a door", graph);
      }
      return;
    }
    if (!drag) return;
    const length = drag.placement.door.end - drag.placement.door.start;
    if (target.kind === "wall" && length < MIN_WALL_PX * lastPerPixel) {
      say("Door too short.");
      return;
    }
    const [message, label] =
      target.kind === "wall"
        ? ["Created a door.", "creating a door"]
        : target.kind === "end"
          ? ["Resized a door.", "resizing a door"]
          : ["Moved a door.", "moving a door"];
    commitDoor(placeDoor(graph, drag.placement, drag.replacing ?? undefined), message, label, graph);
    return;
  }

  if (tool === "suppressRegion") {
    const target = markTarget;
    const dragged = travelled;
    clearGesture();
    invalidate();
    // A press that travelled was a drag, and a mark is placed by a click.
    if (!target || dragged) return;
    commitMark(target);
    return;
  }

  if (tool === "prune") {
    const pressed = pressedPrune;
    clearGesture();
    invalidate();
    // Found on walls a derive or an edit has since replaced: its indices name walls no longer drawn.
    if (!pressed || pressed.graph !== graph) return;
    commit(applyPrunePieces(graph, [pressed.piece]), prunedMessage(1), "pruning a dead end", graph);
    return;
  }

  if (tool === "collapse") {
    const pressed = pressedCollapse;
    clearGesture();
    invalidate();
    // Found on walls a derive or an edit has since replaced: its indices name walls no longer drawn.
    if (!pressed || pressed.graph !== graph) return;
    commit(
      applyCollapses(graph, [pressed.collapse]),
      collapsedMessage(1),
      "collapsing a small region",
      graph,
    );
    return;
  }

  if (tool === "mend") {
    const pressed = pressedMend;
    clearGesture();
    invalidate();
    // The walls changed under the press — a derive landed — so the mend was found on walls that are
    // no longer on screen, and adding it would put a wall where no ring now is.
    if (!pressed || pressed.graph !== graph) return;
    commit(applyMends(graph, [pressed.mend]), mendedMessage(1), "mending a gap", graph);
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
    say("Segment too short.");
    return;
  }
  commit(result, describeDraw(result.overlaps), "drawing a wall segment", graph, result.overlaps > 0);
}

/**
 * Save an edit, and say what it did.
 *
 * One place, because every tool ends the same way and the failure handling is the part that must not
 * differ between them: the graph is stored before what is in hand changes, so a failed write leaves
 * the GM with what they had.
 */
function commit(
  result: EditResult,
  message: string,
  undoLabel: string,
  from: WallGraph,
  /** Say it as a warning: an edit that left walls lying along others (DESIGN.md §10). */
  warn = false,
): void {
  /*
    Compacted here and nowhere else, which is what makes renumbering safe.

    Erasing and merging leave vertices no wall uses, and leaving them for ever grows a stored
    document that a GM never asked to grow. Renumbering is forbidden *mid-gesture* because ids are
    the only stable identity here — but this runs after the gesture ended and cleared its state, and
    `busy` stops another starting until the write lands, so nothing is holding an id to invalidate.
    The hover is then re-asked from the pointer rather than translated.
  */
  const graph = compactNodes(result.graph);
  busy = true;
  // `from` is what this edit was applied to. When it is not the stored document — the first edit on
  // a graph that has only ever been a derivation — saving adopts it, which is the commit that used
  // to be a button.
  void saveEditedWalls(graph, undoLabel, from)
    .then(() => {
      say(message, warn ? "bad" : "");
    })
    .catch((error: unknown) => {
      const detail = describeError(error);
      // Failed and taken back: the walls on screen are what they were before the edit.
      say(`Edit failed: ${detail}.`, "bad");
      devLog("error", "workspace: saving a wall edit failed", detail);
      console.error("Fog Nudger — saving a wall edit failed", error);
    })
    .finally(() => {
      busy = false;
      // What is under the pointer, worked out against the graph as it is now.
      hovered = null;
      hoveredEdge = null;
      hoveredRegion = null;
      doorHover = null;
      toggleHover = null;
      dropSpan();
      if (lastPointer) hover({ ...lastPointer, perPixel: lastPerPixel, modifier: false });
      invalidate();
    });
}

function hover(point: MapPoint | null): void {
  const graph = editableGraph();
  if (!point || !graph) {
    if (
      hovered === null &&
      hoveredEdge === null &&
      !hoveredMend &&
      !hoveredCollapse &&
      !hoveredPrune &&
      hoveredRegion === null &&
      markTarget === null &&
      spanTarget === null &&
      doorHover === null &&
      toggleHover === null
    ) {
      return;
    }
    hovered = null;
    hoveredEdge = null;
    hoveredMend = false;
    hoveredCollapse = false;
    hoveredPrune = false;
    hoveredRegion = null;
    markTarget = null;
    doorHover = null;
    toggleHover = null;
    dropSpan();
    setGrabTarget(false);
    invalidate();
    return;
  }

  lastPerPixel = point.perPixel;
  lastPointer = { u: point.u, v: point.v, x: point.x, y: point.y };
  if (tool === "erase") {
    const found = nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel);
    if (found === hoveredEdge) return;
    hoveredEdge = found;
    setGrabTarget(found !== null);
    invalidate();
    return;
  }

  /*
    A crosshair everywhere, since a click anywhere acts. The picture changes as the pointer moves — a
    ghost mark follows it — so this repaints on a move, as a wall being drawn does, but not while it
    rests on one mark.
  */
  /*
    The wall a click would place, drawn before the click — searched once a frame, so the crosshair and
    the preview arrive together on the frame the search lands.
  */
  if (spans(tool)) {
    scheduleSpan(point);
    return;
  }

  // A crosshair over a door, whose marker is highlighted; the hand elsewhere.
  if (tool === "doorToggle") {
    const target = toggleTargetAt(graph, point);
    setGrabTarget(target !== null);
    const same =
      target?.graph === toggleHover?.graph && target?.edge === toggleHover?.edge && target?.door === toggleHover?.door;
    if (same) return;
    toggleHover = target;
    invalidate();
    return;
  }

  // A crosshair wherever a press would act, and what it would do drawn first; the hand elsewhere.
  if (tool === "door") {
    const target = doorTargetAt(
      graph,
      { x: point.x, y: point.y },
      LAND_RADIUS_PX * point.perPixel,
      GRAB_RADIUS_PX * point.perPixel,
    );
    setGrabTarget(target !== null);
    if (doorHover?.graph === graph && sameDoorTarget(target, doorHover.target)) return;
    if (target === null && doorHover === null) return;
    doorHover = target ? { target, graph } : null;
    invalidate();
    return;
  }

  if (tool === "drawChain") {
    const aim = drawPoint(
      graph,
      point.x,
      point.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    const would = chainClick(
      chain.map((placed) => placed.at),
      aim.at,
      aim.onNode,
      SNAP_RADIUS_PX * point.perPixel,
      LAND_RADIUS_PX * point.perPixel,
    );
    chainLanding = would.kind === "onSegment" ? would.point : null;
    if (chain.length === 0) {
      drawHover = drawPoint(
      graph,
      point.x,
      point.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    } else {
      const held = onMap(point);
      reach = drawPoint(
      graph,
      held.x,
      held.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    }
    setGrabTarget(true);
    invalidate();
    return;
  }

  if (tool === "eraseChain") {
    aimChain(graph, point);
    return;
  }

  if (tool === "suppressRegion") {
    const next = markTargetAt(point);
    setGrabTarget(true);
    if (sameMarkTarget(next, markTarget)) return;
    markTarget = next;
    invalidate();
    return;
  }

  /*
    A crosshair inside a region, where a press will dissolve it; the hand outside every region, where
    it pans. Repainted only when the region under the pointer changes — the highlight is the same
    picture everywhere inside one.
  */
  if (tool === "dissolve") {
    const found = regionUnder(graph, point);
    const unchanged =
      found?.graph === hoveredRegion?.graph && found?.dissolution.face === hoveredRegion?.dissolution.face;
    if (unchanged) return;
    hoveredRegion = found;
    setGrabTarget(found !== null);
    invalidate();
    return;
  }

  if (tool === "draw") {
    const landed = drawPoint(
      graph,
      point.x,
      point.y,
      SNAP_RADIUS_PX * point.perPixel,
      point.modifier,
      LAND_RADIUS_PX * point.perPixel,
    );
    // The far end keeps following even between clicks, which is what makes the two-click form
    // legible: the wall being drawn is on screen the whole time rather than only while a button is
    // held. With nothing started, the same point is what a press would place.
    if (anchor) reach = landed;
    const attachedBefore = drawHover?.onNode ?? null;
    drawHover = landed;
    /*
      Always, because in this tool a press always draws.

      It showed the pan hand except when over a vertex, which is wrong twice over: panning is the
      *secondary* action here and needs Ctrl, and the cursor was carrying a snap indication that
      belongs on the canvas. One rule across the three tools — a crosshair means the tool acts at
      this point, a hand means the surface moves.
    */
    setGrabTarget(true);
    /*
      Only when the picture would differ, which with nothing started is only when the attach target
      changes.

      Repainting on every mouse movement was a frame's work per event to draw the same thing, and a
      room felt it as lag. A wall in progress does have to repaint — its far end follows the cursor.
    */
    if (anchor || landed.onNode !== attachedBefore) invalidate();
    return;
  }

  if (tool === "prune") {
    const ringed = ringAt(currentPrunePieces().map((piece) => piece.points), point.x, point.y, point.perPixel);
    const edge =
      ringed === null ? nearestEdge(graph, { x: point.x, y: point.y }, ERASE_RADIUS_PX * point.perPixel) : null;
    const free = edge === null ? null : pieceAtFreeClick(edge);
    const key: number | "ring" | null = ringed !== null ? "ring" : edge !== null && free !== null ? edge : null;
    if (key !== hoveredPruneFreeKey) {
      hoveredPruneFreeKey = key;
      setHoveredFreePiece(ringed === null ? free : null);
      invalidate();
    }
    const over = key !== null;
    if (over !== hoveredPrune) {
      hoveredPrune = over;
      setGrabTarget(over);
    }
    return;
  }

  if (tool === "collapse") {
    // A crosshair inside a ring, where a press will act; the hand everywhere else, where it will pan.
    const ringed = ringAt(currentCollapses().map((c) => c.outline), point.x, point.y, point.perPixel);
    const free = ringed === null ? collapseAtPoint({ x: point.x, y: point.y }) : null;
    const key: number | "ring" | null = ringed !== null ? "ring" : free !== null ? free.face : null;
    if (key !== hoveredCollapseFreeKey) {
      hoveredCollapseFreeKey = key;
      setHoveredFreeCollapse(free);
      invalidate();
    }
    const over = key !== null;
    if (over !== hoveredCollapse) {
      hoveredCollapse = over;
      setGrabTarget(over);
    }
    return;
  }

  if (tool === "mend") {
    // A crosshair inside a ring, where a press will act; the hand everywhere else, where it will pan.
    const ringed = mendAt(currentMends(), point.x, point.y, point.perPixel);
    const end =
      ringed === null ? nearestNode(graph, { x: point.x, y: point.y }, SNAP_RADIUS_PX * point.perPixel) : null;
    const free = end === null ? null : mendForFreeClick(end);
    const key: number | "ring" | null = ringed !== null ? "ring" : end !== null && free !== null ? end : null;
    if (key !== hoveredMendFreeKey) {
      hoveredMendFreeKey = key;
      setHoveredFreeMend(ringed === null ? free : null);
      invalidate();
    }
    const over = key !== null;
    if (over !== hoveredMend) {
      hoveredMend = over;
      setGrabTarget(over);
    }
    return;
  }

  const found = grabAt(graph, point.x, point.y, GRAB_RADIUS_PX * point.perPixel)?.id ?? null;
  if (found === hovered) return;
  hovered = found;
  setGrabTarget(found !== null);
  invalidate();
}

/**
 * What the state line says once a mend is saved: how many went in. How many were still on offer went
 * with the text rules of 2026-09-29, which is why this is no longer worked out after the save.
 */
function mendedMessage(count: number): string {
  return `Mended ${count} gap${count === 1 ? "" : "s"}.`;
}

/**
 * Accept every mend on offer, as one edit and so one step of undo.
 *
 * The reason the search earns a button (user, 2026-09-16, as for the ink tool): on a map with many
 * small breaks, mending each by hand is the cost the search exists to remove.
 */
export function mendEveryGapShown(): void {
  if (busy || tool !== "mend") return;
  const graph = editableGraph();
  const mends: readonly Mend[] = graph ? currentMends() : [];
  if (!graph || mends.length === 0) {
    say("Nothing to mend.");
    return;
  }
  commit(applyMends(graph, mends), mendedMessage(mends.length), "mending multiple gaps", graph);
}

/**
 * A mend slider was released: search again, and say what it found. Silent when the tool is not in
 * hand, since there are no rings to change.
 */
export function refreshMends(): void {
  if (!mendSearchActive()) return;
  const found = refreshMendSearch();
  if (found !== null) say(describeMends(found));
  invalidate();
}

/**
 * What the state line says once small regions are collapsed: how many went. An early stop — which a
 * correct collapse cannot produce — is the log's and the console's, which say so in full.
 */
function collapsedMessage(count: number): string {
  return `Collapsed ${count} small region${count === 1 ? "" : "s"}.`;
}

/**
 * Collapse every ringed region still under the size, as one edit and so one step of undo — the
 * drawer's button.
 *
 * **Under the working indicator**, because on a dense map at the far right of the track it is not
 * quick: measured at 6 to 7.5 seconds on a mesh of 2,500 regions with the size at the whole map, and
 * a quarter of a second there at the starting size. The real maps tried so far have tens of regions.
 * `whileWorking` yields a painted frame before the work starts, which is the only way the indicator is
 * ever seen while a synchronous computation holds the thread.
 */
export function collapseEveryRegionShown(): void {
  if (busy || tool !== "collapse") return;
  const graph = editableGraph();
  const size = collapseSize();
  if (!graph || !size || currentCollapses().length === 0) {
    say("Nothing to collapse.");
    return;
  }
  busy = true;
  say("Collapsing…", "working");
  void whileWorking(() => collapseAll(graph, size)).then((all) => {
    busy = false;
    // A derive landing in the frames before the work started would have replaced the walls.
    if (editableGraph() !== graph) {
      say("Collapse failed: walls changed.", "bad");
      return;
    }
    // Every highlighted region grew past the size as its neighbours went; the highlights say so.
    if (all.collapsed === 0) {
      say("Nothing to collapse.");
      return;
    }
    if (all.stopped) {
      devLog("warn", `workspace: collapse all stopped after ${all.rounds} rounds — a round did not reduce the regions`);
      console.error(
        "Fog Nudger — collapsing every small region stopped early: a round left as many regions as it " +
          "found, which a correct collapse cannot do. The rounds before it were kept.",
        all,
      );
    }
    devLog(
      "info",
      `workspace: collapsed ${all.collapsed} small regions in ${all.rounds} rounds at ` +
        `${size.toExponential(2)} square graph units`,
    );
    commit(all, collapsedMessage(all.collapsed), "collapsing multiple small regions", graph);
  });
}

/** What the state line says once dead ends are pruned: how many pieces went. */
function prunedMessage(count: number): string {
  return `Pruned ${count} dead end${count === 1 ? "" : "s"}.`;
}

/**
 * Prune every piece ringed, as one edit and so one step of undo — the drawer's button.
 *
 * **Exactly what is ringed and drawn red**, because the pieces already carry the whole cascade
 * (`trace/prunePieces.ts`): there are no rounds to run and nothing a later round could add. Quick, so no
 * working indicator — it is the old amount's commit with the pieces named.
 */
export function pruneEveryDeadEndShown(): void {
  if (busy || tool !== "prune") return;
  const graph = editableGraph();
  const pieces = graph ? currentPrunePieces() : [];
  if (!graph || pieces.length === 0) {
    say("Nothing to prune.");
    return;
  }
  const length = pruneLength() ?? 0;
  devLog(
    "info",
    `workspace: pruned ${pieces.length} dead-end pieces ` +
      `(${pieces.reduce((total, piece) => total + piece.edges.length, 0)} segments) at ${length.toExponential(2)} graph units`,
  );
  commit(applyPrunePieces(graph, pieces), prunedMessage(pieces.length), "pruning multiple dead ends", graph);
}

/**
 * Put the wall tools' searches down without choosing another wall tool — for when the strip moves to a
 * tool outside the Walls band, which does not come through `setTool` here. Mend's and the small
 * regions' alike: a running search would go on re-running against every change to the walls with no
 * rings on screen to show for it.
 */
export function putDownSearches(): void {
  if (mendSearchActive()) {
    stopMendSearch();
    hoveredMend = false;
    hoveredMendFreeKey = null;
  }
  stopCollapseSearch();
  hoveredCollapse = false;
  hoveredCollapseFreeKey = null;
  stopPruneSearch();
  hoveredPrune = false;
  hoveredPruneFreeKey = null;
  invalidate();
}

/** Wire the tools up. The step declares that a drag means this; the shell offers it every press. */
export function registerWallEdit(): void {
  setMapDragHandler("edit", { start, move, end, cancel, hover, escape, rightClick });
}
