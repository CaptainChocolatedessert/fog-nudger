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
 * on both sides saying they were "kept in step by hand". `applyPalette` writes them out as custom
 * properties at start-up, so the prose in a blurb and the marks on the canvas cannot drift.
 */

export const PALETTE = {
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

  /** Ink the GM covered. Warm, because subtraction reads warm, and the only warm mark on the canvas. */
  subtractive: "#f59e0b",

  /**
   * **Reserved**: about to be removed, and nothing else.
   *
   * It earns its alarm value by being rare. It was doing three jobs — the default ink, the emitted
   * wall lines in the preview, and destructive previews — and the first two moved to `ink` and
   * `structure`. The erase highlight and the doomed spurs share it because they answer the same
   * question: *what does the thing I am about to do remove?*
   */
  destructive: "#dc2626",

  /** Under every cased mark. The half doing the visibility work, on any ground. */
  casing: "#ffffff",
} as const;

export type PaletteRole = keyof typeof PALETTE;

/**
 * Publish the palette as custom properties, so the stylesheet and the canvas agree by construction.
 *
 * The blurbs name colours — "covered areas show in amber" — and those words have to match the marks
 * they describe. They used to be a hardcoded hex in the stylesheet beside a comment asking whoever
 * changed one to change the other.
 */
export function applyPalette(): void {
  const root = document.documentElement;
  for (const [role, value] of Object.entries(PALETTE)) {
    root.style.setProperty(`--${role}`, value);
  }
}
