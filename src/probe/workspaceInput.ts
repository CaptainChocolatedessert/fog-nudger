/**
 * Deciding what the workspace probe's input measurements mean.
 *
 * Pulled out of the probe page and kept pure for the reason `viewportSettle` was: these are the
 * parts whose being wrong is **invisible in a room**. A canvas that draws badly is seen; a verdict
 * that is backwards reads as "the modal does not work" rather than "the arithmetic is wrong", and
 * that mistake costs a session in a room, which is the expensive resource here.
 *
 * ## Why any of this is needed rather than just looking
 *
 * The whole point of the surface under test is that it is **opaque**. So the GM cannot see whether
 * Owlbear moved underneath it — the one question that decides whether the surface can own
 * navigation is precisely the one the surface itself hides. It has to be measured, and the only
 * available measurement is asking Owlbear where a fixed world point is now.
 *
 * No DOM, no SDK.
 */

import { STILL_PIXELS, type ScreenPoint } from "./viewportSettle";

/**
 * The input channels a workspace would have to own, kept separate because they can fail
 * independently.
 *
 * A modal might take drags and let the wheel through to Owlbear's zoom, or take both and never
 * see a keystroke. Collapsing them into one "does input work" flag would report the first working
 * channel as success and hide the rest.
 *
 * `other` exists so an attributed movement always has somewhere to go: a movement with no recent
 * input of ours is a real observation — someone else in the room panned, or Owlbear animated a
 * transition — and folding it into whichever channel happened to be nearest would invent a leak.
 */
export type InputChannel = "drag" | "wheel" | "key" | "other";

/** When each channel last saw an event, in `performance.now()` milliseconds. `null` for never. */
export type LastEventTimes = Readonly<Record<InputChannel, number | null>>;

/**
 * How long after one of our events a viewport movement still counts as caused by it.
 *
 * Generous, and deliberately so. Owlbear's transform round-trips through the message bus and the
 * probe polls it on an interval, so a movement caused by a drag is *observed* some way after the
 * drag. Being slow to notice would show as a clean report — no leak found — which is the direction
 * that misleads. An over-attribution says "leaking" and sends someone to look again; an
 * under-attribution says "ours" and closes the question wrongly.
 */
export const ATTRIBUTION_WINDOW_MS = 800;

/**
 * Which of our input channels, if any, a detected viewport movement should be blamed on.
 *
 * The most recent event inside the window wins. Not the *first* — during a drag that also spins
 * the wheel, the last thing the hand did is the better guess, and guessing is what this is.
 *
 * Returns `other` when nothing of ours was recent enough, which is a distinct answer rather than a
 * silent "no". A movement nobody here caused is a fact about the room, not a null result.
 */
export function attributeMovement(
  movedAt: number,
  lastEventAt: LastEventTimes,
  windowMs: number = ATTRIBUTION_WINDOW_MS,
): InputChannel {
  let best: InputChannel = "other";
  let bestAt = -Infinity;

  for (const channel of ["drag", "wheel", "key"] as const) {
    const at = lastEventAt[channel];
    if (at === null) continue;
    // Strictly before the movement: an event timestamped after it cannot have caused it, and
    // clock order within one client is trustworthy even though it is not across clients.
    if (at > movedAt) continue;
    if (movedAt - at > windowMs) continue;
    if (at > bestAt) {
      bestAt = at;
      best = channel;
    }
  }

  return best;
}

/** Whether Owlbear's view has moved, judged the same way the ink overlay judges it. */
export function pointMoved(from: ScreenPoint, to: ScreenPoint): boolean {
  return Math.abs(from.x - to.x) > STILL_PIXELS || Math.abs(from.y - to.y) > STILL_PIXELS;
}

/**
 * What one channel's evidence adds up to.
 *
 * `untested` is the member that earns this being a type rather than a boolean. A channel nobody
 * tried and a channel that leaked nothing produce identical movement counts, and reporting the
 * first as "ours" is exactly the failure DESIGN.md §8 names — a diagnostic that cannot distinguish
 * its outcomes will be believed anyway. The GM has to be told to go and try the wheel, not told
 * the wheel is fine because they never touched it.
 */
export type ChannelVerdict = "untested" | "ours" | "leaking";

export function channelVerdict(events: number, movementsBlamedOnIt: number): ChannelVerdict {
  if (events === 0) return "untested";
  return movementsBlamedOnIt > 0 ? "leaking" : "ours";
}

/**
 * What the keyboard evidence says about focus, which is two questions wearing one name.
 *
 * "Does the modal get keyboard events" and "does it get them *without being clicked first*" are
 * different products. A surface needing a click before a shortcut works is usable; a GM who
 * presses a key and gets nothing, once, will not press it again. So the answer distinguishes them
 * rather than reporting a single flag — and it distinguishes both from "you have not typed
 * anything yet", which is the state the readout spends its first seconds in.
 */
export function describeKeyboardFocus(evidence: {
  readonly hadFocusAtOpen: boolean;
  readonly keysBeforeAnyPointer: number;
  readonly keysAfterAPointer: number;
  /** Whether the page has asked for the keyboard yet. */
  readonly focusWasAsked: boolean;
  /** Keys that arrived *before* it asked, which is the only proof focus was given rather than taken. */
  readonly keysBeforeFocusAttempt: number;
}): string {
  const {
    hadFocusAtOpen,
    keysBeforeAnyPointer,
    keysAfterAPointer,
    focusWasAsked,
    keysBeforeFocusAttempt,
  } = evidence;

  if (keysBeforeAnyPointer > 0) {
    /*
      Three ways a key can arrive with no click, and they are three different products: focus we
      were given, focus we took by asking, and — once the page asks automatically — the two being
      indistinguishable unless the order is recorded. A key that landed before the request is the
      only evidence that no request was needed.
    */
    if (keysBeforeFocusAttempt > 0) {
      return "keys arrive with no click and before we asked — focus is ours on open";
    }
    if (focusWasAsked) {
      return "keys arrive with no click, but only after we asked — asking for the keyboard works";
    }
    return "keys arrive without clicking first";
  }
  if (keysAfterAPointer > 0) {
    return "keys arrive, but only after a click — the modal has to be focused first";
  }
  return hadFocusAtOpen
    ? "no keys yet — the document reports focus, so try typing"
    : "no keys yet, and the document does NOT report focus — try clicking, then typing";
}

/**
 * The line the whole probe exists to produce, in the order the answers matter.
 *
 * Assembled here rather than inline in the page so it can be read without a room, and so an
 * `untested` channel cannot quietly render as a pass.
 */
export function summariseCapture(verdicts: Readonly<Record<"drag" | "wheel", ChannelVerdict>>): string {
  const parts = (["drag", "wheel"] as const).map((channel) => {
    const verdict = verdicts[channel];
    const said =
      verdict === "untested"
        ? "not tried yet"
        : verdict === "ours"
          ? "ours"
          : "LEAKING to Owlbear";
    return `${channel} ${said}`;
  });
  return parts.join(" · ");
}
