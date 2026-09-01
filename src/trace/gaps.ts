/**
 * Finding breaks in the linework, and repairing the ones the GM says to repair.
 *
 * A wall with a section missing merges two rooms, and a merged region is this project's worst
 * outcome: the fog opens on a room nobody has entered. A GM cannot be asked to scan a whole map for
 * a four-pixel crack, and `DESIGN.md` §8 forbids answering that with a warning in a log nobody
 * reads. So the breaks are found, repaired, and **drawn** — every invented pixel in its own colour
 * with a ring round it, because ink this stage made up must never look like ink the map contains.
 *
 * ## What counts as a gap, and the two definitions this replaced
 *
 * > **A gap is a narrow channel of ground whose banks of ink are far apart when measured *along the
 * > ink*.**
 *
 * Two earlier definitions were tried against real cases and both failed:
 *
 * - **"A break that separates the space when sealed."** Exact-sounding, and wrong: it tests the
 *   *space* when the question is about the integrity of the *ink*. A freestanding wall standing in
 *   the middle of a room separates nothing, so a crack in it would never be reported — yet it is
 *   just as broken, and a map may have a great many meaningful walls inside one area of space.
 * - **"A break between two different ink blobs."** Fails on a crack in a ring, where both banks
 *   belong to the same blob by way of the long trip round the other side.
 *
 * Both are fixed by asking the question locally. Two ink pixels three pixels apart across a crack,
 * where getting from one to the other *through the ink* means travelling most of the way round a
 * room, are two different pieces of wall whatever the global labelling says. Two ink pixels three
 * pixels apart across a ragged notch in one wall's edge, where the trip through the ink is eight
 * pixels, are the same stroke. That is the whole discriminator.
 *
 * ## How it is computed, in three steps
 *
 * 1. **A closing** at the search radius. What it converts from ground to ink is exactly the set of
 *    narrow channels: cracks, notches, enclosed pockets, and the hollow interiors of double-line
 *    walls. That is the candidate set and nothing more.
 * 2. **The bank groups.** The ink touching one channel, grouped into the pieces it arrives in. A
 *    channel with **one** group is a dead end — a notch or a pocket — because its banks wrap round
 *    it continuously. A channel that passes *through* necessarily has ground at both its ends, so
 *    its banks arrive as two or more separate faces. This step alone throws out the ragged-edge
 *    noise that a raw closing produces in quantity, and it costs nothing.
 * 3. **The travel test.** Flood outwards through the ink from one whole bank group, no further than
 *    the travel distance. If every other bank is reached, the ink is locally one piece and the
 *    channel is not a gap. If any bank is left unreached, the banks are locally different pieces
 *    and this is a break.
 *
 * Travel is measured through the ink rather than inside a cropped window on purpose: a wall that
 * bulges out of a window and back is still one wall, and travel says so where a crop would not.
 *
 * ## One width, not two — and the reason is a fact about maps
 *
 * Finding and repairing were briefly separate controls: a width to *highlight* candidates, and a
 * share of it to select which got *repaired*, so a GM could settle a stable set of places worth
 * attention and then sweep the repair against it. **That was abandoned on evidence from a room**
 * (user, 2026-08-23), because its premise turned out to be false.
 *
 * Breaks are not discrete items discovered one at a time as the width rises. Where two uneven lines
 * run close together, a closing carves the space between them into several channels at the pinch
 * points, and those channels **merge into one** as the radius grows. So a break has no stable
 * identity across radii — and because a channel was only repaired when *all* of it fell inside the
 * fill radius, raising the highlight could **prevent** a repair that a lower one allowed.
 * Non-monotonic, and unexplainable to anyone turning the knob.
 *
 * One width is well behaved for a precise reason: what a GM is then tuning is the **set of pixels
 * repaired**, which grows with the radius, rather than a set of discrete marks, which does not. The
 * channel count still moves around as channels merge — that is a diagnostic, not the thing being
 * adjusted, and it should not be read as a tally of distinct faults.
 *
 * Everything found is therefore repaired, with exactly one exception: a channel whose flood ran out
 * of budget was never *proved* broken. Marking on a guess is a warning; inventing ink on a guess is
 * not. Those carry a mark and no fill.
 *
 * > **Every pixel the fill invents belongs to a break that has a mark on it.**
 *
 * ## Why the fill is not simply a closing
 *
 * Morphologically a repair *is* a closing, and the obvious implementation is to close the mask at
 * the fill radius and keep the result. That would be wrong, and dangerously so. A blanket closing
 * also seals channels that **failed the travel test** — and the clearest example of one is a narrow
 * doorway right beside a corner, where the two banks meet round the corner within a short travel.
 * It would be sealed with nothing at all to see, where an opening's failures at least leave a
 * visible absence. Dynamic Fog would then derive a wall across an open door and block line of sight
 * through it, silently.
 *
 * So the fill adds the pixels of **marked breaks** and nothing else. A dead end is never filled,
 * which costs nothing: a dead end connects nothing to anything, so sealing it could not have helped.
 *
 * **The claim above is per CHANNEL, and that is weaker than it first reads.** The verdict is one per
 * channel and applies to all of its pixels, and channels *merge* as the radius rises. So a doorway
 * narrow enough for the closing to reach — which is a channel like any other — can merge with a
 * nearby genuine break into a single channel, fail the travel test because of the break, and be
 * filled along with it. The very outcome this section argues the design prevents is reachable that
 * way, and a future session reading the argument alone would not know to look for it.
 *
 * What keeps it honest is that it is **not silent**: the merged channel carries a ring and its
 * invented pixels are painted purple at full alpha, so a GM on the Breaks step sees purple lying
 * across their doorway. That is the visual channel §8 demands, and it is the reason the fill is drawn
 * at full alpha rather than tinted down with the ink.
 *
 * Not fixed rather than not noticed: splitting a channel at its pinch points before deciding would
 * re-introduce the unstable mark set that a room already rejected — marks that appear and vanish as
 * the radius moves, with a repair that a *lower* setting allowed becoming impossible at a higher one.
 *
 * ## Both settings are in raster pixels
 *
 * Stage one stays close to the raster (`DESIGN.md` §5, as amended). Denominating these in measured
 * ink widths was the first plan and was dropped: the ink width is itself a measurement that can
 * come out oddly on an unusual map, and a threshold that moved with it would make the marks change
 * for reasons the GM has no way to see.
 *
 * ## What it will get wrong, stated rather than discovered
 *
 * **A double-line wall.** Where a map draws walls as two parallel strokes with white between, that
 * white is a narrow channel and the two strokes are far apart along the ink — they meet only at the
 * ends of a run. Every hollow wall would be filled solid. It comes out as one mark per wall run
 * rather than a shower of them, and the width control tunes it away; on such a map filling them is
 * arguably the right answer rather than the detector being wrong.
 *
 * **A speck of ink lying close to a wall.** Two locally different pieces, so a gap. Guardable by
 * demanding both sides amount to a real stroke, which is not done here — a speck that close to a
 * wall is worth a glance, and the island filter one stage earlier is the tool for removing it.
 *
 * ## Travel is counted in steps, not in Euclidean distance
 *
 * A diagonal step costs the same as an orthogonal one, so the flood reaches up to about 1.4x
 * further than the setting says along a diagonal run of ink. That errs towards calling two banks
 * the same piece, which is the quiet direction — worth knowing, since a quiet warning is the one
 * failure mode a warning cannot survive. It is a factor the control can absorb.
 *
 * Pure: no DOM, no SDK.
 */

