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
 * **`clear` is an act that IS in the strip**, which undo and redo never were: it sits at the foot of
 * a band and destroys that band's document. So the strip carries a third kind of button beside the
 * drawer opener and the verb — one that neither opens nor arms, and so never draws pressed.
 *
 * ## The house style
 *
 * 24×24, `fill="none"`, `stroke="currentColor"`, round caps and joins — which is what
 * `nudge-action.svg` already uses — but **2 wide rather than its 1.6**, for the reason on `toolIcon`.
 * `currentColor` is the part that matters: a selected tool inverts to dark-on-accent and the glyph
 * follows without a second rule anywhere. **One kind of line is heavier on purpose**: ink, at 4, in
 * every glyph of the Ink band.
 *
 * ## What each one says
 *
 * **Pan is a hand and nothing else is**, which is the established rule on this surface wearing
 * another hat: a hand means the surface moves, a crosshair means the tool acts at a point. Move is
 * arrows around a *vertex* rather than a second hand, so the two cannot be confused.
 *
 * The rest draw the thing they do to the linework: a brush swiping ink away, a pen laying it down,
 * two heavy strokes of ink ringed where a gap parts them, two ends joined, one struck out, two loose
 * wall ends ringed where a mend would join them, a room with a slash through each of its walls, and
 * the same room crossed in the middle, and a wall across between two others with the click on it.
 * **The two gap tools mirror each other** — ink running into the ring, walls ending in it.
 */

