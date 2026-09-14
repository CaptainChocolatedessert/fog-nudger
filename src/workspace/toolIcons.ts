/**
 * The surface's glyphs, drawn here rather than fetched.
 *
 * ## Why not an icon font
 *
 * The obvious route is a webfont from a CDN, and it is wrong here for the same reason the map picker
 * is a list of radio rows rather than a `<select>`: this page is a sandboxed third-party iframe, and
 * a rendering path we neither control nor can check is one that fails in a room rather than at a
 * desk. A font that does not arrive gives blank boxes or tofu with **no error**, and the strip is
 * where every gesture on this surface is chosen — an unreadable one is not a degraded surface, it is
 * an unusable one.
 *
 * A handful of inline paths cost nothing, need no network, and cannot half-arrive.
 *
 * ## Not only tools
 *
 * Most of these are tools, and the file is named for them. **Undo and redo are not** — they are
 * momentary acts rather than modes, which is exactly why they are *not* in the tool strip — but they
 * want the same 24×24 house style and the same guarantee about arriving, so they are drawn here
 * rather than in a second place with a second set of conventions to keep in step.
 *
 * ## The house style, matched exactly
 *
 * 24×24, `fill="none"`, `stroke="currentColor"`, 1.6 wide, round caps and joins — which is what
 * `nudge-action.svg` already uses. `currentColor` is the part that matters: a selected tool inverts
 * to dark-on-accent and the glyph follows without a second rule anywhere.
 *
 * ## What each one says
 *
 * **Pan is a hand and nothing else is**, which is the established rule on this surface wearing
 * another hat: a hand means the surface moves, a crosshair means the tool acts at a point. Move is
 * arrows around a *vertex* rather than a second hand, so the two cannot be confused.
 *
 * The rest draw the thing they do to the linework: a block covering a stroke, a nib laying one down,
 * a stroke with a gap ringed in it, two ends joined, and one struck out.
 */

const ICONS: Readonly<Record<string, string>> = {
  // An open hand: the surface moves, and the only tool that moves it.
  pan: '<path d="M8 12V5.6a1.4 1.4 0 0 1 2.8 0V11" /><path d="M10.8 11V4.6a1.4 1.4 0 0 1 2.8 0V11" /><path d="M13.6 11.4V6.4a1.4 1.4 0 0 1 2.8 0V15" /><path d="M16.4 10.6a1.4 1.4 0 0 1 2.8 0v3.6a6 6 0 0 1-6 6h-1.4a5 5 0 0 1-3.6-1.5L5 15.6a1.4 1.4 0 0 1 2-2l1 1" />',
  // A broad stroke laid over linework: covering, not deleting.
  suppress:
    '<path d="M3 18h18" stroke-dasharray="2 2.6" /><rect x="5" y="6" width="14" height="7" rx="1.6" /><path d="M8.5 9.5h7" />',
  // A nib putting a line down.
  ink: '<path d="M4 20l1.2-3.6L15.6 6a2 2 0 0 1 2.8 2.8L8 19.2 4.4 20.4z" /><path d="M14.2 7.4l2.4 2.4" />',
  // A stroke with a gap in it, ringed the way the search rings one on the map.
  gaps: '<path d="M3 12h5" /><path d="M16 12h5" /><circle cx="12" cy="12" r="4.2" stroke-dasharray="2.2 2" />',
  // A vertex with somewhere to go. Arrows around a point, so it cannot read as a second hand.
  move: '<circle cx="12" cy="12" r="2.4" /><path d="M12 3.4v3.2M12 17.4v3.2M3.4 12h3.2M17.4 12h3.2" /><path d="M10.6 4.8 12 3.4l1.4 1.4M10.6 19.2 12 20.6l1.4-1.4M4.8 10.6 3.4 12l1.4 1.4M19.2 10.6 20.6 12l-1.4 1.4" />',
  // Two ends joined, which is what drawing a wall is.
  draw: '<circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="5.5" r="2" /><path d="M7 17 17 7" />',
  // A curved arrow turning back on itself. The pair is mirrored rather than rotated, so undo and
  // redo read as opposites at a glance rather than as the same shape at two angles.
  /*
    A group's own settings, and the one glyph here that opens something rather than doing
    something.

    Sliders, because that is what is behind it and because it is the one picture nobody has to be
    taught. It is drawn for **Ink** and **Walls**, whose groups are a column of them.
  */
  params:
    '<path d="M4 7h10M18 7h2" /><path d="M4 12h3M11 12h9" /><path d="M4 17h8M16 17h4" /><circle cx="16" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="14" cy="17" r="2" />',
  // Which image is being traced: a picture with a horizon in it, rather than sliders, because
  // what is behind it is a list of images and not a column of numbers.
  map: '<rect x="3.2" y="5" width="17.6" height="14" rx="2" /><path d="M3.2 15.5 8 11l4 3.5 3-2.5 5.8 4.5" /><circle cx="8.4" cy="9" r="1.4" />',
  // What is drawn, and how it looks. An eye: the one group that changes nothing about the
  // document and only what you can see of it.
  view: '<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12z" /><circle cx="12" cy="12" r="3" />',
  undo: '<path d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11H8" /><path d="M8.2 5.2 3.9 9.5l4.3 4.3" />',
  redo: '<path d="M19.5 9.5h-9a5.5 5.5 0 0 0 0 11H16" /><path d="M15.8 5.2l4.3 4.3-4.3 4.3" />',
  // The same wall, struck out.
  erase: '<circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="5.5" r="2" /><path d="M7 17 17 7" stroke-dasharray="2.4 2.2" /><path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" />',
};

/**
 * The glyph for a tool, as an `<svg>` element.
 *
 * Built rather than returned as markup so the caller appends a node: the strip is rebuilt on every
 * tool change, and handing back a string would put an `innerHTML` assignment in that loop for no
 * reason. `aria-hidden` because the button carries the tool's name in its `aria-label` — the visible
 * text went to a tooltip on 2026-09-09, and this used to say the button had it as text.
 *
 * **Drawn at 2, not 1.6** (2026-09-10). A room reported the tool column as too thin to read, and the
 * arithmetic agreed: on a 24-unit grid shown at about 15px, a 1.6 line renders at 1.04 CSS pixels,
 * which anti-aliases across two pixel columns and reads as grey rather than as its colour. At 2, and
 * with the glyph drawn a little larger by the stylesheet, it lands near 1.5px — the weight common
 * line-icon sets use at this size.
 */
export function toolIcon(id: string): SVGElement | null {
  const paths = ICONS[id];
  if (!paths) return null;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}