import type { BinaryMask } from "./binarize";
import { closeMask, radiusForWidth } from "./morphology";

/** Nothing here. */
export const GAP_NONE = 0;
/** A break that was found but not repaired — the flood ran out of budget, so it is only a guess. */
export const GAP_OPEN = 1;
/** A break that was found and repaired — ink this stage invented. */
export const GAP_FILLED = 2;

/**
 * One value per pixel: `GAP_NONE`, `GAP_OPEN` or `GAP_FILLED`.
 *
 * Three states rather than two masks, because the two sets are disjoint by construction and the
 * surface draws them in one pass. It is also what the pipeline reads to decide which pixels to add
 * to the ink — exactly the `GAP_FILLED` ones.
 */
export interface GapLabels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** One break, as the surface needs to draw it. */
export interface GapMark {
  /** Centre of the channel's bounding box — the same box `span` measures — in raster pixels. */
  readonly x: number;
  readonly y: number;
  /** The longer side of the channel's bounding box, in raster pixels. */
  readonly span: number;
  /** How many ground pixels the channel holds. */
  readonly area: number;
  /** Whether the fill closed this one. Decides the ring's colour. */
  readonly filled: boolean;
}

export interface GapOptions {
  /**
   * The widest break to find and repair, in raster pixels. Zero is off.
   *
   * Named to match the setting, `gapFillPx`. That setting was renamed from `gapWidthPx` because
   * "width" meant *highlight only* under the two-control design, and a scene storing the old key
   * would have silently started inventing ink at a width chosen for looking at.
   */
  readonly fillPx: number;
  /**
   * How far two banks may be apart along the ink and still count as one piece, in raster pixels.
   *
   * Zero is meaningful rather than off: it repairs every break that passes through, which is the
   * most eager the detector gets.
   */
  readonly travelPx: number;
  /**
   * Total flood work allowed, in pixel visits. Defaults to `FLOOD_BUDGET`.
   *
   * Overridable only so a test can reach the exhausted state on a fixture small enough to read —
   * the same arrangement `graphRegions.ts` uses for its command cap. Nothing in the UI sets it: it is
   * a guard against a pathological map, not a control.
   */
  readonly floodBudget?: number;
}

