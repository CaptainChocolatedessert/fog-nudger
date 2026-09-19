import { PALETTE_DEFAULTS } from "./palette";

/**
 * The knobs a GM can turn, and the three stages they belong to.
 *
 * ## Why the split is architectural rather than cosmetic
 *
 * The ink determines the partition **completely**. What the rooms are is settled by the time the
 * skeleton is thinned from it: connected-component labelling has one choice in it — the connectivity
 * pairing — and that is forced by the diagonal-leak paradox, so it is a correctness requirement
 * rather than a knob. Nothing after the graph can split or join a region: simplification is bounded
 * so it cannot change topology, and fitting and placement are exact.
 *
 * So every parameter that decides *what the rooms are* acts on the ink or the graph, and every
 * parameter after that is a finish. The three stages are the cascade that falls out of it — what a
 * change **destroys**:
 *
 * - **read** — what is a wall. Recomputes the partition wholesale, discarding everything after it.
 * - **derive** — how the boundaries are drawn from a partition that is already decided. Regenerates
 *   every polygon from the same ink, so it discards hand edits but not the reading.
 * - **adjust** — how the result is *shown* while it is judged. Destroys nothing.
 *
 * The ordering is forced rather than advisory: `read` destroys `derive`'s work every time it runs.
 * The answer to that has never been to engineer around it but to make the sequence visible — which
 * is what the workspace's steps do, and what the two modes settled for good: the ink mode derives a
 * wall graph from the map, and the editor edits the one that was derived. Re-deriving replaces it,
 * which is why saving is a deliberate button rather than something closing does.
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
   * Sauvola's window radius, in raster pixels.
   *
   * How local "local" is. It wants to be comfortably wider than the linework is thick — a stroke
   * that fills its own window becomes the local ground and stops being called ink, which loses the
   * *boldest* lines on the map and is the opposite of what anyone predicts.
   *
   * **In pixels rather than grid squares** (user, 2026-08-23). A GM who does not need a grid leaves
   * it at a default that has nothing to do with the map, and a control denominated in squares then
   * means nothing. It also sits directly beside the blur, which has always been in pixels and is
   * tuned with it — one of the pair in each unit was an inconsistency inside a single section.
   */
  readonly sauvolaRadiusPx: number;
  /**
   * Minimum stroke width, as a fraction of the measured ink width. Zero is off.
   *
   * A morphological **opening** — erode then dilate — so marks narrower than this vanish and
   * everything else keeps its original width. Not a plain erosion: that thins what survives, and
   * since regions are bounded by ink, thinning ink grows every region.
   *
   * The lever for a printed floor grid that the blur cannot reach. Blur works on *contrast*, so a
   * grid drawn as dark as the walls costs linework to remove; this works on *width*, which is the
   * axis a grid line actually differs on.
   *
   * **It is not safe, only visible.** It deletes everything below the threshold — a thin doorway
   * marking, a lightly drawn secret door, a wall hatched as fine parallel strokes — and it can
   * sever a thin wall, which merges two rooms. It was rejected outright until the stage-one overlay
   * made a severed wall something a GM can see. Default zero, so it changes nothing until it is
   * reached for.
   */
  readonly minStrokeInkWidths: number;
  /**
   * Smallest isolated ink island kept, measured as the longest side of its bounding box in raster
   * pixels. Zero is off.
   *
   * The second tool in stage 1b, and it exists because the first leaves a residue. Once a printed
   * floor grid is gone, what remains beside the linework is decoration — high-contrast, thick
   * enough to survive an opening, and **stubby**: a compass rose, rubble, a furniture glyph.
   *
   * It separates those from walls by *connectivity* first and size second. A wall segment can be
   * tiny, but walls **join up** — the linework of a dungeon is one enormous connected network,
   * while a decoration is an island floating inside a room. So the threshold only has to be big
   * enough to catch islands, and it is separating things that differ by orders of magnitude.
   *
   * The longest side rather than the area, because nobody can estimate an area by eye. It is also
   * the measure that says *stubby*, which is the property distinguishing what survives an opening
   * from what should.
   *
   * **In pixels rather than grid squares or ink widths** (user, 2026-08-23). The grid may be a
   * default that has nothing to do with the map; the ink-width measure is not trusted to be
   * reliable across map styles, saturating at 2px and biased thin. Pixels are the only unit here
   * that is always exactly what it says.
   *
   * **The cost:** a genuinely isolated short wall — a free-standing pillar, a lone threshold mark —
   * looks exactly like a decoration and goes with them.
   */
  readonly minIslandPx: number;
  /**
   * The widest gap in the linework the search will **look for**, in raster pixels. Zero finds none.
   *
   * Finds walls thinned or severed upstream, so two rooms do not merge across a gap the map has not
   * actually got. Morphologically a closing — the exact inverse of the minimum stroke width — over
   * only the channels the detector marks, never as a blanket operation.
   *
   * **It proposes; it does not write** (2026-09-05). Every gap found is ringed and shown, and the
   * GM accepts one or all of them; what is accepted goes into the added-ink layer. The old invariant
   * — *every pixel the fill invents belongs to a gap with a ring on it* — is now true by a stronger
   * route, since nothing is invented at all until a click asks for it.
   *
   * **That restriction was the safety property, and it still is.** A blanket closing also seals
   * through-channels that failed the travel test, and the clearest example is a narrow doorway beside
   * a corner, where the two banks meet round the corner within a short travel. That would be sealed
   * with nothing to see — and Dynamic Fog would then derive a wall across an open door and block line
   * of sight through it, silently.
   *
   * In pixels rather than measured ink widths (user, 2026-08-23): stage one stays close to the
   * raster, and a threshold that moved with a measurement would change what is repaired for reasons
   * a GM has no way to see.
   *
   * ## Superseded: this was two controls for one commit
   *
   * Finding and filling were briefly separate — one width to *highlight* candidates, a second share
   * of it to select which got *repaired* — so that a GM could settle a stable set of places worth
   * attention and then sweep the repair against it. **It was abandoned on evidence from a room**
   * (user, 2026-08-23): the premise was false.
   *
   * Gaps are not discrete items that appear one at a time as the width rises. Where two uneven
   * lines run close together, a closing carves the space between them into several channels at the
   * pinch points, and those channels **merge into one** as the radius grows. A gap therefore has
   * no stable identity across radii — and because a channel was only repaired when *all* of it fell
   * inside the fill radius, raising the highlight could **prevent** a repair that a lower one
   * allowed. Non-monotonic, and unexplainable to anyone turning the knob.
   *
   * One control is well behaved for a precise reason: what is being tuned is then the **set of
   * pixels repaired**, which grows with the radius, rather than a set of discrete marks, which does
   * not. The count of marks still jumps around as channels merge; it is a diagnostic, not the thing
   * being adjusted.
   *
   * **Renamed from `gapWidthPx` rather than reinterpreted.** That key meant "highlight only", and a
   * scene storing it would silently have started inventing ink at whatever width had been chosen for
   * looking. A rename falls back to this default, which is the loud version of the same event.
   */
  /**
   * How far from the clicked pixel's tone a pixel may be and still join its mark, on luminance's
   * own 0..1.
   *
   * *Suppress blob* floods the **map image** rather than the derived ink, and this is the whole of
   * what it means by "the same mark". A big solid spot derives as an *outline* — Sauvola's window is
   * uniformly dark in its middle and finds no contrast there — so the derived ink cannot answer the
   * question this tool asks.
   *
   * **Not seeded per map, unlike every other tool distance.** Straightening and the mend tool's two
   * reaches are seeded because they are denominated in pixels or graph units, which mean different
   * lengths on different maps; luminance is 0 to 1 on every map, so a tolerance means the same thing
   * everywhere and `seedDefaults.ts` stays out of it.
   *
   * **Zero is meaningful rather than off**: it takes only pixels of exactly the seed's tone, which on
   * a flat fill is still the whole fill. There is no off state to key on, and none is wanted — a tool
   * that does nothing is not armed.
   */
  readonly blobTolerance: number;
  readonly gapFillPx: number;
  /**
   * How far apart two banks of a gap may be **along the ink** and still count as one piece of
   * wall, in raster pixels.
   *
   * The whole discriminator between a crack and a ragged edge, and the reason a doorway beside a
   * corner is not sealed. Zero is meaningful rather than off: it repairs every gap that passes
   * through, which is the most eager the detector gets.
   */
  readonly gapTravelPx: number;
  /**
   * The longest dead-end wall spur pruning will remove, **in graph units** — the map's longer side
   * is 1.
   *
   * **Renamed from `spurPruneFraction` on 2026-09-16** when the unit changed from a fraction of each
   * side, so a stored value falls back to the default rather than being read in the new unit.
   *
   * A spur is the artefact a ragged ink edge leaves on a centreline; a **stub** is a wall that
   * genuinely stops in mid-air. They are the same shape locally and only length separates them,
   * which is why this is a number rather than a rule. Zero is off.
   *
   * Destructive out of proportion to its size at the top end: a limit longer than a wall's own arms
   * erodes the whole graph, since every arm of a junction is a dead end once the arms around it go.
   */
  readonly spurPruneGraphUnits: number;
  /*
    `simplifyGraphUnits` was here and went on 2026-09-18. It was the **fitting** tolerance, converted
    to raster pixels and handed to the derive.

    **Removed rather than hidden.** A stored value with no handle would have governed every fit for
    ever, silently, on any scene tuned before the change — which is the failure the unit-rename rule
    exists to prevent, arriving by a different route. The derive computes the figure from the measured
    ink width now: a quarter of one, which is what this defaulted to for the months it was denominated
    in ink widths and the only form that means the same on every map.

    The round trip went with it. The seed divided a pixel figure by raster pixels per graph unit and
    the derive multiplied it straight back; that hop existed only so a *stored* number could outlive
    the raster.

    **Straighten** is what a GM presses instead, and it is not this number. It applies an amount to
    the walls in front of them, so it works on a hand-edited graph and needs no lock.
  */
  /**
   * The mend tool's largest gap to look for, **in graph units**. Zero proposes nothing.
   *
   * The graph's counterpart of `gapFillPx`, with the same label. A mend is a wall proposed across a
   * break in the derived walls — a wall line that thinned out in the ink — and `trace/mends.ts`
   * carries what one is and what it may join.
   *
   * **Seeded per map** at the equivalent of 20 raster pixels, where the ink tool's default is 12:
   * thinning pulls each free end back about half an ink width, so a break is wider in the graph than
   * it was in the ink (user, 2026-09-16; reasoning, to be checked in a room).
   */
  readonly mendReachGraphUnits: number;
  /**
   * How far apart along the walls a mend's two sides must be, **in graph units**. Zero switches the
   * test off and proposes every gap within reach.
   *
   * The graph's counterpart of `gapTravelPx`, with the same label: two sides the walls already join
   * within this are one piece of wall with a kink in it. **Seeded per map** at 40 raster pixels, the
   * ink tool's own default.
   */
  readonly mendTravelGraphUnits: number;
  /*
    `editSimplifyFraction` was here, and it went when straightening became one control (2026-09-14).

    There were two straighten settings meaning the same thing on opposite terms: this one applied
    once by a button in the editor, and `simplifyGraphUnits` above re-applied on every derive. The
    justification was real — before the save the graph was a derivation and turning the slider down
    put the detail back, after it the graph was the document and nothing could — and it stopped being
    real when both halves became one surface with one rule: **anything that regenerates the walls
    discards your wall edits, and the mark says so.**

    **Removed rather than defaulted to zero**, for the reason `inkOpacity` was: a stored non-zero
    value with no control left would sit in the settings for ever, reported in the log, meaning
    nothing. With the key gone the normaliser drops it.
  */
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
 * How the stage-one surface paints the mask.
 *
 * Purely how it looks. Nothing here reaches the pipeline, which is why these are display parameters
 * rather than reading ones despite living on the reading surface — see `PARAMETER_KIND`.
 *
 * The gap settings were briefly here, on the reasoning that they changed nothing about the mask.
 * They moved to `trace` the moment the fill became real: a gap parameter now decides which pixels
 * of invented ink reach the regions, which is as far from paint as a parameter gets.
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
   * The other four markup colours, as `#rrggbb`.
   *
   * Adjustable **by category rather than by layer**, which is the whole of why they are grouped: a
   * map with an unusual tint wants one move, not three hunted down across three layers that then have
   * to agree with each other.
   *
   * They adjust the saturated **core** of a mark. The light casing under it is fixed, because that is
   * the half doing the visibility work on a ground we do not control — tinting it would let a GM tune
   * away the mechanism the hues rely on.
   *
   * `inkColour` above keeps its name rather than becoming `inkColour`-by-another-route: renaming a
   * stored key means the old one is ignored and the default applies, and that is the one colour a GM
   * is most likely to have already chosen.
   */
  readonly structureColour: string;
  readonly additiveColour: string;
  readonly subtractiveColour: string;
  readonly destructiveColour: string;
  /*
    `inkOpacity` was here, and the parameter went with its control (user, 2026-09-09: "The ink
    opacity control can be removed").

    **Removed rather than hidden**, which is the part that needed deciding. Dropping only the slider
    would have left anyone who had already lowered it with a faded overlay forever and no control to
    undo it. With the key gone the normaliser drops a stored value, so every map draws the ink solid.

    **The cost:** tinting the overlay so the map's own linework shows through it was a real use —
    it answered "does this ink sit on the line underneath" in one view. The layer toggle answers it
    in two, by taking the overlay away entirely. Per-colour opacity is parked for discussion and is
    where this would come back, if it does.
  */
  /**
   * How wide the suppression brush is, in raster pixels.
   *
   * **A tool setting**, which is a kind of parameter this project has exactly two of, one per brush.
   * It decides what the *next* stroke lays down and recomputes nothing at all — a stroke already
   * painted keeps the width it was painted at, because what is stored is the pixels rather than a
   * recipe for making them again. So it is filed as `display`: not because it is about appearance,
   * but because `PARAMETER_KIND` asks what a change recomputes and the answer here is nothing.
   *
   * In raster pixels, matching the two gap controls and for the same reason: stage one stays close
   * to the raster, and a brush lands in exactly the space the layer is stored in, so what the readout
   * says is what the stroke covers. Screen pixels were the alternative — a brush of constant size
   * under the cursor, which is what most painting tools do — and were rejected because the same
   * gesture would then cover a different amount of map depending on how far the GM was zoomed out.
   *
   * **Separate from the added-ink brush rather than shared**, because the two tools do opposite
   * kinds of work. Suppression covers an area: the motivating case is crosshatching, which a GM
   * blocks out with a wide brush rather than tracing. Added ink draws a line. One control would make
   * every switch between the tools a resize, and their sensible defaults are an order apart.
   */
  readonly suppressBrushPx: number;
  /** How wide the added-ink brush is, in raster pixels. See `suppressBrushPx` for the reasoning. */
  readonly inkBrushPx: number;
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
    sauvolaRadiusPx: 13,
    minStrokeInkWidths: 0,
    minIslandPx: 0,
    /*
      **On by default now, and the reason it was off has gone** (2026-09-05).

      It was zero because this was the only control in stage one that *invented* ink rather than
      deciding what to make of the map's own, and nothing should write into a map's linework before a
      GM has asked. That is no longer what it does: the search proposes, and only an accept writes. So
      the thing the default was protecting against cannot happen at whatever value this holds.

      What zero would cost is now a real cost rather than a safe one — a GM opening the Gaps tool
      would be shown nothing, with no way to tell "this map has none" from "the slider is at zero".
      A tool that has to be switched on before it does anything is one nobody finds.

      Twelve pixels because it is the value this briefly held before, when it was defended on a
      warning argument; it is wide enough to catch a severed wall and well short of a doorway. Nothing
      about a default can be right for every map, which is what the slider is for.
    */
    blobTolerance: 0.12,
    gapFillPx: 12,
    gapTravelPx: 40,
    // Off by default, like every other control that removes something a GM has not looked at yet.
    // Pruning is also destructive out of proportion to its number — see `spurs.ts`: a limit longer
    // than a wall's own arms erodes the whole graph — so the first thing a GM should see is the
    // graph as fitting produced it, hairs and all.
    spurPruneGraphUnits: 0,
    /*
      20 and 40 raster pixels on the 3300px test map, and **only fallbacks**: both are seeded per map
      from its raster once a reading lands, for the reason straightening is — a fixed figure means a
      different stretch of wall on every map.
    */
    mendReachGraphUnits: 6e-3,
    mendTravelGraphUnits: 1.2e-2,
  },
  review: {
    fillOpacity: 0.22,
    /*
      0.08 rather than 1/12, so the default is a position the slider can actually select.

      It was 1/12 (0.08333...), and `SETTING_LIMITS.strokeSquares` steps by 0.01 — the only default
      in the whole set that did not land on its own step. Nudging that slider and putting it back
      landed on 0.08, so `isDefault` was false from then on and every log line said "(edited)" for a
      scene the GM considers untouched, with the per-step Defaults button the only way back.

      Safe to change because this is a **display** parameter in the **adjust** stage: it draws the
      preview's outline on the workspace canvas and reaches no emitted geometry, since an emitted
      shape carries no stroke at all. The visible difference between 0.0833 and 0.08 squares of
      preview outline is nothing.
    */
    strokeSquares: 0.08,
  },
  overlay: {
    /*
      Violet, and it was red.

      Two reasons, and the second is the stronger. Red reads as an error for something that is only a
      *reading* of the map. And ink is the largest area on screen, worn for the whole session at
      partial opacity, so it should be the calmest mark there rather than the loudest — red is now
      reserved for what an action would remove, which earns its alarm by being rare.

      A stored setting is untouched: this is the default a scene gets when it has never chosen one.
    */
    inkColour: PALETTE_DEFAULTS.ink,
    structureColour: PALETTE_DEFAULTS.structure,
    additiveColour: PALETTE_DEFAULTS.additive,
    subtractiveColour: PALETTE_DEFAULTS.subtractive,
    destructiveColour: PALETTE_DEFAULTS.destructive,
    // Wide enough to cover an area rather than trace a line, which is what suppression is mostly
    // for and is also the shape of paint that costs almost nothing to store. Fine work is a matter
    // of turning it down and zooming in.
    suppressBrushPx: 24,
    // Around an ink width on this project's test map, because what this draws is linework and a
    // wall the GM adds should look like the walls beside it.
    inkBrushPx: 6,
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
  // In raster pixels. The floor is a window that can still see past a stroke; the ceiling is far
  // past any linework, so the top end is reachable and visibly wrong rather than merely large.
  sauvolaRadiusPx: { min: 2, max: 48, step: 1 },
  // Tops out well past useful, deliberately (user, 2026-08-23). A control whose top end still
  // looks reasonable gives no sense of where the edge is; being able to push it until the ink
  // disappears entirely is what makes the middle feel like a choice rather than a guess.
  minStrokeInkWidths: { min: 0, max: 3, step: 0.05 },
  // Same reasoning: the top end should be able to erase a map's decoration and then its walls.
  minIslandPx: { min: 0, max: 300, step: 1 },
  /*
    The mend tool's two, on log tracks in graph units like the other two graph controls — but with a
    **declared** top rather than one measured off the graph, because what they measure is a gap and
    the graph has no longest gap to measure. A tenth of the map's longer side is 330 raster pixels on
    the test map and 75 on a 751px one, past the ink tool's own 80px top on both; the same-wall
    distance reaches four times as far, a little past the ink tool's ratio.
  */
  mendReachGraphUnits: { min: 0, max: 0.1, step: 0.0001, floor: 2e-4 },
  mendTravelGraphUnits: { min: 0, max: 0.4, step: 0.0001, floor: 2e-4 },
  fillOpacity: { min: 0, max: 1, step: 0.02 },
  strokeSquares: { min: 0, max: 0.3, step: 0.01 },
  // Runs past a doorway on purpose, like the two filters above it: at the top end whole doorways
  // get sealed, which is what makes the middle of the track feel like a choice. No measurement can
  // separate a doorway from a severed wall — both are a gap of some width — so where that line
  // falls is the GM's to decide, and the control has to reach far enough for them to decide it.
  // Stepped in twos because the value is halved and rounded to a closing radius, so consecutive
  // odd and even settings produce the identical repair. A step of one would give 81 stops for 41
  // outcomes, and which half of the clicks did nothing would depend on parity rather than on
  // anything visible — an unresponsive slider on the one control whose whole use is being swept.
  /*
    Linear in tone, not a log track, and the top is deliberately past useful.

    The graph controls take log tracks because their useful range spans orders of magnitude and their
    top has to be measured off the map. Neither applies here: luminance is a bounded, already
    normalised 0..1, so the whole range is the same size on every map and a linear handle means what
    it looks like. Half the tone range is far enough to swallow a map whole, which is the two ink
    filters' rule — a control whose top end still looks reasonable gives no feel for where the edge
    is — and it is affordable for the same reason, that the fill is drawn before the click.
  */
  blobTolerance: { min: 0, max: 0.5, step: 0.005 },
  gapFillPx: { min: 0, max: 80, step: 2 },
  // The top end calls almost any two pieces of one map's linework the same piece, which silences
  // the repair; the bottom end repairs every gap that passes through, doorways included.
  gapTravelPx: { min: 0, max: 300, step: 5 },
  /*
    Both graph-derived controls carry a `floor` and a static `max` they will normally never reach.

    **The unit is graph units**, measured along the wall rather than between its ends. Not raster
    pixels: the raster is an artefact of the megapixel cap, and the GM's graph outlives any one
    reading of the map.

    **The `max` here is storage, not the track.** The slider's top end is measured off the graph when
    the step opens — the longest spur, the largest bend — so it adapts to how finely the map was
    drawn, which no fixed ceiling can: two maps of the same pixel size can carry 3px or 12px
    linework. This number only bounds what may be stored, and it sits well past any measured top.

    **The `floor` is pinned and is NOT `min`.** A log scale cannot start at zero and both of these
    have a real off state, so the far-left position is off and the log part starts one step in. It
    must not be the *observed* minimum: both tools delete from the bottom, so prune at limit B and
    the shortest surviving spur is B — a tracking bottom would chase the slider upward and make the
    same percentage mean a larger bite every pass, which is the non-monotonicity that collapsed the
    two-slider gap design. And `min` stays 0 because the normaliser clamps into `[min, max]`, so a
    positive `min` would silently raise a stored zero to the floor on every read.
  */
  spurPruneGraphUnits: { min: 0, max: 0.5, step: 0.0001, floor: 2e-4 },
  // From a single pixel — the finest correction a raster can hold — to wide enough to cover a room
  // in a few strokes. The bottom end is genuinely usable rather than a token: repairing one severed
  // wall is a one-pixel job.
  suppressBrushPx: { min: 1, max: 240, step: 1 },
  // A narrower range than suppression's, and the top end is deliberately below it. This draws
  // linework, and a brush wider than a doorway would close one without the GM meaning to.
  inkBrushPx: { min: 1, max: 60, step: 1 },
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
 * The split between the first two is not stylistic. The ink determines the partition completely —
 * labelling's one choice is forced by the diagonal-leak paradox — so nothing in `derive` can split
 * or join a region. That is abstraction rather than reading, which is why the simplification
 * tolerance sits here rather than beside the threshold.
 *
 * The minimum-area filter was the other member and the one that *established* the distinction: it
 * could delete a region and, through the containment rule, absorb the space it held into whatever
 * enclosed it — which is a change to surviving polygons, not a pure delete, and therefore not a
 * reading operation. The control was removed on 2026-08-30; the argument it settled is why the line
 * is drawn here.
 */
export type Stage = "read" | "adjust";

/*
  **`derive` was the middle rung and it is gone (2026-09-18), because it ran out of members.**

  It meant *abstracting the ink into shapes*: regenerates every polygon, so it discards hand edits but
  not the reading. The evidence quoted for it being a real rung was a minimum-area filter that is not a
  pure delete — and that control was deleted on 2026-08-30, which left the simplification tolerance as
  the only parameter at this stage. That tolerance stopped being a setting on 2026-09-18: it is computed
  from the measured ink width inside the derive, and what a GM presses instead is Straighten, which
  applies an amount to the walls rather than changing a parameter.

  So every setting that remains either changes what the ink is (`read`) or destroys nothing (`adjust`).
  **A stage with no members claims an ordering it does not have**, which is what `stages.test.ts` is
  there to refuse, and the honest answer was to take the rung out rather than relax the test.
*/

/**
 * In order, and the order **is** the cascade: read destroys adjust. (It was three until 2026-09-18 —
 * the block above says where the middle one went.)
 *
 * No production code reads this array — the UI reads `PARAMETER_STAGE` and `PARAMETER_STEP`, and the
 * cache invalidation reads the fingerprints. What it is for is stating the cascade in one place so a
 * test can pin it, and so that "the three stages" is checkable rather than remembered. It said "every
 * part of the UI depends on it being this way round", which was true of the panel's stage tabs and
 * stopped being true when they were deleted at A.6.
 */
export const STAGES = ["read", "adjust"] as const;

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
  sauvolaRadiusPx: "read",
  minStrokeInkWidths: "read",
  minIslandPx: "read",
  blobTolerance: "read",
  gapFillPx: "read",
  gapTravelPx: "read",
  spurPruneGraphUnits: "read",
  suppressBrushPx: "read",
  inkBrushPx: "read",
  // Filed `read` as every tool control is, which `stages.test.ts` pins: a tool control's stage is
  // never spent — its kind is what decides — and one convention for all of them is what keeps the
  // re-read prompt from being argued control by control. A mend setting destroys nothing.
  mendReachGraphUnits: "read",
  mendTravelGraphUnits: "read",
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
 *
 * ## There was briefly a third value, and it is worth knowing why it went
 *
 * When the gap marks only *highlighted* gaps, they were neither kind: derived from the mask so
 * not pipeline, but costly enough that treating them as free would have run half a second of
 * morphology on every frame of a drag. A `gaps` value carried that for one commit.
 *
 * It stopped being right the moment the fill became real. A gap parameter now decides which pixels
 * of invented ink reach the regions — and because the fill repairs only gaps the detector has
 * *marked*, the highlighting parameters feed the mask too. All three are pipeline, the third value
 * had no members left, and a kind with no members is a filter that silently matches nothing. The
 * cost it was avoiding is answered instead by caching the reading separately from what is composed
 * on top of it, which is a better answer anyway: it makes the 1b filters cheaper as well.
 */
export type ParameterKind = "pipeline" | "display" | "tool";

/*
  ## The third value, added 2026-09-05 — and the record set the condition for it

  `gaps` was the last third value and lasted one commit, deleted for having no members once the fill
  made every gap parameter feed the mask. The note that replaced it said to revisit *if the repair
  became a tool, at which point there would be four*. It did, and there are.

  **`tool` is not a synonym for `display`, and that is the whole test it had to pass.** Neither
  reaches the mask fingerprint, because neither recomputes a mask. What separates them is who has to
  be told: a `display` change only repaints, while a `tool` change is handed to the tool, which may
  be holding work the new number has just invalidated.

  The gap search is the case that makes it real. It holds a set of marks found at a particular
  width, and moving that slider stops those marks describing anything — **marks on screen that no
  longer match the settings beside them are the stale-diagnostic failure in miniature**, so the
  search re-runs. A brush width has no one to tell, since the next stroke simply reads it; the kind
  is shared because the *question* is the same one, not because both answers are interesting.

  **The original justification here was different and is gone**: `tool` controls used to be dimmed
  once a graph was saved, and `display` ones stayed live. Nothing dims any more — the two modes made
  the boundary a page rather than a disabled slider — so the distinction had to stand on behaviour or
  be deleted. It stands on `recomputeFor`.
*/
export const PARAMETER_KIND: Readonly<Record<SettingName, ParameterKind>> = {
  sauvolaK: "pipeline",
  blurSigma: "pipeline",
  sauvolaRadiusPx: "pipeline",
  minStrokeInkWidths: "pipeline",
  minIslandPx: "pipeline",
  // The gap search proposes and the GM accepts; nothing is recomputed until the tool is run, and
  // what it writes goes into the added-ink layer rather than into a term of the composition.
  blobTolerance: "tool",
  gapFillPx: "tool",
  gapTravelPx: "tool",
  spurPruneGraphUnits: "pipeline",
  suppressBrushPx: "tool",
  inkBrushPx: "tool",
  mendReachGraphUnits: "tool",
  mendTravelGraphUnits: "tool",
  fillOpacity: "display",
  strokeSquares: "display",
};

/*
  `seededSimplifyGraphUnits` was here and went on 2026-09-18 with the setting it seeded.

  Its whole job was to give a *stored* tolerance a per-map starting value, because a fixed one comes
  out sub-pixel on a small map. With the tolerance computed inside the derive there is no default to
  seed: the figure is a quarter of the measured ink width every time, which is what this returned.
*/

/**
 * A length in raster pixels as a starting value for a graph-unit setting, clamped into its track.
 *
 * What the mend tool's two settings are seeded to on a map that has never had them chosen: 20 and 40
 * raster pixels, converted by `rasterPerUnit` — raster pixels per graph unit, which is exact, where
 * a fixed figure in graph units would be a different stretch of wall on every map.
 *
 * Never the off position, for the reason the straightening seed is not: off is a state a GM chooses.
 */
export function seededGraphUnitsFromPixels(
  name: SettingName,
  pixels: number,
  rasterPerUnit: number,
): number {
  const limits = SETTING_LIMITS[name];
  const fallback = readParameter(DEFAULT_SETTINGS, name);
  if (!(pixels > 0) || !(rasterPerUnit > 0)) return fallback;
  const floor = "floor" in limits && limits.floor > 0 ? limits.floor : limits.min;
  return Math.min(limits.max, Math.max(floor, Number((pixels / rasterPerUnit).toPrecision(3))));
}

/** Every parameter belonging to one stage, in `SETTING_LIMITS`' declaration order. */
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
  return readingParameters()
    // The graph-only ones are excluded, which is what stops a prune costing a re-read.
    // They change the faces, not the mask, and `GRAPH_ONLY` says why that distinction survived
    // step D when the record expected it to disappear.
    .filter((name) => !isSkeletonOnly(name))
    .map((name) => `${name}=${readParameter(settings, name)}`)
    .join(",");
}

