/**
 * The action popover. Skeleton scope: say plainly whether the extension is talking to Owlbear.
 *
 * It exists at this stage as a second, independent signal. The background page reports through the
 * dev log; this reports on screen. Two signals separate "the manifest never loaded" from "the
 * manifest loaded and the background script failed", which one signal cannot do.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel, formatDevLogLabel } from "./devlog";
import { describeError } from "./describeError";
import { themeVariables } from "./theme";
// `placeProbeShapes`, `promoteStaged` and `removeProbeShapes` are deliberately NOT wired up. They
// answered roadmap step 1 — every finding is recorded in DESIGN.md §4 — and leaving their buttons
// on the panel would invite someone to scatter magenta squares across a real map. The code stays
// so re-measuring is cheap if Owlbear's fog behaviour ever changes; import them here to bring the
// buttons back, and re-add the markup in panel.html.
import { inspectFogShapes, logCensus } from "./probe/fogProbe";
import { dryRun } from "./dryRun";
import {
  listMapImages,
  mapSignature,
  nominateMap,
  readNominatedMapId,
} from "./map/mapImage";

installDevLog("ui");

const status = document.getElementById("status");
const result = document.getElementById("result");

function report(text: string, state: "ok" | "bad"): void {
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

function reportResult(text: string, state: "ok" | "bad"): void {
  if (!result) return;
  result.textContent = text;
  result.dataset.state = state;
}

/**
 * Wire a probe button.
 *
 * Buttons are disabled while their action runs. Not politeness: every one of these writes to the
 * scene, and a second click landing mid-write would place two sets of shapes or race a delete
 * against the add that created them.
 *
 * A failure is reported in plain words on the panel and in full to the console, through
 * `describeError` — the SDK rejects with a raw payload rather than an `Error`, so reading
 * `.message` would print `undefined` for every refusal it can produce, which is the whole class of
 * outcome this probe exists to observe.
 */