export interface GapFinding {
  readonly labels: GapLabels;
  readonly marks: readonly GapMark[];
  /** The closing radius the search ran at. Zero means the control rounded to nothing, or is off. */
  readonly searchRadius: number;
  /** Narrow channels the closing found, before any sifting. */
  readonly channels: number;
  /** Of those, how many pass through rather than being a dead end. */
  readonly through: number;
  /** How many marks were filled. */
  readonly filled: number;
  /** How many pixels of ink the fill invented. */
  readonly filledArea: number;
  /** Channels marked because the flood budget ran out rather than because the ink was broken. */
  readonly budgetHits: number;
}

/**
 * A ceiling on the total flood work, in pixel visits.
 *
 * The depth limit already bounds one channel's flood to the ink inside a disc of the travel
 * distance, so this only bites when a map has very many through-channels *and* the travel setting
 * is large — a combination that is reachable, since the control deliberately runs well past useful.
 * Channels left unexamined are marked rather than dropped: a warning that goes quiet under load is
 * the one failure a warning cannot survive, and the count is reported so the cause is visible.
 *
 * A channel marked this way is **not** filled, whatever the fill radius is. Marking on a guess is a
 * warning; inventing ink on a guess is not.
 *
 * ## It is spent across the whole call and does not renew, which has three consequences
 *
 * None of these was documented, and the second is the one that matters.
 *
 * - **The budget can go slightly negative.** The check sits at the top of the depth loop, so a flood
 *   overshoots by at most one frontier expansion. Harmless, and clamped at zero below so that
 *   "exhausted" is a state arrived at deliberately rather than through a negative number.
 * - **Once it is spent, every remaining channel exhausts at depth zero** — the first bank group is at
 *   least one pixel, so the very first check fails. Those channels are marked `GAP_OPEN` and never
 *   filled, without a single step of flood having been walked. So exhaustion does not degrade the
 *   answer gradually; it converts every channel after it into a guess.
 * - **Channel order therefore decides which ones get a real answer.** The scan is raster order, so on
 *   a map that exhausts the budget the top is examined properly and the bottom is guessed, with
 *   nothing in the output saying where the line fell.
 *
 * **This is why the `GAP_OPEN` state is not a candidate for deletion.** The record had it as a state
 * never observed, and therefore possibly machinery for a case that does not happen. It is reachable in
 * bulk: a map with hundreds of through-channels at a high travel setting spends 40M and guesses the
 * rest.
 */
const FLOOD_BUDGET = 40_000_000;

