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
import { advanceTo, renderPanel } from "./drawer";
import { loadPaint } from "./paintState";
import { adoptReading, describeMaskFailure, requestRecompose, takeReading } from "./reading";
import { loadStage } from "./stage";
import { openOnOwlbearsView, say, setMapImage, setMapName } from "./shell";

/**
 * Load whatever map the scene currently nominates, and take a reading of it.
 *
 * `opening` moves the GM to the ink step when a map is already chosen — the common case, where they
 * came here to look at ink and the map question is already answered. It does nothing once the GM has
 * touched the drawer themselves, and nothing at all when there is no map, which leaves them in
 * the one step that can do something about that.
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

export async function loadNominatedMap(opening = false): Promise<void> {
  const outcome = await takeReading();
  chosen = outcome.ok;
  if (!outcome.ok) {
    // Rebuilt because the gate has just closed: whatever was open below Map is now about a picture
    // that is not there, and its header has to stop offering to go back into it.
    renderPanel();
    // Two failures, and they need different sentences. "No map" is an unanswered question with the
    // answer one step away; "unreadable" is a map that *is* chosen and drawn, whose pixels would not
    // come back — telling that GM to pick a map is advice they cannot act on.
    say(describeMaskFailure(outcome), "bad");
    setMapName(outcome.reason === "no-map" ? "No map chosen." : `${outcome.mapName} — unreadable.`);
    setMapImage(null);
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
  if (stage.corrupt) {
    say("the saved wall editing could not be read and has been ignored — see the console", "bad");
  }

  /*
    The GM's two paint layers, read for this map for the same reason the graph is.

    **After the reading rather than before it**, which costs one recompose and is the honest order.
    A layer records which map it belongs to, and the only thing that says which map this is, is the
    reading that has just resolved it — so loading first would mean guessing. The reading itself is
    unaffected: what the ink layer draws is the base, which no paint layer touches, so nothing wrong
    is on screen in the meantime.

    The recompose is skipped when there is nothing to fold in, which is every scene until someone
    paints.
  */
  const paint = await loadPaint(result.mapId);
  if (paint.corrupt) {
    say("some saved painting could not be read and has been ignored — see the console", "bad");
  }
  if (paint.present) requestRecompose();
  /*
    Where a GM lands, which the stage decides.

    Ink is where stage one starts, and it is the wrong place to open a scene that is already saved:
    every control there is disabled, so the surface opens on a wall of dimmed sliders explaining
    what the GM cannot do (reported from a room, 2026-09-05). In stage two the step that matters is
    the one holding the graph.
  */
  /*
    Where a GM lands, which start-up decides once and never again.

    Ink is where the ink mode starts once there is a map, which is the common case: they came here to
    look at ink and the map question was already answered. With no map they stay on Map, which is the
    only step open to them.

    **The stage no longer decides this**, because the mode does. The editor is a page of its own now,
    so a saved scene does not have to be recognised and redirected to — the GM chose which surface
    to open before this ran.
  */
  // Only the ink mode has anywhere to move on to. The editor opens on its one step already, and
  // sending it to a step it does not declare would leave the accordion with nothing open.
  if (opening) advanceTo("ink");
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
