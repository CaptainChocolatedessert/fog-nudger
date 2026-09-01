/**
 * Owlbear's theme, translated into the CSS custom properties the panel's stylesheet reads.
 *
 * ## Why the host's theme and not the operating system's
 *
 * Owlbear carries its own light/dark setting, independent of the OS. So `prefers-color-scheme` is
 * the wrong signal: it answers a question nobody asked, and it can disagree with the surface the
 * panel is sitting on. Asking Owlbear is the only way to match it.
 *
 * ## Why the stylesheet keeps a complete default set anyway
 *
 * The panel's first version set no background at all, which left the iframe transparent — so
 * Owlbear's dark popover showed through while the text stayed the UA's black. Unreadable, and
 * unreadable in a way that only appears once it is embedded in the host.
 *
 * The lesson generalises past that one bug: this page must be self-consistently readable *before*
 * the theme arrives, *if* the theme call fails, and *if* the payload turns out to be missing
 * fields. That means the stylesheet owns a full, opaque, readable palette, and this function only
 * ever supplies overrides.
 *
 * Which is why it returns just the entries it could actually fill. A missing field must leave the
 * default standing, and the way to get that wrong is to emit the key with an empty or `undefined`
 * value — which does not fall back to the default, it blanks it.
 *
 * **That invariant holds on the first application only.** Omitting a key leaves whatever is already
 * on the element, which is the stylesheet's default the first time and the *previous theme's* value
 * every time after. Unobservable today, since the SDK's `Theme` makes every field required, so the
 * omission only happens on a payload that is wrong anyway; the one-line fix if it is ever wanted is
 * `removeProperty` for keys not in the returned record.
 *
 * ## The panel's stylesheet, and only the panel's
 *
 * `panel.ts` is the sole caller. **The workspace applies no theme at all** and hard-codes every
 * colour, which is deliberate rather than an omission: it is a drawing surface, and a fixed neutral
 * ground is what the ink colours and the six-colour partition cycle were chosen against — a palette
 * that moved with the host would move what those read against. The cost, stated: a GM running
 * Owlbear in light mode gets a dark full-screen sheet.
 *
 * ## Why it takes `unknown`
 *
 * The theme arrives from the parent frame as a structured clone. Nothing in this process
 * constructed it and nothing here can guarantee its shape, so the type it is declared with would
 * be a claim rather than a check. Validating is cheap; a `TypeError` inside the code that paints
 * the page is not.
 *
 * Pure, and therefore testable — the SDK cannot be imported into a node test at all.
 */
export function themeVariables(theme: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (theme === null || typeof theme !== "object") return out;

  const record = theme as Record<string, unknown>;
  const background = asRecord(record.background);
  const text = asRecord(record.text);
  const primary = asRecord(record.primary);

  // `paper` is the raised surface a popover sits on; `default` is the page behind it. Prefer the
  // first and accept the second, because a panel matching the wrong one of Owlbear's two greys is
  // a much smaller problem than a panel matching neither.
  const bg = asColor(background.paper) ?? asColor(background.default);
  if (bg) out["--bg"] = bg;

  const primaryText = asColor(text.primary);
  if (primaryText) out["--text"] = primaryText;

  const secondaryText = asColor(text.secondary);
  if (secondaryText) out["--dim"] = secondaryText;

  const accent = asColor(primary.main);
  if (accent) out["--accent"] = accent;

  // Owlbear's theme carries no error colour, so this one is ours — but a single red cannot serve
  // both modes. A red legible on the dark surface is washed out on the light one, and the message
  // it carries is the one that must not be missed. Keyed off the mode rather than guessed at.
  if (record.mode === "LIGHT") out["--danger"] = "#b3261e";
  else if (record.mode === "DARK") out["--danger"] = "#ff8a80";

  // Separator and button-fill tint, likewise ours rather than the theme's. A translucent black over
  // a light surface and a translucent white over a dark one, so it reads as the same faint step in
  // both rather than as a colour.
  if (record.mode === "LIGHT") out["--line"] = "#00000024";
  else if (record.mode === "DARK") out["--line"] = "#ffffff1f";

  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * A colour is usable only if it is a non-empty string. `""` is the case worth naming: it is a
 * string, it passes a `typeof` test, and assigning it to a custom property overrides the default
 * with nothing rather than leaving the default in place.
 */
function asColor(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
