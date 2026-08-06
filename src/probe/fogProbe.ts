/**
 * Roadmap step 1 — validate the emit path in a room, with no pipeline.
 *
 * Places a handful of hand-built shapes on the `FOG` layer of the networked scene and lets a human
 * look at them. It answers OQ1–OQ5 in `DESIGN.md` §6, and a failure in the first three is a
 * redesign rather than a bug, which is why this comes before any pipeline exists.
 *
 * Each shape isolates one variable:
 *
 * - **baseline** — a filled `PATH` with a visible stroke. Does it render as revealable fog; can a
 *   GM select and edit it; does it appear usefully in Outliner; does Dynamic Fog wall its edge.
 * - **hairline** — identical but `strokeWidth: 0`. The only difference from baseline, so any
 *   difference in the walls Dynamic Fog derives is attributable to the stroke width and nothing
 *   else. This matters because zero is a plausible default for a filled region, and it could
 *   silently produce no walls while the fog itself looks perfect.
 * - **holed** — a room with a pillar, as two same-wound rings under an even-odd fill rule.
 * - **control** — a `SHAPE` rather than a `PATH`, otherwise the same. Only interesting if the
 *   `PATH` cases fail: it separates "fog shapes do not work this way" from "paths do not".
 *
 * The fill colour is deliberately **magenta**. If the shapes render magenta they are being drawn as
 * ordinary drawings; if they take the scene's fog colour they are being treated as fog. Without a
 * distinctive colour those two outcomes could look the same, which is the diagnostic failure this
 * project has a standing warning about.
 */

import OBR, {
  buildPath,
  buildShape,
  Command,
  type Item,
  type Vector2,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { summariseItems } from "../itemCensus";
import {
  PathOp,
  ringsToCommands,
  squareRing,
  squareWithHoleRings,
  type PathCommandLike,
  type Ring,
} from "./fogProbeGeometry";

/**
 * Compile-time assertion that the numbers mirrored in `fogProbeGeometry` still match the SDK's
 * enum. That module cannot import the enum — it is a runtime value, and importing it would drag the
 * SDK into a node test and kill it. This is the cheap guard: if Owlbear ever renumbers `Command`,
 * the build breaks here instead of the probe silently emitting a path made of the wrong opcodes.
 */
const _pathOpsMatchSdk: [Command.MOVE, Command.LINE, Command.CLOSE] = [
  PathOp.MOVE,
  PathOp.LINE,
  PathOp.CLOSE,
];
void _pathOpsMatchSdk;

const NAMESPACE = "io.github.captainchocolatedessert.fog-nudger";

/** Marks an item as ours, so removal never touches anything the GM drew. */
export const PROBE_KEY = `${NAMESPACE}/probe`;

const MAGENTA = "#ff00ff";

/** Place the probe shapes into the current scene. */
export async function placeProbeShapes(): Promise<string> {
  if (!(await OBR.scene.isReady())) {
    return "No scene open — nothing to place shapes in.";
  }

  const dpi = await OBR.scene.grid.getDpi();
  const centre = await viewportCentre();

  const size = dpi * 3;
  const spacing = dpi * 4;
  const stroke = Math.max(2, Math.round(dpi / 16));

  // Laid out left to right across the middle of what the GM is currently looking at, so they are
  // found without hunting. Placement in world space is roadmap step 7's problem, not this one's.
  const left = centre.x - spacing * 1.5;
  const at = (index: number): Vector2 => ({ x: left + spacing * index, y: centre.y });

  const items: Item[] = [
    pathItem("baseline", [squareRing(size)], at(0), stroke),
    pathItem("hairline", [squareRing(size)], at(1), 0),
    pathItem("holed", squareWithHoleRings(size, size / 3), at(2), stroke),
    shapeItem("control", at(3), size, stroke),
  ];

  await OBR.scene.items.addItems(items);
  devLog(
    "info",
    `probe: placed ${items.length} shapes at`,
    `(${Math.round(centre.x)}, ${Math.round(centre.y)})`,
    `dpi=${dpi} size=${size} stroke=${stroke}`,
  );

  return `Placed ${items.length} shapes. Give Dynamic Fog a moment, then take a census.`;
}

/** Remove only the items this probe created. */
export async function removeProbeShapes(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const ours = await OBR.scene.items.getItems((item) => PROBE_KEY in item.metadata);
  if (ours.length === 0) return "Nothing of ours in the scene to remove.";

  await OBR.scene.items.deleteItems(ours.map((item) => item.id));
  devLog("info", `probe: removed ${ours.length} shapes`);
  return `Removed ${ours.length} shapes.`;
}

/**
 * Report what is in the scene and in this client's local set.
 *
 * Fires unconditionally and reports in every case, including the boring one — a census that only
 * spoke when something was wrong could not tell "no walls were derived" from "the census never
 * ran". Both sets are reported because Dynamic Fog's walls live only in the local one, which is the
 * finding this whole census style came from.
 */
export async function logCensus(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const [networked, local] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.local.getItems(),
  ]);

  const networkedSummary = summariseItems(networked);
  const localSummary = summariseItems(local);

  devLog("info", `census — networked: ${networkedSummary}`);
  devLog("info", `census — local:     ${localSummary}`);

  // Called out separately because it is the answer to OQ4 and the one number worth reading off the
  // panel rather than the log. It is also inside the local summary above, deliberately — two views
  // of the same fact cannot drift apart without it being obvious.
  const walls = local.filter((item) => item.type === "WALL").length;
  const wallNote = walls > 0 ? `${walls} local walls` : "no local walls";

  return `Networked: ${networkedSummary}. Local: ${localSummary}. (${wallNote})`;
}

