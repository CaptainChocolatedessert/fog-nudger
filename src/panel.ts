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
import { dryRun, lastPixelsPerSquare, probeWorldPoint } from "./pipeline";
import {
  DEFAULT_SETTINGS,
  isDefault,
  SETTING_LIMITS,
  type SettingName,
  type Settings,
} from "./settings";
import { readSettings, writeSettings } from "./settingsStore";
import {
  acceptStaged,
  removeOurs,
  restyleStaged,
  returnToStaging,
  stageRegions,
} from "./emit/emitRegions";
import {
  listMapImages,
  mapSignature,
  nominateMap,
  readNominatedMapId,
} from "./map/mapImage";

installDevLog("ui");

/**
 * Ask the pipeline what it computed where the GM is looking.
 *
 * The viewport centre rather than a click or a selection, because it needs no new interaction to
 * learn and no item to exist: centre the view on the thing that looks wrong and press the button.
 */
async function probeViewportCentre(): Promise<string> {
  const [width, height] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);
  const centre = await OBR.viewport.inverseTransformPoint({ x: width / 2, y: height / 2 });
  return probeWorldPoint(centre.x, centre.y);
}

let sceneReady = false;
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
 * Wire a panel button.
 *
 * Buttons are disabled while their action runs. Not politeness: several of these write to the
 * scene, and a second click landing mid-write would place two sets of shapes or race a delete
 * against the add that created them. Staging in particular can take seconds on a large map, which
 * is exactly long enough for someone to click again.
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
          `${map.width}×${map.height} squares`,
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


/**
 * The controls, in the order a GM meets them, with a hint saying which way to turn each one.
 *
 * The hints exist because every one of these is a number whose direction is not guessable —
 * raising Sauvola's `k` makes *less* ink, which is the opposite of what "sensitivity" suggests to
 * most people. A control whose direction you have to discover by experiment is a control that gets
 * turned once and left alone.
 */
const TRACE_CONTROLS: readonly {
  readonly name: TraceName;
  readonly label: string;
  readonly hint: string;
  /** Renders the value in a unit the GM can feel, given the last run's pixels per grid square. */
  readonly derive?: (value: number, pxPerSquare: number) => string;
}[] = [
  {
    name: "sauvolaK",
    label: "Ink threshold",
    hint: "Higher finds <b>less</b> ink — only decisively dark pixels. Lower catches faint linework, and eventually the paper.",
  },
  {
    name: "blurSigma",
    label: "Texture blur",
    hint: "Fades the finest marks below the threshold. The blunt lever against speckle and a printed floor grid — blunt because it works on contrast, so it takes faint walls too.",
    derive: (value) => `${value.toFixed(2)} px`,
  },
  {
    name: "sauvolaRadiusSquares",
    label: "Detail window",
    hint: "How local the threshold is. Wants to stay comfortably wider than the linework is thick, or a bold stroke becomes its own background and stops counting as ink.",
    derive: (value, px) => `${Math.round(value * px) * 2 + 1} px across`,
  },
  {
    name: "minRoomSquares",
    label: "Smallest room",
    hint: "Anything smaller is discarded, and shows as bare map unless something swallows it. Low is safer: a spurious region costs one click, a bare patch is a visible defect.",
    derive: (value, px) => `${Math.round(value * px * px)} px, ${(Math.sqrt(value) * px).toFixed(0)} px across`,
  },
  {
    name: "simplifyInkWidths",
    label: "Edge simplification",
    hint: "As a share of the measured ink width. Capped below a half, which is the point past which a boundary could cross the middle of a wall into the next room.",
  },
];

const REVIEW_CONTROLS: readonly {
  readonly name: ReviewName;
  readonly label: string;
  readonly hint: string;
  readonly derive?: (value: number, pxPerSquare: number) => string;
}[] = [
  {
    name: "fillOpacity",
    label: "Proposal fill",
    hint: "Low keeps the map readable underneath. The partition is carried by the colour changes and the outlines, not by the fill.",
  },
  {
    name: "strokeSquares",
    label: "Proposal outline",
    hint: "In grid squares. Free — outline width does not affect the walls Dynamic Fog derives.",
  },
];

type TraceName = keyof Settings["trace"];
type ReviewName = keyof Settings["review"];

let settings: Settings = DEFAULT_SETTINGS;

/** Build one row. Number inputs rather than sliders: these are values worth reading exactly. */
function settingRow(
  name: SettingName,
  label: string,
  hint: string,
  value: number,
  onChange: (value: number) => void,
): HTMLElement {
  const limits = SETTING_LIMITS[name];
  const row = document.createElement("div");
  row.className = "setting";

  const text = document.createElement("label");
  text.textContent = label;
  text.htmlFor = `set-${name}`;

  const input = document.createElement("input");
  input.type = "number";
  input.id = `set-${name}`;
  input.min = String(limits.min);
  input.max = String(limits.max);
  input.step = String(limits.step);
  input.value = String(value);

  const note = document.createElement("p");
  note.className = "hint";
  note.innerHTML = hint;
  note.dataset.name = name;

  // On `change` rather than `input`: committing on every keystroke would write to scene metadata
  // once per digit, and a half-typed number is a value nobody meant.
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    onChange(Number.isFinite(parsed) ? parsed : value);
  });

  row.append(text, input, note);
  return row;
}