/**
 * Parameters that act on the mask **after** binarisation, and therefore cannot change the reading.
 *
 * ## Declared by exclusion, and the polarity of that is the point
 *
 * The reading — binarise, decide polarity, measure the ink width — is the expensive half of a run,
 * about 690ms of a 1.4s trace, and none of the filters or repairs composed on top of it can change
 * what it produced. Caching it separately is what keeps a sweep of the 1b filters or the gap
 * sliders from re-reading a map that has not changed.
 *
 * A cached reading is only safe if this list is complete, so the list is written the safe way
 * round: everything counts as a reading input **unless it is named here**. Add a new binarisation
 * parameter and forget to touch this file, and the reading cache becomes useless — which costs
 * 690ms and is obvious in the log. Write it as an opt-in list instead, forget the same edit, and
 * the reading gets reused when it should not have been, which is a mask that is quietly wrong. This
 * project has already paid once for a diagnostic that lied; the useless direction is the one to
 * fail in.
 */
const POST_READING: readonly SettingName[] = [
  "minStrokeInkWidths",
  "minIslandPx",
  // The two gap parameters were here until 2026-09-05 and left with the search. This list splits the
  // *pipeline* parameters of the read stage, and they are `tool` parameters now — so naming them
  // here would be naming non-members, and the test that every excluded one still moves the mask
  // fingerprint would fail, correctly.
  "spurPruneGraphUnits",
];

