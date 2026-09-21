/**
 * Which map is on the surface, and getting it there.
 *
 * Two callers, and that is the reason this is not left inside the start-up sequence: the workspace
 * loads a map when it opens, and loads a different one when the GM picks one in the Map step. A
 * second copy of "fetch the image, take the reading, place the view" would be two places for those
 * three things to happen in a different order.
 *
 * ## The image and the reading are fetched together and land apart
 *
 * The reading is what *names* the map and says where it sits in the world, so it comes first; the
 * image is then loaded by URL and the view is placed when it arrives. Nothing waits for the image
 * before publishing the reading, because the mask is drawn over the map rather than into it — the
 * surface simply has nothing to draw until the picture is there.
 *
 * **The URL comes off the reading**, not from a second scene query. That is what makes the picture
 * and the mask provably the same item rather than two independent answers to "which map is
 * nominated" — see `MaskForOverlay.mapUrl`.
 *
 * ## What this does NOT guard, stated
 *
 * There is no generation scheme here, where `reading.ts` and `regions.ts` both have one. Two map
 * changes inside one image load race, and whichever `onload` fires last wins — which need not be
 * the map chosen last. It needs two clicks inside a single image fetch, so it is rare rather than
 * impossible, and the cost of getting it wrong is a picture from the wrong map under a correct
 * mask, which is visible. Recorded rather than fixed.
 */

import { devLog } from "../devlog";
import { resolveTraceMap } from "../map/mapImage";
import { openPanel, renderPanel } from "./drawer";
import { loadPaint } from "./paintState";
import { adoptReading, describeMaskFailure, requestRecompose, takeReading } from "./reading";
import { loadMarks } from "./regionMarks";
import { loadStage, wallsEdited } from "./stage";
import { startOn } from "./subject";
import { clearInkProfiles } from "./inkProfiles";
import { openOnOwlbearsView, say, setMapImage, setMapName } from "./shell";

/**
 * Load whatever map the scene currently nominates, and take a reading of it.
 *
 * **It took an `opening` flag until 2026-09-20**, which moved the GM to the Ink step when a map was
 * already chosen. The start-up advance went; `startOn` lights a side instead of opening a drawer,
 * and the body below says why. With nothing left that behaves differently on the first call, the
 * flag went with it — and both call sites now read the same.
 */
/**
 * Whether a map has been resolved and read, which is what unlocks the rest of the ink mode.
 *
 * Held here because this is the one function that knows: it is the only place a reading is taken for
 * a nominated image, and the answer changes on exactly the two occasions it runs. The accordion asks
 * it rather than being told, so there is no second copy of the fact to go stale.
 */
let chosen = false;

export function mapChosen(): boolean {
  return chosen;
}

