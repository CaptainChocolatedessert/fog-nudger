/**
 * The Map step: choosing which image the trace reads.
 *
 * Moved here from the panel, where it was the last piece of the work that was not on the surface it
 * affects. Choosing a map is the first step of six, and the picture changing under the choice is the
 * whole confirmation that the right one was picked — which a popover beside the map cannot give.
 *
 * ## The picker exists because "the map" is not obvious to a program
 *
 * A scene can hold more than one `MAP`-layer image and one of them may be a GM overlay, and a scene
 * map is normally locked, so it cannot be nominated by clicking it. **Auto** leaves the resolver to
 * decide, which it refuses to do when the scene is genuinely ambiguous.
 *
 * The area filter's verdict is **shown rather than enforced**: a stray token on the map layer is
 * listed, marked, and still choosable, because the filter is a heuristic and the GM is not. Sizes
 * are shown because on a scene with two plausible maps the size is often the only thing telling the
 * real one from an overlay.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import {
  listMapImages,
  mapSignature,
  nominateMap,
  readNominatedMapId,
} from "../map/mapImage";
import { loadNominatedMap } from "./mapSource";
import { say } from "./shell";

/** The element the rows are drawn into, kept so the scene watcher can repaint without the step. */
let list: HTMLElement | null = null;

/**
 * Whether Owlbear is ready to be asked what is in the scene.
 *
 * The same rule as `controlsLive`, for the same reason and with a sharper failure. The surface is
 * built at module load so it looks like itself from the first frame, but this step's body is a list
 * of *scene* contents — and asking for those before `onReady` does not return an empty list, it
 * throws "not ready" and puts a red error on the state line where the map's name should be. So the
 * rows are drawn as "waiting for the scene" and filled once, from the start-up sequence.
 */
let live = false;

/** One choosable row. Built as DOM rather than markup so a map's name cannot be read as HTML. */
function mapRow(value: string, name: string, note: string, checked: boolean): HTMLLabelElement {
  const label = document.createElement("label");

  const input = document.createElement("input");
  input.type = "radio";
  input.name = "map";
  input.value = value;
  input.checked = checked;

  const text = document.createElement("span");
  text.textContent = name;

  label.append(input, text);
  if (note) {
    const hint = document.createElement("span");
    hint.className = "note";
    hint.textContent = note;
    label.append(hint);
  }
  return label;
}

/** Fill the picker from the scene. */
async function refreshMaps(): Promise<void> {
  const container = list;
  if (!container) return;

  try {
    const [maps, nominated] = await Promise.all([listMapImages(), readNominatedMapId()]);

    // Preserved across the rebuild, since this also runs when the scene's items change and
    // discarding a GM's choice because an unrelated token moved would be its own bug.
    const checked = container.querySelector<HTMLInputElement>("input:checked");
    const previous = checked?.value ?? "";

    container.replaceChildren();

    if (maps.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No MAP-layer image in this scene.";
      empty.className = "sub";
      container.append(empty);
    } else {
      // A nomination naming an id this scene does not contain selects nothing rather than adding a
      // phantom row, which matches what the resolver does with it: warn, and fall through.
      const wanted = previous || nominated || "";
      const known = maps.some((map) => map.id === wanted);

      container.append(mapRow("", "Auto", known ? "" : "refuses if two look alike", !known));
      for (const map of maps) {
        const notes = [
          `${map.width}×${map.height} squares`,
          map.plausible ? "" : "too small?",
          map.locked ? "locked" : "",
          map.visible ? "" : "hidden",
        ].filter(Boolean);
        container.append(mapRow(map.id, map.name, notes.join(", "), map.id === wanted));
      }
    }

    // Unconditional, including the zero case. An empty picker was reported as a bug precisely
    // because nothing here spoke: "found no maps" and "never asked" produced identical silence.
    devLog(
      "info",
      `workspace: map picker listed ${maps.length} map image${maps.length === 1 ? "" : "s"}` +
        (maps.length > 0
          ? ` — ${maps.map((map) => `${map.name} ${map.width}x${map.height}${map.plausible ? "" : " (small)"}`).join("; ")}`
          : "") +
        `; nomination ${nominated ?? "auto"}, rows ${container.querySelectorAll("input").length}`,
    );
  } catch (error) {
    const detail = describeError(error);
    say(`could not list the scene's maps: ${detail}`, "bad");
    devLog("error", "workspace: listing maps failed", detail);
    console.error("Fog Nudger — listing maps failed", error);
  }
}

/**
 * Draw the step's body.
 *
 * The rows are filled asynchronously: the surface is built before Owlbear answers, so this is drawn
 * empty-and-waiting rather than not at all, for the same reason the sliders are drawn disabled.
 */
export function renderMapPicker(body: HTMLElement): void {
  const container = document.createElement("div");
  container.className = "maps";

  // Delegated, so the rows can be rebuilt whenever the scene's maps change without rebinding — and
  // so a rebuild that lands between the click and the handler cannot drop the event.
  container.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.checked) return;

    say("changing the map…", "working");
    void nominateMap(input.value || null)
      // A different map is a different everything: a different image to draw, a different reading,
      // and a different place in the world to sit. The mask cache is keyed on map identity, so this
      // gets a fresh reading rather than the previous map's.
      .then(() => loadNominatedMap())
      .catch((error: unknown) => {
        const detail = describeError(error);
        say(`could not change the map: ${detail}`, "bad");
        devLog("error", "workspace: nominating a map failed", detail);
        console.error("Fog Nudger — nominating a map failed", error);
      });
  });

  const waiting = document.createElement("p");
  waiting.className = "sub";
  waiting.textContent = "Waiting for the scene…";
  container.append(waiting);

  list = container;
  body.append(container);
  // A rebuild of the panel after start-up must not lose the rows; a build before it must not ask.
  if (live) void refreshMaps();
}

/**
 * Keep the list in step with the scene.
 *
 * Populating once is not enough, and that is what left the panel's picker empty on its first outing:
 * a surface being up is not the same event as it having received the scene's items, so the first
 * query can legitimately answer "no maps" a moment before the answer becomes two.
 *
 * Guarded by a signature so the rows are rebuilt only when the map images themselves change. Items
 * change constantly in a live room, and rebuilding on every one of them would move the row under the
 * GM's cursor as they tried to click it.
 */
export function watchSceneMaps(): void {
  live = true;
  void refreshMaps();

  // A scene opening or closing under the workspace is not the same event as its items changing, and
  // only this one fires when the GM opens a scene while the surface is already up.
  OBR.scene.onReadyChange((ready) => {
    if (ready) void refreshMaps();
  });

  let signature: string | null = null;
  OBR.scene.items.onChange((items) => {
    const next = mapSignature(items);
    if (next === signature) return;
    signature = next;
    void refreshMaps();
  });
}
