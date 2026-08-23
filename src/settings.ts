/**
 * The knobs a GM can turn, and the two stages they belong to.
 *
 * ## Why the split is architectural rather than cosmetic
 *
 * The binary mask determines the partition **completely**. Connected-component labelling has one
 * choice in it — the connectivity pairing — and that is forced by the diagonal-leak paradox, so it
 * is a correctness requirement rather than a knob. Nothing downstream of the mask can split or join
 * a region: the minimum-area filter only *deletes*, simplification is bounded below half an ink
 * width so it cannot change topology, and tracing and placement are exact.
 *
 * So every parameter that decides *what the rooms are* acts on the mask, and every parameter that
 * acts after it is either a filter or a finish. That is the whole reason for two stages:
 *
 * - **Reading the map** — what is a wall. Changing any of these recomputes the partition wholesale,
 *   which by construction discards anything the GM has edited by hand.
 * - **Editing the regions** — what the GM wants, which no amount of mask work can express: merge
 *   these two because they are one room to me, do not fog that at all, show me the proposals
 *   differently while I judge them.
 *
 * The ordering is therefore forced, not advisory: stage one destroys stage two's work every time it
 * runs. DESIGN.md §9 step 9 has carried "a re-run destroys hand edits" as an open problem; the
 * answer is not to engineer around it but to make the sequence visible.
 *
 * ## Everything is validated, because nothing here is trusted
 *
 * These live in scene metadata, so they arrive from a previous version of this extension, from
 * another client, or from a number input a GM typed into. `normaliseSettings` is total: it takes
 * anything at all and returns a usable set, clamping rather than rejecting. A parameter panel that
 * can put the pipeline into a state it cannot recover from is worse than no panel.
 *
 * Pure: no DOM, no SDK.
 */

export interface TraceSettings {
  /**
   * Gaussian blur before binarisation, in raster pixels.
   *
   * The texture-suppression control. Raising it fades the finest marks below the threshold, which
   * is the blunt lever against speckle, stipple and a printed floor grid — blunt because it works
   * on *contrast*, so it takes faint linework with it as well as thin linework.
   */
  readonly blurSigma: number;
  /**
   * Sauvola's sensitivity, `k`.
   *
   * How far below its local mean a pixel must sit to count as ink. **Raising it makes less ink**:
   * the threshold drops away from the mean, so only decisively dark pixels qualify. Lowering it
   * catches faint linework and, eventually, the paper.
   */
  readonly sauvolaK: number;
  /**
   * Sauvola's window radius, as a fraction of a grid square.
   *
   * How local "local" is. It wants to be comfortably wider than the linework is thick — a stroke
   * that fills its own window becomes the local ground and stops being called ink, which loses the
   * *boldest* lines on the map and is the opposite of what anyone predicts.
   */
  readonly sauvolaRadiusSquares: number;
  /**
   * Smallest area kept as a room, in grid squares.
   *
   * Guards against hatching, speckle and the slivers a picked-up floor grid leaves. It can only
   * delete, never re-partition — and what it deletes is left as bare map inside a revealed room
   * unless a filled hole happens to reach it. §5's bias favours setting it low: a spurious region
   * costs one click, a bare patch is a visible defect.
   */
  readonly minRoomSquares: number;
  /**
   * Simplification tolerance, as a fraction of the measured ink width.
   *
   * **Keep it below 0.5.** Douglas–Peucker moves a boundary by at most the tolerance, so under half
   * an ink width it provably cannot carry a room's edge past the centre of the wall beside it and
   * into the next room. Above that the guarantee is gone, which is why the maximum here is 0.45.
   */
  readonly simplifyInkWidths: number;
}

export interface ReviewSettings {
  /**
   * Fill opacity of a staged proposal.
   *
   * Low by default. Proposals cover the whole map — the exterior is emitted like any other region —
   * so a heavy fill is a flat wash with nothing to contrast against, and the partition, which is
   * the only thing a GM is being asked to judge, disappears. What carries it is the difference
   * between neighbouring colours and the outline between them.
   *
   * Nothing to do with the opacity of an *accepted* shape, which is forced to 1: a fog shape below
   * full opacity leaves a tint over ground the party has already revealed.
   */
  readonly fillOpacity: number;
  /** Outline width of a staged proposal, in grid squares. Free — stroke width does not affect walls. */
  readonly strokeSquares: number;
}

