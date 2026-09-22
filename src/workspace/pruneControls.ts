/**
 * *Prune the dead ends*' own drawer: the length, and the button that prunes every piece ringed.
 *
 * *Collapse small regions*' drawer in every particular that matters, so the two ringed tools under the
 * one amount read as one kind of thing (user, 2026-09-22: Prune as it was *"feels inconsistent"*). The
 * line above it is the tool's group blurb, which the drawer paints into the hint slot.
 *
 * **A place, not a measurement**: off at the far left and 1 to 100 beyond, as every graph track reads.
 * **It applies as it moves**, at most once a frame. **Back at the start every opening**: arming the tool
 * starts the search at four ink widths, and this reads that length to place the handle, so a redraw of
 * the drawer can never move it.
 *
 * DOM only. What the button does is `wallEdit`'s, because pruning is an edit.
 */

import { SLIDER_STEPS, fromSlider, toSlider } from "../sliderScale";
import { currentToolDrawer } from "./drawer";
import { spurTop } from "./graphScale";
import { pruneLimits } from "./pruneScale";
import { pruneLength, setPruneLength } from "./pruneSearch";
import { describePrunes } from "./ringGesture";
import { invalidate, say } from "./shell";
import { workOn } from "./subject";
import { pruneEveryDeadEndShown } from "./wallEdit";

let frameAsked = false;
let pending = 0;

function readoutFor(position: number): string {
  return position > 0 ? String(Math.max(1, Math.round((position / SLIDER_STEPS) * 100))) : "off";
}

export function renderPruneControls(rows: HTMLElement): void {
  if (currentToolDrawer() !== "prune") return;
  const limits = pruneLimits(spurTop());

  const wrapper = document.createElement("div");
  wrapper.className = "row";
  const top = document.createElement("div");
  top.className = "top";
  const label = document.createElement("label");
  label.textContent = "Length";
  const readout = document.createElement("span");
  readout.className = "value";
  top.append(label, readout);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(SLIDER_STEPS);
  slider.step = "1";
  const position = limits ? toSlider(pruneLength() ?? 0, limits, "log") : 0;
  slider.value = String(position);
  slider.disabled = limits === null;
  label.htmlFor = slider.id = "prune-length";
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
      const found = setPruneLength(fromSlider(pending, limits, "log"));
      if (found !== null) say(pending > 0 ? describePrunes(found) : "off — nothing is ringed");
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
  all.textContent = "Prune every dead end shown";
  all.addEventListener("click", () => {
    pruneEveryDeadEndShown();
  });
  actions.append(all);
  rows.append(actions);
}
