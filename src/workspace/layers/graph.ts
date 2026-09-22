/**
 * The graph layer: the walls, and — where they can be grabbed — a handle at every point in them.
 *
 * **Always drawn, from one of two sources.** When the stored graph carries hand edits — or nothing has
 * been derived yet — it is the stored document; otherwise it is the current derivation, fitted
 * exactly as a first edit would adopt it. `regions.ts` decides which, in the one predicate the rooms
 * layer reads too, so the walls and the rooms can never be drawn from different graphs.
 *
 * **Handles only for the tools that use them** — Move, Draw and Erase. With anything else in hand a
 * dot at every vertex is decoration that hides the walls, and a handle that moves nothing would be a
 * lie about what is there, which is the same rule that hides one on an orphaned vertex.
 *
 * (This described two modes, the ink mode's graph with no handles and the editor's with all of them.
 * There has been one surface since 2026-09-14, and the tool in hand decides the handles.)
 *
 * ## Graph units, so there is no raster to agree with
 *
 * The wall graph is stored in graph units, where the map image's longer side is 1 — and the shell
 * draws the map at the image's own aspect. So a point multiplies by the **longer drawn side** and
 * lands where it belongs, on both axes, with no scale factor to derive and no raster to be consistent
 * with.
 *
 * ## Cased lines, learned the expensive way
 *
 * A wall here is a *centreline*, so by construction it lies exactly on top of the map's own
 * linework. The first wall lines this project drew were near-black, and a room reported "no stubs or
 * bridges showing" when all twenty-two were on screen. A saturated core over a light casing is what
 * reads against dark ink and pale paper alike, which is the only pair of backgrounds a wall is drawn
 * against.
 *
 * Blue, the palette's structure colour. It used to be argued against the rooms layer's red wall
 * lines, which were removed on 2026-09-15; the reason that stands is the palette's own, that red is
 * reserved for what is about to be destroyed.
 */

import type { Vector2 } from "@owlbear-rodeo/sdk";

import {
  nodeDegrees,
  spurEdgesToPrune,
  type DoomedSpurs,
  type WallGraph,
} from "../../trace/wallGraph";
import { colourFor } from "../palette";
import { addPainter, type Painter } from "../shell";
import { graphOnScreen } from "../regions";
import { pendingPrune } from "../wallAmounts";
import { currentTool } from "../toolPalette";

/**
 * The tools a handle is for.
 *
 * **It was the tools that grab a point**, which is why Mend, Dissolve region, Suppress region and
 * Span are still absent: none of them takes hold of a vertex, so a dot at every one would be
 * decoration over the marks those tools do draw.
 *
 * **The two amounts joined on 2026-09-21** (user: *"we need to see vertices for both tools"*), and
 * they grab nothing — so the rule this set states is now *the tools whose work is at the vertices*.
 * Straightening drops the ones between a run's ends, and pruning takes whole runs and the handles
 * are what makes a few red pixels legible at map zoom. Both are about points even though neither
 * aims at one.
 */
const WALL_TOOLS = new Set(["move", "draw", "erase", "straighten", "prune"]);
import type { DrawPoint } from "../dragGesture";
import {
  dissolvingWalls,
  pendingSpan,
  draggedNode,
  hoveredNode,
  hoveredWall,
  pendingPoint,
  pendingWall,
  snapTarget,
} from "../wallEdit";

/** The palette's structure colour, kept distinct from the six room colours. */
const wallColour = () => colourFor("structure");
/**
 * What pruning would take, in the colour this canvas already uses for "about to go".
 *
 * The same red the erase tool marks a wall with, deliberately: both answer *what does the thing I am
 * about to do remove*, and giving them two colours would invent a distinction a GM has to learn. It
 * is drawn at the wall's own width rather than the erase highlight's, because there can be hundreds
 * of them and a thickened red would swamp the picture it is meant to be read against.
 */
const doomedColour = () => colourFor("destructive");
const WALL_CASING = colourFor("casing");
/** Screen pixels. A hairline over busy map art is not a wall anybody can judge or aim at. */
const WALL_WIDTH_PX = 2;

const HANDLE_FILL = colourFor("casing");
const handleRim = () => colourFor("structure");
const HANDLE_RADIUS = 3;