/**
 * Parameters that change the wall **graph** but not the ink mask.
 *
 * The third recompute target. This was `SKELETON_ONLY` when the skeleton was a view that emitted
 * nothing, and the record said it would have to empty at step D, when faces started coming from the
 * graph. **That was half right, and deleting the list would have been the wrong correction.**
 *
 * What is true is narrower than it looked. The mask fingerprint answers one question — would these
 * settings produce a different *mask* — and pruning a spur does not touch the mask at all. It changes the graph, and therefore the faces. So the list stays out of the
 * fingerprint, correctly, and what changes at step D is the **dispatch**: a change here used to
 * invalidate only the skeleton view, and must now invalidate the derived regions as well, because
 * they are the graph's faces. `recomputeFor` is where that lives.
 *
 * The cost this saves is real: a prune sweep costs a branch walk and a face traversal rather than
 * re-binarising the map or recomposing the ink.
 */
const GRAPH_ONLY: readonly SettingName[] = ["spurPruneGraphUnits"];

/**
 * Whether a parameter changes the graph without changing the mask.
 *
 * Exported for the recompute dispatch and the tests. Keeps its old name so nothing has to be renamed
 * twice; what it means has narrowed rather than moved.
 */
export function isSkeletonOnly(name: SettingName): boolean {
  return GRAPH_ONLY.includes(name);
}

