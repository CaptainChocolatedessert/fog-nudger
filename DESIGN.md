# fog-nudger — design record

An Owlbear Rodeo extension: **tools for creating and refining the walls that drive dynamic fog.**

This file is the design record — architecture, constraints, rejected alternatives, open questions,
build order. It is the place reasoning lives. Operating context for Claude lives in `CLAUDE.md`,
which is private and gitignored; where the two disagree, this one wins.

**Sibling project.** `../W - cartographers-fog` is a working Owlbear extension by the same author,
public at [CaptainChocolatedessert/cartographers-fog](https://github.com/CaptainChocolatedessert/cartographers-fog).
It is readable from here and it is the single most valuable asset this project has: a year of
Owlbear SDK facts that were expensive to learn, a tested trace pipeline that does most of what step
one needs, and a testing culture worth copying wholesale. **Read its `DESIGN.md` before designing
anything here.** Much of what looks like a fresh decision has already been made and measured there.

---

## 1. What this is for

A map image shows walls. Owlbear's dynamic fog needs walls as *geometry*. Today a GM draws them by
hand, one line at a time, over every room and corridor of every map they run — the single most
tedious piece of prep in the tool.

The proposition: the map already contains the walls, drawn in ink. A trace pipeline can extract
their centrelines. The GM's job then changes from *drawing* walls to *correcting* them.

That framing sets the shape of the whole project, and it is why this is a nudger rather than an
extractor:

- **Automatic extraction will never be perfect** on a hand-drawn map. Doors, arches, curtains,
  windows, secret passages and rubble all read as ink and none of them mean "solid wall".
- So the output is a **proposal**, not a result. It must be reviewable, editable piece by piece, and
  rejectable in pieces without discarding the rest.
- A tool that gets a GM 85% of the way in one click and lets them fix the rest is a large win. A
  tool that claims 100% and is wrong in three places nobody notices is *worse than nothing*,
  because a wall in the wrong place is an invisible bug that only surfaces mid-session as a room
  the party can see into.

---

## 2. Why a separate extension from cartographers-fog

Both trace a map image, and the temptation to merge them should be resisted:

| | cartographers-fog | fog-nudger |
|---|---|---|
| Relationship to walls | **consumes** them, to compute visibility | **produces** them |
| When it runs | continuously, all session, on every client | once per map, GM only, at prep time |
| Output | aesthetic — a hand-drawn sketch | functional — geometry the fog engine obeys |
| Cost of being slightly wrong | a slightly ugly line | a room the party can see into |

The lifecycles have nothing in common. A GM who wants one may not want the other, and bundling
would mean a play-time extension carrying an authoring tool's weight on every client.

---

## 3. The pipeline mostly exists — and it aims almost the right way

cartographers-fog turns a map image into centrelines through a chain that is pure, tested, and
already tuned against real maps:

```
field → binarize → thin → skeleton → chop
```

It reaches for **centrelines**, not contours, and that decision is the whole reason it is reusable
here. Its `DESIGN.md` records why, and it is worth restating because the wrong instinct is strong:
**contour/edge detection traces the silhouette of ink, giving two lines for every drawn line.** A
wall drawn 8px wide becomes two walls 8px apart with a hollow gap between them, and the party can
stand inside it. Centreline extraction gives one line down the middle of the ink, which is what a
wall actually is.

So step one is largely a **re-aim of existing tested code** rather than fresh invention. The tuning
levers, in the sibling's order of payoff: `minContourLength`, `blurSigma`, `sauvolaRadius`.

### Dynamic Fog does the stroking, so we must not — *read from source, 2026-08-04*

Its wall geometry helper does not treat a drawn line as the wall. It **strokes the path to the
drawing's own `strokeWidth`** and takes the contour of the stroked result, giving a thin closed loop
around the stroke. Curves are sampled at a fixed interval, and open doors are subtracted from the
result with a path operation.

That is the two-lines-per-stroke shape §3 warns against, adopted deliberately — at a stroke a few
pixels wide the loop is simply a wall with thickness, and a closed loop is better fog geometry than
an open line because it blocks identically from both sides.

**The consequence for this project is a trap avoided.** Emitting contours of the map's ink would put
the stroking step in twice: our contour, stroked again into a contour of a contour, yielding walls
bounding the *edges* of each drawn wall with a hollow gap between them — the failure mode §3 exists
to prevent, arriving through the back door after the pipeline did the right thing.

So the output stays exactly what the sibling's pipeline already produces: **centrelines, emitted as
thin drawings**, with the wall's thickness carried by `strokeWidth` and the stroking left to
Dynamic Fog. This also settles a question that would otherwise have needed answering — the extracted
ink's measured width is not something we have to reproduce as geometry; it is at most a hint for
choosing a `strokeWidth`.

### But the quality bar inverts, and that changes the tuning

In cartographers-fog the output is decoration and approximation is *desirable* — there is a
deliberate wobble applied to make strokes look hand-drawn. Here the output is load-bearing. Three
consequences, each the reverse of the sibling's choice:

- **No wobble, ever.** Not a setting, not a default — the concept does not belong here.
- **Simplification must be conservative, and its direction matters.** The sibling learned this on
  the parchment overlay: a simplifier cuts concave corners *outward*, and outward beside a wall
  means into the next room. There it was paid for with an erosion step. Here, an outward error puts
  a wall somewhere the map does not have one. Prefer more vertices over fewer; a wall is not a
  drawing and nobody looks at its vertex count.
- **The short-segment filter changes meaning.** `minContourLength` drops specks; for a sketch a
  missing squiggle is invisible, but for walls a dropped short segment is a **missing doorframe or
  pillar** — a hole in a room's perimeter, which is exactly the failure mode that leaks sight.
  Expect to want this far lower here, and to need a different guard against noise.

### What is genuinely new

- **Joining.** Skeleton chains must become long polylines with clean junctions, not a scatter of
  short segments. Both candidate outputs carry a whole polyline in one item — a `WALL` its `points`,
  a `PATH` its commands — so an entire room outline can be a single item, which matters enormously
  for the item budget (§5).
- **Classification.** Which extracted lines are walls at all? A map's ink includes furniture,
  grids, labels, hatching and compass roses. Some of this can be filtered geometrically; the rest is
  the GM's call, which is the review step.
- **Editing.** "Refining" is half the product and has no counterpart in the sibling at all.

---

## 4. Open questions — the ones that block

These are first, because the architecture depends on the answers. **Each names how to answer it.**
The sibling's hardest-won lesson is that a diagnostic which cannot distinguish its outcomes will be
believed anyway and will invent findings — so these want direct tests, not reasoning.

**Most of this section was resolved on 2026-08-04 by reading Dynamic Fog's source**, which is public
at [owlbear-rodeo/dynamic-fog](https://github.com/owlbear-rodeo/dynamic-fog), GPLv3, and published
by Owlbear deliberately as an SDK example. That was far cheaper than a room and answered more than
expected. It carries a standing limit that shapes everything below:

> **Reading Dynamic Fog establishes what Dynamic Fog does. It cannot establish what Owlbear does.**
> The renderer is in Owlbear's closed client. Anything below phrased as a property of the *renderer*
> rather than of the *extension* is inference, and is marked as such.

Two smaller caveats on the same reading: the repository was last pushed 2025-08-14, so the deployed
extension may have moved since; and what was read was the wall reconciliation path, the batching
layer, the drawing type and the wall geometry helper — not the whole repository.

### Q1. How is a wall actually written? — *narrowed to one test; (b) recommended*

`WALL` is a first-class SDK item type — `points`, `doubleSided`, `blocking` — and the SDK ships a
`WallBuilder`. The sibling separately verified by item census that **Dynamic Fog does not store
walls as `WALL` items**: the networked representation is drawings on the `FOG` layer, and each
client materialises its own local `WALL` items from them.

**The source confirms that census and supplies the mechanism.** A reactor watches networked items
matching `layer === "FOG"` and being a shape, path, curve or line. For each, an actor builds `WALL`
items with the SDK's own `buildWall()`, attached to the source drawing. Every write — add, delete,
update — goes through a batching layer that targets `OBR.scene.local` exclusively. There is no
networked write anywhere in that path.

Three things follow, in descending order of confidence:

- **The fog engine consumes first-class `WALL` items.** Not a private representation. Dynamic Fog
  is an editor for Owlbear's engine, not the engine.
- **A `WALL` item in the *local* set occludes.** Proven by Dynamic Fog working at all.
- **Whether a `WALL` item in the *networked* scene occludes is still unknown.** Dynamic Fog never
  writes one, so its source is silent, and the code that would answer is closed. Plausible, since a
  client presumably renders both sets — but that is reasoning, not evidence, and it is exactly the
  kind of plausible gap this project has agreed not to argue its way across.

**The correction that matters.** This section previously claimed path (b) would couple us to
Dynamic Fog's "undocumented metadata", and that `doubleSided`/`blocking` must be encoded somewhere.
**That was wrong.** The reactor's filter is layer plus item type and nothing else. Dynamic Fog does
carry a reverse-domain metadata namespace, but it is used for doors and lights — a plain wall needs
none of it. So (b) means emitting an ordinary drawing on a public layer, which is not a private
schema at all, and the licence concern raised under Q3 largely dissolves with it.

So the two paths now read:

- **(a) Emit `WALL` items directly.** Networked: may not render — the one open question. Local:
  renders, but a local item is per-client and not persisted in the scene, so every participant would
  need this extension running and recomputing. That is a heavy thing to require of an authoring tool
  used once per map at prep time.
- **(b) Emit drawings on the `FOG` layer** and let Dynamic Fog materialise the walls. Matches what
  already works, needs no private schema, and — per Q2 — is the only path where the output is
  editable. **Recommended.**

**What is left to test:** does a `WALL` item added to the networked scene occlude? One test, one
variable, with a real hypothesis rather than a fishing expedition. Worth doing even though (b) is
recommended, because a yes would mean the project *can* stand alone, and that is worth knowing
before accepting a hard dependency.

### Q2. Are walls we create editable by hand? — *largely answered, and it decides Q1*

The product is a proposal the GM corrects, so this was always the question with teeth.

**Dynamic Fog's walls are derived state, not stored state.** On any change to a drawing, the actor
recomputes the wall's `points` from its parent. A wall is a continuously reconciled projection of a
networked drawing — which means the thing a GM edits is the *drawing*, and the wall follows.

The consequence for (a) is decisive: Dynamic Fog's reactor filters for drawings, and a `WALL` item
is not one, so it would ignore ours entirely. Its tools edit drawings. **A raw `WALL` item is
therefore not editable with them** — the extraction would produce geometry nobody can nudge, which
defeats the point of the project. Under (b), editing comes free, because the walls *are* ordinary
drawn lines and the GM already knows the tools.

Not fully closed: whether Dynamic Fog's own line tool will select and edit a `FOG`-layer drawing it
did not create. Its filter is by layer and type rather than by provenance, so it should — reasoning,
not evidence, and cheap to confirm in the same room session as Q1.

### Q3. Is Dynamic Fog required, or is fog core to Owlbear now? — *answered, and it cuts both ways*

**The engine is Owlbear's.** `Wall` and `Light` are SDK types, `buildWall` is an SDK builder, and
Dynamic Fog is published as an example of using them. It is an editor for a renderer it does not own.

But that does not make this extension standalone, and the direction of the dependency is the
opposite of what it first looks like. **Under (b), Dynamic Fog is a hard runtime dependency** — it
is the thing that turns our drawings into walls, and without it installed we would emit lines that
nobody converts. Under (a) there is no dependency, but only if networked walls render, and only at
the cost of the output being uneditable. **State the dependency up front in the README** rather than
letting a GM discover it as fog that does nothing.

The GPLv3 concern is much reduced: what (b) matches is a standard item type on a standard layer, not
a private format. Interoperating at that level is no closer a relationship than using the SDK.

### Q4. What does the GM actually review, and how?

Options span from "a panel listing extracted walls with accept/reject" to "draw the proposal in a
distinct colour and let them delete what is wrong with the existing tools". The latter is far
cheaper and uses tools the GM already knows. Deferred until Q1 and Q2 land, because they constrain
it.

**The skeleton already declares an action with a popover, and that is not an answer to this.** It
is there as a *second signal*: the background page reports through the dev log, the popover reports
on screen, and two independent signals separate "the manifest never loaded" from "the manifest
loaded and the background script died" — which one signal cannot do. Whether the shipped surface is
an action, a tool, or context menu items is still open, and a tool remains the likelier fit for an
authoring workflow.

---

## 5. Constraints inherited from the sibling — verified, not guessed

Every item here was measured in a real room by the sibling project. Do not re-derive them.

- **The SDK cannot be imported into a headless test.** Its index calls `getDetails()` at module
  load, which reads `window.location.search`, so any node-environment test importing it dies with
  `ReferenceError: window is not defined`. **This dictates the layering:** every module touching the
  SDK is split from its pure half, and the pure half is where the tests live. Type-only imports are
  erased and therefore safe. This is not negotiable without adding jsdom, and the sibling's entire
  trace pipeline is testable precisely because it obeyed this from the start.
- **Items cap at exactly 8192 array entries.** Bisected to the single command: 8192 accepted, 8193
  refused. A fixed constant, not a shared budget. **This is a live concern here** — a `Wall`'s
  `points` array is subject to it, so a traced room perimeter must be chunked if it is long enough.
- **Writes are rate limited** (`RateLimitHit: "Too many requests"`), and this is *distinct* from
  validation failure. Distinguish them at every call site: retrying a size failure is futile, giving
  up on a throttle loses data. Committing hundreds of extracted walls is exactly the workload that
  will hit this.
- **SDK rejections are not `Error`s.** The SDK rejects with the parent frame's raw payload —
  `{ error: { name, message } }` — so `instanceof Error` is false for every failure it can hand
  back, and `.message` on the rejection is `undefined`. The sibling has a small pure `describeError`
  worth copying verbatim. A handler testing for `Error` silently discards the cause.
- **Dynamic Fog's walls and lights are LOCAL items.** Read via `OBR.scene.local.getItems()`;
  querying the scene returns zero in a room where the fog plainly works. `scene.items.onChange`
  never fires for them.
- **Walls are not there at startup.** Dynamic Fog materialises them ~1.2s after a fresh load.
  Nothing may assume they exist on load.
- **Check-then-subscribe is a race.** Subscribe *before* checking `isReady()`, and make the
  operation idempotent — checking first leaves a window where the transition happens unobserved and
  the work silently never runs. A popover's connection going ready is **not** the scene being ready;
  the sibling lost two days to that one.
- **Scene metadata has no limit below 512KB per key** — measured. An earlier "reportedly 16KB"
  figure was wrong and shaped several decisions before it was corrected.
- **The grid covers only MAP-layer images.** Anything outside the map image is outside the grid.
- **No textures can ever reach a shader**, and **raster rendering is not available** — `data:` URLs
  do not render. Both are settled; do not re-propose. Less likely to bite here than in the sibling,
  but the extraction preview has to be vector geometry for the same reasons.
- **Map pixel access works** cross-origin, and the sibling ships a startup probe that asserts it.
  The trace harness there can take a pasted Owlbear asset URL to exercise the real path.

---

## 6. Testing and diagnostic practice — copy it

The sibling's culture is the reason it works, and it costs almost nothing to adopt from day one.

- **Mutation testing earns its keep.** Break the code deliberately and confirm a test fails. A green
  suite on first run is evidence about the *tests*, not the code. This caught real defects at every
  stage there.
- **A fixture that is easy to read can be too symmetric to fail.** A tangent test on a horizontal
  run cannot detect a search being disabled when the fallback is `(1, 0)` — the right answer for
  that fixture. Sampling has to actually visit the discontinuity it claims to check.
- **8-connectivity means single-pixel junctions barely exist.** Every pixel beside a junction is
  itself degree 3+, so a tee traces to eight chains, not three. **This one bites here immediately**,
  because junction handling is exactly what wall joining has to get right. Do not write fixtures
  assuming a clean degree-3 node.
- **A diagnostic that cannot distinguish its outcomes will be believed anyway and will invent
  findings.** The sibling paid for this seven times in five disguises: a probe that could not tell
  its failure modes apart, one that saturated, one that could not produce a partial result, one
  gated on the bug not happening, and one sharing fate with what it measured. Its `CLAUDE.md` lists
  them; read that list before building any diagnostic here.
- **Change one variable at a time.** A question was called closed twice before it was, both times
  after changing two things at once.
- **Log a census when a pipeline runs but finds nothing** — every item by `type:layer` across both
  `scene.items` and `scene.local`. That is what revealed Dynamic Fog's local items in one line,
  after a wrong guess that it was not installed.
- **Diagnostics that fire unconditionally are worth their noise.** A diagnostic that only fires when
  something is known to be wrong cannot distinguish "fine" from "never ran".

---

### Rejected: scoring extraction against hand-drawn walls — 2026-08-04

Proposed and closed the same day. A map whose walls the GM has already drawn looks like ground
truth, and the appeal is obvious: it would turn "does this look about right" into a number.

It does not survive contact with what a wall is.

- **Where a wall goes along a stroke of ink is a judgement.** Inner edge, centre and outer edge are
  all defensible, and whether a gap is a doorway or a break in the linework is a *reading* of the
  map rather than a fact about it. A diff would score the extractor down for disagreeing with an
  arbitrary choice, which drives tuning toward reproducing one GM's habits instead of toward being
  useful (user, 2026-08-04).
- **One map cannot generalise**, and a different drawing style would score differently for reasons
  that say nothing about the algorithm. The sibling has already paid for this exact mistake once,
  in a different costume: its wall margin's safety turned out to be *a property of the test map*,
  not of the margin — fine on the map it was judged against, a spoiler on a tighter one.

The compounding danger is that such a score would look rigorous while measuring the fixture. That
is this project's inherited first lesson — a diagnostic that cannot distinguish its outcomes will be
believed anyway — arriving before any code was written.

**If evaluation is ever revisited, the surviving form is topological, not geometric.** What matters
for fog is not whether a wall is within some distance of where a human would have put it, but
whether sight *leaks*. A wall a few pixels off encloses the same room and is harmless; a missing
wall merges two rooms, which is the failure that ruins a session. Comparing enclosed regions rather
than coordinates is immune to the wiggle room, because the wiggle does not change what is enclosed.

**Not rejected, and separate from all of this:** dumping one of Dynamic Fog's own `LINE` items, plus
any scene metadata under its namespace, from a room where walls already exist. That is
reconnaissance rather than evaluation — a worked example of the thing Q1 does not know how to write
— and it costs a few lines in the session that answers Q1 and Q2 anyway.

## 7. Proposed build order

Deliberately front-loads the unknowns. Steps 0–2 are cheap and answer whether the project is
possible at all; there is no point tuning an extractor before knowing walls can be written.

0. **Skeleton project** — Vite, TypeScript, vitest, manifest, Pages deploy. Copy the sibling's
   shape; it is known to work and the CI/lockfile traps are already recorded. Two things get
   copied close to verbatim because they are load-bearing here from the first probe onward: the
   dev log shim with its per-client labels, and `describeError`. The second matters more than its
   size suggests — Q1 is answered by writing walls and reading what Owlbear says back, so a
   refusal *is* the finding, and a reporter that tests `instanceof Error` throws away every
   refusal the SDK can produce.
1. **Close what is left of Q1 and Q2 in a room.** Reading Dynamic Fog's source did most of this
   from a desk, and the residue is three cheap checks in one session: does a networked `WALL` item
   occlude; will Dynamic Fog's line tool select and edit a `FOG`-layer drawing it did not create;
   and does a drawing we emit get picked up and materialised as a wall at all. The first is the only
   one that could still change the architecture.
2. **Trace harness first, extension second.** The sibling's harness — a local page with a file
   picker that runs the pipeline on a map image and draws the result — is where the tuning work
   actually happens, and it is far faster than a room. **Known structural limit: the harness never
   leaves pixel space, so a world-placement bug is invisible in it by construction.** Where harness
   and room disagree about direction, look at the stage the harness does not run.
3. **Port the trace pipeline** and re-tune for walls: wobble removed, simplification conservative,
   short-segment filter reconsidered.
4. **Join skeleton chains into polylines** with real junction handling. The new work.
5. **Emit walls**, chunked against the 8192 cap and debounced against the rate limiter.
6. **Review and refine** — whatever Q4 resolves to.

---

## 8. Code sharing with the sibling — decided: copy, for now

The genuinely shared surface is the pure trace pipeline and the geometry helpers. Both are already
pure and tested, so extracting them into a package is *technically* easy.

**Not doing it yet.** The two projects want different things from the same code — the sibling wants
centrelines it can make wobble, this one wants centrelines it must not — so the tuning will diverge
before it converges, and a shared abstraction would spend its life being pulled in two directions.
Extracting a package also has real cost: versioning, a release step, a second lockfile, and CI for
both. That cost buys nothing until both projects want the *same* behaviour and are stable enough to
agree on it.

**The cost of copying is real and should not be dressed up as a virtue: bug fixes will not
propagate.** A defect found in the thinning step here will still be present there, and nothing will
tell either project about it. Note fixes in both design records when they happen.

**Revisit when** the pipeline here has settled and the two versions have visibly converged — at
that point extract the common half into a package and take the release overhead knowingly.

---

## 9. Licence — GPL-3.0-or-later

Free-tier Pages requires a public repository, so a licence has to exist before the first push.
Matching the sibling, and chosen as the option least likely to need changing rather than on
principle:

- **Nothing is published until the first push**, so up to that point the choice costs nothing to
  revise.
- **Relicensing is one-directional in practice.** The copyright holder can relicense at any time,
  but anyone who took a copy under the old terms keeps those rights to *that copy* permanently, and
  once outside contributors land code they hold copyright on their parts. With no contributors,
  moving to something permissive later stays easy; the reverse direction is the one that gets stuck.
- **Q1 may remove the choice.** Dynamic Fog is GPLv3. Interoperating with it is not deriving from
  it, but if the answer to Q1 turns out to be (b) — matching its private line format — the
  relationship gets closer, and any code actually copied rather than merely interoperated with would
  settle the question outright.
