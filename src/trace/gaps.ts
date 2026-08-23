/**
 * Finding breaks in the linework, and repairing the ones the GM says to repair.
 *
 * A wall with a section missing merges two rooms, and a merged region is this project's worst
 * outcome: the fog opens on a room nobody has entered. A GM cannot be asked to scan a whole map for
 * a four-pixel crack, and `DESIGN.md` §8 forbids answering that with a warning in a log nobody
 * reads. So the breaks are found, drawn, and — separately, on the GM's judgement — filled.
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
 * ## Marking places the candidates; filling selects among them
 *
 * `widthPx` decides what is **shown**; `fillPx` decides which of those is **repaired**, and the
 * second is never allowed to exceed the first. The point of separating them (user, 2026-08-23) is
 * that a GM can settle the marking width to get a stable set of places worth attention, then sweep
 * the fill and watch how many of that fixed set turn from open to filled — judging the trade with
 * the reference set held still underneath it.
 *
 * **The control that drives `fillPx` is a share of the marking width**, from nothing to all of it,
 * so there is no position on its track that means "wider than what is marked". That is where the
 * relationship is enforced; what this function does is honour it rather than assume it, by running
 * the search at the larger of the two radii. Either way the invariant holds:
 *
 * > **Every pixel the fill invents belongs to a break that has a mark on it.**
 *
 * The `max` is therefore unreachable through the controls, and it stays because this is a pure
 * function with its own contract: a caller that passes a wider fill gets a wider search, not a
 * silent repair of something it was never shown.
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
 * ## Both thresholds are in raster pixels
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
 * ends of a run. Every hollow wall would be marked. It comes out as one mark per wall run rather
 * than a shower of them, and the width control tunes it away; on such a map filling them is arguably
 * the right answer rather than the mark being wrong.
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
/** A break that was found and left open. */
export const GAP_OPEN = 1;
/** A break that was found and filled — ink this stage invented. */
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
  /** Centre of the channel, in raster pixels. */
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
  /** The widest break to highlight, in raster pixels. */
  readonly widthPx: number;
  /**
   * How far two banks may be apart along the ink and still count as one piece, in raster pixels.
   *
   * Zero is meaningful rather than off: it marks every break that passes through, which is the
   * loudest the detector goes.
   */
  readonly travelPx: number;
  /** The widest highlighted break to fill, in raster pixels. Zero fills nothing. */
  readonly fillPx: number;
}

export interface GapFinding {
  readonly labels: GapLabels;
  readonly marks: readonly GapMark[];
  /** The radius the search ran at — the larger of the two settings. */
  readonly searchRadius: number;
  /** The radius a break had to fall inside to be filled. Zero means the fill is off. */
  readonly fillRadius: number;
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
 */
const FLOOD_BUDGET = 40_000_000;

export function findGaps(mask: BinaryMask, options: GapOptions): GapFinding {
  const { width, height } = mask;
  const markRadius = radiusForWidth(options.widthPx);
  const fillRadius = radiusForWidth(options.fillPx);
  const searchRadius = Math.max(markRadius, fillRadius);

  const empty: GapFinding = {
    labels: { width, height, data: new Uint8Array(width * height) },
    marks: [],
    searchRadius,
    fillRadius,
    channels: 0,
    through: 0,
    filled: 0,
    filledArea: 0,
    budgetHits: 0,
  };
  if (searchRadius <= 0 || width === 0 || height === 0) return empty;

  const closed = closeMask(mask, searchRadius);
  // One closing when the fill is off or is itself the wider of the two, which is the common case:
  // a GM sweeping the fill up towards the highlight pays for a second closing, and stops paying for
  // it the moment they push past.
  const closedFill =
    fillRadius <= 0 ? null : fillRadius === searchRadius ? closed : closeMask(mask, fillRadius);

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
  let budget = FLOOD_BUDGET;

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
    budget -= spent.visited;
    if (spent.exhausted) budgetHits += 1;
    if (spent.allReached) continue;

    // Filled only when the whole channel falls inside the fill radius. A break sealed along part of
    // its length is still a break at the rest of it, so a partial fill is no fill at all — and the
    // ring must stay open to say so. A guessed channel is never filled, whatever its width.
    const fills = closedFill !== null && !spent.exhausted && allFilled(pixels, closedFill);
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
    fillRadius,
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

function allFilled(pixels: readonly number[], closedFill: BinaryMask): boolean {
  for (const index of pixels) {
    if (closedFill.data[index] !== 1) return false;
  }
  return true;
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
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const area = pixels.length;
  return {
    x: sumX / area,
    y: sumY / area,
    span: Math.max(maxX - minX + 1, maxY - minY + 1),
    area,
    filled,
  };
}