/**
 * The three states a handle can be in beyond ordinary, and they say different things.
 *
 * **Grabbable** is the answer to a question nobody can otherwise ask: a press either moves a vertex
 * or pans, and without this the GM finds out which by doing it. **Moving** marks the one point the
 * gesture is carrying. **Joining** is the one §8 actually demands — the boundary has to be visible
 * *before* it is crossed, so the target changes colour and grows while there is still a chance to
 * move away or hold Shift. (This said a merge "is not undoable"; undo reaches it now, and the rule
 * stands on the better reason, which is that Undo only helps a GM who noticed what the release did.)
 */
const HOVER_RADIUS = 5;
const ACTIVE_FILL = "#ffcc00";
const mergeFill = () => colourFor("additive");
const ACTIVE_RIM = "#20242c";
const MERGE_RADIUS = 6;

/**
 * The wall about to be erased, and the wall about to be drawn.
 *
 * Both are the §8 rule doing the same job in two places: an erase removes a wall and a drawn wall
 * changes which rooms exist, so what is about to happen is on screen before the click that does it.
 * It said an erase "cannot be undone", which stopped being true when undo arrived; the rule stands on
 * the better reason, which is that Undo only helps a GM who noticed what went.
 *
 * The palette's destructive colour for the one that removes and its additive colour for the one that
 * adds. **Not red against green**, which this used to say was the one pair a colour can carry without
 * being learned: it is the classic pair a colour-vision deficiency cannot separate, and the palette
 * folded "adds" into the additive family for exactly that reason. Both are read from the palette, so
 * the actual hues are whatever the GM has set.
 */
const eraseColour = () => colourFor("destructive");
const ERASE_WIDTH_PX = 5;
const drawColour = () => colourFor("additive");

/**
 * Past this many handles *on screen*, none are drawn.
 *
 * A real map's graph is thousands of points, and every one of them at zoom-out is a wash of dots
 * that hides the walls the handles are meant to sit on. The cap is on what is visible rather than on
 * the graph's size, which is the difference that matters: zooming in to work on a room brings the
 * handles back, and zooming out to judge the whole map leaves the linework readable. The state line
 * carries the total, so nothing is silently missing.
 */
const MAX_HANDLES = 2000;

/** Degrees are derived per graph rather than per frame; the graph only changes on an edit. */
let degreesOf: number[] = [];
let degreesFor: WallGraph | null = null;

function degrees(graph: WallGraph): number[] {
  if (degreesFor !== graph) {
    degreesOf = nodeDegrees(graph);
    degreesFor = graph;
  }
  return degreesOf;
}

/**
 * The graph on screen, which `regions.ts` decides.
 *
 * Asked once per frame rather than held, so nothing has to be told when a derive lands or a gesture
 * writes. It used to repeat the saved-versus-derived predicate here; it delegates now, because a
 * *substitution* — Straighten previewing its result — has to reach the walls and the room fills
 * together, and two copies of the answer is how those come apart.
 */
function graphOnCanvas(): WallGraph | null {
  return graphOnScreen();
}

/**
 * The doomed set, remembered between frames.
 *
 * A canvas redraws for every pan, zoom and hover, and none of those changes which walls a limit
 * would take. Recomputing per frame is a run walk plus a cascade — cheap on a real graph and pure
 * waste sixty times a second. Keyed on the graph object and the limit, both of which are replaced
 * rather than mutated when they change.
 */
let doomedFor: { graph: WallGraph; limit: number; doomed: DoomedSpurs } | null = null;

function doomed(graph: WallGraph): DoomedSpurs {
  /*
    Only while the graph on screen **is** the graph the pruning would act on.

    The Walls drawer's two amounts share one pinned base. Straightening substitutes its result onto the
    canvas, and the runs a prune would take are already absent from that result — so marking them would
    claim the press removes walls that are not in the picture. Pruning alone substitutes nothing, which
    is exactly the case this is for, and the identity test is what tells the two apart.

    (It used to ask `showingSaved()`, on the ground that a fresh derivation already had the limit
    applied because the trace pruned as it built. Since 2026-09-18 the limit is an amount a GM presses,
    which no derive applies — the derive's own automatic prune, since 2026-09-21, is a fixed two ink
    widths and is not this — so that condition would hide the marks on every unedited map.)
  */
  const pending = pendingPrune();
  if (!pending || pending.base !== graph) return NOTHING_DOOMED;
  const limit = pending.limit;

  if (doomedFor && doomedFor.graph === graph && doomedFor.limit === limit) return doomedFor.doomed;
  const found = spurEdgesToPrune(graph, limit);
  doomedFor = { graph, limit, doomed: found };
  return found;
}