export function findGaps(mask: BinaryMask, options: GapOptions): GapFinding {
  const { width, height } = mask;
  const searchRadius = radiusForWidth(options.fillPx);

  const empty: GapFinding = {
    labels: { width, height, data: new Uint8Array(width * height) },
    marks: [],
    searchRadius,
    channels: 0,
    through: 0,
    filled: 0,
    filledArea: 0,
    budgetHits: 0,
  };
  if (searchRadius <= 0 || width === 0 || height === 0) return empty;

  const closed = closeMask(mask, searchRadius);

  const labels = new Uint8Array(width * height);

  // Which channel pixels have been claimed already. Ground that the closing left alone is never a
  // candidate, so this doubles as the candidate test.
  const claimed = new Uint8Array(width * height);
  // Reused across channels rather than reallocated: the flood clears only what it touched.
  const reached = new Uint8Array(width * height);

  const marks: GapMark[] = [];
  let channels = 0;
  let through = 0;
  let filledCount = 0;
  let filledArea = 0;
  let budgetHits = 0;
  let budget = options.floodBudget ?? FLOOD_BUDGET;

  const pixels: number[] = [];
  const banks: number[] = [];

  for (let seed = 0; seed < claimed.length; seed++) {
    if (closed.data[seed] !== 1 || mask.data[seed] === 1 || claimed[seed] === 1) continue;

    channels += 1;
    collectChannel(closed, mask, claimed, seed, pixels, banks);

    const groups = groupBanks(banks, width, height);
    if (groups.count < 2) continue; // A dead end: a notch, or a pocket the ink encloses.
    through += 1;

    const spent = floodFromFirstGroup(
      mask,
      banks,
      groups,
      reached,
      width,
      height,
      options.travelPx,
      budget,
    );
    // Clamped rather than allowed to go negative. A flood overshoots the remaining budget by at
    // most one frontier expansion, so this subtracts more than was left; the behaviour is identical
    // either way, and zero makes "exhausted" a state the code says rather than one it implies.
    budget = Math.max(0, budget - spent.visited);
    if (spent.exhausted) budgetHits += 1;
    if (spent.allReached) continue;

    // Everything found is repaired, with one exception: a channel whose flood ran out of budget was
    // never *proved* broken, and marking on a guess is a warning where inventing ink on a guess is
    // not. Those carry a mark and no fill, which reads on the surface as a ring with nothing in it.
    const fills = !spent.exhausted;
    const state = fills ? GAP_FILLED : GAP_OPEN;
    for (const index of pixels) labels[index] = state;
    if (fills) {
      filledCount += 1;
      filledArea += pixels.length;
    }

    marks.push(describe(pixels, width, fills));
  }

  return {
    labels: { width, height, data: labels },
    marks,
    searchRadius,
    channels,
    through,
    filled: filledCount,
    filledArea,
    budgetHits,
  };
}

/**
 * Add the filled breaks to the ink.
 *
 * The whole of what the repair writes. Returns the input untouched when nothing was filled, which
 * is the default and has to stay exactly true — a map whose GM never reaches for the fill must get
 * the same mask it got before this existed.
 */
export function applyGapFill(mask: BinaryMask, labels: GapLabels): BinaryMask {
  let filled = 0;
  for (let i = 0; i < labels.data.length; i++) if (labels.data[i] === GAP_FILLED) filled += 1;
  if (filled === 0) return mask;

  const out: BinaryMask = {
    width: mask.width,
    height: mask.height,
    data: Uint8Array.from(mask.data),
  };
  for (let i = 0; i < labels.data.length; i++) {
    if (labels.data[i] === GAP_FILLED) out.data[i] = 1;
  }
  return out;
}

/**
 * Gather one channel and the ink around it.
 *
 * Eight-connected, matching the pairing rule this project holds everywhere: a crack that runs
 * diagonally is one channel rather than a dotted line of them, and its banks include ink that only
 * touches it at a corner.
 */
function collectChannel(
  closed: BinaryMask,
  mask: BinaryMask,
  claimed: Uint8Array,
  seed: number,
  pixels: number[],
  banks: number[],
): void {
  const { width, height } = mask;
  pixels.length = 0;
  banks.length = 0;

  // A pixel-index stack rather than recursion: a channel can run the width of the map, and that is
  // not a call stack any browser will give us.
  const stack: number[] = [seed];
  claimed[seed] = 1;

  while (stack.length > 0) {
    const index = stack.pop()!;
    pixels.push(index);
    const x = index % width;
    const y = (index - x) / width;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighbour = ny * width + nx;

        if (mask.data[neighbour] === 1) {
          // Ink: a bank. Duplicates are harmless — the grouping below works from a set.
          banks.push(neighbour);
          continue;
        }
        if (closed.data[neighbour] !== 1 || claimed[neighbour] === 1) continue;
        claimed[neighbour] = 1;
        stack.push(neighbour);
      }
    }
  }
}