/**
 * Whether changing this parameter re-reads the map.
 *
 * **One statement of it, used twice**, and the second use is the reason it exists. The recompute
 * cascade asks it to decide whether a release requests a re-read; the discard prompt asks it to
 * decide whether to warn. They used to ask different questions — the prompt read the stage alone and
 * never the kind — so it fired for five controls that re-read nothing: both brush widths, both gap
 * sliders and the editor's straighten slider (found 2026-09-10). Each of them told a GM with wall
 * edits outstanding that it "decides what counts as ink" and would derive the walls again, which was
 * false on both counts, and confirming did nothing at all.
 *
 * A pipeline parameter of the reading stage, less the graph-only ones: pruning re-applies to a graph
 * already in hand and never goes near the map.
 */
/**
 * Whether changing this replaces the wall graph, and so discards anything edited into it by hand.
 *
 * **Every pipeline parameter, which is a wider net than `rereadsTheMap`** — that one asks whether the
 * expensive first half runs again, which is a question about *cost*. This asks what a change
 * **destroys**, and the answer is the same for all of them: the graph is a pure function of the ink
 * and these numbers, so moving any of them produces a new one and the old one's hand edits are not in
 * it.
 *
 * It covers the two wall controls as well as the five ink ones, which is the point. Straightening and
 * pruning used to be exempt because the editor applied them through buttons of their own against the
 * stored document; with one control each, live, they regenerate like everything else and have to be
 * priced the same way.
 *
 * Also covers the ink **brushes**, whose strokes are pipeline inputs rather than parameters —
 * `settingRows` prices the sliders and `paintTool` prices a stroke, but the rule they share is this
 * one.
 */