/** Repaint both control groups from the current settings, and refresh the derived figures. */
function renderSettings(): void {
  const px = lastPixelsPerSquare();

  const paint = (
    container: HTMLElement | null,
    controls: readonly { name: string; label: string; hint: string; derive?: (v: number, p: number) => string }[],
    read: (name: string) => number,
    write: (name: string, value: number) => void,
  ): void => {
    if (!container) return;
    container.replaceChildren();
    for (const control of controls) {
      const value = read(control.name);
      const derived = px !== null && control.derive ? ` <b>${control.derive(value, px)}</b>` : "";
      container.append(
        settingRow(
          control.name as SettingName,
          control.label,
          control.hint + derived,
          value,
          (next) => write(control.name, next),
        ),
      );
    }
  };

  paint(
    document.getElementById("trace-settings"),
    TRACE_CONTROLS,
    (name) => settings.trace[name as TraceName],
    (name, value) => {
      void save({ ...settings, trace: { ...settings.trace, [name]: value } });
    },
  );
  paint(
    document.getElementById("review-settings"),
    REVIEW_CONTROLS,
    (name) => settings.review[name as ReviewName],
    (name, value) => {
      void save({ ...settings, review: { ...settings.review, [name]: value } });
    },
  );

  setSettingsEnabled(sceneReady);
  const traceReset = document.getElementById("reset-trace");
  const reviewReset = document.getElementById("reset-review");
  if (traceReset instanceof HTMLButtonElement) {
    traceReset.disabled = !sceneReady || isDefault(settings);
  }
  if (reviewReset instanceof HTMLButtonElement) {
    reviewReset.disabled = !sceneReady || isDefault(settings);
  }
}

/**
 * Persist and repaint.
 *
 * Repaints from what came *back* rather than from what was sent, so a value the store clamped shows
 * the clamped figure immediately. A control that silently keeps displaying a number the pipeline is
 * not using is worse than one that snaps.
 */
async function save(next: Settings): Promise<void> {
  try {
    settings = await writeSettings(next);
  } catch (error) {
    const detail = describeError(error);
    reportResult(`Could not save the setting: ${detail}`, "bad");
    console.error(`Fog Nudger — saving settings failed: ${detail}`);
    return;
  }
  renderSettings();
  reportResult("Saved. Trace again to see it.", "ok");
}

function setSettingsEnabled(enabled: boolean): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(".setting input")) {
    input.disabled = !enabled;
  }
}

/** Put one group back to its defaults, leaving the other alone. */
async function resetGroup(which: "trace" | "review"): Promise<string> {
  await save({ ...settings, [which]: DEFAULT_SETTINGS[which] });
  return which === "trace"
    ? "Reading settings back to defaults. Trace again to see it."
    : "Appearance back to defaults.";
}

/** Show one tab. Kept plain: two buttons, two panels, one selected. */
function selectTab(which: "read" | "edit"): void {
  for (const name of ["read", "edit"] as const) {
    const tab = document.getElementById(`tab-${name}`);
    const panel = document.getElementById(`panel-${name}`);
    tab?.setAttribute("aria-selected", String(name === which));
    if (panel) panel.hidden = name !== which;
  }
}

// Painted once at load, before Owlbear is known to be there at all. The values are the defaults
// and every control is disabled until a scene opens, but the panel shows what it is rather than an
// empty column — which is the same rule the status line follows, and the reason the map picker was
// reported as broken when it was merely empty.
renderSettings();

// Wired at load rather than inside `onReady`: switching tabs is pure UI and has no business waiting
// on the SDK. It *was* inside, and outside a room the tabs were simply dead — which is also how it
// was caught, since the SDK is inert there by design.
for (const which of ["read", "edit"] as const) {
  document.getElementById(`tab-${which}`)?.addEventListener("click", () => selectTab(which));
}
selectTab("read");

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
    wireButton("probe", probeViewportCentre),
    wireButton("stage", stageRegions),
    wireButton("accept", acceptStaged),
    wireButton("unaccept", returnToStaging),
    wireButton("remove", removeOurs),
    wireButton("census", logCensus),
    wireButton("inspect", inspectFogShapes),
    wireButton("restyle", restyleStaged),
    wireButton("reset-trace", () => resetGroup("trace")),
    wireButton("reset-review", () => resetGroup("review")),
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
    const setEnabled = (open: boolean): void => {
      sceneReady = open;
      for (const button of buttons) if (button) button.disabled = !open;
      setPickerEnabled(mapSelect, open);
      reportResult(open ? "Ready." : "Waiting for a scene.", "ok");
      // Settings live in scene metadata, so there is nothing real to show until a scene is open.
      if (open) {
        void readSettings()
          .then((loaded) => {
            settings = loaded;
            renderSettings();
          })
          .catch((error: unknown) => {
            console.error("Fog Nudger — reading settings failed: " + describeError(error));
          });
      } else {
        renderSettings();
      }
      // Repopulated on every transition rather than once: the list belongs to the scene, so a
      // scene change makes the previous one's maps stale, and a stale nomination silently pointing
      // at an id from another scene is exactly the confusion the picker exists to remove.
      if (open) void refreshMaps(mapSelect);
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