interface BankGroups {
  /** How many separate faces the banks arrive in. */
  readonly count: number;
  /** The bank pixels belonging to the first face, seeded whole so a long face is not split by it. */
  readonly first: number[];
}

/**
 * Split the bank pixels into the faces they arrive in.
 *
 * Grouped by adjacency **within the bank set**, which is what makes the count mean "does this
 * channel pass through". Around a dead end the banks wrap continuously and come out as one; across
 * a break the two faces are separated at both ends by the ground the break opens into.
 *
 * The first group is returned whole rather than as a single pixel, and that matters: the flood is
 * seeded from all of it at once, so a bank running the length of a long channel cannot be judged
 * "far from itself".
 */
function groupBanks(banks: readonly number[], width: number, height: number): BankGroups {
  const members = new Set(banks);
  const seen = new Set<number>();
  let count = 0;
  let first: number[] = [];

  for (const start of members) {
    if (seen.has(start)) continue;
    count += 1;
    const group: number[] = [];
    const stack: number[] = [start];
    seen.add(start);

    while (stack.length > 0) {
      const index = stack.pop()!;
      group.push(index);
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (!members.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
    }

    if (count === 1) first = group;
  }

  return { count, first };
}

interface FloodResult {
  readonly allReached: boolean;
  readonly visited: number;
  readonly exhausted: boolean;
}

/**
 * Walk the ink outwards from one bank, and see whether the others are within reach.
 *
 * Breadth-first over 8-connected ink, seeded with the whole of the first bank group at depth zero
 * and stopped at the travel distance. Reaching every other bank means the banks are one piece of
 * linework that happens to be pinched here; failing to means they are different pieces, which is a
 * break.
 */
function floodFromFirstGroup(
  mask: BinaryMask,
  banks: readonly number[],
  groups: BankGroups,
  reached: Uint8Array,
  width: number,
  height: number,
  travelPx: number,
  budget: number,
): FloodResult {
  const limit = Math.max(0, Math.floor(travelPx));
  const touched: number[] = [];
  let frontier: number[] = [];

  for (const index of groups.first) {
    if (reached[index] === 1) continue;
    reached[index] = 1;
    touched.push(index);
    frontier.push(index);
  }

  let exhausted = false;
  for (let depth = 0; depth < limit && frontier.length > 0; depth++) {
    if (touched.length >= budget) {
      exhausted = true;
      break;
    }
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (mask.data[neighbour] !== 1 || reached[neighbour] === 1) continue;
          reached[neighbour] = 1;
          touched.push(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }

  // An exhausted flood has not proved the ink intact, so it is reported as a break — loud is the
  // safe direction for a warning, and `budgetHits` says how many marks came from here.
  let allReached = !exhausted;
  if (allReached) {
    for (const index of banks) {
      if (reached[index] !== 1) {
        allReached = false;
        break;
      }
    }
  }

  for (const index of touched) reached[index] = 0;
  return { allReached, visited: touched.length, exhausted };
}

/** Where to draw the mark, how big the thing it is marking is, and whether it was repaired. */
function describe(pixels: readonly number[], width: number, filled: boolean): GapMark {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // The bounding box's centre, not the centroid. `span` is that box's longer side and the ring is
  // drawn from both, so a centroid would put the ring off-centre from the thing sizing it. A merged
  // channel is L-shaped or forked — and merging is the normal case as the radius rises — which is
  // exactly where a centroid can land outside the channel altogether, ringing sound ink while the
  // repair sits at the ring's edge. Neither measure guarantees a point inside a concave channel;
  // this one at least agrees with the radius.
  const area = pixels.length;
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    span: Math.max(maxX - minX + 1, maxY - minY + 1),
    area,
    filled,
  };
}