/**
 * How the stage-one overlay paints the mask.
 *
 * Purely how it looks. Nothing here reaches the pipeline, which is why these are display parameters
 * rather than reading ones despite living on the reading tab — see `PARAMETER_KIND`.
 */
export interface OverlaySettings {
  /**
   * The colour ink is painted in, as `#rrggbb`.
   *
   * Adjustable because no single colour works on every map. Red is invisible on a red-tinted map
   * and screams on a grey one, and the GM is the only one who can see which they have.
   */
  readonly inkColour: string;
  /**
   * How opaque that paint is.
   *
   * Defaults to fully opaque, which is the honest starting point: the question stage one asks is
   * "is this what you call a wall", and a solid answer is easiest to read. Lowering it turns the
   * overlay into a tint the map shows through, which is what you want when the question shifts to
   * "does this line up with the linework underneath".
   */
  readonly inkOpacity: number;
}

export interface Settings {
  readonly trace: TraceSettings;
  readonly review: ReviewSettings;
  readonly overlay: OverlaySettings;
}

export const DEFAULT_SETTINGS: Settings = {
  trace: {
    blurSigma: 1,
    sauvolaK: 0.34,
    sauvolaRadiusSquares: 0.25,
    minRoomSquares: 0.1,
    simplifyInkWidths: 0.25,
  },
  review: {
    fillOpacity: 0.22,
    strokeSquares: 1 / 12,
  },
  overlay: {
    inkColour: "#ff2020",
    inkOpacity: 1,
  },
};

/**
 * The fallback colour, and the shape every stored colour must have.
 *
 * Validated rather than trusted for the same reason every number here is clamped: this arrives from
 * scene metadata, so it can have been written by an older build or hand-edited. An unvalidated
 * string goes straight into a canvas fill style, where a malformed value is silently ignored and
 * the overlay paints in whatever colour was set last — which reads as the control being broken.
 */
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;

/** Bounds for every field, and the step a control should offer. */
export const SETTING_LIMITS = {
  // Maxima chosen so the default sits somewhere a GM can push in both directions. A blur of 5px
  // against 5.7px ink would erase the linework outright, and a window radius of 1.5 squares is 13
  // times any stroke — both were reachable only by crushing the useful end of the track.
  blurSigma: { min: 0, max: 3, step: 0.25 },
  sauvolaK: { min: 0.02, max: 0.9, step: 0.02 },
  sauvolaRadiusSquares: { min: 0.05, max: 0.75, step: 0.05 },
  minRoomSquares: { min: 0.002, max: 6, step: 0.01 },
  // Capped below the half-ink-width bound that stops a boundary crossing a wall. A GM cannot be
  // given a control whose top end silently merges rooms.
  simplifyInkWidths: { min: 0.02, max: 0.45, step: 0.01 },
  fillOpacity: { min: 0, max: 1, step: 0.02 },
  strokeSquares: { min: 0, max: 0.3, step: 0.01 },
  // Not floored above zero. Dragging it to nothing is a legitimate way to check what is underneath
  // without taking the overlay down and losing its position.
  inkOpacity: { min: 0, max: 1, step: 0.02 },
} as const;

export type SettingName = keyof typeof SETTING_LIMITS;

/**
 * The three ordered stages, and what each one destroys.
 *
 * `read` decides what is ink. `derive` abstracts that ink into the regions that will define walls.
 * `adjust` is what the GM wants, which no amount of the first two can express.
 *
 * **Destruction cascades one way.** Changing anything in `read` recomputes the mask, which
 * re-partitions wholesale and discards both later stages. Changing anything in `derive` regenerates
 * every polygon from the same mask, so it discards hand edits but not the reading. Nothing in
 * `adjust` destroys anything.
 *
 * The split between the first two is not stylistic. The mask determines the partition completely —
 * labelling's one choice is forced by the diagonal-leak paradox — so nothing in `derive` can split
 * or join a region. What it *can* do is delete a region and, through the containment rule, absorb
 * the space it held into whatever encloses it. That is abstraction, not reading, which is why the
 * minimum-area filter and the simplification tolerance sit here rather than beside the threshold.
 */
export type Stage = "read" | "derive" | "adjust";

/** In order. The order is the cascade, and every part of the UI depends on it being this way round. */
export const STAGES = ["read", "derive", "adjust"] as const;

