/**
 * Finding breaks in the linework — the failure that matters most, made visible.
 *
 * A wall with a section missing merges two rooms into one region, and a merged region is this
 * project's worst outcome: the fog opens on a room nobody has entered. A GM cannot be asked to
 * scan a whole map for a four-pixel crack, and `DESIGN.md` §8 forbids answering that with a warning
 * in a log nobody reads. So the breaks are found and drawn.
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
 * 1. **A closing** at the gap radius. What it converts from ground to ink is exactly the set of
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
 * ## Both thresholds are in raster pixels
 *
 * Stage one stays close to the raster (`DESIGN.md` §5, as amended). Denominating these in measured
 * ink widths was the first plan and was dropped: the ink width is itself a measurement that can
 * come out oddly on an unusual map, and a threshold that moves with it would make the marks change
 * for reasons the GM has no way to see.
 *
 * ## What it will get wrong, stated rather than discovered
 *
 * **A double-line wall.** Where a map draws walls as two parallel strokes with white between, that
 * white is a narrow channel and the two strokes are far apart along the ink — they meet only at the
 * ends of a run. Every hollow wall would be marked. It comes out as one mark per wall run rather
 * than a shower of them, and the width control tunes it away; on such a map bridging is arguably
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

import { emptyMask, type BinaryMask } from "./binarize";
import { closeMask, radiusForWidth } from "./morphology";

/** One break, as the surface needs to draw it. */
export interface GapMark {
  /** Centre of the channel, in raster pixels. */
  readonly x: number;
  readonly y: number;
  /** The longer side of the channel's bounding box, in raster pixels. */
  readonly span: number;
  /** How many ground pixels the channel holds. */
  readonly area: number;
}

export interface GapOptions {
  /** The widest break to look for, in raster pixels. Zero is off. */
  readonly widthPx: number;
  /**
   * How far two banks may be apart along the ink and still count as one piece, in raster pixels.
   *
   * Zero is meaningful rather than off: it marks every channel that passes through, which is the
   * loudest the detector goes.
   */
  readonly travelPx: number;
}

export interface GapFinding {
  /** The pixels of the channels judged to be breaks, for painting. Empty when the control is off. */
  readonly mask: BinaryMask;
  readonly marks: readonly GapMark[];
  /** The closing radius used, in raster pixels. Zero means the control rounded to nothing. */
  readonly radius: number;
  /** Narrow channels the closing found, before any sifting. */
  readonly channels: number;
  /** Of those, how many pass through rather than being a dead end. */
  readonly through: number;
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
 */
const FLOOD_BUDGET = 40_000_000;

export function findGaps(mask: BinaryMask, options: GapOptions): GapFinding {
  const { width, height } = mask;
  const radius = radiusForWidth(options.widthPx);
  const empty: GapFinding = {
    mask: emptyMask(width, height),
    marks: [],
    radius,
    channels: 0,
    through: 0,
    budgetHits: 0,
  };
  if (radius <= 0 || width === 0 || height === 0) return empty;

  const closed = closeMask(mask, radius);
  const out = emptyMask(width, height);

  // Which channel pixels have been claimed already. Ground that the closing left alone is never a
  // candidate, so this doubles as the candidate test.
  const claimed = new Uint8Array(width * height);
  // Reused across channels rather than reallocated: the flood clears only what it touched.
  const reached = new Uint8Array(width * height);

  const marks: GapMark[] = [];
  let channels = 0;
  let through = 0;
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

    const spent = floodFromFirstGroup(mask, banks, groups, reached, width, height, options.travelPx, budget);
    budget -= spent.visited;
    if (spent.exhausted) budgetHits += 1;
    if (spent.allReached) continue;

    for (const index of pixels) out.data[index] = 1;
    marks.push(describe(pixels, width));
  }

  return { mask: out, marks, radius, channels, through, budgetHits };
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
          // Ink: a bank. Recorded once, which the flood's own bookkeeping enforces below.
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
function groupBanks(
  banks: readonly number[],
  width: number,
  height: number,
): BankGroups {
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
    // Two groups is already the answer to "does it pass through"; counting the rest is only for
    // reporting, and the flood below needs the first group alone.
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

/** Where to draw the mark, and how big the thing it is marking is. */
function describe(pixels: readonly number[], width: number): GapMark {
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
  };
}