export function regeneratesWalls(name: SettingName): boolean {
  return PARAMETER_KIND[name] === "pipeline";
}

export function rereadsTheMap(name: SettingName): boolean {
  return PARAMETER_KIND[name] === "pipeline" && PARAMETER_STAGE[name] === "read" && !isSkeletonOnly(name);
}

/** Every reading-stage pipeline parameter, in `SETTING_LIMITS`' declaration order. */
function readingParameters(): readonly SettingName[] {
  return stageParameters("read").filter((name) => PARAMETER_KIND[name] === "pipeline");
}

/**
 * The identity of the *reading* a set of settings would produce.
 *
 * A strict prefix of what `maskFingerprint` covers: same map, same reading, whatever the filters
 * and repairs above it are set to.
 */
export function readingFingerprint(settings: Settings): string {
  return readingParameters()
    .filter((name) => !POST_READING.includes(name))
    .map((name) => `${name}=${readParameter(settings, name)}`)
    .join(",");
}

/** Whether a parameter is composed on top of the reading rather than feeding it. Exported for the tests. */
export function isPostReading(name: SettingName): boolean {
  return POST_READING.includes(name);
}

/*
  `isStageDefault`, `resetStage` and the `COLOUR_STAGE` that served them were here until 2026-08-31.

  They were the panel's per-stage reset. A.6 replaced them with `isStepDefault` and `resetStep` in
  `steps.ts`, per *step* rather than per stage — the user's reason being that "the reading stage" is a
  phrase about cache invalidation and had stopped naming anything a GM can see. The stage versions
  were left behind with no caller at all.

  `stageParameters` stays: `readingParameters()` uses it below, so it is live despite having no
  external caller.
*/

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
      sauvolaRadiusPx: clamp(trace.sauvolaRadiusPx, "sauvolaRadiusPx", t.sauvolaRadiusPx),
      minStrokeInkWidths: clamp(
        trace.minStrokeInkWidths,
        "minStrokeInkWidths",
        t.minStrokeInkWidths,
      ),
      minIslandPx: clamp(trace.minIslandPx, "minIslandPx", t.minIslandPx),
      blobTolerance: clamp(trace.blobTolerance, "blobTolerance", t.blobTolerance),
      gapFillPx: clamp(trace.gapFillPx, "gapFillPx", t.gapFillPx),
      gapTravelPx: clamp(trace.gapTravelPx, "gapTravelPx", t.gapTravelPx),
      spurPruneGraphUnits: clamp(
        trace.spurPruneGraphUnits,
        "spurPruneGraphUnits",
        t.spurPruneGraphUnits,
      ),
      mendReachGraphUnits: clamp(trace.mendReachGraphUnits, "mendReachGraphUnits", t.mendReachGraphUnits),
      mendTravelGraphUnits: clamp(
        trace.mendTravelGraphUnits,
        "mendTravelGraphUnits",
        t.mendTravelGraphUnits,
      ),
    },
    review: {
      fillOpacity: clamp(review.fillOpacity, "fillOpacity", r.fillOpacity),
      strokeSquares: clamp(review.strokeSquares, "strokeSquares", r.strokeSquares),
    },
    overlay: {
      inkColour: normaliseColour(overlay.inkColour, o.inkColour),
      structureColour: normaliseColour(overlay.structureColour, o.structureColour),
      additiveColour: normaliseColour(overlay.additiveColour, o.additiveColour),
      subtractiveColour: normaliseColour(overlay.subtractiveColour, o.subtractiveColour),
      destructiveColour: normaliseColour(overlay.destructiveColour, o.destructiveColour),
      suppressBrushPx: clamp(overlay.suppressBrushPx, "suppressBrushPx", o.suppressBrushPx),
      inkBrushPx: clamp(overlay.inkBrushPx, "inkBrushPx", o.inkBrushPx),
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

/**
 * Whether a set differs from the defaults, so a surface can say "(edited)" and mean it.
 *
 * **Both sides go through `normaliseSettings`, and that is not belt-and-braces.** `JSON.stringify`
 * serialises in key insertion order, so comparing against the `DEFAULT_SETTINGS` literal directly was
 * equal only while the literal and the normaliser happened to list their fields in the same sequence.
 * They did; nothing enforced it. Reordering `DEFAULT_SETTINGS` for readability would have made this
 * return false forever — every log line reading "(edited)" for a scene at its defaults — and the
 * symptom is quiet enough to live a while. It costs one call to remove the dependency entirely.
 */
export function isDefault(settings: Settings): boolean {
  return (
    JSON.stringify(normaliseSettings(settings)) ===
    JSON.stringify(normaliseSettings(DEFAULT_SETTINGS))
  );
}

/** One line for the log, so a run's numbers can be read beside the settings that produced them. */
export function describeSettings(settings: Settings): string {
  const { trace, review } = settings;
  return (
    `blur ${trace.blurSigma}, k ${trace.sauvolaK}, window ${trace.sauvolaRadiusPx}px, ` +
    `min stroke ${trace.minStrokeInkWidths} ink widths, ` +
    `min island ${trace.minIslandPx}px, ` +
    // Spur pruning belongs in the summary more than most: it is the one control here that can erode
    // the entire graph at its top end, and it went missing when the smallest-room term was removed.
    `prune ${trace.spurPruneGraphUnits.toExponential(2)} graph units; ` +
    `review fill ${review.fillOpacity}, stroke ${review.strokeSquares.toFixed(3)} sq; ` +
    `gaps ${trace.gapFillPx === 0 ? "off" : `up to ${trace.gapFillPx}px, travel ${trace.gapTravelPx}px`}; ` +
    `blob tolerance ${trace.blobTolerance.toFixed(3)}; ` +
    `mends ${
      trace.mendReachGraphUnits === 0
        ? "off"
        : `up to ${trace.mendReachGraphUnits.toExponential(2)}, travel ${trace.mendTravelGraphUnits.toExponential(2)} graph units`
    }` +
    (isDefault(settings) ? " (all defaults)" : " (edited)")
  );
}