/**
 * The single declaration of which stage owns which parameter.
 *
 * Both the panel's tabs and the pipeline's cache invalidation read this, so they cannot disagree
 * about what a change to a given knob invalidates — which is the failure that would let a stage-two
 * tweak silently reuse a stale mask. A test asserts the mapping is total.
 */
export const PARAMETER_STAGE: Readonly<Record<SettingName, Stage>> = {
  sauvolaK: "read",
  blurSigma: "read",
  sauvolaRadiusSquares: "read",
  inkOpacity: "read",
  minRoomSquares: "derive",
  simplifyInkWidths: "derive",
  fillOpacity: "adjust",
  strokeSquares: "adjust",
};

/**
 * Whether a parameter feeds the pipeline or only decides how its result is drawn.
 *
 * **The second axis, and it is not the same as the stage.** The stage says which tab a control
 * appears on, which is decided by *what it displays*: the overlay's colour belongs beside the
 * reading controls because the overlay is what those controls produce, and flipping tabs to recolour
 * the thing you are looking at would be absurd. But recolouring destroys nothing and recomputes
 * nothing.
 *
 * Conflating the two would be a real bug rather than untidiness: the mask fingerprint reads the
 * reading stage, so a display parameter filed as a reading parameter would throw away a cached mask
 * and force a full re-binarisation **every time the GM nudged the opacity slider**. Hence
 * `maskFingerprint` reads pipeline parameters only, and a test pins that.
 *
 * The cascade in `Stage` therefore governs pipeline parameters. Display parameters are orthogonal
 * to it: they live with the thing they display and they destroy nothing, wherever they sit.
 */
export type ParameterKind = "pipeline" | "display";

export const PARAMETER_KIND: Readonly<Record<SettingName, ParameterKind>> = {
  sauvolaK: "pipeline",
  blurSigma: "pipeline",
  sauvolaRadiusSquares: "pipeline",
  inkOpacity: "display",
  minRoomSquares: "pipeline",
  simplifyInkWidths: "pipeline",
  fillOpacity: "display",
  strokeSquares: "display",
};

/** Every parameter belonging to one stage, in declaration order. */
export function stageParameters(stage: Stage): readonly SettingName[] {
  return (Object.keys(SETTING_LIMITS) as SettingName[]).filter(
    (name) => PARAMETER_STAGE[name] === stage,
  );
}

/**
 * Which sub-object of `Settings` holds a parameter.
 *
 * The stored shape is deliberately **not** renested to match the three stages. Renesting would mean
 * either a migration or a normaliser that falls back to defaults for every field of a GM's existing
 * tuning — and silently rewriting a stored setting merely because the panel opened is the worst
 * failure a control can have. So storage keeps its two groups and the stage mapping above is what
 * carries the semantics.
 */
function groupOf(name: SettingName): "trace" | "review" | "overlay" {
  if (name in DEFAULT_SETTINGS.review) return "review";
  if (name in DEFAULT_SETTINGS.overlay) return "overlay";
  return "trace";
}

/** Read one parameter by name, whichever group it is stored in. */
export function readParameter(settings: Settings, name: SettingName): number {
  const group = groupOf(name);
  return (settings[group] as unknown as Record<string, number>)[name]!;
}

/** A copy of `settings` with one parameter replaced. */
export function writeParameter(
  settings: Settings,
  name: SettingName,
  value: number,
): Settings {
  const group = groupOf(name);
  return { ...settings, [group]: { ...settings[group], [name]: value } };
}

/**
 * The identity of the mask a set of settings would produce.
 *
 * Only the `read` stage contributes, which is the whole point: two settings differing anywhere else
 * describe the same mask, so the expensive half of the pipeline can be reused between them. The
 * pipeline combines this with the map's own identity before trusting a cached mask.
 */
export function maskFingerprint(settings: Settings): string {
  return stageParameters("read")
    .filter((name) => PARAMETER_KIND[name] === "pipeline")
    .map((name) => `${name}=${readParameter(settings, name)}`)
    .join(",");
}

/**
 * The stage the overlay's colour belongs to.
 *
 * Stated once rather than in each of the two places below. The colour is the one setting that is
 * not a number, so it sits outside `SETTING_LIMITS` and therefore outside `stageParameters` — which
 * means every function that walks a stage's parameters has to remember it separately. That is the
 * cost of having one non-numeric setting, and naming it here is cheaper than a second machinery.
 */
const COLOUR_STAGE: Stage = "read";