const ICONS: Readonly<Record<string, string>> = {
  // An open hand: the surface moves, and the only tool that moves it.
  pan: '<path d="M8 12V5.6a1.4 1.4 0 0 1 2.8 0V11" /><path d="M10.8 11V4.6a1.4 1.4 0 0 1 2.8 0V11" /><path d="M13.6 11.4V6.4a1.4 1.4 0 0 1 2.8 0V15" /><path d="M16.4 10.6a1.4 1.4 0 0 1 2.8 0v3.6a6 6 0 0 1-6 6h-1.4a5 5 0 0 1-3.6-1.5L5 15.6a1.4 1.4 0 0 1 2-2l1 1" />',
  /*
    A broad brush swipe crossing a heavy stroke of ink, with the ink gone where the swipe passed.

    **The heavy stroke is ink throughout the Ink band** (user, 2026-09-16), as in Gaps below it. This
    was a box over a line above a dashed baseline, which never said ink. Diagonal, so its outline is
    unlike the ring Gaps is built round. **The cost, chosen:** it does not say the ink comes back when
    the paint is erased — covering rather than deleting is the one thing the old glyph tried to show.
  */
  suppress:
    '<path d="M2.5 12h3.2" stroke-width="4" /><path d="M18.3 12h3.2" stroke-width="4" /><rect x="4" y="9" width="16" height="6" rx="3" transform="rotate(-45 12 12)" />',
  /*
    A pen at the end of a heavy stroke of ink it has just laid down.

    The nib it always was, smaller, with the Ink band's heavy stroke added (user, 2026-09-16). Chosen
    over Suppress's own swipe filled with ink, which would have paired the two brushes as opposites
    and left them one outline apart on adjacent buttons — the confusion Mend's glyph was redrawn to
    end. **The cost:** the most detailed glyph in the band, and a pen suggests a fine line where the
    tool is a brush with a width.
  */
  ink: '<path d="M3.5 19H8.5" stroke-width="4" /><path d="M11.5 19l.57-2.97 6.72-6.72a1.7 1.7 0 0 1 2.4 2.4l-6.72 6.72z" /><path d="M17 11.1l2.4 2.4" />',
  /*
    Two heavy strokes of ink stopping short of each other inside a dashed ring, the way the search
    rings a gap on the map.

    **Drawn as Mend's mirror** (user, 2026-09-16): the same ring at the same size, with ink running in
    where Mend has walls ending in vertex dots, so the two gap tools read as one act on two documents.
    **The strokes are 4 wide, twice the house line**, and that is the cost chosen: it is what
    says *ink* rather than *wall* while staying outline-only — solid blobs were the other way to say
    it, and would have been the first filled shapes in the strip.
  */
  gaps: '<path d="M2.5 12H8" stroke-width="4" /><path d="M16 12h5.5" stroke-width="4" /><circle cx="12" cy="12" r="7" stroke-dasharray="2.2 2" />',
  /*
    Suppress's own swipe, across a solid blot instead of a stroke — chosen from four at strip size
    (user, 2026-09-17).

    **The pair with Suppress is the point.** That glyph is a broad swipe crossing a heavy stroke of
    ink with the ink gone where the swipe passed; this is the identical swipe across a filled *area*.
    The band's rule is that a heavy stroke is ink, and the one thing this tool turns on is that a
    solid mark is not a stroke — so an area is the only part that may differ.

    **The swipe is empty, not drawn over the fill** (user, same day). Lying on top, the blot showed
    through it and the glyph said "a blot with a band drawn on it"; empty, it says what Suppress's
    says — what the swipe passed over is gone.

    **Two lumps either side of it, and not one path with a hole in it.** `fill-rule="evenodd"` was the
    obvious way and is wrong here: even-odd is a *symmetric difference*, so the parts of the capsule
    lying outside the blot — which are most of it, since the swipe must run past both ends — would
    have filled solid instead of cutting. Two shapes stopping short of the band is also exactly
    Suppress's own construction, where two heavy ink stubs stop either side of the same rect.

    **The rect is Suppress's, unchanged**, so the pair holds at any size: same width, same radius,
    same rotation about the same centre.
  */
  blob:
    '<path d="M13 5L4.5 13.5c-.9-.8-1.2-1.9-1-3 .5-2.8 3.1-5.2 6.1-5.8 1.3-.3 2.5-.1 3.4 .3z" fill="currentColor" stroke="none" />' +
    '<path d="M18.5 11.5L13 17c.9 1.4 2.2 2.3 3.4 2.3 2-.1 3.3-2.3 2.9-4.7-.2-1.1-.4-2.2-.8-3.1z" fill="currentColor" stroke="none" />' +
    '<rect x="4" y="9" width="16" height="6" rx="3" transform="rotate(-45 12 12)" />',
  // A vertex with somewhere to go. Arrows around a point, so it cannot read as a second hand.
  move: '<circle cx="12" cy="12" r="2.4" /><path d="M12 3.4v3.2M12 17.4v3.2M3.4 12h3.2M17.4 12h3.2" /><path d="M10.6 4.8 12 3.4l1.4 1.4M10.6 19.2 12 20.6l1.4-1.4M4.8 10.6 3.4 12l1.4 1.4M19.2 10.6 20.6 12l-1.4 1.4" />',
  // Two ends joined, which is what drawing a wall is.
  draw: '<circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="5.5" r="2" /><path d="M7 17 17 7" />',
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
  // A curved arrow turning back on itself. The pair is mirrored rather than rotated, so undo and
  // redo read as opposites at a glance rather than as the same shape at two angles.
  undo: '<path d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11H8" /><path d="M8.2 5.2 3.9 9.5l4.3 4.3" />',
  redo: '<path d="M19.5 9.5h-9a5.5 5.5 0 0 0 0 11H16" /><path d="M15.8 5.2l4.3 4.3-4.3 4.3" />',
  /*
    Two loose wall ends facing each other inside a dashed ring, which is what the tool puts on the map.

    **Not Draw's wall with a break in it**, which it was until 2026-09-16: that kept Draw's diagonal and
    its end dots, so at strip size the difference was a few pixels in the middle and a room found the
    two hard to tell apart (user). Level rather than diagonal, and ringed, so its outline is unlike
    every other wall tool's. **Deliberately mirrored by Gaps** a band above — the same act on the ink
    rather than on the walls — and the vertex dots are what say walls.
  */
  mend: '<path d="M2.5 12H7" /><path d="M17 12h4.5" /><circle cx="8.6" cy="12" r="1.6" /><circle cx="15.4" cy="12" r="1.6" /><circle cx="12" cy="12" r="7" stroke-dasharray="2.2 2" />',
  // The same wall, struck out.
  erase: '<circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="5.5" r="2" /><path d="M7 17 17 7" stroke-dasharray="2.4 2.2" /><path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" />',
  /*
    A room with a single slash through each of its walls: every wall goes (user, 2026-09-16).

    **Where the mark sits says what goes**, and Suppress region is the other half of that: the same
    room with a cross in the middle, where the room is struck and its walls stay. So both draw their
    walls solid and the marks alone tell them apart. This was the room dashed and crossed in the middle
    for its first day, which is the mark Suppress region takes; a dashed wall is how this surface draws
    one that is going, and the tool that keeps its walls could not wear that.

    A slash rather than a cross on each wall, because four crosses blurred into a spiky square at strip
    size. **The cost:** one slash says "delete" less strongly than a cross does.
  */
  dissolve:
    '<circle cx="5" cy="5" r="1.8" /><circle cx="19" cy="5" r="1.8" /><circle cx="19" cy="19" r="1.8" /><circle cx="5" cy="19" r="1.8" /><path d="M7 5h10M19 7v10M17 19H7M5 17V7" /><path d="M10 7l4-4M10 21l4-4M3 14l4-4M17 14l4-4" />',
  /*
    The same room crossed in the middle: the room goes, its walls stay (user, 2026-09-16). Dissolve's
    other half — where the mark sits says what goes — and the cross is also the mark the tool leaves
    on the map.
  */
  suppressRegion:
    '<circle cx="5" cy="5" r="1.8" /><circle cx="19" cy="5" r="1.8" /><circle cx="19" cy="19" r="1.8" /><circle cx="5" cy="19" r="1.8" /><path d="M7 5h10M19 7v10M17 19H7M5 17V7" /><path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8" />',
  /*
    Two walls with a new wall across between them, and the click as a small solid dot on it (user,
    2026-09-16). The side walls stop at their vertex rings rather than running through them, so the
    rings read hollow as every other vertex here does; the click is solid and smaller, because it is a
    point in the map rather than a vertex of the graph.
  */
  span: '<path d="M5 3v7M5 14v7M19 3v7M19 14v7" /><circle cx="5" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /><path d="M7 12h10" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />',
  /*
    A bin, and the one glyph here that **is drawn twice** — at the foot of Ink and at the foot of
    Walls, for *Clear ink edits* and *Clear wall edits* (user, 2026-09-20, from four candidates at
    strip size).

    **The band above it says which subject**, which is the strip's own ordering rule — *what a tool
    acts on is said by where it is* — and the column already repeats a glyph on exactly that
    argument: `params` is drawn for Ink, Walls and View. The three candidates that put the subject
    *into* the glyph were each shown beside their real neighbours and each cost more than they
    bought: the band's heavy ink stroke or a wall between two vertex rings is about a fifth of a
    glyph at 18px, a struck-out wall is very nearly Erase three buttons above it, and a slashed pair
    was the busiest thing in the column.

    **The cost, chosen:** two identical destructive buttons in one column, so telling them apart
    means reading the caption rather than the picture. And a bin is the first piece of *furniture*
    in a strip whose glyphs otherwise all draw the map — which is also what makes it read as an act
    rather than as a tool, since it is neither a drawer to open nor a verb to arm.
  */
  /*
    **Straighten**: the same wall twice, crooked on the left and straight on the right (user,
    2026-09-21, chosen from four at strip size). Both wear vertex rings at their ends, because the
    fitter keeps both ends of what it is handed and drops only what is between — which is the whole
    of what the tool does.

    **Nothing between the two**, and that is the cost chosen: the eye has to decide they are one wall
    twice rather than two walls. A dot between them said *one thing* more clearly and was the
    smallest mark in the band; dimming the crooked side said it best of all and was ruled out
    because the strip already dims a disabled glyph to 0.65, so the two dimmings would stack.
  */
  straighten:
    '<circle cx="6" cy="3.6" r="1.6" /><circle cx="6" cy="20.4" r="1.6" /><path d="M6 5.2 3.9 9.4 8.1 14.6 6 18.8" />' +
    '<circle cx="18" cy="3.6" r="1.6" /><circle cx="18" cy="20.4" r="1.6" /><path d="M18 5.2v13.6" />',
  /*
    **Prune the dead ends**: a long wall with a stub off it, and a single slash through the stub
    (user, 2026-09-21).

    **The slash is Dissolve region's own mark**, and it carries the same rule — *where the mark sits
    says what goes*. Here it sits on the stub alone, because the wall stays.

    **The wall runs off both edges of the box and wears no end rings**, which is what says it is long:
    a spur is short *relative* to the wall it hangs from, and a limit that takes it leaves the wall
    standing. The junction ring joins two segments rather than sitting on one, which is how every
    other glyph in this band is built.
  */
  prune:
    '<path d="M6 1.5v8.8M6 13.7v8.8" /><circle cx="6" cy="12" r="1.7" />' +
    '<circle cx="19.5" cy="12" r="1.7" /><path d="M7.7 12h10.1" /><path d="M11 16.5 16 7.5" />',
  /*
    **Add walls around the map edge**: the map picker's own picture with a vertex ring at each corner
    (user, 2026-09-21).

    Reusing `map`'s box, horizon and sun is the point — the subject is *this map's edge* — and the
    four rings are what the button actually builds: four segments as one closed run, so the corners
    are shared vertices by construction. The box is drawn as four segments stopping at the rings
    rather than as a rectangle behind them, which is Dissolve region's construction exactly.

    **The cost:** it is the most detailed glyph in the band, carrying a horizon and a sun inside a
    ringed box at 18px.
  */
  frame:
    '<circle cx="4.2" cy="5.2" r="1.8" /><circle cx="19.8" cy="5.2" r="1.8" />' +
    '<circle cx="19.8" cy="18.8" r="1.8" /><circle cx="4.2" cy="18.8" r="1.8" />' +
    '<path d="M6 5.2h12M19.8 7v10M18 18.8H6M4.2 17V7" />' +
    '<path d="M6.4 15.4 9.8 12l2.6 2.3 2.1-1.8 3.1 2.6" /><circle cx="8.6" cy="9.2" r="1.2" />',
  clear:
    '<path d="M4 7.6h16" /><path d="M9.8 7.6V5.4a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v2.2" />' +
    '<path d="M6.4 7.6l.85 11.8a2 2 0 0 0 2 1.85h5.5a2 2 0 0 0 2-1.85L17.6 7.6" />' +
    '<path d="M10 11.6v6M14 11.6v6" />',
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
