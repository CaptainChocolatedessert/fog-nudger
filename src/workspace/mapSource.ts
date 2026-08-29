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
 */

import { devLog } from "../devlog";
import { resolveTraceMap } from "../map/mapImage";
import { advanceTo } from "./accordion";
import { adoptReading, takeReading } from "./reading";
import { openOnOwlbearsView, say, setMapImage, setMapName } from "./shell";

/**
 * Load whatever map the scene currently nominates, and take a reading of it.
 *
 * `opening` moves the GM to the ink step when a map is already chosen — the common case, where they
 * came here to look at ink and the map question is already answered. It does nothing once the GM has
 * touched the accordion themselves, and nothing at all when there is no map, which leaves them in
 * the one step that can do something about that.
 */
export async function loadNominatedMap(opening = false): Promise<void> {
  const result = await takeReading();
  if (!result) {
    // Not an error state so much as an unanswered question, and the answer is one step away.
    say("no map chosen — pick one under Map", "bad");
    setMapName("No map chosen.");
    setMapImage(null);
    return;
  }

  setMapName(result.mapName);
  if (opening) advanceTo("ink");

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
  image.src = (await resolveTraceMap())?.image.url ?? "";

  adoptReading(result);
}