/** Whether one stage's parameters are all at their defaults, ignoring the other stages. */
export function isStageDefault(settings: Settings, stage: Stage): boolean {
  const normalised = normaliseSettings(settings);
  const numbersMatch = stageParameters(stage).every(
    (name) => readParameter(normalised, name) === readParameter(DEFAULT_SETTINGS, name),
  );
  const colourMatches =
    stage !== COLOUR_STAGE ||
    normalised.overlay.inkColour === DEFAULT_SETTINGS.overlay.inkColour;
  return numbersMatch && colourMatches;
}

/** A copy of `settings` with one stage's parameters back to their defaults, leaving the rest alone. */
export function resetStage(settings: Settings, stage: Stage): Settings {
  const numbers = stageParameters(stage).reduce(
    (accumulated, name) =>
      writeParameter(accumulated, name, readParameter(DEFAULT_SETTINGS, name)),
    settings,
  );
  if (stage !== COLOUR_STAGE) return numbers;
  return {
    ...numbers,
    overlay: { ...numbers.overlay, inkColour: DEFAULT_SETTINGS.overlay.inkColour },
  };
}

function clamp(value: unknown, name: SettingName, fallback: number): number {
  const limits = SETTING_LIMITS[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * Take anything and return a usable set.
 *
 * Total by design. Clamps rather than rejecting, and falls back per field rather than wholesale, so
 * one bad value in stored metadata cannot discard a GM's other four.
 */
export function normaliseSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Record<string, unknown>;
  const trace = (source.trace ?? {}) as Record<string, unknown>;
  const review = (source.review ?? {}) as Record<string, unknown>;
  const overlay = (source.overlay ?? {}) as Record<string, unknown>;
  const t = DEFAULT_SETTINGS.trace;
  const r = DEFAULT_SETTINGS.review;
  const o = DEFAULT_SETTINGS.overlay;

  return {
    trace: {
      blurSigma: clamp(trace.blurSigma, "blurSigma", t.blurSigma),
      sauvolaK: clamp(trace.sauvolaK, "sauvolaK", t.sauvolaK),
      sauvolaRadiusSquares: clamp(
        trace.sauvolaRadiusSquares,
        "sauvolaRadiusSquares",
        t.sauvolaRadiusSquares,
      ),
      minRoomSquares: clamp(trace.minRoomSquares, "minRoomSquares", t.minRoomSquares),
      simplifyInkWidths: clamp(
        trace.simplifyInkWidths,
        "simplifyInkWidths",
        t.simplifyInkWidths,
      ),
    },
    review: {
      fillOpacity: clamp(review.fillOpacity, "fillOpacity", r.fillOpacity),
      strokeSquares: clamp(review.strokeSquares, "strokeSquares", r.strokeSquares),
    },
    overlay: {
      inkColour: normaliseColour(overlay.inkColour, o.inkColour),
      inkOpacity: clamp(overlay.inkOpacity, "inkOpacity", o.inkOpacity),
    },
  };
}

/**
 * Take anything and return a usable `#rrggbb`.
 *
 * Lower-cased so a value round-trips unchanged through the panel's colour input, which reports in
 * lower case. Without that, opening the panel on a scene storing `#FF2020` would write back
 * `#ff2020` and mark the settings edited — the same "merely opening the panel changed something"
 * failure the slider round-tripping tests exist to prevent, in a place nobody would think to look.
 */
export function normaliseColour(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOUR_PATTERN.test(value) ? value.toLowerCase() : fallback;
}

/** Whether a set differs from the defaults, so the panel can offer a meaningful reset. */
export function isDefault(settings: Settings): boolean {
  return (
    JSON.stringify(normaliseSettings(settings)) === JSON.stringify(DEFAULT_SETTINGS)
  );
}

/** One line for the log, so a run's numbers can be read beside the settings that produced them. */
export function describeSettings(settings: Settings): string {
  const { trace, review } = settings;
  return (
    `blur ${trace.blurSigma}, k ${trace.sauvolaK}, window ${trace.sauvolaRadiusSquares} sq, ` +
    `min room ${trace.minRoomSquares} sq, simplify ${trace.simplifyInkWidths} ink widths; ` +
    `review fill ${review.fillOpacity}, stroke ${review.strokeSquares.toFixed(3)} sq` +
    (isDefault(settings) ? " (all defaults)" : " (edited)")
  );
}
