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
import { listMapImages, nominateMap, readNominatedMapId } from "./map/mapImage";

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
function wireMapPicker(): HTMLSelectElement | null {
  const select = document.getElementById("map");
  if (!(select instanceof HTMLSelectElement)) return null;

  select.addEventListener("change", () => {
    void nominateMap(select.value || null).catch((error: unknown) => {
      const detail = describeError(error);
      reportResult(`Could not save the map choice: ${detail}`, "bad");
      console.error(`Fog Nudger — nominating a map failed: ${detail}`);
    });
  });
  return select;
}

/**
 * Fill the picker from the scene, marking anything the area filter thinks is too small to be a map.
 *
 * The filter's verdict is shown rather than enforced — a stray token on the map layer is listed,
 * marked, and still choosable, because the filter is a heuristic and the GM is not. Sizes are shown
 * because on a scene with two plausible maps the size is often the only thing distinguishing the
 * real one from a GM overlay.
 */
async function refreshMaps(select: HTMLSelectElement | null): Promise<void> {
  if (!select) return;

  try {
    const [maps, nominated] = await Promise.all([
      listMapImages(),
      readNominatedMapId(),
    ]);

    select.replaceChildren();
    const auto = new Option("Auto", "");
    select.append(auto);

    for (const map of maps) {
      const label =
        `${map.name} — ${map.width}×${map.height}` +
        (map.plausible ? "" : " (too small?)") +
        (map.locked ? " (locked)" : "") +
        (map.visible ? "" : " (hidden)");
      select.append(new Option(label, map.id));
    }

    // A nomination naming an id this scene does not contain is left unselected rather than added
    // as a phantom entry, which matches what the resolver does with it: warn, and fall through.
    select.value = nominated && maps.some((map) => map.id === nominated) ? nominated : "";

    if (maps.length === 0) {
      auto.text = "No MAP-layer image in this scene";
    }
  } catch (error) {
    const detail = describeError(error);
    reportResult(`Could not list the scene's maps: ${detail}`, "bad");
    console.error(`Fog Nudger — listing maps failed: ${detail}`);
  }
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
      if (mapSelect) mapSelect.disabled = !sceneReady;
      reportResult(sceneReady ? "Ready." : "Waiting for a scene.", "ok");
      // Repopulated on every transition rather than once: the list belongs to the scene, so a
      // scene change makes the previous one's maps stale, and a stale nomination silently pointing
      // at an id from another scene is exactly the confusion the picker exists to remove.
      if (sceneReady) void refreshMaps(mapSelect);
    };
    OBR.scene.onReadyChange(setEnabled);
    setEnabled(ready);
  } catch (error) {
    // Plain text on screen, full detail to the console. The SDK's rejections are not `Error`s, so
    // this goes through `describeError` rather than reading `.message`, which would be undefined.
    report("Connected, but could not read the scene.", "bad");
    console.error(`Fog Nudger — scene readiness check failed: ${describeError(error)}`);
  }
});
