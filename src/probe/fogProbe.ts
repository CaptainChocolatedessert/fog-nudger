/**
 * Roadmap step 1 — validate the emit path in a room, with no pipeline.
 *
 * Places hand-built shapes on the networked scene and lets a human look at them. What the first
 * run settled (2026-08-06): our shapes render as fog rather than as drawings, propagate to players,
 * reveal correctly, carry holes under an even-odd fill, list properly in Outliner, and can be
 * selected and edited by hand. The design's core assumptions hold.
 *
 * What this second set is for:
 *
 * - **`fillOpacity`** — a revealed area kept a translucent tint of the fog colour, and a hand-drawn
 *   fog shape does not do that, so it is ours. `opaque` differs from `baseline` in fill opacity
 *   alone.
 * - **Wall attribution** — the first census reported a total, which was consistent with the split
 *   we expected *and* with splits we did not. Walls are now counted per parent shape (see
 *   `attributeByParent`), so "stroke width zero still makes walls" is measured rather than inferred.
 * - **Layer staging** — fog shapes ignore their own colour, so a proposal cannot be marked by
 *   appearance while it sits on the `FOG` layer. Staging proposals on another layer and moving them
 *   across when accepted would restore that. The open question is whether players see them while
 *   staged, which would leak the whole dungeon during prep; `staged` and `staged-hidden` differ in
 *   `visible` alone to answer it.
 */

import OBR, {
  buildPath,
  Command,
  type Item,
  type Layer,
  type Vector2,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import { attributeByParent, summariseItems } from "../itemCensus";
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

/**
 * Ignored entirely by fog rendering — confirmed in a room — and therefore useful twice over. It
 * still distinguishes a shape staged on a non-fog layer, and if a `FOG`-layer shape ever *does*
 * come out magenta, something has changed about how Owlbear treats them.
 */
const MAGENTA = "#ff00ff";

interface ProbeSpec {
  readonly label: string;
  readonly rings: (size: number) => readonly Ring[];
  readonly strokeWidth: (stroke: number) => number;
  readonly fillOpacity: number;
  readonly layer: Layer;
  readonly visible: boolean;
}

/**
 * Laid out in two rows of three. Each row varies one thing at a time against `baseline`; nothing
 * varies two.
 */
const SPECS: readonly ProbeSpec[] = [
  { label: "baseline", rings: (s) => [squareRing(s)], strokeWidth: (w) => w, fillOpacity: 0.5, layer: "FOG", visible: true },
  { label: "hairline", rings: (s) => [squareRing(s)], strokeWidth: () => 0, fillOpacity: 0.5, layer: "FOG", visible: true },
  { label: "holed", rings: (s) => squareWithHoleRings(s, s / 3), strokeWidth: (w) => w, fillOpacity: 0.5, layer: "FOG", visible: true },
  { label: "opaque", rings: (s) => [squareRing(s)], strokeWidth: (w) => w, fillOpacity: 1, layer: "FOG", visible: true },
  { label: "staged", rings: (s) => [squareRing(s)], strokeWidth: (w) => w, fillOpacity: 0.5, layer: "DRAWING", visible: true },
  { label: "staged-hidden", rings: (s) => [squareRing(s)], strokeWidth: (w) => w, fillOpacity: 0.5, layer: "DRAWING", visible: false },
];

const COLUMNS = 3;

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

  // Centred on what the GM is currently looking at, so they are found without hunting. Placement in
  // world space is roadmap step 7's problem, not this one's.
  const rows = Math.ceil(SPECS.length / COLUMNS);
  const originX = centre.x - (spacing * (COLUMNS - 1)) / 2;
  const originY = centre.y - (spacing * (rows - 1)) / 2;

  const items = SPECS.map((spec, index) =>
    pathItem(spec, size, stroke, {
      x: originX + spacing * (index % COLUMNS),
      y: originY + spacing * Math.floor(index / COLUMNS),
    }),
  );

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

  const ours = await ourItems();
  if (ours.length === 0) return "Nothing of ours in the scene to remove.";

  await OBR.scene.items.deleteItems(ours.map((item) => item.id));
  devLog("info", `probe: removed ${ours.length} shapes`);
  return `Removed ${ours.length} shapes.`;
}

