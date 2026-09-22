/**
 * *Collapse small regions*' own drawer: the size, and the button that collapses every region ringed.
 *
 * Registered with the drawer as tool content, as Mend's and the amounts' are, and drawn only while
 * this tool's drawer is the one open. The line above it is the tool's group blurb, which the drawer
 * paints into the hint slot — so it is not drawn here a second time.
 *
 * ## The handle is a place, not a measurement
 *
 * It reads **off** at the far left and **1 to 100** beyond, as Straighten's and Prune's do (user,
 * 2026-09-21): the number is for remembering where you were while trying settings, and an area in
 * square graph units is not a thing anybody can hold on to. The real figure reaches the log when the
 * button is pressed.
 *
 * **It applies as it moves.** The rings follow the handle, because the search is a filter over areas
 * worked out once per graph — `collapseSearch.ts` has the measurement — and at most once a frame.
 *
 * **Back at the start every opening**: arming the tool is opening this drawer, and arming it starts
 * the search at eight square ink widths (`collapseScale.ts`). This reads that size to place the handle
 * rather than keeping a position of its own, so a redraw of the drawer can never move it.
 *
 * DOM only. What the button does is `wallEdit`'s, because collapsing is an edit and every edit saves
 * through the one path.
 */

import { SLIDER_STEPS, fromSlider, toSlider } from "../sliderScale";
import { describeCollapses } from "./collapseGesture";
import { collapseLimits } from "./collapseScale";
import { collapseSize, setCollapseSize } from "./collapseSearch";
import { currentToolDrawer } from "./drawer";
import { invalidate, mapExtent, say } from "./shell";
import { workOn } from "./subject";
import { collapseEveryRegionShown } from "./wallEdit";

/** Set while a frame is owed a search, so a drag costs one per frame rather than one per pixel. */
let frameAsked = false;
/** The latest handle position waiting for that frame. */
let pending = 0;

/** The handle's place as one to a hundred, or "off" at the far left — Straighten's readout exactly. */
function readoutFor(position: number): string {
  return position > 0 ? String(Math.max(1, Math.round((position / SLIDER_STEPS) * 100))) : "off";
}

export function renderCollapseControls(rows: HTMLElement): void {
  if (currentToolDrawer() !== "collapse") return;
  const extent = mapExtent();
  const limits = extent ? collapseLimits(extent) : null;

  // The ordinary row's markup — `row > top > (label, value)` with the slider under it — which is what
  // the stylesheet places and colours. The amounts learned that the hard way (`wallAmounts.ts`).
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
  const size = collapseSize() ?? 0;
  const position = limits ? toSlider(size, limits, "log") : 0;
  slider.value = String(position);
  slider.disabled = limits === null;
  label.htmlFor = slider.id = "collapse-size";
  readout.textContent = readoutFor(position);

  slider.addEventListener("input", () => {
    if (!limits) return;
    workOn("walls");
    pending = Number(slider.value);
    readout.textContent = readoutFor(pending);
    if (frameAsked) return;
    frameAsked = true;
    requestAnimationFrame(() => {
      frameAsked = false;
      const found = setCollapseSize(fromSlider(pending, limits, "log"));
      if (found !== null) say(pending > 0 ? describeCollapses(found) : "off — nothing is ringed");
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
  all.textContent = "Collapse every region shown";
  all.addEventListener("click", () => {
    collapseEveryRegionShown();
  });
  actions.append(all);
  rows.append(actions);
}
