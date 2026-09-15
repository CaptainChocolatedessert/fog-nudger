/**
 * Which layers are on, and the one rule that keeps that predictable.
 *
 * ## Why this exists
 *
 * A step used to decide what the canvas drew, and exclusivity made that unambiguous: one expanded
 * heading, one set of layers. With several expandable at once the union is a reasonable default and
 * a poor rule — it means the only way to stop seeing something is to collapse the controls for it,
 * which is navigation being used as a visibility switch.
 *
 * So the groups *propose* and the GM *disposes*.
 *
 * ## A tool may turn a layer on. It may never turn one off.
 *
 * Picking a wall tool brings the graph up if it was down, because you cannot edit what you cannot
 * see. Nothing you switched on disappears because you changed tools. **Monotone in the safe
 * direction**, and it is what stops this re-creating the coupling the tool strip was built to
 * remove: the tool nudges, and the GM's own answer is final.
 *
 * The cost is that things accumulate — after reaching for every tool, everything is on. That is why
 * the toggles are a visible row rather than something buried: the way back has to be as cheap as the
 * way there.
 *
 * ## Suppressed rather than selected
 *
 * The state kept here is what the GM has switched **off**, not what is on. That is what makes the
 * two rules above composable: a group expanding or a tool being picked can add to the proposal
 * freely, and one small set subtracts from it. Holding the positive set instead would mean every
 * proposal having to decide whether it was allowed to add, which is the same tangle one level up.
 *
 * Not stored in the scene: it is what the GM is looking at rather than a setting, and a workspace
 * that reopened with a layer hidden from last session would be hiding something for a reason nobody
 * could see.
 *
 * Six mutations tried, six caught: `requireLayer` replacing rather than adding, `requireLayer`
 * un-hiding, the duplicate guard removed, `visibleLayers` ignoring the hidden set, a proposal
 * clearing it, and a toggle that only hides.
 */

import { LAYERS, type LayerId } from "../steps";

/** What the GM has switched off. Empty is the ordinary state. */
const hidden = new Set<LayerId>();

/** What the expanded groups and the tool in hand between them ask for. */
let proposed: readonly LayerId[] = [];

const listeners: (() => void)[] = [];

export function onLayerChange(listener: () => void): void {
  listeners.push(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * What the groups want drawn. Replaces the previous proposal wholesale.
 *
 * Called by the rail whenever what is expanded changes, and by the tool strip when the tool does.
 */
export function proposeLayers(layers: readonly LayerId[]): void {
  /*
    **Unchanged means silent**, which is a correctness rule rather than an optimisation.

    The strip re-proposes on every render, and a listener that re-renders the drawer would then
    render the strip, which proposes again — an unbounded loop from two things each doing the
    right thing. Announcing only a real change breaks it at the source.
  */
  const same =
    proposed.length === layers.length && proposed.every((layer, at) => layers[at] === layer);
  proposed = layers;
  if (!same) announce();
}

/**
 * Add to the proposal without disturbing what is already in it.
 *
 * The "a tool may turn a layer on" half. Kept separate from `proposeLayers` so the direction is
 * visible at the call site: one replaces and one only adds, and confusing them is how a tool would
 * come to take a layer away.
 */
export function requireLayer(layer: LayerId): void {
  if (proposed.includes(layer)) return;
  proposed = [...proposed, layer];
  announce();
}

/** What the canvas should actually draw: what was asked for, minus what the GM turned off. */
export function visibleLayers(): readonly LayerId[] {
  return proposed.filter((layer) => !hidden.has(layer));
}

/** Whether a layer is being asked for at all, which is what decides if its toggle is meaningful. */
export function layerProposed(layer: LayerId): boolean {
  return proposed.includes(layer);
}

export function layerHidden(layer: LayerId): boolean {
  return hidden.has(layer);
}

export function toggleLayer(layer: LayerId): void {
  if (hidden.has(layer)) hidden.delete(layer);
  else hidden.add(layer);
  announce();
}

/** Every layer, in declaration order, for whoever draws the row. */
/**
 * Show everything, or hide everything that is proposed.
 *
 * **The one press that gets back to a plain map**, which is the state this surface most needs and
 * had lost when the picture became constant: with four layers always on, turning them off one at a
 * time is four presses to see the image you are tracing.
 *
 * It writes the *hidden* set, like every other route here — showing everything is forgetting what
 * was switched off, and hiding everything is switching off exactly what is currently proposed. A
 * layer that arrives later is therefore shown, which is right: hiding is a statement about the
 * layers you were looking at, not a standing order about ones you have not met.
 */
export function showAllLayers(): void {
  if (hidden.size === 0) return;
  hidden.clear();
  announce();
}

/**
 * Hide exactly what was offered, which is **not** everything proposed.
 *
 * A tool's own marks are proposed too and have no switch, so sweeping them into the hidden set
 * would turn off something the GM was never offered and cannot see a way back to.
 */
export function hideAllLayers(layers: readonly LayerId[]): void {
  const before = hidden.size;
  for (const layer of layers) hidden.add(layer);
  if (hidden.size !== before) announce();
}

/** Whether anything proposed is currently switched off, which is what the show-all button asks. */
export function anyLayerHidden(layers: readonly LayerId[]): boolean {
  return layers.some((layer) => hidden.has(layer));
}

export function allLayers(): readonly LayerId[] {
  return LAYERS;
}