function wireButton(id: string, run: () => Promise<string>): HTMLButtonElement | null {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) return null;

  button.addEventListener("click", () => {
    button.disabled = true;
    reportResult("Working…", "ok");
    void run()
      .then((message) => reportResult(message, "ok"))
      .catch((error: unknown) => {
        const detail = describeError(error);
        reportResult(`Failed: ${detail}`, "bad");
        console.error(`Fog Nudger — probe failed: ${detail}`);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

/**
 * The map nomination control.
 *
 * Writes the choice to scene metadata as soon as it changes, rather than holding it until the dry
 * run reads it. The popover is dismissed by clicking anywhere outside it, so a choice held in the
 * page would be lost by the most ordinary gesture there is.
 */
function wireMapPicker(): HTMLElement | null {
  const container = document.getElementById("maps");
  if (!container) return null;

  // Delegated, so the rows can be rebuilt whenever the scene's maps change without rebinding —
  // and so a rebuild that lands between the click and the handler cannot drop the event.
  container.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.checked) return;

    void nominateMap(input.value || null).catch((error: unknown) => {
      const detail = describeError(error);
      reportResult(`Could not save the map choice: ${detail}`, "bad");
      console.error(`Fog Nudger — nominating a map failed: ${detail}`);
    });
  });
  return container;
}

/** Enable or disable the picker as a whole. Radios carry no group-level disabled state of their own. */
function setPickerEnabled(container: HTMLElement | null, enabled: boolean): void {
  if (!container) return;
  container.setAttribute("aria-disabled", String(!enabled));
  for (const input of container.querySelectorAll("input")) input.disabled = !enabled;
}

/**
 * Fill the picker from the scene, marking anything the area filter thinks is too small to be a map.
 *
 * The filter's verdict is shown rather than enforced — a stray token on the map layer is listed,
 * marked, and still choosable, because the filter is a heuristic and the GM is not. Sizes are shown
 * because on a scene with two plausible maps the size is often the only thing distinguishing the
 * real one from a GM overlay.
 */
async function refreshMaps(container: HTMLElement | null): Promise<void> {
  if (!container) {
    // Said out loud because the alternative is a picker that is empty for one reason and looks
    // exactly like a picker that is empty for a completely different one.
    devLog("warn", "panel: no map picker element — the markup and the wiring disagree");
    return;
  }

  try {
    const [maps, nominated] = await Promise.all([
      listMapImages(),
      readNominatedMapId(),
    ]);

    // Preserved across the rebuild, since this also runs when the scene's items change and
    // discarding a GM's choice because an unrelated token moved would be its own bug.
    const checked = container.querySelector<HTMLInputElement>("input:checked");
    const previous = checked?.value ?? "";
    const enabled = container.getAttribute("aria-disabled") !== "true";

    container.replaceChildren();

    if (maps.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No MAP-layer image in this scene.";
      empty.className = "note";
      container.append(empty);
    } else {
      // A nomination naming an id this scene does not contain selects nothing rather than adding a
      // phantom row, which matches what the resolver does with it: warn, and fall through.
      const wanted = previous || nominated || "";
      const known = maps.some((map) => map.id === wanted);

      container.append(
        mapRow("", "Auto", known ? "" : "refuses if two look alike", !known),
      );
      for (const map of maps) {
        const notes = [
          `${map.width}×${map.height}`,
          map.plausible ? "" : "too small?",
          map.locked ? "locked" : "",
          map.visible ? "" : "hidden",
        ].filter(Boolean);
        container.append(mapRow(map.id, map.name, notes.join(", "), map.id === wanted));
      }
    }

    setPickerEnabled(container, enabled);

    // Unconditional, including the zero case. An empty picker was reported as a bug precisely
    // because nothing here spoke: "found no maps" and "never asked" produced identical silence.
    devLog(
      "info",
      `panel: map picker listed ${maps.length} map image${maps.length === 1 ? "" : "s"}` +
        (maps.length > 0
          ? ` — ${maps.map((map) => `${map.name} ${map.width}x${map.height}${map.plausible ? "" : " (small)"}`).join("; ")}`
          : "") +
        `; nomination ${nominated ?? "auto"}, rows ${container.querySelectorAll("input").length}, ` +
        `enabled ${enabled}`,
    );
  } catch (error) {
    const detail = describeError(error);
    reportResult(`Could not list the scene's maps: ${detail}`, "bad");
    console.error(`Fog Nudger — listing maps failed: ${detail}`);
  }
}

/** One choosable row. Built as DOM rather than markup so a map's name cannot be read as HTML. */
function mapRow(
  value: string,
  name: string,
  note: string,
  checked: boolean,
): HTMLLabelElement {
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

/**
 * Paint the page in Owlbear's colours, over the stylesheet's own readable defaults.
 *
 * Failure here is deliberately quiet on screen and loud in the log: a panel wearing the wrong
 * greys is still perfectly usable, so an error message about it would be noise sitting where the
 * actual content goes.
 */
function applyTheme(theme: unknown): void {
  const style = document.documentElement.style;
  for (const [property, value] of Object.entries(themeVariables(theme))) {
    style.setProperty(property, value);
  }
}

OBR.onReady(async () => {
  // Same first move as the background page, and for the same reason. This page is a separate
  // iframe from it, so it has its own copy of the shim with its own unset label — which is how
  // this was missed the first time: the background page was labelled, the log looked labelled,
  // and the panel's lines were quietly going out as `?`.
  try {
    const role = await OBR.player.getRole();
    setDevLogLabel(formatDevLogLabel(role, OBR.player.id, "ui"));
  } catch (error) {
    devLog("warn", "could not read player role", describeError(error));
  }

  devLog("info", "panel: connection ready");

  // Subscribe before reading, for the same reason the background page does: a theme changed in the
  // window between the two would otherwise never be observed. Both paths run `applyTheme`, which
  // is idempotent, so the overlap costs nothing.
  OBR.theme.onChange(applyTheme);
  try {
    applyTheme(await OBR.theme.getTheme());
  } catch (error) {
    devLog("warn", "could not read Owlbear's theme", describeError(error));
  }

  const buttons = [
    wireButton("dry-run", dryRun),
    wireButton("census", logCensus),
    wireButton("inspect", inspectFogShapes),
  ];

  const mapSelect = wireMapPicker();

  try {
    // A popover's connection going ready is NOT the scene being ready — the sibling lost two days
    // to treating them as the same event. Ask separately, and say which of the two is true.
    const ready = await OBR.scene.isReady();
    report(
      ready ? "Connected. Scene open." : "Connected. No scene open.",
      "ok",
    );

    // Subscribe as well as check, for the usual reason: a scene opened while the popover is already
    // up would otherwise leave the buttons dead with no explanation.
    const setEnabled = (sceneReady: boolean): void => {
      for (const button of buttons) if (button) button.disabled = !sceneReady;
      setPickerEnabled(mapSelect, sceneReady);
      reportResult(sceneReady ? "Ready." : "Waiting for a scene.", "ok");
      // Repopulated on every transition rather than once: the list belongs to the scene, so a
      // scene change makes the previous one's maps stale, and a stale nomination silently pointing
      // at an id from another scene is exactly the confusion the picker exists to remove.
      if (sceneReady) void refreshMaps(mapSelect);
    };
    OBR.scene.onReadyChange(setEnabled);
    setEnabled(ready);

    // Populating once at open is not enough, and that is what left the picker empty on its first
    // outing. A popover is a fresh iframe every time it is opened, and the scene being *ready* is
    // not the same event as this iframe having received the scene's items — so the first query can
    // legitimately answer "no maps" a moment before the answer becomes two. Watching for the items
    // makes the race moot rather than betting on having won it.
    //
    // Guarded by a signature so the select is rebuilt only when the map images themselves change.
    // Items change constantly in a live room, and rebuilding on every one of them would collapse
    // the dropdown under the GM's cursor as they tried to use it.
    let signature: string | null = null;
    OBR.scene.items.onChange((items) => {
      const next = mapSignature(items);
      if (next === signature) return;
      signature = next;
      void refreshMaps(mapSelect);
    });
  } catch (error) {
    // Plain text on screen, full detail to the console. The SDK's rejections are not `Error`s, so
    // this goes through `describeError` rather than reading `.message`, which would be undefined.
    report("Connected, but could not read the scene.", "bad");
    console.error(`Fog Nudger — scene readiness check failed: ${describeError(error)}`);
  }
});
