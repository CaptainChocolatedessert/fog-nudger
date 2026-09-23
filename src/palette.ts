/**
 * Every colour the surface draws over the map, in one declaration.
 *
 * ## Two rules come before any hue
 *
 * **Visibility is structural, not chromatic.** We do not control the map, so no hue is reliably
 * legible on it — one that reads on parchment vanishes on slate. What *is* controllable is the mark's
 * construction: a light casing under a saturated core, which is how wall centrelines have been drawn
 * since a room reported "no stubs showing" when all 22 were being drawn in near-black on top of the
 * map's own linework. Every mark that must be seen is built that way, so hue carries meaning and the
 * casing carries visibility instead of the two competing.
 *
 * **Avoid the map's own territory.** Map artwork lives in warm, low-chroma pigment: tans, browns,
 * ochres, muted greens and blues. Saturated cyan, magenta and violet essentially never occur in it,
 * which is what makes them the safe families here.
 *
 * ## Two axes, not one list
 *
 * **Hue** says what kind of thing it is. **Treatment** says how real it is: solid is committed,
 * hollow or dashed is proposed.
 *
 * That removes "information" as a category. The gap finder is not a third kind of thing — it is the
 * **additive** category in its *proposed* state, which is literally what it does. It also makes
 * structural a distinction that has already caused a defect here, when an unexamined gap was painted
 * solid and became indistinguishable from ink the repair had really invented. Proposals are not
 * solid, so that cannot recur.
 *
 * ## Why the values live here rather than beside each layer
 *
 * They were spread across three layer modules and duplicated again in the stylesheet, with comments
 * on both sides saying they were "kept in step by hand". One declaration, published as custom
 * properties, so the prose in a blurb and the marks on the canvas cannot drift.
 *
 * These are **defaults**. Each is adjustable per category, because no fixed hue is legible on every
 * map and the GM is the only one who can see which they have. `workspace/palette.ts` is where the
 * live value is read; this half is pure so `settings.ts` can take its defaults from it.
 *
 * Pure: no DOM, no SDK.
 */

export const PALETTE_DEFAULTS = {
  /**
   * What the trace read. The default for the ink mask, which the GM can still change.
   *
   * Violet rather than the red it used to be, for two reasons. Red reads as an error for something
   * that is only a reading; and **ink is the largest area on screen**, worn for the whole session at
   * partial opacity, so it should be the calmest thing there rather than the loudest.
   */
  ink: "#9333ea",

  /** The wall graph. Cased, because a centreline lies exactly on the map's own linework. */
  structure: "#1d4ed8",

  /**
   * Anything being added: ink the GM drew, a gap proposal, an end that would attach.
   *
   * **Attach is cyan and not green**, which an earlier draft had. Green for *will attach* against red
   * for *will remove* is the classic pair that the commonest colour blindness cannot separate — and
   * folding attach in here is more correct anyway, since a snap target is an addition.
   */
  additive: "#06b6d4",

  /**
   * What the GM took out: ink they covered, and the marks that leave a region out of the fog. Warm,
   * because subtraction reads warm, and the only warm marks on the canvas.
   */
  subtractive: "#f59e0b",

  /**
   * **Reserved**: about to be removed, and nothing else.
   *
   * It earns its alarm value by being rare. It was doing three jobs — the default ink, the emitted
   * wall lines in the preview, and destructive previews — and the first two moved to `ink` and
   * `structure`. The erase highlight, the walls a dissolve would take, the mark a click would remove
   * and the doomed spurs share it because they answer the same question: *what does the thing I am
   * about to do remove?*
   */
  destructive: "#dc2626",

  /**
   * Under every cased mark. The half doing the visibility work, on any ground.
   *
   * **Not adjustable, and that is the point.** The casing is what makes a hue legible on a map we do
   * not control; letting it be tinted would let a GM tune away the mechanism the other five rely on.
   * They adjust the core, and this stays light.
   */
  casing: "#ffffff",
} as const;

export type PaletteRole = keyof typeof PALETTE_DEFAULTS;

/** Every adjustable role, in the order a GM meets them. `casing` is not one — see below. */
export const PALETTE_ROLES = ["ink", "structure", "additive", "subtractive", "destructive"] as const;

export type AdjustableRole = (typeof PALETTE_ROLES)[number];

/**
 * What each role is called where a GM can see it, and what it marks.
 *
 * Named by **what it means** rather than by the layer it happens to appear on, which is the whole
 * point of grouping the pickers this way: adjusting for a map with an unusual tint should move one
 * control and have everything additive follow, rather than hunting three layers for three hues that
 * have to agree.
 */
export const ROLE_LABELS: Readonly<Record<AdjustableRole, { name: string; means: string }>> = {
  ink: { name: "Ink", means: "what counts as a mark on the map" },
  structure: { name: "Walls", means: "the walls, drawn over the linework itself" },
  additive: { name: "Added", means: "ink you drew, gaps proposed, an end that would attach" },
  // "Covered" until 2026-09-10: the verb the Suppress tool used before both paint tools became Draw
  // and Erase. Named for the tool now, the way "Added" is named for Add ink.
  subtractive: { name: "Suppressed", means: "ink you marked to ignore" },
  destructive: { name: "Going", means: "what the next click would remove" },
};
