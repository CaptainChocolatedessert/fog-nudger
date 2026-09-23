/**
 * *Suppress speckles*' own drawer: the span, and the button that takes every lump ringed.
 *
 * *Prune the dead ends*' drawer in every particular that matters, so the ringed tools read as one kind
 * of thing. The line above it is the tool's group blurb, which the drawer paints into the hint slot.
 *
 * **A place, not a measurement**: off at the far left and 1 to 100 beyond, as every ringed track reads.
 * **It searches as it moves**, at most once a frame, and writes nothing — a press is still what takes
 * anything.
 *
 * **Where it starts**: at *Smallest mark to keep*, the reading's own filter, so the tool opens agreeing
 * with what the reading already does and the GM moves it from there. That setting stays what it is; this
 * is a search bound, not a copy of it.
 *
 * DOM only. What the button does is `paintTool`'s, because suppressing is paint.
 */

import { SLIDER_STEPS, fromSlider, toSlider, type ScaleLimits } from "../sliderScale";
import { currentToolDrawer } from "./drawer";
import { suppressEverySpeckleShown } from "./paintTool";
import { invalidate, say } from "./shell";
import { setSpeckleSpan, speckleMarks, speckleRaster, speckleSpan } from "./speckleSearch";
import { workOn } from "./subject";

let frameAsked = false;
let pending = 0;

/**
 * The track, in raster pixels.
 *
 * **The top is the whole map** (user, 2026-09-22: *"The top end of the slider might as well be the whole
 * map size. That's worked ok with a log scale elsewhere."*). It was a fifth of the shorter side, on the
 * argument that a room is the biggest thing worth offering — but the wall network is the only thing up
 * there, the log scale spends its length where the lumps are, and the preview says what would go.
 */
function limits(): ScaleLimits | null {
  const raster = speckleRaster();
  if (!raster) return null;
  return { min: 0, max: Math.max(4, Math.max(raster.width, raster.height)), step: 1, floor: 1 };
}

function readoutFor(position: number): string {
  return position > 0 ? String(Math.max(1, Math.round((position / SLIDER_STEPS) * 100))) : "off";
}

export function renderSpeckleControls(rows: HTMLElement): void {
  if (currentToolDrawer() !== "speckles") return;
  const scale = limits();

  const wrapper = document.createElement("div");
  wrapper.className = "row";
  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.textContent = "Size";
  const readout = document.createElement("span");
  readout.className = "value";
  top.append(label, readout);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(SLIDER_STEPS);
  slider.step = "1";
  const position = scale ? toSlider(speckleSpan(), scale, "log") : 0;
  slider.value = String(position);
  slider.disabled = scale === null;
  label.htmlFor = slider.id = "speckle-span";
  readout.textContent = readoutFor(position);

  slider.addEventListener("input", () => {
    if (!scale) return;
    workOn("ink");
    pending = Number(slider.value);
    readout.textContent = readoutFor(pending);
    if (frameAsked) return;
    frameAsked = true;
    requestAnimationFrame(() => {
      frameAsked = false;
      setSpeckleSpan(pending > 0 ? fromSlider(pending, scale, "log") : 0);
      const found = speckleMarks().length;
      say(
        pending > 0
          ? `${found} lump${found === 1 ? "" : "s"} ringed at ${speckleSpan()} px`
          : "off — nothing is ringed",
      );
      invalidate();
    });
  });
  wrapper.append(top, slider);
  rows.append(wrapper);

  const actions = document.createElement("div");
  actions.className = "step-actions";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip";
  all.textContent = "Suppress every lump shown";
  all.addEventListener("click", () => {
    suppressEverySpeckleShown();
  });
  actions.append(all);
  rows.append(actions);
}
