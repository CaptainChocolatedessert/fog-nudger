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
 * map is normally locked, so it cannot be nominated by clicking it.
 *
 * **Every map-layer image is listed, unfiltered and unmarked** (user, 2026-08-29), in the layer's
 * own z-order with its pixel size beside its name. There is no *Auto* row: with nothing nominated
 * the largest image is what gets traced, so the row for that image is simply the one that starts
 * selected — the list says what will happen rather than naming a policy that decides later.
 */

import OBR from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { describeError } from "../describeError";
import {
  listMapImages,
  mapSignature,
  nominateMap,
  readNominatedMapId,
  type MapImageSummary,
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

/**
 * The last answer the scene gave, kept so a rebuild can draw it immediately.
 *
 * The drawer rebuilds the open group's body on every `renderPanel()` — which is every press
 * click and every Defaults press — and that is deliberate and earns its keep elsewhere. The cost
 * lands here alone, because this is the one step whose body is a query rather than a set of numbers:
 * without this the list reverted to "Waiting for the scene…" and fired a fresh `listMapImages()`
 * four times over a click through the four steps, each one a `getItems` plus a bounds measurement of
 * every map-layer image in the scene.
 *
 * Drawing the known rows first does not remove the query — `refreshMaps` still runs and still
 * replaces them, which is what keeps the list honest when the scene has changed underneath. It
 * removes the *flash*, which is the part a GM sees.
 */
let known: { readonly maps: readonly MapImageSummary[]; readonly selected: string } | null = null;

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

/** Draw one row per map, with the trace's choice marked. */
function drawRows(
  container: HTMLElement,
  maps: readonly MapImageSummary[],
  selected: string,
): void {
  for (const map of maps) {
    const notes = [
      `${map.pixelWidth}x${map.pixelHeight} px`,
      map.locked ? "locked" : "",
      map.visible ? "" : "hidden",
    ].filter(Boolean);
    container.append(mapRow(map.id, map.name, notes.join(", "), map.id === selected));
  }
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
    let selected = "";

    if (maps.length === 0) {
      // Cleared, not left holding the last non-empty answer: a scene that has lost its maps must not
      // go on offering them on the next rebuild.
      known = null;
      const empty = document.createElement("p");
      empty.textContent = "No MAP-layer image in this scene.";
      empty.className = "sub";
      container.append(empty);
    } else {
      /*
        What the row shows selected is what the trace would actually read.

        A nomination naming an id this scene does not contain selects nothing of its own — which
        matches what the resolver does with it: warn, and fall through to the largest. So the
        fallback is the marked row rather than a policy named in a row of its own, and the list
        cannot show a selection the pipeline would disagree with.
      */
      const wanted = previous || nominated || "";
      selected = maps.some((map) => map.id === wanted)
        ? wanted
        : (maps.find((map) => map.isDefault)?.id ?? "");

      drawRows(container, maps, selected);
      known = { maps, selected };

      /*
        A nomination this scene cannot satisfy is said out loud, because otherwise it is invisible.

        The fallback is right and the marked row is honest, but "you chose this" and "we picked this
        because your choice is missing" looked identical — and a room spent three hours in the second
        state without knowing (2026-09-07). The log said so forty times; the surface said nothing,
        which is the wrong way round.

        **It says what to do rather than only what happened.** Choosing a row writes a nomination and
        the line goes; nothing here rewrites it unasked, for the reason the resolver gives.
      */
      if (nominated && !maps.some((map) => map.id === nominated)) {
        const stale = document.createElement("p");
        stale.className = "sub";
        stale.innerHTML =
          "The map saved for this scene is <b>not in it any more</b>, so the largest one is being " +
          "traced instead. Pick a row to make that choice stick.";
        container.append(stale);
      }
    }

    // Unconditional, including the zero case. An empty picker was reported as a bug precisely
    // because nothing here spoke: "found no maps" and "never asked" produced identical silence.
    devLog(
      "info",
      `workspace: map picker listed ${maps.length} map image${maps.length === 1 ? "" : "s"}` +
        (maps.length > 0
          ? ` — ${maps.map((map) => `${map.name} ${map.pixelWidth}x${map.pixelHeight}px`).join("; ")}`
          : "") +
        `; nomination ${nominated ?? "none"}, showing ${selected.slice(0, 8) || "nothing"} selected, ` +
        `rows ${container.querySelectorAll("input").length}`,
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
    void nominateMap(input.value)
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

  // What the scene last said, if it has said anything. `refreshMaps` below replaces these the moment
  // it lands; until then the GM sees the list they were just looking at rather than it emptying.
  if (known) {
    drawRows(container, known.maps, known.selected);
  } else {
    const waiting = document.createElement("p");
    waiting.className = "sub";
    waiting.textContent = "Waiting for the scene…";
    container.append(waiting);
  }

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