export async function loadNominatedMap(): Promise<void> {
  /*
    The GM's paint is loaded **before** the reading, and that ordering is load-bearing.

    It used to come after, justified by *"what the ink layer draws is the base, which no paint layer
    touches, so nothing wrong is on screen in the meantime"* — and that stopped being true on
    2026-09-14, when the ink layer started drawing the **composite**. The first reading then composed
    no paint, so the surface opened showing ink that was missing every stroke the GM had saved, and
    corrected itself only once something forced a recompose (reported from a room, 2026-09-15).

    The old comment said loading first would mean *guessing* which map. It would not:
    `resolveTraceMap` answers that without touching a pixel, and is what the reading resolves with
    anyway. One extra item query buys a first frame that is simply right.
  */
  const map = await resolveTraceMap();
  if (map) {
    const early = await loadPaint(map.id);
    if (early.corrupt) {
      say("some saved painting could not be read and has been ignored — see the console", "bad");
    }
  }

  const outcome = await takeReading();
  chosen = outcome.ok;
  if (!outcome.ok) {
    /*
      No map, so the picker opens — the one case where a drawer is the right answer at start-up,
      because it is the only thing a GM can do anything about from here and every other opener in
      the strip is disabled until they do.

      **The mirror of what this branch used to hold.** The old start-up advance moved the GM *to*
      Ink when a map turned out to be chosen, and needed a flag to avoid relocating somebody who had
      already pressed something. This moves them to Map when one turns out **not** to be, and needs
      no flag: with the rest of the strip shut, the only drawer they could have opened is this one.
    */
    openPanel("map");
    // Rebuilt because the gate has just closed: whatever was open below Map is now about a picture
    // that is not there, and its header has to stop offering to go back into it.
    renderPanel();
    // Two failures, and they need different sentences. "No map" is an unanswered question with the
    // answer one step away; "unreadable" is a map that *is* chosen and drawn, whose pixels would not
    // come back — telling that GM to pick a map is advice they cannot act on.
    say(describeMaskFailure(outcome), "bad");
    setMapName(outcome.reason === "no-map" ? "No map chosen." : `${outcome.mapName} — unreadable.`);
    setMapImage(null);
    /*
      And drop the shapes on the two ink sliders, for the gap marks' reason one line up: they
      describe a reading that is gone, and a distribution left beside a control after its map has
      is a diagnostic answering about something else. Nothing redraws them until a reading lands.
    */
    clearInkProfiles();
    return;
  }
  const result = outcome.reading;

  setMapName(result.mapName);
  /*
    The stage is re-read for *this* map, and that is what makes switching maps safe.

    A wall graph's coordinates are fractions of a map and say nothing about which, so the store
    records the map's id beside them and a mismatch reads as "no graph here". Nominating a second
    image therefore drops the GM back into stage one for it, without touching the first map's work —
    and switching back restores it. **One graph is stored at a time**, so deriving on the second map
    does replace the first map's; per-map keys are the fix if that ever matters.
  */
  const stage = await loadStage(result.mapId);
  /*
    Where the map opens, decided by the document rather than guessed.

    Walls holding something the trace did not derive means the ink half is under the cover, so the
    walls are the side there is anything to do on; otherwise the ink is where somebody with nothing
    to lose is going. **After `loadStage`**, which is what makes `wallsEdited` answer about this map
    rather than the last one.
  */
  startOn(wallsEdited());
  if (stage.corrupt) {
    say("the saved wall editing could not be read and has been ignored — see the console", "bad");
  }
  // After the stage, which clears the undo history for this map: marks are another document of the
  // same map, and their history went with it.
  const marked = await loadMarks(result.mapId);
  if (marked.corrupt) {
    say("the saved suppression marks could not be read and have been ignored — see the console", "bad");
  }

  /*
    Loaded again only if the reading resolved a *different* map than the resolver did.

    They agree in every ordinary case — the reading resolves with the same function — but a scene
    whose items changed between the two calls could differ, and a paint layer belonging to the wrong
    map is worse than a wasted query. No recompose either way: the early load happened before the
    reading, so the composite already has it.
  */
  if (result.mapId !== map?.id) {
    const paint = await loadPaint(result.mapId);
    if (paint.corrupt) {
      say("some saved painting could not be read and has been ignored — see the console", "bad");
    }
    if (paint.present) requestRecompose();
  }
  /*
    Where a GM lands, which the stage decides.

    Ink is where stage one starts, and it is the wrong place to open a scene that is already saved:
    every control there is disabled, so the surface opens on a wall of dimmed sliders explaining
    what the GM cannot do (reported from a room, 2026-09-05). In stage two the step that matters is
    the one holding the graph.
  */
  /*
    **The start-up advance went on 2026-09-20.** It opened the Ink *parameters* drawer the moment a
    map loaded, and with it the guard added that morning to stop it doing so under the cover.

    Two reasons, and the second is the better one. It was the only route to an open drawer that was
    not a press, which is why it needed a guard at all. And a drawer is a guess at **which controls**
    a GM wants, where the thing start-up actually knows is **which half of the map** they can work
    on — which `startOn` above says by lighting that side, opening nothing.

    So a map that is already chosen opens with no drawer and the plain picture, one side lit. The
    drawer a GM meets with no map is still the picker, which is the initial state and the one case
    where they have to be shown the way in.
  */
  // The gate has just opened, so every step below Map becomes reachable.
  renderPanel();

  // The map image, drawn by us rather than by Owlbear. `crossOrigin` matches the pipeline's loader:
  // it proves the CDN sends the headers, and matching it means this cannot succeed where a trace
  // would fail.
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    setMapImage(image);
    void openOnOwlbearsView(result.bounds);
  };
  image.onerror = () => {
    say("the map image would not load", "bad");
    devLog("error", "workspace: the map image failed to load");
  };

  // Guarded rather than left to `src = ""`, which browsers resolve against the document URL and then
  // try to fetch — producing an `onerror` and the CDN-failure message for a case that is not a CDN
  // failure. The right message by accident is still the wrong message.
  if (result.mapUrl) {
    image.src = result.mapUrl;
  } else {
    say("the scene gives no image for this map", "bad");
    devLog("error", `workspace: "${result.mapName}" resolved with no image URL`);
  }

  adoptReading(result);
}