function pathItem(
  label: string,
  rings: readonly Ring[],
  position: Vector2,
  strokeWidth: number,
): Item {
  return buildPath()
    .commands(toSdkCommands(ringsToCommands(rings)))
    // Even-odd, so a hole is a hole regardless of which way its ring winds. Dynamic Fog maps
    // anything that is not "nonzero" onto Skia's even-odd fill type, so this matches on both sides.
    .fillRule("evenodd")
    .fillColor(MAGENTA)
    .fillOpacity(0.5)
    .strokeColor(MAGENTA)
    .strokeOpacity(1)
    .strokeWidth(strokeWidth)
    .layer("FOG")
    .position(position)
    // Named for Outliner (OQ3). Sixty of these will eventually land in one scene, so whether they
    // are legible in a list is a real question and not a cosmetic one.
    .name(`Fog Nudger probe — ${label}`)
    .metadata({ [PROBE_KEY]: label })
    .build();
}

function shapeItem(
  label: string,
  position: Vector2,
  size: number,
  strokeWidth: number,
): Item {
  return buildShape()
    .shapeType("RECTANGLE")
    .width(size)
    .height(size)
    .fillColor(MAGENTA)
    .fillOpacity(0.5)
    .strokeColor(MAGENTA)
    .strokeOpacity(1)
    .strokeWidth(strokeWidth)
    .layer("FOG")
    .position(position)
    .name(`Fog Nudger probe — ${label}`)
    .metadata({ [PROBE_KEY]: label })
    .build();
}

/**
 * The single boundary where locally-built commands become the SDK's type. Safe because of the
 * compile-time assertion above; a cast without that guard would be a silent hazard.
 */
function toSdkCommands(commands: PathCommandLike[]): Parameters<
  ReturnType<typeof buildPath>["commands"]
>[0] {
  return commands as Parameters<ReturnType<typeof buildPath>["commands"]>[0];
}

/** The world point at the middle of what this client is currently looking at. */
async function viewportCentre(): Promise<Vector2> {
  try {
    const [width, height] = await Promise.all([
      OBR.viewport.getWidth(),
      OBR.viewport.getHeight(),
    ]);
    return await OBR.viewport.inverseTransformPoint({ x: width / 2, y: height / 2 });
  } catch (error) {
    // Falling back to the origin is survivable — the shapes exist and can be found — but it is a
    // different situation from landing where the GM is looking, and silence would hide which
    // happened when they go hunting for shapes that are not on screen.
    devLog("warn", "probe: could not read viewport, placing at origin", describeError(error));
    return { x: 0, y: 0 };
  }
}
