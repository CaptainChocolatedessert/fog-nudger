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

export interface Settings {
  readonly trace: TraceSettings;
  readonly review: ReviewSettings;
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
};

/** Bounds for every field, and the step a control should offer. */
export const SETTING_LIMITS = {
  blurSigma: { min: 0, max: 5, step: 0.25 },
  sauvolaK: { min: 0.02, max: 0.9, step: 0.02 },
  sauvolaRadiusSquares: { min: 0.05, max: 1.5, step: 0.05 },
  minRoomSquares: { min: 0.002, max: 6, step: 0.01 },
  // Capped below the half-ink-width bound that stops a boundary crossing a wall. A GM cannot be
  // given a control whose top end silently merges rooms.
  simplifyInkWidths: { min: 0.02, max: 0.45, step: 0.01 },
  fillOpacity: { min: 0, max: 1, step: 0.02 },
  strokeSquares: { min: 0, max: 0.3, step: 0.01 },
} as const;

export type SettingName = keyof typeof SETTING_LIMITS;

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
  const t = DEFAULT_SETTINGS.trace;
  const r = DEFAULT_SETTINGS.review;

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
  };
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
