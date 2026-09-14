/**
 * Whether a wall action can act, decided before the press rather than after it.
 *
 * ## The rule this applies, which the project already had
 *
 * `toolPalette` states it: *a tool offered in a state where its presses do nothing is a button that
 * lies.* The tool strip has always obeyed it — the wall tools grey out with no graph, the ink tools
 * with no map. **The three wall actions did not.** Straighten, Prune and the frame button were
 * enabled whenever the settings had loaded, and refused *after* the press by writing a sentence to
 * the state line.
 *
 * That sentence is in the bottom-right corner of a full-screen window at 0.75rem, and the button is
 * in the left rail. A room pressed all three, saw nothing happen where it was looking, and reported
 * them as dead (2026-09-09). The message was there; the diagonal is what made it invisible.
 *
 * ## Why a disabled button needs a sentence of its own
 *
 * Greying out alone trades a lying button for a silent one. The tool strip gets away with it because
 * a tool's unavailability has one cause and the step it belongs to says so; these have **two** —
 * there is no saved graph, or the action's own limit is at zero — and they want different answers.
 *
 * - **No graph** returns `NO_GRAPH`, which is empty on purpose. `wallTools` already draws one
 *   sentence at the top of the step for exactly this state, and three copies of it under three
 *   buttons would be noise saying nothing the first did not.
 * - **A limit at zero** is per-action and nothing else says it, so each carries its own line — and
 *   that line is where the prune limit's slider gets named, since the slider lives in **Walls** and
 *   the button was in **Edit walls**, a group that no longer exists. Naming it is what a second handle would otherwise have been
 *   for, and a second handle is forbidden: two sliders on one setting, both reachable at once on a
 *   rail that no longer forces a section shut, disagree the moment either moves.
 */

/**
 * Blocked, with nothing to add. The step's own empty-state sentence is the explanation.
 *
 * An empty string rather than a boolean so the three states — can act, blocked silently, blocked
 * with a reason — are one value a caller cannot get half-right.
 */
export const NO_GRAPH = "";

/**
 * Why an action cannot act, or `null` when it can.
 *
 * `limit` is the action's own threshold and its explanation. Omit it for an action that needs only a
 * graph, which is the frame button: it adds walls rather than removing them, so there is no ceiling
 * on what it would take.
 *
 * **Pure, and takes the graph as a boolean rather than reading it.** The rest of this module touches
 * the DOM and cannot be imported into a node test; this half is the decision, and it is the half
 * worth pinning — which is the same split the gesture deciders were pulled out along.
 */
export function actionBlocked(
  /** Whether a graph is saved for this map. Passed in rather than read, which is what keeps this pure. */
  hasGraph: boolean,
  limit?: {
    readonly value: number;
    /** Shown under the button, naming the control that lifts it and which step holds that control. */
    readonly reason: string;
  },
): string | null {
  // The graph first, and the order is the point: with nothing to act on, a limit at zero is not the
  // reason the button is dead, and saying so would send a GM to the wrong slider.
  if (!hasGraph) return NO_GRAPH;
  if (limit && !(limit.value > 0)) return limit.reason;
  return null;
}

/**
 * Put a decided state onto the button and its note.
 *
 * `live` is threaded in rather than read here so this module does not depend on the settings
 * lifecycle: before the stored settings arrive every control is disabled regardless, and that is a
 * different statement from "this action cannot act".
 */
export function applyActionGate(
  button: HTMLButtonElement,
  note: HTMLElement,
  ready: string,
  live: boolean,
): void {
  const blocked = actionBlockedFor(button);
  button.disabled = !live || blocked !== null;
  // A ready note says something about the act itself, so it must not be shown beside a button that
  // cannot act. All three are empty today; the mechanism is kept for the note that earns a place.
  note.innerHTML = blocked === null ? ready : blocked;
}

/**
 * The gate a button was last built with, so a refresh can re-ask the same question.
 *
 * Held on the element rather than in a module map: the rail rebuilds these wholesale, and a map
 * keyed by id would go on holding a closure over a detached button after every rebuild.
 */
const gates = new WeakMap<HTMLButtonElement, () => string | null>();

export function setActionGate(button: HTMLButtonElement, gate: () => string | null): void {
  gates.set(button, gate);
}

function actionBlockedFor(button: HTMLButtonElement): string | null {
  const gate = gates.get(button);
  return gate ? gate() : null;
}