/**
 * Report what is in the scene, what is in this client's local set, and which of our shapes produced
 * which walls.
 *
 * Fires unconditionally and reports in every case, including the boring one — a census that only
 * spoke when something was wrong could not tell "no walls were derived" from "the census never
 * ran". Both item sets are reported because Dynamic Fog's walls live only in the local one, which
 * is the finding this census style came from.
 */
export async function logCensus(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const [networked, local, ours] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.local.getItems(),
    ourItems(),
  ]);

  const networkedSummary = summariseItems(networked);
  const localSummary = summariseItems(local);

  // Per shape, not as a total. A total is consistent with the split we expect and with splits we do
  // not, so it cannot settle what it was run to settle.
  const walls = local.filter((item) => item.type === "WALL");
  const perShape = attributeByParent(
    walls,
    ours.map((item) => ({ id: item.id, label: labelOf(item) })),
  );

  devLog("info", `census — networked: ${networkedSummary}`);
  devLog("info", `census — local:     ${localSummary}`);
  devLog("info", `census — walls by parent: ${perShape}`);

  return `Walls by shape: ${perShape}. (networked ${networkedSummary}; local ${localSummary})`;
}

/**
 * Dump the full style of every `FOG`-layer item, ours and the GM's alike.
 *
 * Reconnaissance rather than a test. A hand-drawn fog shape does not leave the tint ours does, so
 * the difference is in a property we set — and reading Owlbear's own values beats guessing at which
 * one, field by field.
 */
export async function inspectFogShapes(): Promise<string> {
  if (!(await OBR.scene.isReady())) return "No scene open.";

  const fogItems = await OBR.scene.items.getItems((item) => item.layer === "FOG");
  if (fogItems.length === 0) {
    return "No FOG-layer items at all — draw one by hand to compare against.";
  }

  let theirs = 0;
  for (const item of fogItems) {
    const ours = PROBE_KEY in item.metadata;
    if (!ours) theirs += 1;
    devLog(
      "info",
      `fog item [${ours ? labelOf(item) : "GM-drawn"}]`,
      `type=${item.type}`,
      `visible=${item.visible}`,
      `zIndex=${item.zIndex}`,
      `fillRule=${(item as { fillRule?: unknown }).fillRule ?? "n/a"}`,
      `style=`,
      (item as { style?: unknown }).style ?? "n/a",
    );
  }

  return `Logged ${fogItems.length} fog items (${theirs} not ours). Compare the styles in dev.log.`;
}

function ourItems(): Promise<Item[]> {
  return OBR.scene.items.getItems((item) => PROBE_KEY in item.metadata);
}

function labelOf(item: Item): string {
  const label = item.metadata[PROBE_KEY];
  return typeof label === "string" ? label : "unlabelled";
}

function pathItem(
  spec: ProbeSpec,
  size: number,
  stroke: number,
  position: Vector2,
): Item {
  return buildPath()
    .commands(toSdkCommands(ringsToCommands(spec.rings(size))))
    // Even-odd, so a hole is a hole regardless of which way its ring winds. Dynamic Fog maps
    // anything that is not "nonzero" onto Skia's even-odd fill type, so this matches on both sides.
    .fillRule("evenodd")
    .fillColor(MAGENTA)
    .fillOpacity(spec.fillOpacity)
    .strokeColor(MAGENTA)
    .strokeOpacity(1)
    .strokeWidth(spec.strokeWidth(stroke))
    .layer(spec.layer)
    .visible(spec.visible)
    .position(position)
    // Named for Outliner. Sixty of these will eventually land in one scene, so whether they are
    // legible in a list is a real question and not a cosmetic one.
    .name(`Fog Nudger probe — ${spec.label}`)
    .metadata({ [PROBE_KEY]: spec.label })
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
