/**
 * The row of layer switches, in the rail's head.
 *
 * ## Why it is here and not in the View group
 *
 * The View group is where *how* a layer is drawn lives — its colour, its opacity. This is whether it
 * is drawn at all, which is a thing a GM reaches for while looking at the map rather than while
 * tuning appearance. It also has to stay reachable regardless of what is expanded, for the same
 * reason the tool hint does: layers accumulate as tools are picked up, so the way back has to be as
 * cheap as the way there.
 *
 * ## Only what is being asked for
 *
 * A switch appears for a layer some expanded group or the tool in hand actually wants. Listing all
 * five always would offer to hide things that are not on screen, which is a control with nothing to
 * do — and would make the row a fixed lump of chrome rather than something that grows with what is
 * happening.
 *
 * A layer the GM has hidden is still *proposed*, so its switch stays and stays off. That is the whole
 * of getting it back.
 *
 * ## Led by the word "Show" — room, 2026-09-09
 *
 * *"The buttons at the top for hiding different layers are not clear. It isn't obvious what they are
 * for."* They were a row of bare words, and the purpose lived only in a hover tooltip. Worse, two of
 * the words — *Ink* and *Walls* — are also rail sections, so the row read as navigation.
 *
 * One caption fixes the reading without adding an explanation: *Show — Ink · Rooms · Walls*. A lit
 * switch then reads as "shown" and a dim one as "not", which is what the pressed state was already
 * saying to anyone who knew what the row was.
 */

import { ALWAYS_LAYERS, type LayerId } from "../steps";
import {
  anyLayerHidden,
  hideAllLayers,
  showAllLayers,
  layerHidden,
  layerProposed,
  onLayerChange,
  toggleLayer,
  visibleLayers,
} from "./layerToggles";
import { invalidate, setActiveLayers } from "./shell";

/**
 * What each layer is called where a GM can see it. The ids are ours; these are theirs.
 *
 * **Every layer, not only the ones with a switch.** Exhaustive over `LayerId` deliberately: the row
 * below draws the always-on three, so a name here for `paint`, `gaps` or `delta` reaches nothing
 * today — and the type is what makes adding a layer a compile error until somebody has decided what
 * a GM would call it, rather than a blank label the first time one is offered a switch.
 */
const NAMES: Readonly<Record<LayerId, string>> = {
  ink: "Ink",
  paint: "Your edits",
  gaps: "Gaps",
  mends: "Mends",
  blob: "Blob preview",
  regions: "Rooms",
  graph: "Walls",
  delta: "Your wall changes",
};

/**
 * The switches, built into whatever the drawer hands us.
 *
 * **Only the always-on layers get one.** A tool's own marks — the paint while a brush is held, the
 * gap rings while the finder is running — are proposed too and are deliberately absent here: they
 * are part of the tool rather than part of the resting picture, so the tool *is* the switch and a
 * second one would be two handles on the same state.
 */
export function renderLayerRow(body: HTMLElement): void {
  const host = document.createElement("div");
  host.id = "layer-row";
  body.append(host);

  const showing = ALWAYS_LAYERS.filter((layer) => layerProposed(layer));
  if (showing.length === 0) return;

  /*
    One press back to the map alone, and one back to everything.

    With four layers on from the moment a map is chosen, turning them off one at a time is four
    presses to see the image you are tracing — and seeing it plainly is the state this surface most
    needs. The button says which way it would go, because a toggle that does not is a coin flip.
  */
  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip quiet";
  all.textContent = anyLayerHidden(showing) ? "Show all" : "Hide all";
  all.addEventListener("click", () => {
    if (anyLayerHidden(showing)) showAllLayers();
    else hideAllLayers(showing);
  });
  host.append(all);

  for (const layer of showing) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer";
    button.textContent = NAMES[layer];
    const on = !layerHidden(layer);
    // `aria-pressed` carries the look and the meaning together, as everywhere else on this surface.
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? `Hide ${NAMES[layer]}` : `Show ${NAMES[layer]}`;
    button.addEventListener("click", () => {
      toggleLayer(layer);
      invalidate();
    });
    host.append(button);
  }
}

export function registerLayerRow(redraw: () => void): void {
  /*
    One subscription doing both jobs, so the canvas and the row can never disagree about what is
    drawn. Everything that changes either — a tool being picked, a switch being clicked — arrives
    here.

    **The row is redrawn by asking the drawer**, rather than by rebuilding a fixed element in place.
    That is what having one slot costs and it is a fair price: the drawer owns what is in it, so
    there is no host sitting in the markup waiting for a module that may never be showing.

    Safe from looping only because `proposeLayers` is silent when the set is unchanged — the strip
    re-proposes on every render, and without that guard this would render the drawer, which renders
    the strip, which proposes again.
  */
  onLayerChange(() => {
    setActiveLayers(visibleLayers());
    redraw();
  });
  setActiveLayers(visibleLayers());
}
