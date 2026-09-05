/**
 * The tool picker and the buttons at the end of a painting step.
 *
 * The same shape the wall tools settled into: a picker at the top saying what a press does, and the
 * thing that acts on the work at the bottom. Drawn rather than described, for the reason the map
 * picker and the ink swatches are — a native control opened from a sandboxed third-party iframe
 * paints against the *system* background, and the first version of the map picker rendered white on
 * white and looked empty.
 *
 * No subscription to anything: the accordion rebuilds a step's body on every header click, so a
 * listener here would leak one per click. The buttons repaint themselves on the click that changes
 * the tool, which is the only thing that can change it.
 */

import { PAINT_NAMES, type PaintKind } from "../inkPaintStore";
import { confirmAction } from "./confirmDialog";
import type { PaintVerb } from "./paintGesture";
import { hasUnsavedPaint, paintRaster, workingLayer } from "./paintState";
import { currentPaintTool, finishPaint, abandonPaint, setPaintTool } from "./paintTool";
import { paintStroke } from "../trace/inkPaint";
import { refreshPaintRegion } from "./layers/paint";
import { invalidate, say } from "./shell";
import { inStageTwo } from "./stage";

interface ToolChoice {
  readonly id: PaintVerb;
  readonly label: string;
}

const TOOLS: readonly ToolChoice[] = [
  { id: "paint", label: "Paint" },
  { id: "erase", label: "Erase" },
];

/** What each layer's brush is for, in the fewest words that still say what a press does. */
const HINTS: Readonly<Record<PaintKind, Readonly<Record<PaintVerb, string>>>> = {
  suppress: {
    paint:
      "Drag to cover marks the trace should ignore. Hold <b>Shift</b> to erase while you drag, " +
      "<b>Ctrl</b> to pan. The ring shows how much map the brush covers.",
    erase:
      "Drag to uncover what you suppressed, putting those marks back. Hold <b>Shift</b> to " +
      "suppress instead, <b>Ctrl</b> to pan.",
  },
  ink: {
    paint:
      "Drag to draw linework the map does not have. Hold <b>Shift</b> to erase while you drag, " +
      "<b>Ctrl</b> to pan. Zoom in and turn the width down for fine work.",
    erase:
      "Drag to remove ink you drew. This does not touch the map's own linework — only what you " +
      "added here. Hold <b>Shift</b> to draw instead, <b>Ctrl</b> to pan.",
  },
};

/** The picker, at the top of the step. */
export function renderPaintTools(kind: PaintKind): (body: HTMLElement) => void {
  return (body) => {
    if (inStageTwo()) {
      body.append(frozenNotice(kind));
      return;
    }
    const row = document.createElement("div");
    row.className = "step-actions";

    const hint = document.createElement("p");
    hint.className = "sub";

    const buttons = TOOLS.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice.label;
      button.addEventListener("click", () => {
        setPaintTool(choice.id);
        paint();
        invalidate();
      });
      row.append(button);
      return { choice, button };
    });

    function paint(): void {
      const active = currentPaintTool();
      for (const { choice, button } of buttons) {
        // `aria-pressed` is the selected style already, so it carries the look and the meaning
        // together rather than a class saying the same thing beside it.
        button.className = "chip";
        button.setAttribute("aria-pressed", String(choice.id === active));
      }
      hint.innerHTML = HINTS[kind][active];
    }

    paint();
    body.append(row, hint);
  };
}

/**
 * Done, Discard and Clear all, at the end of the step.
 *
 * **Done is not the only way work is kept**, and saying so is the point of its blurb: leaving the
 * step or closing the workspace saves too. That is what keeps the standing claim true — nothing on
 * this surface is ever lost by navigating away — and it makes Discard the one control here that
 * throws anything away, which is the right shape for the one that does.
 */
export function renderPaintActions(kind: PaintKind): (body: HTMLElement) => void {
  return (body) => {
    // The notice is at the top of the step already; a second copy under it would say the same thing
    // twice to a GM who cannot act on either.
    if (inStageTwo()) return;
    const row = document.createElement("div");
    row.className = "step-actions";

    const done = document.createElement("button");
    done.type = "button";
    done.className = "primary";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      void finishPaint("done");
    });

    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard changes";
    discard.addEventListener("click", () => {
      if (!hasUnsavedPaint()) {
        say("nothing has changed since this was last saved");
        return;
      }
      void confirmAction({
        title: "Discard the changes since you last saved?",
        // Names what survives as well as what goes, which is the rule the one-way door's
        // confirmations follow: without it "discard" reads as losing the whole layer.
        body: [
          "The strokes made since this layer was last saved are lost.",
          "Everything saved before that stays, and so do the reading settings, the other layer " +
            "and the map.",
        ],
        confirmLabel: "Discard",
        destructive: true,
      }).then((yes) => {
        if (yes) abandonPaint();
      });
    });

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear layer";
    clear.addEventListener("click", () => {
      void clearWholeLayer();
    });

    row.append(done, discard, clear);

    const note = document.createElement("p");
    note.className = "sub";
    note.innerHTML =
      `<b>Done</b> saves the ${PAINT_NAMES[kind]} and rebuilds the ink. Leaving this step or ` +
      "closing the workspace saves it too &mdash; nothing here is lost by navigating away.";

    body.append(row, note);
  };
}

/**
 * What this step says once the graph is frozen.
 *
 * The same treatment the reading sliders get, and for the same reason: §8 wants a boundary visible
 * *before* it is crossed, so the tools are simply not here rather than present and inert. Painting is
 * a reading input and the frozen graph does not re-derive from the reading — a stroke made here would
 * change nothing visible and then take effect on starting over.
 */
function frozenNotice(kind: PaintKind): HTMLElement {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    `Closed — the graph is frozen, so the ${PAINT_NAMES[kind]} is not being read any more. ` +
    "Start over, under Edit walls, reopens this. Your painting is kept either way.";
  return note;
}

/**
 * Wipe the open layer, after asking.
 *
 * Through the brush rather than by replacing the layer, so there is one path by which a paint layer
 * changes and one place the surface finds out about it. Replacing the array would need the painter
 * to be told separately, which is a second mechanism for the same event.
 */
async function clearWholeLayer(): Promise<void> {
  const layer = workingLayer();
  if (!layer) return;

  const raster = paintRaster();
  const yes = await confirmAction({
    title: "Clear this whole layer?",
    body: [
      "Every mark on this layer goes, including ones already saved.",
      "The reading settings, the other layer and the map are untouched. Nothing is written until " +
        "you press Done, so Discard changes still brings it back.",
    ],
    confirmLabel: "Clear it",
    destructive: true,
  });
  if (!yes) return;

  // A stroke wide enough to cover the raster, which is the brush's own erase applied everywhere.
  const width = raster?.width ?? layer.width;
  const height = raster?.height ?? layer.height;
  const result = paintStroke(
    layer,
    { x: width / 2, y: height / 2 },
    { x: width / 2, y: height / 2 },
    Math.hypot(width, height),
    false,
  );
  if (result.bounds) refreshPaintRegion(result.bounds);
  say(`cleared ${result.changed} px · not saved until you press Done`);
  invalidate();
}