const NOTHING_DOOMED: DoomedSpurs = {
  edges: new Set<number>(),
  vertices: new Set<number>(),
  anchors: new Set<number>(),
  runs: 0,
  length: 0,
  rounds: 0,
};

const paint: Painter = ({ context, view, drawWidth, drawHeight }) => {
  const graph = graphOnCanvas();
  if (!graph || graph.edges.length === 0) return;

  // Graph units to screen: the longer drawn side is one unit on both axes.
  const long = Math.max(drawWidth, drawHeight);
  const x = (units: number): number => view.x + units * long;
  const y = (units: number): number => view.y + units * long;

  /*
    Where a vertex is *drawn*, which during a drag is not where it is stored.

    The gesture holds the position it would land on and nothing is written to the graph until the
    release. So the walls follow the cursor by substituting one coordinate here, at no cost beyond
    the redraw — no graph rebuilt per frame, and no crossing sweep per frame either.
  */
  const dragged = draggedNode();
  const at = (id: number): Vector2 | undefined =>
    dragged !== null && id === dragged.id ? dragged.at : graph.nodes[id];

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  // One path for every wall, stroked twice: the casing first, then the core over it.
  context.beginPath();
  for (const edge of graph.edges) {
    const from = at(edge.a);
    const to = at(edge.b);
    if (!from || !to) continue;
    context.moveTo(x(from.x), y(from.y));
    context.lineTo(x(to.x), y(to.y));
  }
  context.strokeStyle = WALL_CASING;
  context.lineWidth = WALL_WIDTH_PX + 2;
  context.stroke();
  context.strokeStyle = wallColour();
  context.lineWidth = WALL_WIDTH_PX;
  context.stroke();

  /*
    The walls the prune button would delete, marked while the slider moves rather than reported after.

    Pruning is destructive — Undo takes it back, but only if the GM noticed what went, which is the
    point of showing it first — and the standing rule is that a control which can be wrong needs a
    visual channel *before* it is used. A limit is also not a number anybody can picture on their own
    map — the same setting takes four hairs off one and a third of the walls off another — so the only
    honest way to choose one is to see what it would take.

    Drawn **over** the ordinary walls and under everything interactive, so a doomed wall reads as a
    wall that has been marked rather than as a different kind of thing.
  */
  const going = doomed(graph);
  if (going.edges.size > 0) {
    context.beginPath();
    for (const index of going.edges) {
      const edge = graph.edges[index];
      const from = edge ? at(edge.a) : undefined;
      const to = edge ? at(edge.b) : undefined;
      if (!from || !to) continue;
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
    }
    context.strokeStyle = doomedColour();
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
  }

  // The wall a click would erase, marked before it goes rather than reported after.
  const erasing = hoveredWall();
  if (erasing !== null) {
    const edge = graph.edges[erasing];
    const from = edge ? at(edge.a) : undefined;
    const to = edge ? at(edge.b) : undefined;
    if (from && to) {
      context.beginPath();
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
      context.strokeStyle = eraseColour();
      context.lineWidth = ERASE_WIDTH_PX;
      context.stroke();
    }
  }

  /*
    The walls a click would remove by dissolving the region under the pointer, in Erase's colour and
    at Erase's width, because it is the same act on more walls.

    Only against the graph they were found on: the indices name walls in that graph and no other, and
    a derive landing between the hover and this frame would otherwise mark a scatter of unrelated ones.
  */
  const dissolving = dissolvingWalls();
  if (dissolving !== null && dissolving.graph === graph) {
    context.beginPath();
    for (const index of dissolving.edges) {
      const edge = graph.edges[index];
      const from = edge ? at(edge.a) : undefined;
      const to = edge ? at(edge.b) : undefined;
      if (!from || !to) continue;
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
    }
    context.strokeStyle = eraseColour();
    context.lineWidth = ERASE_WIDTH_PX;
    context.stroke();
  }

  /*
    The wall being drawn, following the cursor.

    Dashed, because it is the one line on this canvas that is not there yet — every other stroke
    describes something the document already holds, and a solid rubber band would claim the same
    standing as a wall that exists.
  */
  /*
    The wall a Span click would place, drawn as a wall being drawn is — dashed, because it is not there
    yet, and in the additive colour, because it would be put in. Both ends are marked as attaching:
    a span always lands on a wall, and placing it shares a vertex there.

    Only against the graph it was found on, as the dissolve highlight is.
  */
  const spanning = pendingSpan();
  if (spanning !== null && spanning.graph === graph) {
    const { from, to } = spanning.span;
    context.save();
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(x(from.at.x), y(from.at.y));
    context.lineTo(x(to.at.x), y(to.at.y));
    context.strokeStyle = WALL_CASING;
    context.lineWidth = WALL_WIDTH_PX + 2;
    context.stroke();
    context.strokeStyle = drawColour();
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
    context.setLineDash([]);
    for (const end of [from, to]) {
      context.beginPath();
      context.arc(x(end.at.x), y(end.at.y), MERGE_RADIUS, 0, Math.PI * 2);
      context.fillStyle = mergeFill();
      context.fill();
      context.strokeStyle = ACTIVE_RIM;
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }

  const pending = pendingWall();
  if (pending) {
    context.save();
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(x(pending.from.at.x), y(pending.from.at.y));
    context.lineTo(x(pending.to.at.x), y(pending.to.at.y));
    context.strokeStyle = WALL_CASING;
    context.lineWidth = WALL_WIDTH_PX + 2;
    context.stroke();
    context.strokeStyle = drawColour();
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
    context.restore();
  }

  // The walls the gesture is carrying, over the rest, so what is moving is never in doubt.
  if (dragged !== null) {
    context.beginPath();
    for (const edge of graph.edges) {
      if (edge.a !== dragged.id && edge.b !== dragged.id) continue;
      const from = at(edge.a);
      const to = at(edge.b);
      if (!from || !to) continue;
      context.moveTo(x(from.x), y(from.y));
      context.lineTo(x(to.x), y(to.y));
    }
    context.strokeStyle = ACTIVE_FILL;
    context.lineWidth = WALL_WIDTH_PX;
    context.stroke();
  }

  /*
    Handles follow the **tool**, not a mode.

    A handle is the grab target rather than part of the graph: with a brush or a pan in hand it is a
    dot that cannot be used, several hundred times over. Drawing them only for the tools that can act
    on them is what stops the resting state being the dense one — and it is the same rule the gap
    rings follow.
  */
  /*
    **Both sets, and only for the drawing.** The vertices that go, plus the junctions the doomed runs
    hang off — which stay exactly where they are, and are marked anyway because a stub worth pruning
    is a few pixels long and two red handles either end of it are far easier to catch than one.

    Kept apart in `spurEdgesToPrune` rather than merged there, so the operation and the log still
    read the honest set. This is the one place that over-claims, and it does it deliberately.
  */
  if (WALL_TOOLS.has(currentTool())) {
    paintHandles(context, graph, x, y, at, new Set([...going.vertices, ...going.anchors]));
  }
  context.restore();
};

/**
 * A handle at every point of the graph — in **screen** space, so it stays grabbable at any zoom.
 *
 * The same argument as the gap rings: a point is a single position with a whole map on the canvas,
 * and a mark that scales with the zoom disappears at exactly the moment it is wanted. A handle has a
 * second reason on top of that one — it is what the drag gesture aims at, and a target that changes
 * size under the cursor as the GM zooms is a target they have to re-learn.
 *
 * **A point with no walls gets no handle.** Merging two vertices leaves the folded one in the table
 * unreferenced rather than renumbering, because renumbering would invalidate every id the caller
 * holds. Those are bookkeeping, not geometry, and a handle you can grab that moves nothing would be
 * a lie about what is there.
 */
function paintHandles(
  context: CanvasRenderingContext2D,
  graph: WallGraph,
  x: (units: number) => number,
  y: (units: number) => number,
  at: (id: number) => Vector2 | undefined,
  /**
   * Vertices pruning would take, drawn red like the walls they belong to.
   *
   * A stub is short, so a red *line* a few pixels long is easy to miss against the linework it sits
   * on (room, 2026-09-07). Its handles are the part that reads at a glance, and they are already
   * drawn — so marking them costs nothing and is what makes the preview legible at map zoom.
   *
   * **The junctions are marked too, since 2026-09-21** (user): *"when a stub turns red, its base
   * vertex should, too, even though it's not actually disappearing."* This used to take only the
   * vertices that actually go, on the argument that marking the junction would be the preview lying
   * about the one thing it is for — and a room weighed that against seeing a two-pixel stub at all,
   * and chose seeing it.
   *
   * **The over-claim is confined to this argument.** `spurEdgesToPrune` still separates the two, so
   * the operation and the log read the set that is true; the caller unions them.
   */
  doomedVertices: ReadonlySet<number>,
): void {
  const degree = degrees(graph);
  const width = context.canvas.width;
  const height = context.canvas.height;
  const onScreen = (px: number, py: number): boolean =>
    px >= -HANDLE_RADIUS &&
    py >= -HANDLE_RADIUS &&
    px <= width + HANDLE_RADIUS &&
    py <= height + HANDLE_RADIUS;

  let visible = 0;
  for (let id = 0; id < graph.nodes.length; id++) {
    if ((degree[id] ?? 0) === 0) continue;
    const node = graph.nodes[id]!;
    if (onScreen(x(node.x), y(node.y))) visible += 1;
    if (visible > MAX_HANDLES) return;
  }

  const dragged = draggedNode();
  const snap = snapTarget();
  const hover = hoveredNode();

  const dot = (px: number, py: number, radius: number, fill: string, rim: string): void => {
    context.fillStyle = fill;
    context.strokeStyle = rim;
    context.beginPath();
    context.arc(px, py, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  };

  context.lineWidth = 1.5;
  for (let id = 0; id < graph.nodes.length; id++) {
    if ((degree[id] ?? 0) === 0) continue;
    // The three marked states are drawn afterwards, over everything, so a handle they overlap
    // cannot cover them.
    if (id === dragged?.id || id === snap) continue;
    const node = graph.nodes[id]!;
    const px = x(node.x);
    const py = y(node.y);
    if (!onScreen(px, py)) continue;
    const grabbable = id === hover;
    const going = doomedVertices.has(id);
    dot(
      px,
      py,
      grabbable ? HOVER_RADIUS : HANDLE_RADIUS,
      going ? doomedColour() : HANDLE_FILL,
      going ? doomedColour() : handleRim(),
    );
  }

  if (dragged !== null) {
    const point = at(dragged.id);
    if (point) dot(x(point.x), y(point.y), HOVER_RADIUS, ACTIVE_FILL, ACTIVE_RIM);
  }
  // Last and largest: this is the one mark that has to be seen before the gesture ends, because a
  // merge is what release would do and it cannot be taken back.
  if (snap !== null) {
    const point = graph.nodes[snap];
    if (point) dot(x(point.x), y(point.y), MERGE_RADIUS, mergeFill(), ACTIVE_RIM);
  }

  /*
    Either end of a wall being drawn, marked green where it would **attach**.

    Attaching is the whole difference between a wall that closes a gap and one that merely ends
    near it — a shared vertex is joined for ever, two coincident points agree until one moves. So the
    two states are drawn differently rather than left for the GM to infer from the position.
  */
  /*
    A mark where a drawn end would **attach**, and nowhere else.

    Attaching is the whole difference between closing a gap and drawing a line that merely ends
    near one, and it is decided before the press — so it has to be visible then, which the cursor
    cannot say. A crosshair means "the tool acts here", not "and it will join that".

    **Nothing is drawn under the cursor when it would not attach** (user, 2026-09-05). A dot that
    simply follows the pointer says only where the pointer is, which the pointer already says, and
    it sits in the middle of the thing being aimed at — the same fault the grab cursor had. The
    fixed end of a wall in progress is different and is always marked: it is not under the cursor,
    and where a wall began and whether it caught is worth seeing while the far end moves.
  */
  const pending = pendingWall();
  const marks: DrawPoint[] = [];
  if (pending) {
    marks.push(pending.from);
    if (pending.to.onNode !== null) marks.push(pending.to);
  } else {
    const next = pendingPoint();
    if (next && next.onNode !== null) marks.push(next);
  }

  for (const point of marks) {
    const attaching = point.onNode !== null;
    dot(
      x(point.at.x),
      y(point.at.y),
      attaching ? MERGE_RADIUS : HOVER_RADIUS,
      attaching ? mergeFill() : ACTIVE_FILL,
      ACTIVE_RIM,
    );
  }
}

/** Wire the layer up. Registered after the regions, so the graph sits over the rooms it makes. */
export function registerGraphLayer(): void {
  addPainter("graph", paint);
}
