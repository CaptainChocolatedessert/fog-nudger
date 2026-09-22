# fog-nudger — design record

An Owlbear Rodeo extension: **trace a map image into the fog regions a GM reveals room by room —
and, with Dynamic Fog installed, the walls that block sight, from the same shapes.**

This is the design record: what the thing is, how it works, why it is built the way it is, and what
is still open. It is written to be read start to finish by someone new to the code, and to be dipped
into by someone who already knows it. Operating notes for Claude live in `CLAUDE.md`, which is
private and gitignored.

**It describes the present.** Where a past mistake explains why something is the way it is, the
lesson is stated as part of the design rather than as history. Git holds the history.

**Sibling project.** `../W - cartographers-fog` is a working Owlbear extension by the same author
([repository](https://github.com/CaptainChocolatedessert/cartographers-fog)), readable from here. A
few hundred lines of pure functions were **copied** from it rather than shared, which carries a
standing obligation — see §11. Everything else it taught this project is written down here.

---

## Contents

- [Vocabulary](#vocabulary) — read this first if any term below is unfamiliar

1. [What this is for](#1-what-this-is-for)
2. [The platform: Owlbear and Dynamic Fog](#2-the-platform-owlbear-and-dynamic-fog)
3. [Architecture: the wall graph is the document](#3-architecture-the-wall-graph-is-the-document)
4. [Reading the map into a graph](#4-reading-the-map-into-a-graph)
5. [The wall graph](#5-the-wall-graph--stored-walked-and-edited)
6. [Emitting](#6-emitting)
7. [The surfaces](#7-the-surfaces)
   - [7a. The surface redesign — built, and judged](#7a-the-surface-redesign--built-and-judged)
8. [Testing and diagnostic practice](#8-testing-and-diagnostic-practice)
9. [Constraints and pitfalls](#9-constraints-and-pitfalls)
10. [Open questions and what is next](#10-open-questions-and-what-is-next)
    - [The workflow rework](#the-workflow-rework--designed-in-full-2026-09-18-part-built) — in progress
11. [Copied code, and what it obliges](#11-copied-code-and-what-it-obliges)
12. [Licence](#12-licence--gpl-30-or-later)

- [Appendix A: the code map](#appendix-a-the-code-map)
- [Appendix B: build and deployment](#appendix-b-build-and-deployment)

**If you are new to the code**, §1 and §3 are the two that matter — what the thing is for and why it
is built around a graph rather than a partition. Appendix A says where everything lives.

---

## Vocabulary

Several of these words drifted in conversation and mean one thing each here. **Say what a piece of
machinery is the first time it comes up** — none of these is self-explanatory, and an algorithm's
name is not an explanation.

Where a term names a type, the type has the same name: `SkeletonGraph`, `WallGraph`, `WallFace`.

### The things

| term | means |
|---|---|
| **ink** | the linework, as a binary mask. Whatever the reading decided is a mark rather than ground. |
| **the reading** | binarise + polarity + ink width — the expensive first half of the pipeline, cached on its own. |
| **skeleton** | the ink thinned to one-pixel centrelines. A raster, not a graph. |
| **skeleton graph** (`SkeletonGraph`) | the skeleton chained into nodes and edges, still in raster pixels, edges still carrying their pixel chains. An intermediate, thrown away once the walls are fitted. |
| **wall graph** (`WallGraph`) | the fitted graph, stored in scene metadata in graph units. **The GM's own work**, and the project's document. Nothing re-derives it. |
| **graph unit** | the wall graph's one unit of length: **the map image's longer side is 1**, so the map spans `1 × h/w` or `w/h × 1`. The same length in every direction, which fractions of each side were not. |
| **face** | a cycle of the graph traversal — the abstract thing. |
| **region** / **room** | a face we emit as a fog shape. The GM-facing word. |
| **wall** | a *run* of segments chained through degree-2 nodes — what a GM thinks they are editing. |
| **segment** / **edge** | one straight piece between two nodes. **Every vertex is a node**, so these are the same thing in the wall graph. |
| **bridge** | an edge with the same face on both sides. A stub wall is one. Bridges emit as lines. |
| **spur** | a wall run with a free end. What pruning removes. |
| **sliver** | a cycle enclosing no lattice point — sub-pixel, an artefact of junction clusters. |
| **gap** | a narrow channel of ground whose banks of ink are far apart *measured along the ink* — a place the drawing failed to close a wall. What merges two rooms. **Not a doorway**, which is a real opening and the tool's known false positive. **In the graph** the same fault is a break in the walls: two pieces close in space and far apart *measured along the walls*. |
| **mend** | a proposed wall that closes a gap in the graph, and the act of accepting one. Once accepted it is an ordinary drawn wall. **Not a bridge** — a mend usually closes a loop and splits a region in two, which is the opposite of what a bridge is. |
| **dissolve** | removing the walls around a region with one click: every wall between it and anything outside it, and every wall with it on both sides. **The walls of closed regions inside it stay.** The region merges with every neighbour at once. |
| **mark** | a point in graph units the GM places with *Suppress region*. It belongs to no wall and survives a rebuild of the walls. |
| **span** | a straight wall placed across an opening from a click: through the click, or near it when that is far shorter. |
| **collapse** | taking a small region out with *Collapse small regions*: its walls go, and a new vertex at the average of its **connections** — the outline vertices with a wall running elsewhere — is joined to each, so nothing outside it moves. **Not Straighten's *collapse guard***, which is about a closed run fitting to a point, the failure that guard prevents. |
| **an action with an amount** | a control that applies an operation to the walls *in front of the GM* — *Straighten*, and only Straighten since *Prune the dead ends* became ringed on 2026-09-22. Not a setting: nothing is stored, and the handle reads as *how much more*. |
| **the latch** | the graph pinned when a drawer opens, so an amount previews against a fixed base instead of against its own last result. Void the moment the document is replaced under it. |
| **the fitting tolerance** | the number that turns pixel chains into fitted edges inside the derive, and escalates to meet the command cap. **Computed** — a quarter of the measured ink width — never chosen. |
| **the automatic prune** | the dead ends every derive removes before handing the graph over: runs with a free end of up to **two measured ink widths**. Computed, never chosen, and nothing when no width was measured. Distinct from the **Prune** tool, which takes more on request. |
| **suppressed** | a region holding a mark. It is not emitted, so it stays fogged and can never be revealed, like the outside; its walls stay, and emit by the bridge criterion with it out of the emitted set. |

### The stages — and the surface words for them are **retired**

**Stage one and stage two are the two halves of the pipeline**, either side of the handover where
the pixels stop being needed. They are architecture words and they are still exact.

> **"The ink mode" and "the wall editor" are gone (2026-09-14) and should not be used.** They were
> the *surface* words for the same two halves, from when each was its own page. There is one
> surface now, so naming a stage as a place a GM goes is describing something that does not exist —
> and it misleads in a specific way, because a GM moves between the two halves freely and
> continuously rather than travelling to either.

**Do not confuse the stages with the three cascade stages** (`read` / `derive` / `adjust`), which
are about what a settings change **destroys**. Those are a property of a parameter, not a place.

| | stage one | stage two |
|---|---|---|
| works on | the map image | the wall graph |
| re-derives? | yes, whenever a setting that feeds it moves | **never** |
| where the GM meets it | the Ink group and its brushes | the wall tools, and the Walls group |

**There is no save between them.** The first hand edit adopts the derivation as the document,
because that is the moment a document is needed; §6 has the whole of it.

### The checks

| check | says |
|---|---|
| **orphan count** | every skeleton pixel was claimed by some chain. Not that it was claimed *correctly*. |
| **Euler's identity** | the traversal of the document was coherent. Fails legitimately on a doubled wall, so it is a log line, not a gate. |
| **planarity** | no two segments cross. The separate check Euler does not imply. |
| **the point probe** | *"what is here?"* — the luminance actually read at one pixel, whether it was called ink, and whether the GM painted it. The one diagnostic that answers what looking cannot. |

### A limit is not a budget

**Two words that were one until 2026-09-09** (user), and keeping them apart is the point rather than
a preference:

- A **budget** is a resource, spent down until it runs out. Three are real: the **megapixel budget**
  bounding the raster, the gap search's **flood budget**, and the emit **item budget**. Each is
  consumed by the work, and running out of one changes what the answer *is* — a gap whose flood
  exhausted its budget is marked as a guess and refuses to be filled.
- A **limit** is a threshold, compared against and never consumed. The **prune limit** (*Longest dead
  end to remove*) and the straightening limit are these: nothing is spent, a value is measured
  against a ceiling, and running the same operation twice at the same setting costs the same both
  times.

Pruning was called a budget everywhere, and it is the clearer case of the two — spending implies a
running total that pruning does not have. **Do not rename the three real budgets to match.** The
distinction is the useful part; collapsing it in the other direction would lose it just as
completely.

**The area check is gone**, and §8 says why. Do not reintroduce it.
---

## 1. What this is for

Owlbear's fog is **subtractive**. The whole map starts hidden, and shapes drawn on the `FOG` layer
are the regions that *can* be revealed. Anything falling inside no shape stays hidden permanently —
which is the correct behaviour for the solid rock between rooms, and it means the artifact a GM
prepares is essentially **one shape per room and corridor**.

Drawing those by hand, over every room of every map, is the single most tedious piece of prep in the
tool. But the map already shows where the rooms are — they are drawn on it, in ink. A trace pipeline
can turn the ink into the regions, which changes the job from *drawing* them to *correcting* them.

**One artifact, two payoffs.** Those same shapes are what Dynamic Fog derives walls from: it strokes
each drawing on the `FOG` layer and takes the outline, so a region's boundary becomes a wall (§2). So
the tracing produces a complete manual fog-of-war map on **vanilla Owlbear with no extension at
all**, and line-of-sight occlusion for free the moment Dynamic Fog is present. Nothing extra is
emitted for the second case. Dynamic Fog is a bonus, not a requirement.

### Why "nudger" and not "extractor" — the inverted quality bar

**Automatic extraction will never be perfect** on a hand-drawn map. Doors, arches, curtains, windows,
secret passages and rubble all read as ink and none of them means "solid wall". So the output is a
**proposal**: something a GM looks at and corrects before it goes near the scene, rather than an
answer they are asked to trust.

A tool that gets a GM most of the way in one click and lets them fix the rest is a large win. **A
tool that claims to be finished and is wrong in three places nobody notices is worse than nothing**,
because the failures are invisible until play.

That inverts the usual quality bar, and it is the single idea the rest of the design serves: *being
wrong quietly is much worse than being wrong loudly.* Everything that follows — the review surface,
the refusal to write into the GM's work unasked, the rule that a warning is not a safeguard — comes
from it.

### The two failure modes are not equally bad

- **Merging** — a leak through a gap in the linework puts several rooms in one region, so revealing
  one reveals all of them. Ruins a scene.
- **Splitting** — one room emitted as several regions costs the GM extra clicks.

**Bias toward splitting.** This is the opposite of what "be conservative" suggests at first glance,
and it decides several parameter choices on its own.

A third failure sits underneath both and is worse than either: **a region grown a little too far
shows a secret door that was meant to stay hidden.** That sets the safe direction wherever a boundary
can be moved — err toward showing less.

### Why a separate extension from cartographers-fog

Both trace a map image, and the temptation to merge them should be resisted:

| | cartographers-fog | fog-nudger |
|---|---|---|
| Relationship to fog | **consumes** visibility, to draw where the party has been | **produces** the regions and, downstream, the walls |
| When it runs | continuously, all session, on every client | once per map, GM only, at prep time |
| Output | aesthetic — a hand-drawn sketch | functional — geometry the fog engine obeys |
| Cost of being slightly wrong | a slightly ugly line | a room the party can see into |

The lifecycles have nothing in common. A GM who wants one may not want the other, and bundling would
mean a play-time extension carrying an authoring tool's weight on every client.

---

## 2. The platform: Owlbear and Dynamic Fog

The foundation everything else rests on. Assembled from three sources of different strength, marked
throughout:

> - **Read from Dynamic Fog's source** — [owlbear-rodeo/dynamic-fog](https://github.com/owlbear-rodeo/dynamic-fog),
>   GPLv3, published by Owlbear as an SDK example. Strong, but it establishes what *Dynamic Fog*
>   does, never what *Owlbear* does — the renderer is in Owlbear's closed client.
> - **Read from the SDK's own type definitions** — strongest available, since it is what we compile
>   against. They are in `node_modules/@owlbear-rodeo/sdk/lib/**/*.d.ts` and are greppable.
> - **Measured in a room** — an actual observation in an actual Owlbear scene.
> - **Reported** — from Owlbear's documentation, not verified here. Flagged where load-bearing.

### The fog model, stated once and exactly

This is the paragraph most likely to be consulted, and a wrong inference from it has already misled
one session, so it is worth being precise:

> **Everything is fogged by default. A shape we emit is fogged too — it is not a hole — but it is
> the region Owlbear will let a GM *reveal*. Space in no shape is fogged and *unrevealable*,
> permanently.**

So "shapes on the `FOG` layer are the revealable regions" is exactly right, and so is "space in no
shape can never be shown". **One exception, and it belongs to Dynamic Fog rather than to Owlbear**: a
light still reveals unshaped space, because DF assumes everything is fogged and lights reveal.
"Unrevealable" means unrevealable by Owlbear's own fog tools.

**`visible` is the hide/reveal flag**, and this is not obvious. On the `FOG` layer that flag is *not*
"can this be seen" — it is the difference between a shape that **is** fog and one that has been
**cleared**. An emitted room at `visible: false` comes back already revealed. Nothing else in the SDK
expresses it: `Item` carries only `visible`, and `OBR.scene.fog`'s `filled` is scene-wide styling
(filled versus outline-only). The flag means the opposite thing on the `DRAWING` layer, where false
is what hides a thing from players — which is exactly how the error survived for a week.

### There is no fog-shape API

The SDK's fog API is **styling only** — get and set the fog colour, the stroke width and whether fog
is filled, plus a change subscription. Nothing creates, reads or enumerates fog shapes. They are
ordinary `Shape` / `Path` / `Curve` / `Line` items on the `FOG` layer, distinguished by nothing else.

This is what collapses "emit native fog shapes" and "emit drawings Dynamic Fog can read" into a
single act.

### One abstraction, two consumers

**A wall drawn with Dynamic Fog's own tool is an ordinary `LINE`** — read from its source. Not a
`WALL` item, not a zero-area region. Two points, `layer: "FOG"`, stroke width and colour from
`OBR.scene.fog`, the end stored relative to the item's position. The wall the GM then sees is derived
from it a moment later by the same machinery that derives walls from a room's boundary.

So there is **one** abstraction — drawings on the `FOG` layer — with two consumers reading different
aspects of the same object:

| | reads | for |
|---|---|---|
| Owlbear | the **interior** | what can be revealed |
| Dynamic Fog | the **stroked boundary** | what blocks sight |

A closed filled region has both. An open line has only the second.

**The choice is therefore never "Owlbear's abstraction or Dynamic Fog's".** It is only whether a
thing we emit has an interior — and the answer is that some must and some must not. §3 settles which.

### The wall filter is layer plus type, and nothing else

```
WallReactor.filter(item) === item.layer === "FOG" && isDrawing(item)
isDrawing === isShape || isPath || isCurve || isLine
```

**No metadata is involved.** An ordinary drawing on the `FOG` layer, from any source, becomes walls.
This is why feeding Dynamic Fog needs no private schema and why the output degrades gracefully.

### Walls are derived state, recomputed from the drawing

Dynamic Fog is an **editor for Owlbear's engine, not the engine**. It builds ordinary `WALL` items
with the SDK's own `buildWall()`; the occlusion rendering is Owlbear's.

Its architecture is a **one-way binding** from the shared scene to local children: a reconciler
subscribes to networked item changes, reactors filter for items they care about, each matching item
gets an actor owning the derived local items, and a patcher batches writes — every one of them to
`OBR.scene.local`. Because it cannot observe the local scene, its children are unselectable and
non-copyable. **That is Dynamic Fog deliberately making its walls un-clickable**, and it is why
editing means editing the drawing rather than the wall.

On any change, the actor recomputes the wall's points from the parent drawing. The geometry helper
converts the drawing to a path, **strokes it to the drawing's own `style.strokeWidth`** — in Skia's
sense, where `stroke()` replaces the path with the *outline of the stroked region* — samples curves
at a fixed interval, and subtracts every open door in world space.

**So the wall lands at the boundary of whatever shape is on the `FOG` layer.** That is the mechanism
the whole design depends on, and it is confirmed in a room.

#### The stroke width IS the offset, and that is load-bearing

Stroking a *closed* loop yields an annulus, and an annulus has two boundaries: one offset
`+strokeWidth/2` and one `−strokeWidth/2`. Each becomes its own polyline and each becomes its own
`Wall`. So **two wall items per closed contour** — not per shape, and not by anyone's decision. A
shape with a hole has two contours and yields four.

The consequence that matters is not the count but the **band between the two derived walls**, which
is unreachable from either side. A shape carrying an outline W wide reveals only to its boundary
− W/2, so two adjacent rooms sharing a centreline each fall short by half of W.

> **This is why emitted shapes carry no stroke at all** (`ACCEPTED_STROKE_WIDTH = 0`). A band of fog
> down the middle of a wall is not the wall; it is a strip of map nobody can ever see.

**Zero is safe and it is measured, not assumed.** A zero-stroke shape produces exactly as many walls
as a stroked one, and a zero-width `LINE` still yields a working wall — Skia's stroker returns
something usable at zero rather than nothing. Confirmed in a room by lighting a wall from both sides:
everything reveals, no fog line down the middle, and the walls still block sight. Tiny rendering
artefacts sit on the division, visible only under a deliberately garish fog colour, and are accepted
as cosmetic.

**Stroking an open segment yields one contour** — a capsule around the line — so an open `LINE` gives
one wall where a closed loop gives two.

### What an emitted fog item must look like — measured in a room

| | ours | Owlbear's fog tool | decision |
|---|---|---|---|
| `fillOpacity` | 0.5 | **1** | **match — required** |
| `visible` | false | **false** | **differ — must be `true`** |
| `fillRule` | evenodd | nonzero | **differ, deliberately** |
| `strokeWidth` | 9 | 5 | **0 — see above** |

- **`fillOpacity` must be 1.** Below that, ground the party has *revealed* keeps a translucent tint
  of the fog colour, for GM and players alike.
- **`visible: true`**, per the fog model above. Owlbear's own tool writes cleared shapes; we write
  fog.
- **`fillRule: "evenodd"`, deliberately unlike Owlbear's `nonzero`.** Under even-odd an inner ring
  cuts a hole regardless of winding, so winding direction never has to be got right. Dynamic Fog maps
  anything that is not `"nonzero"` onto Skia's even-odd, so the two ends agree. **This retires the
  winding-direction pitfall entirely.**
- **A `SHAPE` is positioned from its corner; a `PATH`'s commands are relative to its position.**
  Costs nothing since we emit paths, and it confirms the positioning semantics world placement
  depends on.

The four values an emitted item must carry — layer, visibility, fill opacity, stroke width — are
**declared together in `emit/fogShapes.ts`** so the next edit has one place to miss rather than four.
That module imports no SDK, which is why the constants can be tested headlessly.

### Walls, lights and doors

- **`Wall` and `Light` are first-class SDK types and are local-only.** Reported, and consistent with
  everything observed: the sibling's item census found Dynamic Fog's walls and lights only in the
  local set, and Dynamic Fog writes only there.
- **Walls are built with the `VISIBLE` and `COPY` attachment behaviours explicitly disabled**, which
  is why an invisible parent still produces a live wall — Dynamic Fog opts out of visibility
  inheritance rather than us getting lucky.
- **Dynamic Fog does not draw walls.** The thin white lines a GM sees while the fog tool is active are
  Owlbear's own rendering of `WALL` items. So wall visualisation comes free and costs us nothing.
- **Doors ride on the same drawings.** `DoorReactor` filters on exactly the same condition as walls,
  and **door subtraction is global**: the actor asks for every door in the scene and subtracts each
  open one from its polylines in world space. So a door cuts whatever wall geometry it overlaps,
  regardless of which drawing it hangs off or who created it.

  Two consequences. **A wall represented twice needs only one door**, so two adjacent rooms sharing a
  boundary are cut by one door spanning both. And **doors can be left to Dynamic Fog entirely** — a
  GM adding them with its own tool afterwards cuts our walls with nothing emitted by us. Doors are
  off this project's critical path by choice rather than by postponement.
- **Lights are the exception.** `LightReactor` filters on `rodeo.owlbear.dynamic-fog/light` being
  present in metadata. **There is no metadata-free route to a light.** Walls are free; lights are
  gated behind a private namespace. Do not assume symmetry.

### Forecast — noted, not pursued

Owlbear 2.4 shipped a first-party computer-vision pipeline that fogs a battlemap automatically, in
beta and limited to a paid tier, with the caveat that it "won't always get 100% of the way there". It
produces the same artifact this project produces, which is a strong independent signal that the
artifact is the right one.

Deliberately not treated as a blocker: this project is primarily for its author's own use and that
tier is not available to them. Revisit if it becomes broadly available — the interesting question
then is whether this becomes the *nudging* half on top of Forecast's extraction, which is the half
nobody ships.
---

## 3. Architecture: the wall graph is the document

**The project works in a graph of wall centrelines. The fog items in the scene are a rendering of
it.**

```
ink mask  →  skeleton graph  →  wall graph  →  { fog shapes for the faces, lines for the rest }
              (derived)      (the GM's own)
```

### The target: emulate a careful human's scene

The clearest available statement of what correct output means, and it settles arguments abstract
reasoning does not:

> **Where possible, produce the scene a person would have got by drawing fog shapes in Owlbear, then
> switching to Dynamic Fog, making any necessary additions, and adding doors.**

That person's scene contains one fog shape per room and corridor, plus line items for the walls no
room boundary covers, plus doors. So does ours. Three things follow:

- **Redundancy the human version also has is not a defect.** Two adjacent rooms are two shapes whose
  boundaries run along the same wall. That duplication is inherent in the requirement that rooms
  reveal *independently*.
- **We are not obliged to use Owlbear's tools to produce it**, only to produce what they would have.
- **Doors are the human's last step and they can stay that way.**

### Fog the rooms, not the rock

The wall geometry is identical either way, since the boundary between rock and room is shared. But
only fogging the enclosed walkable areas produces useful native behaviour: unexplored rooms hidden,
revealed one at a time. Fogging the solid material would hide decoration and nothing else.

### Why a wall graph rather than a partition of the map

**A wall is a blockage, not an area.** A partition of the map into regions can only express a wall as
*the thing between two regions*, and a map contains walls that are between nothing.

#### The case that decides it: a stub wall

Take a square room with a short wall extending out from one corner into open space. Both faces of
that stub touch the **same** ground region — the outside. So:

- It is not a boundary between two regions, because there is only one region there.
- A partition can still *represent* it, as a slot cut into the outside region's polygon.
- But **any operation that grows regions into the ink destroys it**, because the slot is attacked
  from both sides at once and closes. The wall does not merely thin — it disappears.

That matters because growing regions into the ink is not optional: it is how half the wall gets
revealed, which §1's product judgement requires.

#### The proof, from the correct version of that operation

The right way to reveal half a wall is a **watershed** — give every ink pixel to the nearest ground
region. Where two regions compete, the boundary lands on the ink's medial axis: exactly half the
wall, everywhere, under any ink width, with no radius to guess. Where only one region competes, every
pixel goes to it and the feature is consumed.

> **So the correct region operation deletes precisely the walls that are not region boundaries.**
> That is not a bug in an implementation. It is the partition reporting what it can represent.

And a watershed from ground regions *is* the medial axis restricted to its separating branches — half
a skeleton. A region-first design would compute half the skeleton, discard the other half, and then
patch the missing half back with special cases, which is re-inventing skeletonisation by tweaks.

**This was verified rather than predicted.** Under the old partition a pillar — ink enclosed by floor,
containing no region — became a hole in the room's region, and the containment rule filled any hole
enclosing no surviving region. The emitted polygon covered the pillar, so it derived no wall, blocked
no sight, and was revealable floor. The partition was already deleting pillars, silently.

#### The real argument is parameter *coupling*, not parameter count

Lines do not remove parameters. What changes is that **each parameter does one job**:

| | region model | wall graph |
|---|---|---|
| reveal extent | a pullback, which **also** decides which thin features survive | true by construction — a face boundary *is* the centreline |
| feature survival | the same pullback, plus a hole rule | spur pruning, asking a question a GM already answers |

The region model forces one number to set how much wall is revealed *and* which walls exist, because
the representation ties them together. **One parameter doing two jobs means neither can be tuned.**

#### Half-wall reveal is then free

A revealed region should extend into the wall, roughly to its centre, rather than stopping at the
ink's inner edge. The reasoning is a product judgement: the wall is part of the drawing, makes the
room look complete, sometimes carries detail worth seeing, and a region stopping at the floor reads
as though the party is being shown a partial room.

**Under the wall graph this needs no parameter at all.** Regions are the faces of the line
arrangement, so a face's boundary *is* the wall centreline and the reveal reaches half the wall by
construction. If the safe direction is ever wanted, it is a pure inset on the derived region — and
unlike a pullback it **cannot delete a wall**, because walls come from the graph rather than from the
region's edge. **The centreline is the ceiling**: any such inset moves the boundary back from it,
never past it.

### The exterior is not a room

**We do not emit a shape for the space outside the dungeon.**

> *"On most maps the exterior isn't a 'room'. It's not an explorable space. Not emitting a shape for
> it would simplify what we emit, and be more true to the typical intent of the map."*

Per the fog model in §2, no exterior shape means the outside stays **fogged and unrevealable**, which
is the intent. And it turns the project's worst failure into its loudest: **a room that leaks to the
outside joins a face nothing emits, and so becomes a room that cannot be revealed at all.** A merge
that used to be invisible until play is now obvious the moment the GM looks.

**It also removes an identification problem with no sound answer.** Deciding which face is the
exterior is not reliably solvable — "touches the image border" fails on maps whose rooms run to the
edge, and tone fails because the convention varies by drawing style. Worse, a single line across a
page separating two buildings carves a bordered exterior into two faces, where largest-by-area picks
one and touching-the-border matches both.

**With no border frame painted into the raster there is exactly one unbounded face, by topology, on
every map.** It has no polygon, so it drops out for free with nothing to identify.

**The cost, stated:** a GM who *wants* the outside revealable has to say so, by drawing walls at the
map's edge. That is one button — *Add walls around the map edge* (§5) — and it is an ordinary edit
afterwards.

### What emits as a shape and what emits as a line — the bridge criterion

Regions are the **faces** of the wall-graph arrangement, and each emitted face is a fog shape. A face
boundary already carries every wall along it, so most walls need no line of their own. The rule for
the rest is exact:

> **A wall emits as a line exactly when no emitted face boundary covers it.**

**"Emitted" is load-bearing**, and since 2026-09-16 it is not every face: a **suppressed** region
(§10) is left out, and the rule is applied to what remains with nothing else changed. A wall it
shares with an emitted neighbour stays inside the neighbour's shape; a wall it shares only with the
outside or another suppressed region comes out as a line.

The case that produces it is a **bridge** — an edge with the same face on both sides. A stub wall is
a bridge, and no region boundary can ever cover one because there is only one region there.
Bridge-finding is standard linear-time graph work.

#### Emitting the slit instead was proposed and rejected

The traversal walks a bridge **out and back**, so a stub hanging into a room appears in the room's
boundary cycle as a zero-width slit. That looks as though the room's own shape already carries its
stub, and no line were needed.

**Emitting that is wrong.** It puts our internal representation into the scene and leaves two other
renderers to interpret a degenerate excursion: Skia may collapse a zero-area subpath when stroking,
Owlbear may normalise it when storing, and neither is measured. It also produces something no human
could have drawn, since Owlbear's fog tool cannot make a shape with a slit in it — against the target
above. So the slit is **dropped from what is emitted** and the bridge goes out as its own line.

**Traversal and rendering are different things, and this is the clearest case of it.** The slit is
still walked; it is only not emitted.

#### Taking a bridge out of a ring SPLITS the ring

Skipping a bridge's half-edges while walking the cycle looks safe — an excursion returns to where it
left, so the ring stays continuous. **That is true for a plain stub and false for a lollipop**: a room
on the end of a stalk, whose own outline is not a bridge because it separates two faces. Skip only
the two stalk half-edges and the ring jumps from the stalk's base to the far room and back, cutting a
chord across the map and dropping every wall in between.

Removing a stalk from a boundary genuinely **disconnects** it: one hole around building-plus-lollipop
becomes two, one around each. Both naive rules fail in opposite directions — cutting at every omitted
half-edge separates a plain stub's two sides, which should stay joined.

What settles it: after the bridges are removed, every node has as many kept half-edges arriving as
leaving, because an excursion always comes back. So the kept half-edges **decompose into closed
loops**, found by following unused departures from each arrival. `LOLLIPOP` is a named test fixture
because the shape is worth recognising.

### The document and its rendering

**Our graph is the document. The scene is a rendering of it.** Emitted items are an output, never the
working state.

**This is forced rather than chosen: Owlbear cannot hold the graph.** Items are independent, each with
its own geometry and transform, and there is no shared vertex between two items. Emit a room as a
shape and its stub as a line and all they share is a coincidence in world space — drag the room's
corner natively and the stub stays behind, silently, at a scale where the break is invisible until it
is a fog leak.

**Attachment does not help**: it carries the parent's *transform*, not its geometry. The proof is
Dynamic Fog itself, whose wall actor recomputes a wall's points from scratch on every change to the
parent drawing. If attachment propagated geometry it would not need to.

**Precedent worth noticing:** this is exactly Dynamic Fog's own shape, one level down. Drawings are
its document; walls are derived, recomputed, never read back. A one-way binding from a document to a
rendering is the pattern the platform pushes you toward, and we apply it one level up.

**The trade, stated plainly.** A hand edit to one of our fog items does not survive the next push.
That is the point rather than a regression — what the GM sees is the current state — but it means the
wall editor is the *only* place to edit. Accepted on a second argument as well: Owlbear has no
polyline continuity between line segments, so editing our output there would have been poor anyway.

**Nothing is ever read back out of the scene.** Everything the surfaces derive is a pure function of
durable inputs — the settings, the nominated map and the paint layers, all in scene metadata, plus
the wall graph. Scene metadata belongs to the scene rather than to the extension or the browser
session, so it survives closing the workspace, reloading the room, and disabling and re-enabling the
extension. There is no `localStorage` use at all.

> **This is why emitted geometry carries no vertex ids.** They existed so that grouping items by id
> could reconstruct the graph, and so a stub's free tip could be told from a **doorway** — two ends
> deliberately close and deliberately separate, which geometry alone cannot distinguish. With nothing
> reading the scene back, the graph is always one re-run away and the question is never asked.
>
> **What would bring them back** is storing hand edits *as scene items* rather than as durable
> inputs. That is the one arrangement where the scene becomes the source of truth for something the
> pipeline did not derive, and it is already rejected.

### Rejected alternatives

- **Emitting `WALL` items directly.** Three independent reasons, any one sufficient: reported to be
  impossible on the networked scene at all; local walls are per-client and unpersisted, so **every
  participant would need this extension running**, absurd for an authoring tool used once per map;
  and Dynamic Fog's tools edit drawings and would ignore a `WALL` item entirely, so the output would
  be geometry nobody can nudge — which defeats the project.
- **Mimicking Dynamic Fog's private format for walls.** Unnecessary — there is no private format for
  walls to mimic (§2). It remains the shape of any eventual *door* work.
- **Bundling a stub into its room as a second subpath of one `Path`.** Fill would ignore the open
  subpath and the stroke would give correct walls, so the two could not be separated by a whole-item
  move. Declined because a **bent** stub, implicitly closed for filling, encloses and reveals a
  sliver — and because it fails the general case anyway: a junction shared by three faces belongs to
  no single item.
- **Emitting centrelines as thin drawings, instead of regions.** A thin line emitted as fog is a thin
  revealable sliver, so that design does nothing without Dynamic Fog. The wall graph emits lines **as
  well as** regions, so vanilla Owlbear still gets a complete manual fog map and the dependency never
  arises.
- **A global outward offset to reveal half the wall.** One radius against variable ink width,
  under-covering heavy walls and over-covering light ones on the same map — and, per the stub-wall
  argument above, it destroys any wall that separates nothing.
---

## 4. Reading the map into a graph

This is stage one: everything that turns pixels into the document. It is orchestrated in
`pipeline.ts`, and every step of it lives under `trace/` as a pure, headless-testable function.

```
load  →  binarise  →  compose the GM's paint  →  filter ink
      →  thin  →  chain into a graph  →  remove slivers  →  fit  →  build the wall graph
```

### Resolution is native

**We trace at the map's own resolution.** The cap that exists is a memory limit, not a speed limit.

The sibling traces at 1024 pixels wide, and it would have been easy to inherit that as prudence. Its
actual reason does not transfer: **its tuning constants are raw pixel values measured at that
raster**, so changing the width silently invalidates every one of them. The width is a calibration
lock-in wearing the costume of a performance budget.

The positive case is stronger than the absence of a reason to downscale. **Downscaling resamples the
ink, and the ink's topology is the answer this project computes.** Averaging a thin dark line into
its lighter surroundings lowers its contrast, and any stretch that then falls below threshold opens a
gap that is not on the map — a manufactured leak between rooms. The same averaging can also close a
genuine doorway. Both artifacts are real, they push in opposite directions, and which dominates on a
given map is not predictable. At native resolution neither is introduced. The graph pivot strengthens
this: the centreline of a resampled stroke is not the centreline of the drawn one, and centrelines
are now the emitted geometry rather than an intermediate.

The time is affordable for its own reason — this runs GM-only, once per map, at prep time.

**The cap is memory**: roughly four bytes per pixel for the decoded image, one for the mask, four for
the labels, inside a third-party iframe. The budget is stated in megapixels, reported on every run
whether or not it bit, and when it bites the reduction is by an **integer** factor so it is uniform
across the image — a fractional ratio resamples different regions against different sub-pixel phases
and thins linework unevenly.

**Named cost:** when the budget does bite, the reduction is done by the browser's own resampler
during the draw, not by a box filter of ours. A box average would be better, but computing one needs
the full-resolution pixels in memory, which is precisely what the budget exists to avoid. **The
budget bounds the raster and says nothing about the decoded source image**, which is not capped and
is the larger of the two on exactly the maps that trigger capping.

#### The budget bit for the first time — 2026-09-17

A 7252×5197 map (37.7 MP) against the 16-megapixel budget, reduced by a factor of 2 to 3626×2598.
`rasterPlan.ts` had recorded that nothing had ever run this path, and named what would happen when
something did.

**The factor is integral; the ratio is not.** The output size is a `floor` and the reduction is
`drawImage(source, 0, 0, plan.width, plan.height)` — the whole image into the floored size — so the
**effective** ratio is `source / floor(source / factor)`. Here that is 7252/3626 = 2.000000 across
and 5197/2598 = **2.000385** down, because 5197 is odd. One phase slip over the whole image, which is
the mildest form of the beat pattern the integer factor exists to avoid.

**Nothing is misplaced by it.** Raster row *r* genuinely samples the image around row *r* × 2.000385,
and both the drawing and the graph build invert exactly that. What it produces is a raster sampled on
a grid that drifts sub-pixel against the image's own — **a property of the ink, not of any
conversion**. You cannot get an un-skewed map from skewed ink (user, 2026-09-17), and no drawing
choice recovers it.

**What it looked like in a room**, which is how it was found: at high zoom the mask cells straddle the
map's pixel grid by a fraction that grows down the map — read as *low* in the top half, worst in the
middle where the drift is half an image pixel, and *high* in the bottom half, because past halfway the
eye measures against the next pixel down instead. It reaches exactly one image pixel at the bottom,
which is back in phase and so looks aligned again.

> **Two wrong answers were proposed before this one**, and both are worth not repeating: that the
> drift was a rendering fault in how the layers are drawn, and that the cure was to treat the raster
> as covering `rasterHeight × factor` image rows at a true factor of 2. The second would have
> *introduced* an error, since it does not describe what the resampler did. The file being read —
> `mapImage.ts`'s one `drawImage` call — settled it in a line.

**The answer is that the workspace draws the map at the raster's own resolution whenever the budget
bit.** This is §7's registration argument applied to the one place still outside it: drawing the
full-resolution image under raster-sized layers is our arithmetic agreeing with the browser's rather
than registration by construction, and taking the finer grid away removes the comparison rather than
fixing a fault. It is also the honest picture — detail the pipeline never saw is detail no amount of
looking can act on, which is the ink layer's own rule about drawing the composite.

- **One bitmap swapped into the same `drawImage` call, on the same rectangle.** The destination stays
  the *image's* size times the scale, so the map occupies the box it always did, at a coarser
  resolution. `mapImage` is read in eight places in `shell.ts` and is a draw *source* in one; the
  other seven want its pixel dimensions — the extent, the frame button, fit-to-rectangle, the click
  mapping — and are untouched.
- **The plan is computed, not awaited.** `planRaster` is pure and `MEGAPIXEL_BUDGET` is a constant,
  so the answer is a function of the image's own size, available the moment it decodes.
- **Smoothing counts the pixels the trace saw**: the threshold is `scale × factor < 1`, which is the
  existing rule — off past one screen pixel per source pixel — with the source being the raster.
- **Inert on an uncapped map.** `capped` false means no bitmap, factor 1, and not one line behaves
  differently. That is the property most worth having in a change to the shell.

*Rejected: marking the map name "(reduced 2×)"* (user, 2026-09-17). *"Downsampling isn't a strange
thing to do, and a user will understand if they spot it."*

**And the full-resolution decode is released once the reduced one exists — 2026-09-17.** The shell
held an `HTMLImageElement` for the whole time the workspace was open, and once there is a canvas
nothing wants it: the geometry wants the image's **pixel size**, which is two numbers, and the
drawing wants the canvas. About 150MB against the canvas's 38MB on that map, so keeping it was the
larger cost by four to one.

**What made it possible was splitting two facts that had been one.** `mapImage` answered both *what
does `drawImage` take* and *how big is the map* — it is `mapSource` and `mapPixels` now, and the
seven geometry sites that used to read `naturalWidth`/`naturalHeight` read two stored numbers.

- **`removeAttribute("src")`, never `src = ""`.** An empty string resolves against the document URL
  and the browser fetches *that*; `mapSource.ts` carries the same trap, where it produced a
  CDN-failure message for something that was not one.
- **Dropping the reference is the lever; clearing the element is a hint.** Whether the browser then
  frees the decode also depends on its own image cache, which nothing here can see.
- **There is no second holder of ours.** `mapSource.ts` builds the element in a local and hands it
  straight over. The pipeline decodes its own copy for tracing and lets it go when the trace ends,
  which is a separate and transient one — and it is the pair of those two that `rasterPlan.ts`
  reasons about.

**This is not the change that note warns against making without a log.** That paragraph is about the
*budget*, and whether the decoded source should be counted against it. This changes no budget and
touches no trace: it is a surface that was keeping a full-resolution decode for a session in order to
read two integers off it.



### Units — there is no unit that is always right

The original rule was *"denominate in measured ink width or grid squares, never raster pixels"*. Both
halves have since failed, and stating it that way hid the fact that the choice has to be made **per
parameter**.

- **Grid squares fail when the grid is not the map's.** A GM who does not need a grid leaves it at a
  default, or sets it wrong, and nothing about that is visible or reported. The pipeline still runs;
  the control simply stops meaning anything.
- **Ink width is not trusted across map styles.** It saturates at 2px, is biased thin, and is
  measured by erosion on a mask that a heavily hatched or stippled map makes unrepresentative. It is
  a good unit when it is good, and there is no way to know from inside which case you are in.
- **Raster pixels stop meaning the same thing only when the megapixel budget bites**, which is
  reported and rare — and they are always *exactly* what they say for the run in front of you.
- **Graph units** — the map image's longer side is 1 — are independent of the raster and the grid,
  which is what lets a value outlive any one reading: the GM's graph is kept in them, and a setting
  that acts on the graph has to be too. They replaced **fractions of each side** on 2026-09-16, which
  had the same independence and one flaw: on a map that is not square one number meant two lengths,
  so a vertical wall measured about 29% longer than a horizontal one on the test map.

So the rule is: **prefer ink width where the parameter is genuinely about the linework's own scale;
otherwise prefer pixels; use graph units where a value must outlive the raster; use grid
squares only where the quantity really is a distance on the map's own grid.** Nothing may depend on
the grid *silently*.

| parameter | unit | why |
| --- | --- | --- |
| Texture blur | px | a filter kernel size |
| Detail window | px | a filter kernel size, tuned beside the blur |
| Thinnest stroke to keep | ink widths | genuinely a statement about stroke thickness |
| Smallest mark to keep | px | a size on the image, and ink width is not trusted here |
| Largest gap to look for | px | a threshold that moved with a measurement would change what is proposed invisibly |
| Same-wall distance | px | a distance travelled across the image |
| Brush widths | px | what the GM is aiming with, on screen |
| Straighten (the amount) | graph units | acts on the graph, and is measured against it |
| Prune the dead ends (the amount) | graph units | acts on the graph, and is measured against it |
| Mend: largest gap to look for | graph units | a gap between walls, measured on the graph |
| Mend: same-wall distance | graph units | a distance travelled along the walls |

**Nothing in the pipeline depends on the grid.** The one control that did — the deleted smallest-room
filter — depended on it *squared*, so a grid off by four put it off by sixteen.

*Rejected: choosing the raster to hit a target pixels-per-grid-square density.* The sibling tried it,
reasoning that pixel-denominated constants are only meaningful against the ink scale they were tuned
on. It broke on a map spanning 5.4 grid squares, where the rule picked a raster 174 pixels wide and
thinned every line out of existence.

*Rejected: a grid-plausibility check* that would compare pixels-per-square against measured ink width
and report a grid that is not the map's. It is a **warning**, and §8 forbids those as safeguards. The
fix was to remove the dependency instead.

**A unit change is a rename, never a reinterpretation.** Keeping a settings key while changing its
unit would read a stored `0.25` squares as `0.25` pixels — catastrophic and silent. A rename means
the old key is ignored and the new default applies, which is the loud version of the same event. Any
scene tuned before such a change comes back at defaults for that control alone.

### Binarisation and polarity

Sauvola's **local** adaptive threshold over summed-area tables, ported from the sibling, with an
explicit Gaussian blur ahead of it as the texture-suppression control.

**Ink polarity — is the linework darker or lighter than its ground — must be decided, and the obvious
rule is wrong.** Taking whichever luminance class is the minority fails on a map with dark walls,
light floors and a **dark fill outside the rooms**: ink and exterior both land on the dark side, so
"dark" is most of the image while the ink is plainly still dark, and the rule inverts a map that
needed nothing done to it.

**What replaces it: ink is thin, not rare.** Linework is thin everywhere by construction; floors,
fills and exteriors are not, and that property survives whatever a map does with its tones. Measured
by eroding each candidate mask by one pixel and scoring the share of ink that fails to survive — a
hairline scores 1, a three-pixel stroke about two thirds, a blob near zero. The higher score is the
more line-like reading and therefore the polarity. Readings covering more than half the image are
disqualified outright, since ink is never most of a map.

Both polarities come from **one pass**: variance is invariant under negation, so a single pair of
summed-area tables yields both thresholds and the second mask is nearly free. The two masks are *not*
complements — Sauvola's threshold is asymmetric about the mean — which is itself why the decision has
to inspect the masks rather than reason about the histogram.

**Ink width falls out of the same measurement for free.** Eroding a stroke of width `w` leaves
`w − 2`, so a long straight stroke has `thinness = 2 / w` and the width is `2 / thinness`. That is the
denomination several parameters want, and it costs nothing beyond the arithmetic. The Sauvola window
should be comfortably wider than the ink — below about 3× a heavy stroke fills enough of its own
window to be read as ground.

**Erosion is a ruler, not a stage.** It measures thinness for polarity and ink width; nothing ever
writes an eroded mask back. There is no knob, because a knob would move the *unit* other parameters
use. And **erosion is not a minimum line width**: erosion thins survivors, and since regions are
bounded by ink, thinning ink **grows every region**.

**Colour is discarded and that is a real loss.** Binarisation runs on luminance, so a water-filled
room drawn in a mid tone can land in the same band as an exterior. It does not affect *connectivity*,
since regions are separated by ink rather than by tone. The live risk is narrower: if a mid-tone fill
ever falls on the ink side of the threshold, that room fills with "ink" and vanishes. Hue selection
is the reserve if it happens.

### The GM's paint — two layers, composed

```
base ink  −  suppression  +  added ink
```

Three independent inputs. The base is the reading; the GM owns the other two, painting each with a
brush. **Position in the composition is load-bearing**: suppression composes first, and added ink is
**last of everything**, which is what makes it immune to the ink filters below — nothing automatic
second-guesses what the GM drew deliberately.

`composePaint` is the one statement of that order, pure and tested. It could not be extracted while
the gap repair sat between its terms, which is why the repair becoming a tool (below) mattered more
than it looked.

**A raster, not a list of strokes.** The rule is that a document belongs in the space of the thing it
produces: the wall graph produces geometry, this produces ink pixels. What it buys is that the
preview and the effect stop being two computations — the array the GM is shown **is** the array that
composes — and that erasing needs no definition, it writes zero.

**At the pipeline's raster**, so applying it is pixel for pixel forever. The document records its own
dimensions, which is what makes a replaced image or a changed megapixel budget a *reported* resample
instead of a silent one. Moving, scaling or rotating the map cannot invalidate a layer, because the
raster comes from the decoded image's pixels and our budget alone.

**Size decided the design, and it is measured.** At 3300×2550: untouched ~0, a hall covered solid
(11.4% of the map) **4.2KB**, 100 wide strokes 10.6KB, 500 scattered dabs 34KB — and a grid *traced
line by line* map-wide **1,674KB**, which does not fit in scene metadata. The reason that does not
matter is a fact about people rather than about code: **nobody paints out crosshatching stroke by
stroke, they cover the area with a wide brush**, and solid is about 400× cheaper than traced.
`writePaintLayer` refuses above 128KB with a message saying what to do differently, rather than
letting an obscure metadata failure land at the moment the GM finishes.

**An empty layer is deleted rather than stored.** "No paint for this map" and "paint, and it is
blank" are one fact told two ways, and the second can disagree with the first.

### Repairing gaps in the linework

**A gap merges two rooms, which is this project's worst outcome**, and it is too small to spot by
eye on a whole map.

**The definition, after two wrong ones:** *a gap is a narrow channel of ground whose banks of ink are
far apart when measured **along the ink**.* Both rejects are worth remembering:

- *"a gap that separates space when sealed"* — tests the space when the question is the integrity
  of the **ink**. A freestanding wall in the middle of a room separates nothing, so a crack in it
  would never be reported.
- *"a gap between two different ink blobs"* — fails on a crack in a **ring**, where both banks are
  one blob by the long way round.

**Three steps, and only the first costs anything.** A morphological closing gives the candidate
channels. Grouping the ink touching a channel gives **one group for a dead end** and two or more for
something that passes through — that step alone kills the ragged-edge confetti a raw closing
produces, and it is free. Then a bounded flood through the ink from one whole bank group decides
whether the banks are the same piece of wall locally.

**It is a tool, not a filter.** Selecting it runs the search and rings every gap; clicking inside a
ring accepts that one; a button accepts every ring shown. **What is accepted goes into the added-ink
layer**, so from that moment it is paint like any other, with no separate term in the composition and
nothing that can re-invent itself.

That is what makes the safety rule fully true. A non-zero threshold was never one-time consent — it
re-invented ink on *every* recompose thereafter, whatever else moved underneath. As a tool, **the
writing is an act**.

- **A dead end is never repaired**, since it connects nothing.
- **A guessed gap** — one whose flood ran out of budget — is ringed but never filled. Marking on a
  guess is a warning; inventing ink on a guess is not.
- **The search runs against the composite**, not the base: a gap already brushed closed is not a
  gap, and one the suppression opened is.
- **Accepting re-runs the search**, so the caller can never draw marks the accept invalidated. The
  rings visibly reshuffle, which is expected — channels merge and split as the ink changes.

**Why the automatic search survives at all**, given a GM can now draw a wall by hand in the editor:
*on a map that has a lot of little gaps, the automated fix is a huge time saving.* That is also why
accept-all exists rather than click-one-at-a-time alone.

**One control, after two were tried.** Finding and repairing were briefly separate — a width to
highlight candidates and a share of it to select which got repaired. That failed on a fact about
maps: **gaps are not discrete items** that appear one at a time as the width rises. Where two
uneven lines run close together, a closing carves the space between them into several channels at the
pinch points, and those channels **merge into one** as the radius grows. So there was no stable
reference set to hold still, and **raising the highlight could prevent a repair a lower setting
allowed** — non-monotonic. One control is well behaved because what it tunes is the *set of pixels*,
which grows, rather than a set of marks, which does not. The channel count still jumps around, and is
reported as a diagnostic rather than as a tally of distinct faults.

**Predicted, not measured: a double-line wall is a false positive.** Hollow walls are narrow channels
whose two strokes meet only at the ends of a run, so every one would get filled solid — one mark per
run, not a shower.

**A stated cost: an accepted fill goes stale where the search used to self-correct.** Change the
threshold now and a gap that closed on its own stops being filled; an accepted one does not. The
direction that matters is a fill left across what has since become an open **doorway**, which Dynamic
Fog would derive a wall across. Accepted because it is visible in the added-ink layer's own colour,
and hand-painted ink already fails the same way.

### The two ink filters, and why both go past useful

Both act on the composed mask and neither is safe on its own. **Both maxima deliberately go far
enough to erase the map**, because a control whose top end still looks reasonable gives no feel for
where the edge is. That is only defensible because the surface draws the result.

- **Thinnest stroke to keep** — a morphological **opening** (erode k, then dilate k), denominated in
  measured ink widths, default zero. It works on **width**, which is the axis a floor grid printed as
  dark as the walls actually sits on; blur works on **contrast** and cannot reach it. It **runs after
  the ink-width measurement, never before** — measuring a filtered mask would raise the mean width,
  move the threshold, and change what it removes.
- **Smallest mark to keep** — removes 8-connected ink components whose bounding box is short on **both**
  sides, in raster pixels. Walls join into one network and decorations are islands, so connectivity
  does the separating and size only has to catch islands. **Longest bounding-box side, not area**,
  because that is the measure that means *stubby*.

Two implementation rules that look like inconsistencies and are not:

- **`erosionCounts` treats off-image as ground; the morphology passes clamp the window.** For
  *measuring* thinness, counting off-image as ground can only make a shape look thinner, which is the
  safe direction. For *filtering*, it would erode a band off every edge and delete a wall drawn along
  the border. Opposite rules, both right.
- **The island filter is 8-connected**, which is the conservative direction rather than merely the
  consistent one: a decoration touching a wall diagonally is then part of the network and is never
  removed.

**Both filters are separable running-count passes** — O(pixels) and **independent of the radius**. The
inner loop addresses pixels through a base and a stride rather than a closure choosing between two
multiplications; measured in Node at 3300×2550, radius 6 went from 503ms to 235ms, and the new
version is flat in the radius where the old one was not.

#### Each filter draws the distribution it acts on — 2026-09-17

A shape rises off each of the two ink filters' own rails: **ink per stroke width** on *Thinnest stroke
to keep*, **ink per island span** on *Smallest mark to keep*. Where the humps are says what kinds of
mark the map has; where the handle sits says which of them are being kept.

**The measurement is the filter, sampled — not a model of it.** Both have an obvious cheaper way to
answer "how much is there at each size" that is *not* the control: a distance transform for stroke
width, a plain size histogram for islands. Either would be a second opinion about a quantity the
control already decides, and a curve drawn beside a slider to say where to put it is the worst
possible place for one. So the stroke profile is a **granulometry** — open the mask at each radius the
slider can reach and count what survives, using the same `openMask` the filter applies — and the
island profile shares `removeSmallInkIslands`' own walk, extracted so there is one definition of an
island rather than two that can drift.

**Neither profile depends on the slider it belongs to.** Each is measured from the ink *before* its
own filter, so dragging that handle redraws the same curve with the marker somewhere new. The stroke
profile depends on the reading alone; the island profile also moves with the stroke slider, which is
real rather than an oversight — the islands the second filter sees are whatever the first left,
after the severance repair between them.

**Computed off the critical path.** The stroke profile is one opening per radius, the same order of
work as the reading itself, so folding it in would roughly double what a slider release costs to draw
a hint. A frame is yielded first — §7a's trap, where a synchronous computation holds the thread and
nothing set before it ever paints — and the map goes up before the shape follows it.

**The resolution is the control's, not ours.** The filter halves its pixel threshold and rounds to a
radius, so the curve has one point per *distinct outcome*: six on a map whose ink measures 3.4px,
against sixty slider stops. Drawing it at any finer grain would describe something the control cannot
do.

- **A band sits where its ink leaves the map**, for both filters, because the question the picture
  answers is what moving the handle here costs. For islands that settles a boundary too: a span
  landing exactly on a band edge belongs to the band *below*, since `removeSmallInkIslands` keeps an
  island when `span >= minSpan`, so one of span 4 survives the setting 4.
- **Islands longer than the track can reach are left out**, not folded into the last band. A map's
  wall network is one island spanning most of the raster and holding most of the ink, and including
  it would put every decoration on the floor.
- **Normalised to the tallest band**, so the shape fills its box on any map. Wrong if anyone compared
  two maps; nobody does.
- **A band with any ink at all is drawn at a visible height** (user, 2026-09-18), because the question
  at the thin end of the picture is *is there anything here* rather than *how much*. On a map whose
  detail outweighs its walls, normalising alone puts the wall population on the floor and hides the
  one thing worth seeing — where the setting starts costing linework rather than pebbles. **The cost:
  heights stop being comparable below that floor.** Zero is still zero and stays on the rail, which is
  the distinction that matters there.
- **A blank top end has two causes and the log tells them apart.** A plot shows only ink that *leaves*
  somewhere on the track; ink in strokes too wide for the last stop, or in islands longer than the
  track can reach, is in no band at all. So the `profiles:` line reports the share each profile does
  not account for. No floor under a band can raise what is not in the profile, and on a map whose
  linework survives everything the control can do, that share is the whole story.
- **It fits inside the row the slider already occupies**, with the rail as its floor, so nothing below
  it moves. Only these two controls get one, and `controls.test.ts` names them — a third has to be
  argued for there.

**Three findings from the oracles, none of which a mutation would have produced:**

- The first stroke oracle modelled an *unclamped* opening and disagreed with the implementation on
  every random mask. The implementation was right: `morphology.ts` counts off-image as ink so a wall
  along the border is not eroded off it, and the fixture that caught it had a block resting on the
  bottom row.
- The island oracle walked islands independently but binned them with a **copy of the expression
  under test**, so a mutated formula survived the whole sweep. Rewriting it to scan the band
  boundaries — saying what a band *means* rather than restating how one is computed — then failed,
  and this time the implementation was wrong: it offset every island by one span. That offset had
  also made a genuine overflow guard look like dead code, which a previous survivor had been
  "answered" by deleting.
- The random generator made white noise, in which a 7×7 all-ink window essentially never occurs, so
  the sweep agreed about nothing surviving 120 times. The reach assertions refused it.

**And one thing asserted here first and backwards:** chaining each opening off the previous result
gives the *same* answer, because openings by squares compose as a granulometry. That mutation is
equivalent rather than uncaught, and the fixture written to catch it cannot. The code still opens from
the original, because that is the definition and because it does not depend on the structuring element
continuing to compose that way.

**Thirteen mutations, thirteen caught**, plus four more over the track placement.

*Open, and noticed only because this plot makes it visible: the stroke slider has about ten stops per
distinct outcome.* This project has already treated that as a defect once — the gap width is stepped
in twos *"because the value is halved and rounded to a closing radius, so consecutive odd and even
settings produce the identical repair"* — and the stroke filter has a worse version that nobody has
seen, because the map redraws identically either way. With the curve drawn, the handle slides a third
of the way across a flat stretch while nothing moves.

### Healing what the stroke filter severs — 2026-09-21

**An opening retracts a stroke's end**, so a radius one notch too high nicks a corner — and a nick
is not a small thing downstream. Thinning pulls each free end back by `(w + 1) / 2`, and a severance
makes two, so:

> **A break of `g` pixels in the ink arrives as `g + w + 1` pixels in the graph.**

Measured in a room: two pixels of ink, about nine pixels of graph, on 5.7px linework. **The penalty
is additive and does not shrink with the break** — a one-pixel nick still costs an ink width — so
there is no such thing as a small break once it reaches the graph. That is the whole argument for
repairing here, where two pixels are two pixels, rather than on the graph where every mend has to
bridge the lot.

**So the opening is followed by a closing at the same radius, intersected with the reading.**
`healSeverances` puts a pixel back only if all three hold: the closing says it lies in a channel
narrower than `2 * radius`, the filter has removed it, and **the reading had ink there**.

**Restore, never invent — and it is an invariant rather than a habit.** An opening only removes, so
`filtered ⊆ original`, and the heal may only add from `original`; therefore
`filtered ⊆ healed ⊆ original` for any input, which is swept over random masks rather than argued.
Three things follow:

- **It cannot seal a doorway.** A doorway is a real opening in the drawing, so those pixels were
  ground before the filter ran and the intersection refuses them. **Without the check this is a
  plain closing**, which would seal any opening under `2 * radius` — six pixels on the map that
  prompted it.
- **It cannot resurrect a stroke the filter removed whole**, since nothing survives either side for
  the closing to bridge between.
- **It needs no control, no colour and no confirmation.** This is what the automatic gap repair
  could not have: that one was retired because a non-zero threshold *re-invented ink on every
  recompose*, so it was never one-time consent. **This is filter-damage repair rather than gap
  repair**, and the difference is enforced by construction.

**The same radius as the opening, so nothing is set.** An opening at `radius` can only sever where
the stroke dipped under about `2 * radius`, and the bridge reaches exactly that scale — self-tuning
to the damage.

**The erosion is one short of the dilation, and that is what makes a diagonal wall heal** (room,
2026-09-21: a gap the first version missed, reported as *staggered by a pixel*). **A square erosion
cannot fit inside a thin diagonal band** — the `(2r+1)` window needs that many consecutive full rows
and columns and a diagonal never offers them — so a symmetric closing dilates the gap shut and then
erodes the bridge straight back off. Measured: a severed two-pixel diagonal wall heals at **no radius
at all** under a symmetric closing, and at **every** radius with the erosion one short. Closing at
`radius + 1` does not help either, because the window grows with the band.

> **The stagger was not the variable**, which a probe corrected on the way: a gap heals when it is
> under `2 * radius` whether the two stumps are offset or not. What fails is the *angle* of the wall,
> and it fails completely rather than marginally.

**The cost of the asymmetry, measured:** the net one-pixel dilation restores a removed pixel that
merely *touches* surviving ink rather than only one in a channel, so a stroke the filter removed
leaves a one-pixel nub where it met a wall — 8 pixels of 64 removed on a hatched fixture at radius
two, none at radius three. **Reasoned, not measured:** a one-pixel bump on the side of a five-pixel
wall should not survive thinning as a branch, so it should cost no spurs. **Since the automatic prune
(below), one that did would be removed at the derive**, being far under two ink widths — so the
free-end count no longer shows it, and the prune line's count is where it would appear.

**It runs before the island filter**, so a restored bridge rejoins its fragment to the network
rather than leaving it to be deleted as debris. That also makes the island profile's input the
healed mask, which is the honest one.

**The cost, stated:** a thin stroke running through a narrow channel between two surviving walls
comes back in the part inside the channel, because those pixels were ink and the channel is narrow.
Bounded by `2 * radius`, and ambiguous anyway. **Seven mutations, six caught and one equivalent** —
the survivor relaxes a guard that the radius-zero no-ops already make redundant, kept for cost.

### Connectivity — the pairing is not optional

Connected-component labelling must use **8-connectivity for ink and 4-connectivity for space**.
Using the same connectivity for both produces the classic paradox: a one-pixel diagonal touch
simultaneously connects the ink and fails to separate the space, so regions leak diagonally through
walls that look closed. **This is a correctness requirement, not a tuning knob**, and the turn rule at
a diagonal pinch is the same decision one stage later.

### Thinning

**Topology-preserving thinning (Zhang–Suen), never a distance-transform medial axis.** It iterates a
list of surviving ink pixels rather than the raster, and takes `floor(w / 2)` passes for ink of width
`w` — pinned by a test across four widths rather than left as an impression.

**The reason is not that thinning avoids the free-end retraction.** It does not: Zhang–Suen pulls back
**(w + 1) / 2 pixels**, measured on bars of known width. What distinguishes it is that the **branch
survives at all**, where a partition deletes it outright. A stub three pixels short is a wall; a stub
that is gone is not. The retraction is a standing cost — about 0.06 of a grid square on the test map
— and the fix, if a room ever wants one, is extending each branch end back along its own direction to
the ink boundary, not a different skeleton.

**Thinning runs on the COMPOSED ink**, not the base: a repair asserts two segments are connected, and
thinning the unrepaired ink would show them as two.

### Chaining the skeleton into a graph

The sibling had already solved this, from the author's own `VTT_Maps`. Two of its rules transfer as
they stand, one is forbidden, and one was taken and withdrawn.

- **Walk the skeleton into pixel chains running node to node.** Interior pixels are marked as consumed
  so a chain is not traced again from its far end; **node pixels are never marked**, because several
  chains legitimately share one.
- **Join two chains where exactly two ends meet at a node.** Such a node is not a junction, so those
  chains are one edge.
- **Merging chains *through* a junction is forbidden here**, not merely defaulted off. The sibling
  pairs the straightest continuations through a crossroads, because a stroke drawn as one line has to
  wobble as one line. Merging two edges through a degree-3 node would destroy the incidence the faces
  are read from.

#### Nothing between the skeleton and the faces may move a point

This is the strongest rule in the pipeline, and it was learned expensively.

**Welding** — collapsing chain endpoints within a small radius onto one shared node — is the sibling's
answer to the junction cluster, and it was adopted here with a GM-facing radius. **It is wrong here,
and the reason is specific to wanting faces rather than polylines.** Welding moves a chain's endpoint
to a node it was not on, and the moved end then has to be walked to its node along an invented lattice
path. **That path can cross other linework.** Once the embedding is not planar, a half-edge traversal
means nothing: the angular order at a node no longer corresponds to the order faces appear around it,
and the walk crosses between faces without noticing.

Measured over generated linework, by failure rate:

| weld radius | failures |
| --- | --- |
| 0 px | 21 / 600 |
| 2 px | 30 / 600 |
| **3 px — the default that shipped** | **459 / 600** |
| 4 px | 540 / 600 |

> **Every point in the graph is a pixel that was in the skeleton, and every step is to an 8-neighbour
> of the last. Deleting is allowed; inventing is not.**

The control was **deleted**, not defaulted to zero.

#### What replaces it: removing the sub-pixel slivers

A junction cluster's real signature is not that its pixels are close together. It is that the chains
between them **enclose a face with no space in it** — where thinning turns a T into a small Y, two
chains run between the same pair of nodes and bound a triangle of half a pixel containing no lattice
point at all.

That is something to *find* rather than a distance to guess at, and the repair is to **delete one of
the sliver's bounding edges**, merging it into whatever lies on the other side. Deleting an edge
cannot break planarity and moves nothing. Two constraints on which edge:

- **It must have no interior pixels.** Deleting one that has them takes those pixels out of the graph
  entirely, leaving them neither inside a face nor on any boundary.
- **A diagonal link is preferred.** Three mutually-touching pixels form a triangle whose hypotenuse is
  the redundant 8-connection; giving up a leg instead cuts the corner off the linework.

**No parameter, and that is the point.** A sliver either encloses a lattice point or it does not — by
Pick's theorem in doubled integers, where **B is DISTINCT boundary points, never the step count**. A
slit walked out and back visits its pixels twice, and using steps there scores real slivers at
I = −2 and lets them through.

**A sliver with no interior-free bounding edge is left alone and counted.** Never observed.

#### Degree is counted two ways, deliberately

**`walkChains` counts raw neighbours. Anything deleting a branch counts contiguous runs around the
ring (the crossing number).** Making these consistent reintroduces a defect either way:

- A **raw count** stops a branch walk one pixel early and leaves a nub on the wall.
- The **crossing number** reads a pixel with four neighbours falling in two runs as an ordinary path
  pixel, so a chain walk passes straight through it and **strands** whichever branch it did not take.
  A stranded pixel is still skeleton, so it is not space either — the smallest possible failure, and
  exactly the kind no eye finds.

**The cost of counting neighbours, stated:** three mutually-touching pixels become a half-pixel
sliver, so sliver removal has real work on every map rather than occasionally.

### Fitting, and building the wall graph

**Each edge is fitted once, and both faces sharing it are assembled from that one fitted edge.**
Under a partition, two adjacent rooms' boundaries were a wall width apart, so simplifying each ring
separately was harmless. Under the graph they are **coincident**, and independent fitting lets them
drift apart by up to the tolerance — opening a sliver between two rooms that share a wall. Fitting
per edge makes that impossible by construction rather than by a tolerance.

**Escalation is therefore global**: when anything exceeds the command cap, the tolerance rises for the
whole map, because a region escalated alone would stop matching its neighbours. **Cost stated: one
enormous region can coarsen every other one.**

**Douglas–Peucker selects a subset of its input** rather than computing new points, so a fitted vertex
is still a lattice point and every later comparison stays exact. `simplifyIndices` is the decision and
`simplifyPolyline` is that plus a lookup — one Douglas–Peucker, not two.

**A collinear pass runs as the wall graph is built**, dropping any point lying exactly on the line between its
neighbours. It is the only simplification that **moves nothing** — every remaining point is where it
was and the enclosed area is identical.

- **The test is an exact cross product, and it has to be.** Asking the fitter's distance function
  whether a point is zero from the chord fails: it divides by a squared length and multiplies back,
  so a collinear lattice point comes out at ~1e-30 and a `> 0` test keeps it.
- **It runs at the build, not in the fitter.** The randomised sweep runs the derivation at a
  tolerance of zero precisely to get *unfitted* rings, and asserts every step of one is to an
  8-neighbour. Collapsing a straight run inside the fitter would break that assertion for a reason
  unrelated to what it guards.
- **No figure is quoted for what it saves, and none should be.** A thinned centreline is a
  **staircase**, so a wall at exactly 45° or exactly axis-aligned collapses and one at three degrees
  off horizontal keeps every step. **It is not a substitute for choosing a tolerance.**

**Simplification stays conservative, and the reason changed.** The sibling's warning was that a
simplifier cuts concave corners *outward*, and outward beside a wall means into the next room. Here
outward means **into the wall**, which is harmless — a centreline that drifts is still inside the ink.
The risk that remains is a **corner cut across a doorway**, bridging into a corridor and merging two
regions.

**The old half-ink-width cap is retired.** Its reason went when the graph made both faces of a shared
wall move together, and the top of the slider is now meant to reach obviously-useless values like the
two ink filters. *"The user will be looking at the consequences."*

**Never split a region to meet the 8192-command cap.** Raise the tolerance; report what still will not
fit. Splitting puts a boundary — and therefore a wall — down the join, in the middle of a room.

### The hairs come off in the derive — 2026-09-21

**Confirmed in a room the same day**: *"No more stubs."* Whether any stub a GM wanted went with them
has not been reported either way.

**Every derive prunes the dead ends of up to two measured ink widths** before it hands the graph over.
A *dead end* is a wall run with a free end; pruning deletes such runs, in rounds, since removing one
can leave a junction with another short arm hanging. Thinning grows one off every notch in a
hand-drawn edge that survives binarisation, and a room reported them as *"a lot of tiny spurs"*.

**The argument is visibility, not measurement** (user): *"A spur the size of the ink width or two
almost certainly isn't a real wall."* A measurement could not settle the figure, because it cannot say
which spurs a GM wanted. What can be said is that a dead end no longer than the stroke is wide was not
drawn as a wall.

- **Computed, never chosen**, beside the fitting tolerance: `autoPruneLimitPx` in `deriveWalls.ts`,
  converted to graph units by raster pixels per unit. **No ink width, no pruning** — the pipeline's
  other fallback for a missing width is a tenth of a grid square, and nothing may depend on the grid
  silently.
- **Safe to automate where the gap repair was not**, by §4's rule: deleting is allowed, inventing is
  not. It cannot put anything on the map the ink did not have. The **Prune** tool stays for more.
- **Inside the escalation ladder, on every rung**, so the faces the command cap is counted against are
  the ones a push writes. The push's own trace and the workspace get the same graph, because both are
  the pipeline's.
- **The limit is inclusive**, as `spursToPrune` has always been: a run exactly at it goes.
- **The stored base is the pruned graph**, since the base is what the trace derived. So a pruned hair
  is not a hand edit and raises no cover.

**The costs, stated.** **It trusts the ink width**, an erosion estimate that is biased thin and
unrepresentative on hatched or stippled maps — accepted for now (user). **A real feature that short
goes too**: a serif across a wall's end, or both arms of a T-shaped door jamb; the wall it hung off
stays. **A fragment between two breaks goes whole** when it is under the limit, which widens what Mend
then has to bridge. And **it cascades**, so a small star of short strokes goes entire. **Reasoned, not
measured:** all of these sit under two ink widths, where the argument above says nobody drew a wall.

**Nine mutations, nine caught**, against a sweep over random ink with an oracle that walks each free
end along degree-two vertices itself rather than through `walkRuns`, and checks that every segment
handed over was in the unpruned derivation.

### The two caches, split where the pipeline stops reading the image

- **The reading** — binarise, polarity, ink width; ~690ms of a ~1.4s run — is cached on map identity
  plus the reading parameters alone.
- **The composed ink** is cached on everything, and is built from a possibly-reused reading.

So a sweep of a later control skips the expensive half. **It is still one implementation**: two
functions in series, not two copies of the chain — a second copy re-opens the sibling's worst
diagnostic failure, where its harness and a real room disagreed *in direction* because the harness
never ran world placement.

**The boundary is declared by exclusion**, so anything new invalidates the reading unless it is
explicitly named as post-reading. That polarity is deliberate: a forgotten entry makes the cache
*useless* (690ms, obvious in the log) rather than *wrong* (a stale mask reported as current). **Do not
tidy it into an opt-in list.**

Both fingerprints are deliberately over-broad on the map side — identity, geometry, scene grid — since
a wrong reuse would report stale regions as current. Which halves ran is logged every time.
---

## 5. The wall graph — stored, walked and edited

**Stage one is the map; stage two is the graph.** Building the wall graph is where the pixels stop
being needed: everything before it derives from the image, and nothing after it re-derives.

That is what makes editing possible at all. Re-deriving renumbers everything, so stored edits would
point at vertices that no longer exist. The editor never re-derives, so **a moved vertex is just a
stored coordinate** rather than a thing that has to be found again.

**Nothing is "frozen", and there is no door.** An earlier design made this a one-way crossing, and
the vocabulary outlived it — if you meet the words *freeze* or *frozen* anywhere, they mean this
build and nothing more. Reopening the ink mode is harmless: it derives a graph and shows it, and only
the two save buttons at the foot of it replace what is stored. What is true is narrower and is the
whole of it: **a re-derive produces a new graph rather than updating the old one**, so saving over
edits discards them, which is why saving is a deliberate button rather than something closing does.

**No edit list, deliberately.** Replaying GM actions would have to happen twice — on the raster and
again on the graph — and grows more error-prone with every tool added. Accepting the information loss
from earlier stages is the price.

### What is stored

**Two flat tables**: nodes as coordinates, positionally indexed, and edges. **Faces are derived, not
stored**, which is what makes add and delete tractable — change an edge, re-traverse, and the faces
fall out. **Node ids are the only identity the document has.**

- **Coordinates are GRAPH UNITS: the map image's longer side is 1.** The raster is an artefact of our
  own memory budget rather than of the map, so a document denominated in it goes stale when a budget
  constant moves. Graph units are independent of the raster, and convert to world at emit time from
  the map's **current** bounds — so moving or scaling the map in Owlbear carries the fog with it,
  which absolute world coordinates would not.

  **Fractions of each side until 2026-09-16** (user). Those had every property above and one flaw: on
  a map that is not square, one number meant two lengths, so everything that measures — the prune
  limit, straightening, the measured tops of both tracks, every hit radius a tool turns from screen
  pixels — was skewed by the map's aspect. On the test map a vertical wall measured about 29% longer
  than a horizontal one of the same pixel length.

  **The extent comes from the image, not the raster.** A capped raster is the image divided by an
  integer factor and floored, so its aspect can be a pixel off; the build converts per axis against
  the raster and scales to the image's extent, which puts the raster's far edge exactly on the map's.
  The document does not record the extent — whoever holds the map image supplies it: the trace from
  the decoded image, the push from the map item's pixel size, the frame button from the drawn image.

  **Placement uses the extent as a raster size.** `createPlacement` maps a raster linearly onto the
  world box, so a raster of `extent.x × extent.y` *is* graph-unit space, with per-axis scaling intact —
  which is what keeps a map a GM has stretched out of proportion in Owlbear working.

  **Format version 4.** The bytes did not change, which is exactly why the version had to: a version 3
  graph would decode cleanly and be wrong on every non-square map. Version 3 was deployed, and stored
  graphs from it are **refused rather than converted** (user, 2026-09-16) — the only scenes holding one
  are the author's, and converting needs the aspect a version 3 document never recorded. *Remove ours*
  in the panel clears one.
- **float32, quantised with `Math.fround` on the way in**, so the round trip is exact rather than
  nearly so and nothing downstream needs a tolerance for storage having moved a number.
- **Segments, not polylines**, so **every vertex is a node** and a junction cannot hide at an interior
  point. A polyline store needed the invariant "a junction is always an edge endpoint", and that is
  violable: a wall meeting another head-on at a middle vertex makes a junction the walk passes
  straight through. Segments make it *impossible* rather than checked. Junction-ness is then purely
  derived — degree 1 is a free end, 2 is a bend, 3+ is a junction — and a **wall** is recovered by
  `wallRuns`, chaining through degree-2 nodes. Storage roughly doubles: tens of kilobytes against a
  512KB ceiling.
- **A checksum (FNV-1a over the body)**, because this format lost the integrity check a lattice walk
  had for free. A flipped bit in a lattice step threw the walk off its end node; a flipped bit in a
  *coordinate* is a different, entirely plausible coordinate.
- **The store records which map the graph is for.** Graph units of *a* map say nothing about which, so a
  mismatch reads as "no graph here": nominating a second image drops the GM into stage one for it
  without touching the first map's work. One graph at a time; per-map keys are the fix if it ever
  matters.

**Three decisions in the store, each easy to undo by accident:**

- **The graph's *presence* is what says the editor has something to show**, with no separate flag that
  could disagree.
- **It has its own metadata key**, or a slider release would rewrite tens of kilobytes and two writes
  could race.
- **`writeWallGraph` throws where `readSettings` swallows.** A failed read falls back to defaults
  and carries on; a failed write means the GM keeps editing something that is not being saved.

### The base is stored beside the document — 2026-09-14

**A second key holds the graph as the trace last derived it.** The document is what the GM has; the
base is what it was before they touched it, and the difference between the two is the answer to the
only question the surface needs to ask about hand editing: *is there work of mine in these walls?*

**It replaces a count that could not survive a session.** `handEdits` is in memory, so a GM returning
to a map they edited last week opened at zero — no mark, no warning, at exactly the moment both were
most needed. Two graphs in the scene make the question a comparison of two durable things.

**A count was the wrong instrument anyway** (user, 2026-09-14). Fourteen tells a GM nothing they can
act on; they cannot know whether fourteen is a lot or whether those fourteen mattered. It is a
numeric proxy for something that should be looked at, which is the fault that retired the merge
alarm. What replaces it is a mark with no number, and — at the moment a regenerate is offered — the
**delta drawn on the map**: what would go in amber, what would arrive in cyan, the same subtractive
and additive pair the painted ink already uses.

**Segments are compared by their endpoint coordinates, never by node id.** This is not the identity
rule being broken. That rule is about whether two walls *meet*, where a proximity test would join a
doorway's two deliberately-separate ends; nothing here asks that. This asks whether a segment is
present in both sets, and both sets hold float32 coordinates quantised through `Math.fround` on the
way in, so a segment in both is byte-identical — exact, with nothing to tune. What it buys is that
`compactNodes` and pruning may renumber freely, where a diff by id would silently degrade into
**wrong output** the first time either ran.

**A move is a removal and an addition, deliberately.** There is no third category: dragging a vertex
changes the coordinates of every segment touching it, so each falls out both ways with no special
handling. **The cost, stated:** a crossing split replaces one segment with two halves and none of the
three matches, so an incidental crossing reads as a change when nothing moved. Over-reporting is the
safe direction; the refinement, if anyone minds, is to treat a split as unchanged when the halves are
collinear with what they replaced.

**No base means "assume it was edited".** Three cases — nothing stored, a base for another map, and
one that will not decode — all mean *we cannot say this graph is still what was derived*, and the
loud answer is the right one: a mark nobody needed costs a mark, where a missing one lets a GM
regenerate away an evening with nothing said.

**One `setMetadata` at a derive, two keys.** They are the same graph at that moment, so the encoding
happens once. A hand edit writes only the document, which is why the base is its own key rather than
a field in the same record — sharing one would put its tens of kilobytes back on the wire on every
wall drag.

**`decodeWallGraph` refuses all-or-nothing**, unlike the settings normaliser which degrades field by
field. Settings are independent — a bad blur can take its default while the others survive. A graph is
not: an edge referencing a node that does not exist has no sensible fallback, and **a graph with an
edge quietly dropped is a corrupt document presented as a valid one.** So it is a complete graph or
`null`, and it distinguishes "nothing stored" from "stored and unreadable" — both yield no graph, but
the second has cost the GM their editing and must not read as "you have not started".

### The build itself

Fitted edges are positionally aligned with the derived graph's edges, and fitting keeps both ends, so
the shared points *are* the derived graph's nodes with their indices intact; each edge's interior
points become ids of its own.

**Coincident and zero-length segments are dropped, counted and reported.** Two walls bounding a room
thinner than the smoothing tolerance both fit to the same straight line between the same two corners,
so the room closes up and the document gains a doubled wall — which is not an embedding a traversal
can mean anything over. **The stated cost: that thin room is gone from the document and will not be
emitted.** Restoring the unfitted chain was the alternative and was declined.

### Faces from the graph, with no raster anywhere

The walk: sort the walls at each vertex by heading, leave by the entry **before** the one arrived
along, face on the right, enclosing cycles positive.

> **The successor rule takes the entry BEFORE the one it arrived along, not after.** This is invisible
> on any fixture whose nodes have two departing half-edges, which is every plain room. At a junction,
> the wrong rule walks a stub hanging into a room as part of the band *outside* it.

**Grouping is by containment, and the exclusion is a correctness requirement rather than a speed
one.** Each connected piece of linework contributes exactly one outward-facing cycle plus one
enclosing cycle per bounded face of its own, so an outward cycle is a hole of the *smallest* enclosing
ring containing it. **A cycle is only ever tested against cycles of other pieces**: a piece's outward
cycle runs along the same vertices as its own rings, so testing it against one of them asks whether a
point exactly on a polygon is inside it — a coin flip, and the case that arises on every single room.
Different pieces share no vertex, so the test is never degenerate.

**Areas are summed per half-edge, dropping any whose twin is in the same cycle.** A slit's two terms
are exact negations, but summing point by point separates them by the whole rest of the walk.
Measured, not assumed: **about one random float32 chain in a thousand fails to cancel**, and the
fixture that pins it sums to +5.55e-17 — positive, which is the direction that turns a loose stub into
a room. Dropping the terms before they are added is exact by construction.

**Nothing is dropped for being small.** Slivers are the GM's to keep — they may be reducing an area to
a sliver on purpose, to get a wall where they want one. Nothing downstream breaks: even-odd fill
retired winding long ago, and a degenerate ring contributes zero to any area total. **Warn, never
prevent**, including for an exactly degenerate shape: refusing assumes the gesture is finished, and
doubling a line in order to drag the copy elsewhere is a legal intermediate state.

Worth putting in any such warning's wording: **a sliver is not small in its effect**, because Dynamic
Fog strokes a boundary to derive walls, so a few pixels of shape still block line of sight.

**No fitting happens here, which is the handover paying off.** The wall graph *is* the fitted
geometry, so a ring is its own nodes and nothing is approximated twice.

### Editing the graph

Every edit is planar-safe and every one goes through one crossing sweep.

- **Crossings are SPLIT, not refused.** The crossing test is exact integer arithmetic where it can be;
  the crossing point is **rounded to the nearest pixel**, since two integer segments meet at a
  rational point. Up to ~0.7px of movement, accepted so every later comparison stays exact rather
  than committing the project to floats and epsilons permanently.
- **Collinear overlap is reported, never fixed.** Splitting cannot separate two edges lying along each
  other, and it is a legal intermediate state.
- **Only the segments an edit touched are checked** — a correctness argument before a speed one, since
  a graph that was planar before can only have gained a crossing involving something that moved.
  Sweeping everything is quadratic: order 10^8 pairs on a real map, at every drag-end.
- **`removeEdge` and `removeEdges` run no crossing sweep**, because deleting cannot break planarity.
- **`mergeNodes` is what snapping produces**, and it is a different operation from a move: every
  reference to the folded id is renamed, so the walls genuinely *share a point*.

**Identity is by id and is exact — never introduce a matching epsilon.** Two walls meet because they
**share a node id**, not because two coordinates are close. A doorway is two ends deliberately near
and deliberately separate, so a geometric test alone would flag every one. What floating-point
coordinates did reintroduce is a *degeneracy* threshold in the crossing predicate and *screen-derived*
radii in the tools — neither is an identity test, and both are decisions the GM can see being made.

**Snapping is the TOOL's job, not the geometry's.** A dragged or placed vertex snaps to a nearby
existing vertex by default, with the target drawn in green; **Shift suppresses it**. That is why
`insertEdge` matches nodes by exact coordinate and never by proximity — the caller has already
decided, and a second proximity rule underneath would be a second opinion nobody asked for.

> **Shift, not ALT.** Firefox raises its menu bar on ALT and takes the keyboard away mid-drag. Ctrl
> was never available because it pans. The shell names the field for its *role* rather than for the
> key, so the choice lives in one place.

**Renumbering node ids is forbidden mid-gesture.** Ids are the only stable identity the document has.
`compactNodes` — which drops every vertex no wall uses and renumbers the rest — runs at exactly one
moment: after a gesture has ended and cleared its state, with the in-flight write blocking another.
**The caller answers "hold no ids across it" by *stopping holding them*** and re-asking what is under
the pointer, which is also more correct: the graph just changed, so what the cursor is over may
genuinely be something else. Measured at 0.05ms for 430 vertices and 1.06ms for 44,000, against a
scene write of about 1,200ms — speed was never the objection.

**The layer's rule and the query's rule must agree.** Between them they are what "there is something
here" means. Erasing and merging leave vertices no wall uses; the layer skips them, because a handle
that moves nothing would be a lie — and the snap query has to skip them too, or drawing catches on
points nobody can see.

### The three verbs, and the tools that followed

A drag can only mean one thing, so the editor has a sticky tool picker: **Move**, **Draw**, **Erase**,
Move by default. **Mend** joined them on 2026-09-16 — it proposes walls across breaks rather than
taking a gesture — and **Dissolve region** the same day, which removes the walls around a region with
one click, **Suppress region**, which leaves a region out of the fog with a mark, and **Span**, which
walls an opening straight across from a click. **Collapse small regions** followed on 2026-09-21, ringing
regions under a size and turning each clicked one into a star of its connections. §10 carries all five; Suppress region edits marks rather than walls, and sits with the wall tools because what it
decides is which regions the walls make count. The alternative — hiding draw and erase behind modifier keys — was rejected for
putting a destructive action on an unannounced click and leaving both verbs undiscoverable.

- **All but two decide by looking.** Move takes a press only when a vertex is under it, Erase only
  when a wall is, Mend and Collapse small regions only inside a ring, Dissolve region only inside a region and Span only where it
  has a wall to place, so a plain drag anywhere else still pans. **Draw and Suppress region take every press**: a wall has to be able to
  start on empty map, and a mark can go anywhere, outside every region too. Ctrl pans regardless.
- **Draw supports both forms.** Press-drag-release puts a wall down in one gesture; press-release then
  click puts one down in two, with the far end re-aimable in between. Neither is more correct — a drag
  is quicker and two clicks are more precise — so both are served.
- **Both ends of a drawn wall snap, and that is what makes it useful.** A wall that merely *ends* where
  another begins is two coincident points agreeing until one moves; one that shares a node is joined
  for ever. Attaching ends are drawn green and larger, loose ends amber.
- **Erase deletes ONE SEGMENT, not the wall run.** The cost is stated in the UI rather than left to be
  discovered: a long wall drawn as many segments takes a click each. What it buys is that punching a
  doorway through a room's boundary is a single ordinary action rather than a modifier.
- **A minimum drawn length, in screen pixels.** Two clicks in nearly the same place otherwise make a
  wall a few thousandths across, which cannot be seen or aimed at. The floor is on what can be aimed
  at, not on what the map may contain, so zooming in to draw fine detail still works.
- **Escape belongs to the tool first.** The shell asks the handler before closing, so abandoning a
  half-drawn wall does not also close the workspace and push to the scene. Right-click asks the same
  question.

**`nearestEdge` is pure proximity and was never asked to prefer longer walls.** What makes a long wall
*feel* preferred is geometry rather than a rule: it is within the radius from far more places. If a
bias is ever wanted, the narrow change is a tie-break toward the **shorter** wall.

**The drag holds nothing in the graph.** The tool holds where the vertex *would* be and the layer
substitutes that one coordinate, so a drag costs no graph rebuild and no crossing sweep per frame. The
sweep runs once, on release, which is also the scene write. **The grab keeps an offset** so a vertex
does not jump to the cursor when touched — a few pixels of the GM's own work moving because they
touched it is not something this surface may do at any size. **The snap is measured from the vertex,
not the cursor**; they differ by that offset, and measuring from the cursor makes the merge mark appear
beside a wall that never comes close.

**A snap is drawn in the target's place, not merely coloured**, because that is exactly what releasing
produces, so the boundary has to be visible **before** it is crossed — undo reaches a merge, but only
helps a GM who noticed what the release did.

**A press and release that did not move writes nothing**, and does not fire the point probe either — a
gesture the tool took is finished by the tool.

### One rule for the cursor

> **A crosshair means the tool will act at this point; a hand means the surface will move.**

An **arrow** is the null statement ("ordinary surface, clicking picks things"), which under-promises on
a map where every press does something. A **crosshair** says the exact position matters and keeps its
own target visible — which is why it replaced the grab hand, whose fingers sat exactly over the dot
being aimed at. An **open hand** says the surface moves and misleads wherever moving it is not the
point.

**A release ends the gesture, not the hovering**, so the hint persists over the vertex the pointer is
still on — the dragged one, or the one it was folded into.

### Straightening, pruning, and the one button left

> **Straightening is an amount applied to the walls in front of the GM, since 2026-09-18, and the
> fitting tolerance is computed rather than chosen.** The passage below describes both as live sliders
> the derive read, which was true from 2026-09-14 until then. Read *Straighten and Prune became
> actions* in §10 for what replaced it; the history here is kept because it is what that change had to
> answer. **And Prune moved again on 2026-09-22**, from an amount to a ringed tool — §10's *Prune became
> a ringed tool*.

**Straightening and pruning were single live sliders, applied on every derive — 2026-09-14.** They
were a slider each under Walls *and* a button each in the editor, and crossing the save turned one
into the other without saying so. There was one control each, and changing either regenerated the
walls like any reading change: the mark said the graph holds work of yours, the dialog priced it, and
`editSimplifyFraction` is gone.

**What was wrong with that, and what it cost.** A slider the derive reads can only ever apply to a
fresh derivation — so turning it **discarded every hand edit**, which is the whole reason the group
carrying it had to be locked at all. The record already stated the cost as *"you can no longer tidy a
graph you have already hand-edited. Draw three walls, then decide to prune hairs, and the three walls
go with it."* That is the cost the change removes.

**What made the editor's copies necessary went with the save button.** Before the save the graph was
a derivation and turning a slider down put the detail straight back; after it the graph was the
document with nothing to re-derive it from, so a slider that pruned on release would have destroyed
work on a gesture as small as brushing the track. One surface, one rule, and the ratchet is gone with
them: turning either slider back down puts the detail back, because a derivation is not spent by
being redone.

**`simplifyWalls` and `pruneWallGraph` are unchanged and still do the work**, now from inside the
derive rather than from a button. What each is:

- **Straightening** (`simplifyWalls`) — Douglas–Peucker **per wall run**, which is what makes
  junctions safe without special-casing them: a run's ends are junctions or free ends by construction,
  and the fitter keeps both ends of what it is handed. **The collapse guard applies to CLOSED runs
  only** — an open wall is safe at any tolerance, since the worst it becomes is one straight segment
  between its ends, while a closed loop fits to a single point and the room disappears. Its crossing
  sweep is **total and quadratic**, because this touches everything and the "only what moved" argument
  offers no saving.
- **Prune the dead ends** (`pruneWallGraph`) — deletes wall runs with a free end shorter than a
  limit, cascading, since every arm of a junction becomes a dead end once its neighbours go. **The
  doomed runs are drawn in red while the slider moves**, in the same red the erase tool uses, because
  a limit is not a number anybody can picture on their own map — and Undo, which does take a prune
  back, only helps a GM who saw what went. The
  same setting takes four hairs off one map and a third of the walls off another. **`spurEdgesToPrune`
  is the question and `pruneWallGraph` is written in terms of it**, so the picture cannot lie about
  what the button does. **The handles go red too, and by a narrower rule than the walls**: only
  vertices that actually go, since the junction where a stub meets its wall keeps its other walls and
  stays put.
**Add walls around the map edge** (`addFrameWalls`) is the one button left, at the foot of Walls —
four segments at the map's extent as **one closed run**, so the corners are shared vertices by
construction. **It adds, so it asks nothing first**, which is also why it never needed the pair's
ceremony and why it survives them. **A second press is refused rather than absorbed**: four segments laid on four existing
  ones are collinear overlaps, which splitting cannot separate and which make Euler's identity fail —
  corrupt with nothing to see until the next traversal. **The already-framed test is strict on
  purpose**: a segment must lie *along* an edge, not merely touch it, because a single wall drawn
  corner to corner reaches all four edges and a looser test would call that map framed.

  There is no un-frame button, and none is wanted: once added they are ordinary walls, and the erase
  tool takes them a segment at a time.

**Pruning does NOT rebuild the raster**, and the alternative was measured and abandoned. Prune the
graph, rasterise the survivors, rebuild the graph: it works, and it leaves the sub-pixel-sliver
artefact on **181 of 400** generated seeds against **1 of 400** for a pixel-walking prune — because
deleting a whole edge takes one pixel further into every pruned junction. The table is kept because
"rebuild the graph and rasterise it back" is an idea that will occur to somebody again.

### The graph-derived tracks

> **These were the two *amounts*, not settings, from 2026-09-18** — nothing stores either value. Since
> 2026-09-22 only Straighten's is an amount (`wallAmounts.ts`); Prune's is the length its rings are
> searched at (`pruneControls.ts`), with the same top and the same floor. The measurement below is unchanged and still live; what went
> is the storage, and with it the cap at a declared ceiling that a stored value needed. Read *Straighten
> and Prune became actions* in §10 first.

Both simplification and pruning act on the graph, which outlives any reading and so has neither a
raster nor an ink width of its own. **The answer is to denominate the value in graph units, and
to measure the top of the slider's track off the graph itself.**

- **A log scale**, from a **pinned floor** — a small length in graph units — to a **graph-derived top**:
  the longest wall run for pruning, the largest bend for simplification, re-measured when the tool
  opens and held for that opening.
- **The floor is PINNED, not the observed minimum**, and the reason is sharp: **both tools delete from
  the bottom**, so the minimum is the most mobile quantity there is. Prune at limit B and the shortest
  surviving run is B. A tracking bottom would chase the slider upward every time, and "30%" would mean
  a larger bite on each pass — the same non-monotonicity that collapsed the two-slider gap design.
- **The far left is a literal zero**, so the tools are exactly off rather than doing a little work at
  the floor. **Keyed on the POSITION, not the value**: keying on the value makes the floor a sentinel
  meaning two things, and since the scale snaps to three significant figures, whether a low position
  collided with the floor would depend on the leading digit of the floor constant.
- **The floor is a new field on the limits, NOT `min`, and that is forced.** The settings normaliser
  clamps a stored value into `[min, max]`, so a positive `min` would raise a stored zero to the floor
  on every read and destroy the off state where nothing is watching.

**A fixed ceiling cannot work here**: two maps of the same pixel size carry 3px or 12px linework, and a
ceiling generous enough for one puts the whole useful range of the other in the first percent.

**These are the exception to "a threshold that moves with a measurement changes the result invisibly",
and it is worth saying why it is not one.** The *stored* value is an absolute length and nothing
moves it. What is measured is the **top of the track**, so a re-measurement moves the handle and never
the setting.

Three details that were each learned the hard way:

- **The prune track's top is the longest wall RUN, not the longest spur.** Measuring only runs that have
  a free end *today* means a run that sits between two junctions was never counted — and the cascade
  frees exactly such runs on later rounds, so at the far right, where a GM reasonably expects every
  dead end to go, those are the walls left standing. No run can be longer than the longest run, so a
  limit there reaches anything the cascade ever frees, while staying a real measurement. It must be
  the *run*, not the longest segment, because pruning removes a whole run at a time.
- **`largestBend` is per VERTEX, not per wall** — how far one point sits off the line joining its
  neighbours. A whole wall's deviation from the chord between its ends is dominated by the exterior,
  which departs from its own chord by something like half the map, and every useful setting would sit
  in the first percent.
- **The measured top is capped at the declared storage maximum.** Without that, a map whose measurement
  overshoots hands back a value the normaliser silently clamps on the next read — a setting rewritten
  with nothing announced, which is the failure the round-trip tests exist to prevent. **And the
  measurement is rounded up** to the scale's three significant figures, or the far right fails to reach
  the very run it was measured from.

**A release that did not move the handle writes nothing.** With a moving top, `fromSlider(toSlider(v))`
is no longer exactly `v`, so a drag away and back would otherwise rewrite the setting.

**One key for simplification, since 2026-09-14.** There were two — `simplifyFraction` and
`editSimplifyFraction`, as they were then named — on the argument that different defaults is what says two things are
different settings. That was true while the editor applied its own by a button against a document
with nothing behind it. With one live slider the ink mode's answer is the only one: a *fitting
parameter*, re-applied on every derive, whose sane non-zero start is what stops a fresh map producing
a graph too large to write.

**The default is seeded per map, because a fixed one is not map-independent.** 4e-4 of the longer
side is 1.3px on a 3300px map and 0.30px on a 751px one — sub-pixel, so very nearly no simplification,
and on that small map it produced a graph too large to write. So once a reading lands, a tolerance
still at its static default is set to a quarter of the measured ink width, converted by raster pixels
per graph unit; `seedDefaults.ts` carries why seeding a start is not a threshold moving with a
measurement.

**Both keys were renamed on 2026-09-16**, to `simplifyGraphUnits` and `spurPruneGraphUnits`, when their
unit changed from a fraction of each side. The rule is that a unit change is a rename and never a
reinterpretation, so a stored value falls back to the default rather than being read in the new unit;
resetting both sliders on every map was accepted (user).
---

## 6. Emitting

**There is one operation: push.** Delete our old fog items, then write the current result onto `FOG`.
No staging, no proposals, no accept step, and no refusal to write over an existing set.

Staging used to exist because judging a partition meant writing a few hundred shapes into the scene
and looking at them, and because a first run had to be unable to affect play. Judging now costs
opening a step on a surface that draws the partition and the walls **exactly as they will be emitted**,
so the layer was answering a question nobody has to ask. Removing it also finished §3's decision: the
graph is the document, and staging was the last place still treating the scene as working state.

### What goes out

- **One filled `PATH` per face not suppressed**, on `FOG`, `visible: true`, `fillOpacity: 1`,
  `fillRule: "evenodd"`, no stroke.
- **One `LINE` per segment of every wall no emitted face boundary covers** (§3's bridge criterion), on `FOG`,
  `visible: true`, no fill anywhere, at the scene's own fog stroke width and colour.

**A fitted polyline of n points becomes n − 1 items**, so a wall is several Outliner entries and
nudging one segment in Owlbear moves only that segment.

**Every emitted item carries a key under `io.github.captainchocolatedessert.fog-nudger`.** Provenance
is load-bearing: removing and re-running both need to find exactly our items and never the GM's.

### Delete first, then write

The alternative — writing before deleting, so the map is never briefly unfogged — was rejected on the
better argument: **a fog layer holding nothing fogs everything**, so the gap is safe, while
overlapping duplicates of every shape is a state nothing here is designed for.

> *If a push is ever seen to flash the map visible, that premise is wrong and inverting the order is
> the whole of the fix.*

### When a push happens

- **The workspace's *Put on the map*.** The mid-session case — a change a table is waiting on, made
  without giving up the surface. It is also where the item-budget warning stands.
- **Closing**, when something changed. The fingerprint is the map plus every setting plus the encoded
  graph, held in memory; losing it costs one unnecessary push, which is the safe direction.

**There is no save button, and closing commits — 2026-09-14.** *Put the walls on the map* stood at
the foot of Walls and was the crossing into editing: it wrote the derived graph to metadata, pushed
it, and confirmed what it would replace.

**What replaced it is that the commit is caused by the edit.** The wall tools act on the graph that
is **drawn** rather than on the stored one, so a map that has been read can be edited straight away;
and the first edit that changes something adopts the derivation as the document, because that is the
moment a document becomes necessary. The store writes the base and the document in one
`setMetadata`, so a first edit costs one scene write rather than two.

> This is the rasterize moment from a drawing program, and the point of borrowing it is *where the
> dialog goes*. Nothing asks you to commit before the brush will work; the commit happens because you
> used the brush.

**Closing used to commit nothing, and that rule was about the button.** While one existed, *not
pressing it* meant something — so a GM who opened stage one to look at a threshold and pressed Escape
had not replaced their walls. With no button the same behaviour is only a GM tuning for twenty
minutes and getting nothing, which §7a already named as the thing to fix. What made the old rule
necessary is handled elsewhere: **a graph carrying hand edits keeps the screen**, so a derivation can
never be adopted over work the GM can see.

**The modal is dismissed before a closing write, not after.** Waiting would leave a GM staring at an
opaque sheet that has stopped responding for the seconds a large map takes. **`pushOnClose` never
rethrows**: the way out of a full-screen sheet cannot depend on a scene write.

### The escape hatch

Owlbear gives a scene write about five seconds, and a large enough push saturates the message bus —
observed at 5,881 wall segments, where `OBR_SCENE_ITEMS_ADD_ITEMS` timed out repeatedly and eventually
even `OBR_SCENE_IS_READY` did.

**`withEscapeHatch` wraps every write**: after a few seconds it says what is happening and reveals a
button that requests a stop. **Three things about it are deliberate.**

- **It stops the write and reports; it closes nothing.** Only the caller knows whether stopping meant
  *leave* or *give me the surface back*, so closing reads the answer and goes anyway while a button
  reads it and re-enables itself.
- **The label is the caller's.** "Exit anyway" is right when leaving is what happens next and a lie
  when it is not, so a button-driven push says **Stop writing**.
- **A stopped push does not hand off.** Pressing stop during *Edit the walls* stays put and says the
  map is partly written. The graph is saved either way, because it is built before the push.

**The stop is cooperative and lands between batches**, leaving the partial set rather than rolling
back — which is safe precisely because the next push deletes all of ours before writing.

**All three in-workspace pushes lacked the hatch and only closing had it**, which was backwards:
closing is the one case where the GM is already leaving, and a button is where they are stuck
watching. Every push routes through one place now, so there is one set of terms rather than three call
sites drifting.

### The item budget

**A warning stands in front of *Put on the map***, naming the item count and pointing at the slider
that reduces it. **It does not stand in front of closing**, which also pushes: a dialog in the way out
is one a GM meets while leaving, and a write that will not finish already has the escape hatch — a way
*out* of the problem rather than a question about it. Its threshold of **1,500 items is provisional and calibrated on two
observations** — 274 items writes in a couple of seconds, 5,881 cannot be written at all — and nobody
has bisected between them.

**It warns and does not refuse**, because it is a prediction about a scene rather than a measurement of
one.

**Shapes have the command cap and escalate the tolerance to fit; wall lines have no equivalent at
all** — and at a tolerance of zero the escalation ladder cannot even start, because doubling zero is
zero. That is the gap the warning stands in for.

---

## 7. The surfaces

> **This section is a historical record.** It describes the surface as two modes with an exclusive
> accordion, and **none of that exists**: the modes merged, the accordion became a rail, the rail
> became a drawer off the tool strip, and the save button between the stages was deleted. It is
> kept because the reasoning in it is what each later shape had to answer — read
> [§7a](#7a-the-surface-redesign--built-and-judged) for what is true, and treat every "is" below as
> a "was".

**One page, two modes**, chosen by `?mode=` on the URL and by which of two panel buttons opened it.
The shell, the accordion, the map loading, the transform and every layer are shared; `steps.ts` gives
every step a `modes` field.

- **Ink mode** — *Map*, *Ink*, *Walls*.
- **Wall editor** — *Edit walls*. (The group is deleted; §7a and §10 carry where its contents went.)
- **View**, a persistent group in both, outside the accordion and never entered.

### Why the workspace is a full-screen modal

**A modal without `disablePointerEvents` owns its input completely** — measured over fifteen runs.
Pointer, wheel and right-click all arrive and **Owlbear's viewport never moved once**, against a
detector that deliberately moves the viewport to prove it can see one. Every wheel event is
`cancelable`, so a zoom can be stopped.

That is what makes the whole design possible: **the map and the mask go into one canvas under one
transform**, so they register by construction rather than by our arithmetic agreeing with Owlbear's.
It opens on Owlbear's current view, so nothing jumps when the sheet goes up.

**The click-through overlay it replaced is deleted**, and with it the viewport poll, the settle
interval, blank-and-restore, the clip band and the panel's presence heartbeat — every one of which
existed only because that sheet did not own the transform.

**Drawing costs nothing worth measuring.** 1,202 frames with two map-sized layers drawn every frame:
0.1ms mean, 1.0ms worst, against a 16.7ms frame. Display-bound, not draw-bound.

**Three things about input that bite:**

- **The keyboard is taken, not given.** Nothing reaches the modal unasked — fourteen runs, including
  one where nine digits were typed and none arrived. `window.focus()` plus focusing an element claims
  it on the first try, ~16ms in. Until then every keystroke goes to **Owlbear's page** and does
  whatever it does there, invisibly, under an opaque sheet.
- **Escape belongs to whoever holds focus.** Unclaimed, Owlbear closes the modal itself and our handler
  never runs.
- **`hidePaper` / `hideBackdrop` change nothing under `fullScreen`.**

**No dismissal timer.** The retired probes had one because an opaque sheet that might swallow every
click was a trap while input capture was unmeasured. It is measured now, and evicting a GM mid-tuning
would be a certain cost against a retired risk.

#### The wheel: three intents down one event

Measured over 1,200 events, and **Owlbear behaves identically**, so matching it is free.

- **`ctrlKey` means pinch** — a browser convention, not a guess. A `deltaMode` other than pixels means
  mouse; a coarse integer purely-vertical pixel delta means mouse. Everything else is a two-finger
  scroll and means pan.
- **A pinch scales with its delta; a notch must not.** A notch's magnitude is arbitrary — browsers send
  3, 100 or 120 for one physical click — while a pinch's is the fingers actually moving. Settled
  constants: **12% per notch, 1.00% of zoom per trackpad pixel.**
- **A two-finger scroll is axis-locked if the gesture begins along an axis** (163 x-only and 413 y-only
  against 624 diagonal), applied upstream at gesture start and unfixable from JavaScript.
- **A pinch never carries a pan.** 291 pinches, zero with a horizontal delta, zero interleaved with a
  scroll inside 200ms. So pinch-and-drag together is not available.

Click-drag panning has no such lock, which is the workaround — and the reason **Ctrl-drag pans in every
step**, since a plain drag is the brush in some of them.

### An exclusive accordion, not tabs

Each step paints something different on the canvas **and** gives a drag a different meaning, so two
open at once would be a lie. Collapsing sections *imply* two can be open; enforcing exclusivity removes
the implication and adds two things: **every header stays on screen**, so the ordering is a shape
rather than something to remember, and a **tall narrow column** is what vertical stacking suits.

**At most one open, not exactly one — clicking the open header closes it.** This is the one thing an
accordion can do that a tab strip cannot, and it was missing at first: some step was always open, so
its layers were always on the map and its controls always over part of it. **On a surface whose whole
job is looking at a map, being unable to see the map plainly was the state it most needed and did not
have.** Nothing open is a coherent mode — no layers, plain pan — and every listener is told, which is
also how a paint mode in progress gets finished and written rather than abandoned.

**The cost:** a header is a weaker "you are here" than a selected tab. Answered with accent colour and
an edge mark.

### The steps

- **Map** — the picker, and it **gates the rest**: until an image is loaded every step below is dimmed
  and its header disabled, because they are about a picture that is not there. A locked step cannot
  stay open either, so nominating a different map drops the GM back to Map.

  **Map shows no layers on purpose**: its question is which image, and a mask on top would answer the
  next question over it.
- **Ink** — colour and opacity, then what counts as ink, then a **Linework** sub-heading for the two
  ink filters, then a tool picker: **Suppress**, **Add ink**, **Gaps**. The picker names the *layer*,
  and paint-versus-erase is a pair inside whichever brush is chosen.

  **Both paint layers are open at once.** Entering Ink takes a working copy of each, either brush
  writes into its own, leaving writes both. Keying the mode to the *tool* would have put a scene write
  — about a second — between every flick from one brush to the other.

  **Clicking the chosen tool puts it down**, which is the state where a plain drag pans. That is what
  keeps the sliders above usable without holding Ctrl.
- **Walls** — spur pruning and edge smoothing, drawing the **fitted graph** over the partition over the
  ink. The last thing the ink mode shows and the first thing the editor shows are one picture, because
  both come from the same build.
- **Edit walls — gone (user, 2026-09-14):** *"Edit walls can disappear."* It emptied out rather
  than being cut. Its tool picker went to the strip, its straighten and prune buttons went when
  each became one live slider, and its push went to the bar — leaving a group whose whole content
  was one button that adds four walls. That button is at the foot of **Walls** now, with the two
  sliders that shape the same graph.

  **The rail and the tool strip now agree one for one** — Look, Ink, Walls — which was not
  designed and is worth keeping.
- **View** — preview fill and outline. A control describing a layer that *two* steps draw cannot live
  with "its" step, and a group that is never entered answers that objection rather than reintroducing
  it.

### Layers

A layer is drawn because the open step asks for it, by name. Each step has its own display style —
with **one deliberate exception**: `paint` is drawn wherever the ink is, because a picture of the ink
that omits the GM's edits is a picture of something that no longer exists downstream. Amber for ink
taken away, cyan for ink put in, both at full alpha. (The ink itself is solid too now — its opacity
control was removed on 2026-09-09, and with it the case where the two could differ.)

**The ink layer draws the BASE, not the composite.** Handing it the composite would make invented
pixels indistinguishable from read ones.

**The regions layer sits below the graph in the canvas stack**: a fill drawn after a two-pixel line
covers the thing being judged.

**Wall lines are blue and cased** — a white stroke two pixels wider under a saturated core. A
centreline lies exactly on top of the map's own linework, so a dark line is invisible; a room once
reported "no stubs showing" when all 22 were being drawn.

**The rooms layer no longer draws the emitted wall lines** (user, 2026-09-15). It stroked the walls
that emit as `LINE` items — the bridges — in red over the fills, so that the preview would not show
*fewer walls than the push writes*. That reason held while the graph layer appeared in one step only;
with it on always and drawing every wall, bridges included, the preview shows all of them regardless.
**And it read as a fault**: turning the Walls layer off left a great many walls on screen apparently
changing colour, because two layers were drawing walls and one of them was switched off. What is lost
is which walls emit as lines rather than as ring boundaries — an emit-path distinction, drawn over
the one thing that layer exists to show.

**The preview draws wall lines at a fixed 2 screen pixels**, not the fog stroke width. That is settled
rather than outstanding: it is a **preview** affordance, and what a GM judges there is where a wall
runs rather than how thick it will be.

**Handles are capped on what is *visible*** — 2,000 on screen, rather than on the graph's size — so
zooming in to work brings them back and zooming out leaves the linework readable.

### The parameter axes — four, and they must not be conflated

| axis | asks | read by |
|---|---|---|
| `PARAMETER_STAGE` | what does a change **destroy** | cache invalidation, the recompute cascade |
| `PARAMETER_KIND` | what does a change **recompute** | the mask fingerprint (`pipeline` alone) |
| `POST_READING` | which **half of the reading cache** does it touch | the reading fingerprint |
| `PARAMETER_STEP` | **where** does the control appear | the accordion |

**The stages are the cascade, and destruction flows one way:**

1. **read** — what is ink. Re-partitions wholesale and discards the later stage.
2. **adjust** — destroys nothing.

> **There were three until 2026-09-18, and the middle one is deleted.** `derive` meant *abstracting the
> ink into shapes*: regenerate every polygon, discarding hand edits but not the reading. Its documented
> evidence was that a minimum-area filter is **not a pure delete** — a hole is kept only when it
> encloses a surviving region, so dropping a sliver dilates whatever surrounds it, measured at 15 holes
> kept against 51 at another threshold. **That control was deleted on 2026-08-30**, which left the
> simplification tolerance as the rung's only member; when that stopped being a setting the rung had
> none.
>
> **A stage with no members claims an ordering it does not have**, which `stages.test.ts` refuses, so
> the rung came out rather than the test being relaxed. Every setting that remains either changes what
> the ink is or destroys nothing.
>
> **The evidence above is still a good argument** — it is why a minimum-area filter could not be filed
> under `read`. If such a control ever returns, the rung returns with it.

**`PARAMETER_KIND` is `pipeline | display | tool`**, and the third is not a synonym for the second.
`display` here does not mean "about appearance" — it means the answer to *what does a change
recompute* is **nothing**. A brush width is `display` in that sense, because what is stored is pixels
rather than a recipe, so a stroke keeps the width it was painted at. **What distinguishes `tool` is
behaviour**: a `display` control stays live wherever it applies, and a `tool` control is closed when
the tool it belongs to is.

**`tool` controls apply live on drag**, in memory only — the scene write still waits for the release,
and so does anything the tool must *recompute*. **`pipeline` must never join them**: its re-read is
690ms and synchronous, which is 690ms the slider cannot move.

**`PARAMETER_STEP` is a COVER, not a partition.** A parameter may name several steps, and one does:
the spur limit, which both modes draw. What is asserted instead is that **nothing appears twice within
one mode**, which would be two handles on one setting.

**What the axis test can and cannot pin.** It asserts each declaration is **total on its own**, since
the only way to classify a parameter with no entry is to guess from a neighbouring axis, and every such
guess is silent. It asserts stage, kind and the reading boundary are each independent of the step. It
deliberately does **not** assert that step cannot be recovered from stage — which direction happens to
be a function is a fact about today's sixteen parameters and moves whenever the sections do.

**The stored metadata shape was NOT renested to match the stages.** It keeps its own groups and the
mapping carries the semantics. Renesting means a migration or a normaliser that resets a GM's whole
tuning, which is the failure the round-tripping tests exist to prevent.

**Settings live in scene metadata, read through a TOTAL normaliser**: it clamps rather than rejects and
falls back per field, so one bad key cannot discard the rest.

### Deriving is lazy

A reading marks the partition stale; rebuilding is visible in one step, so **entering that step is what
pays**. A slider release consults `PARAMETER_STAGE` to decide which cycle it triggers — the cascade, not
a third list.

~~**The prune limit has a fast path.**~~ **Gone 2026-09-18.** The built graph was kept, so a limit
change cost a run walk and a traversal rather than a full re-derive. Pruning is an amount a GM presses
now, not a parameter, so nothing dispatches here — and the whole graph-only recompute target went with
it. The cheapness was real and would be worth rebuilding if a graph-only *parameter* ever returns.

**The partition's source is the MODE, not the presence of a stored graph.** Reading a stored graph in
the ink mode would show the GM the rooms as *edited* while they moved sliders that do not produce them.
Equally, **a stage change re-derives only in the editor**: in the ink mode the rooms come from the
reading whatever is stored, so a re-derive after a save would cost a full trace to arrive at the picture
already on screen.

### The map picker

**Everything on the `MAP` layer is offered, and the largest by world area is the default.** Four rules,
each a reversal of something more clever:

- **No filter, no mark.** An area heuristic used to flag anything under a quarter of the largest as "too
  small?". The sizes are on screen and the GM can see the picture, so the mark was an opinion offered
  where the evidence was already in view.
- **No *Auto* row.** It named a policy that decided later, which a GM cannot check. Every row is a real
  image, and the one that would be traced is simply the one that starts selected.
- **No refusal.** Two comparable images used to produce *nothing at all*, on the grounds that the wrong
  one might be a GM overlay. That was written when a wrong guess was **invisible**, from a popover with
  no picture. The workspace inverts it: the chosen map is drawn full-screen, so a wrong guess is evident
  and one click from being fixed.
- **Pixel sizes, in z-order.** The size is the image's own resolution — the figure a GM can match
  against the file they imported. The order is the stack, bottom upward, so the base map comes before
  whatever was laid on top of it, and scaling an image does not make rows move under the cursor.

**The ranking is world area, not pixel count**, because "the map" means the thing covering the most
ground: a small image blown up to fill the table is the map, and a crisp 4000px inset of one room is
not. **One function decides it, read by the picker and the resolver alike** — two functions deciding
separately would show one map selected while tracing another.

**A stale nomination is reported, never cleared.** If the scene no longer contains the nominated image
the resolver falls through to the largest, and the picker **says so under the rows**, because "you
chose this" and "your choice is missing, so we picked the largest" otherwise look identical. It is not
cleared because writing to metadata unasked is the thing this project does not do — and here it would
also be *unsafe*, since the map list is briefly empty while a scene loads.

### Painting is a mode with a Done

Entering a step takes a working copy, the brush edits that, finishing writes once and recomposites
once. A scene write is about a second, so per-stroke writes were never possible.

**Leaving any other way saves rather than warns**: switching step or closing the workspace finishes
exactly as Done does, which is what keeps *nothing on this surface is ever lost by navigating away*
true. Discard is the only control that throws work away.

**A stroke does NOT blank the surface, and this is the one change that may not.** What the ink layer
draws is the *base*, and paint composes strictly after it, so painting cannot change the picture on
screen. Nothing goes stale, so blanking would remove the GM's own map for a recompose in exchange for
nothing.

### Sliders re-read on release, not live

Tried live, reported unusable from a room, reverted. **The re-read is synchronous**, so its 690ms is
690ms the slider cannot move, and cancel-and-retry can never fire because the work it would cancel
holds the thread. Live needs a worker or a crop-to-viewport — **measure the real cost first, then
choose**.

The coalescing is not the problem and is still there: it blanks on change, keeps only the latest value,
and drops a superseded answer.

**The mask stays up while a slider moves**, which is not a violation of the blanking rule: it is the
last reading the GM *applied*. Blanking there means adjusting blind. The state line says the slider is
ahead of the map.

### The panel

**Three buttons**: *Open the workspace*, *Remove ours*, and *Clear everything*. One mode, so one door,
and nothing else that acts on the scene.

**The two destructive ones differ by how far they reach.** *Remove ours* takes our items and the saved
wall graph, leaving the reading settings, both painted layers, the suppression marks and the map
nomination — so a map you have painted on still composes your old strokes on the next read, and a
region you marked is still suppressed once walls are derived round it again. *Clear everything* is the start-over:
the scene as though the extension had never run.

**It lives here rather than on the workspace**, and the argument that decided it is that the workspace
is the thing being reset — a reset inside it is unreachable in exactly the case that needs it, a
workspace that will not open because of what is stored. **It finds what to take by namespace rather
than by a list of keys**, so a key written by a build whose name exists nowhere in the current code
goes too, which is what a GM starting over means. The predicate that decides is the most dangerous
line in the extension — it runs in a scene holding the GM's own fog — so it is pure, in
`namespace.ts`, and tested; the separator is load-bearing, or a neighbouring extension whose id merely
begins with ours would be caught by it. **It is the one control here that undo does not reach**, which
is why it is also the one place "this cannot be undone" is true.

**The diagnostics band went on 2026-09-09** (user): *"Remove everything except open and remove ours…
we haven't used them in a long time."* It held *Trace, emit nothing*, *Inspect fog* and the three
workspace-probe buttons. **Every function behind them is still exported and unchanged** — the import
block in `panel.ts` is the list of what they were and what to know before re-wiring one, and a button
is that import plus one line plus the markup.

Two of the five had also stopped being true, which is why this is not purely a tidy-up:

- *Trace, emit nothing* justified itself by running exactly the emit path's code, so its numbers and
  the scene could not disagree by construction. **The wall graph becoming the document ended that.**
  `pushToFog` emits the *saved* graph and calls `runTrace` only when a map has none — so on any map a
  GM has actually worked, the dry run described a graph that was not the one on the map. It has a
  live substitute in any case: the workspace logs the identical `runTrace` summary on every derive.
- The *workspace probe* asked whether a full-screen modal without `disablePointerEvents` is usable at
  all. The workspace has been running on that combination for weeks, which answers it. Its **leak
  detector** is the part still worth having, and is why the page and its control are kept.

*Inspect fog* is the one that left on the band's coat-tails rather than on its own merits: it is still
entirely true, and still the only thing that says what is on the `FOG` layer, ours against the GM's.
**It is the first to bring back if a scene ever looks wrong.**

**Remove ours drops the fog AND the stored graph.** On its own it would be half a removal, since the
next save from either surface would put the same walls straight back.

### Draw the control yourself

**A native popup opened from our iframe paints against the SYSTEM background, not the page's.** Measured
the expensive way: an early map picker was a `<select>` whose options rendered white-on-white and looked
empty, because a 12%-alpha border colour stopped being a dark grey the moment the list escaped the
iframe.

Explicit opaque option colours would fix that one symptom, but a native popup inside a sandboxed
third-party iframe is a rendering path we neither control nor can style reliably. **So we draw the
control ourselves** — the map picker is a list of radio rows — and it also happens to be better for
its job, since choosing a map is a *comparison* and a dropdown hides what you compare on.

**The ink colour was the second example and no longer is** (2026-09-13). It was a row of preset
swatches with the native `<input type="color">` beside them; the presets went so that ink is a colour
row like the other four, leaving the native control alone. That is the one place this argument is now
*not* acted on, and it is worth knowing which way the risk runs: if a GM ever reports the colour popup
rendering unreadably in their browser, this passage is the reason why, and presets are the remedy that
was removed.
---

## 7a. The surface redesign — built, and judged

**§7 above describes the surface as it was before this**, and is kept because the reasoning that
produced it is what this had to answer. The pipeline, the emit path and the storage are untouched;
this was a rework of the surface only.

**All of it is built**: the tool strip and its glyphs, the rail (**a drawer since 2026-09-14** — see
below), one page with one panel button, undo, the derive indicators, the markup palette, the layer
toggles and the colour pickers.

> Two things in this list were **removed** rather than built on: the **pinned rail head**, whose shape
> survived into the drawer as four fixed children with three hidden and had to be cut back to one
> slot; and the **hand-edit count**, replaced by a mark with no number and, at the moment a rebuild is
> offered, the delta drawn on the map. A number could not survive a session anyway — it lived in
> memory, so a map edited last week opened at zero.

### Two lessons the first room taught

**An exported symbol nothing reaches can be the defect rather than dead weight.** `toolPalette`
exports an `onToolChange` hook and nothing subscribed to it, so choosing a tool set the state, redrew
the strip and invalidated the canvas while the rail kept whatever body it was last given — the tool's
controls were built correctly and never drawn again. The unreachability *was* the bug, and a
reachability sweep that deleted it would have made things worse.

**The rail body is about the map; the pinned head is about the hand.** What counts as ink is a setting
of the document; how wide the brush is, and whether it covers or uncovers, belongs to what you are
holding. That is why a tool's controls sit in the head — they were at the foot of the Ink step, which
needed the section expanded, a tool selected and a scroll to the bottom, all at once, and were
reported simply missing. The head already carried the tool *hint* on exactly this argument and had
stopped one step short of the controls it described. **The cost:** the head grows while a tool is
armed, and that space comes off the scrollable rail.

> **It has been judged, and it held.** Two sessions went through the whole surface — the rail, the
> strip, the tools, the wall actions, the panel — and what came back was fifteen faults, every one a
> detail rather than a disagreement with the arrangement. Nobody asked for the modes back, for the
> accordion to force one section shut, or for the verb to leave the strip. **The redesign's own
> question is answered: the shape is one a GM wants.**

**That known cost is paid** (user, 2026-09-09): *"most items don't need any description at all. Let's
see how far we can get just with good naming."* Roughly 1,400 words across the rail and the panel came
down to about 250.

### The rule for UI text, and what it kept

**A line of description survives only if it says something the label and the readout beside it
cannot.** The readout is half of that and is easy to forget: most sliders already print their value in
a unit a GM can feel — *"12px, 0.24 of a square"* — which is what most of the deleted sentences were
restating in words.

**A readout is held to the same rule as a sentence: it must be true.** The example here used to be
the stroke filter's *"under ~4px goes, ink is 3.2px"*, and that line went on 2026-09-16 with every
other readout quoting the measured ink width (§10, decision 3). Nobody had looked at them while
tuning, and what they quoted was an estimate.

**Where a name was doing too little, the name changed rather than being propped up.** The old note in
`controls.ts` defended a hint on every control on the grounds that a direction is not guessable —
raising Sauvola's `k` finds *less* ink, and "sensitivity" suggests the opposite. That was right about
the problem and wrong about the fix. The control is **Ink strictness** now, and a stricter threshold
finding less ink needs no explaining. Likewise **Longest dead end to remove** for the spur limit,
because *spur* is this document's vocabulary and not a GM's.

**The frame button is the one case where naming the point turned out to be wrong**, and it took
three names to find out. *Wall the map's edge* was rejected as a mechanism with its point left to
four sentences underneath; *Make the outside a room* named the point and was doubted twice in
rooms; it is **Add walls around the map edge** now (user, 2026-09-14): *"The user may not think of
that exterior in terms of a room."* The lesson is narrower than "name the point" — a point that
is only one of several reasons a GM might press the button is not a name, it is a guess at their
intent.

Three things kept their text, and each for a reason that generalises:

- **The tool sentences.** A tool is an inline glyph in a strip with a tooltip, so the pinned line at
  the top of the rail is the *only* thing on screen saying what a press does and which modifier
  changes it. `steps.test.ts` pins that every tool is still explained by its own hint or by the blurb
  of the group it reveals — the one place this cull could have removed the last copy silently, since
  an empty hint slot collapses and looks like a tool with nothing to say.
- **Warnings on the actions that lose work** — which turned out to be one, not three. The save button
  is the only control in the rail whose *absence* costs the graph, and its warning is true. **Prune and
  straighten kept "It cannot be undone" through this cull and it was false**: both are saved like any
  hand edit and sit on the undo history — the Undo button's own doc names *"Undo pruning the dead
  ends"* as its example. Found on 2026-09-10 and removed; the prune confirmation now says *"Undo takes
  it back"*. The cull kept the one sentence on those buttons that was wrong, which is worth knowing
  about any rule of the form "keep the warnings": check that the thing warned of still happens.
- **Two hints**, on the gap controls: that a proposal is ringed and not applied until accepted, and
  which way the same-wall distance leans. No name found says either.

**The tests were inverted, and that is the change rather than a relaxation.** `controls.test.ts` used
to demand a non-empty hint from every control and `steps.test.ts` a non-empty blurb from every step —
which is a suite making the prose mandatory and the naming optional. Both now name the exceptions
exactly. A cap was tried first and let a third hint through under mutation; naming them means adding
one fails and has to be argued for.

**The cost, stated: the Gaps tool no longer teaches.** Its seventy words spent most of themselves on
*why* a four-pixel crack matters — that a severed wall merges two rooms, which is the worst thing this
tool can get wrong and the best argument in the product. What is left says what a press does. A
first-time GM does not meet the argument anywhere now, and **whether that costs anything is a question
only a room can answer.**

### Why: the mode boundary runs across the grain of the task

The real work loop is *look at the rooms → spot a merged one → realise it is an ink problem → fix the
ink → look again*. That crosses the ink-mode/editor boundary twice per iteration, so the boundary sits
across the grain of the job. Two panel buttons are a symptom rather than the disease: the modes are
separate **pages**, so entry needs two doors.

**And the thing the boundary protects is real but modelled as a place.** Re-deriving destroys hand
wall edits — true, and not fixable. But that cost exists only *if there are hand edits*, and today the
ceremony fires on crossing the boundary whether or not anything is at stake.

> The irreversibility is not "you are in stage two now". It is **"this graph contains work that is not
> in the ink"** — a property of the document, and exactly computable: has any editing operation been
> applied since the last derive?

**The accordion is straining because it does two jobs.** It is a *navigator* (which controls am I
reading) and a *mode selector* (what does my drag mean). Navigation wants to be cheap and
non-exclusive; mode wants to be exactly one thing. Where they fail to coincide, escapes had to be
added: the nothing-open state, the no-tool state, and Ctrl-to-pan-anywhere.

### The one structural move

**Separate what a drag does from what controls you are reading.**

- **A tool palette** — always visible, every tool in it, banded by what it acts on: navigate (pan,
  probe), ink (suppress, add, gaps), walls (collapse small regions, prune, straighten, mend, move, draw, erase, dissolve region, suppress region, span). One click to switch, and switching a
  tool does not move the controls.
- **The controls drawer** — the same groups in the same cascade order, **one at a time**, opened by
  the group's own name in the strip. It slides out **beside** the strip rather than under it, is only
  as tall as it needs to be, and sits **level with the button that opened it** — so the strip never
  moves, the map stays visible above and below it, and the thing you pressed and the thing that
  appeared are plainly the same subject. The tool in hand draws its own controls at the top of it,
  where the pinned rail head used to be.

  It was a scrolling rail with every group present at once, and it became a drawer on 2026-09-14
  (user: *"let the buttons slide out drawers with their content when pressed"*). **That is not the
  old exclusivity coming back.** The accordion was exclusive because a step bound the *drag*, so
  two open steps were two meanings for one press; the drawer is exclusive because there is one
  slot, and every group is one click away in the strip rather than a scroll away in a column.
  Switching what you read and switching what your drag does are still separate gestures, which
  was the whole of the complaint.

  **The ordering still teaches itself, and the strip is what teaches it now** — Look, Map, Ink,
  Walls, View down one column, with each group's verbs under its own name. The numbered rail is
  gone and nothing was lost with it, because the column *is* the order.

  **Two costs, stated.** Two groups can no longer be read side by side; the live counts moved to
  the bar to cover the main case, and comparing two sets of numbers at once is gone. And a group's
  controls are behind a press rather than a scroll, which is cheaper to reach and easier to forget
  is there.

- **Two selection groups, one column.** A **panel** opens a drawer; a **verb** arms a drag; neither
  disturbs the other. Borrowed from Procreate, which mixes the two in one strip and is not read as
  a category error precisely because tapping *Adjustments* does not put your brush down.

  **A third kind joined them on 2026-09-20 and is not a selection group at all**: an **act**, which
  is the two clear buttons at the foot of the Ink and Walls bands. It opens nothing and arms
  nothing, so there is no state for it to be in and it never draws pressed — which is the
  distinction doing the work, since nothing else tells it from a verb. §10's clear family carries
  why they are here rather than in a drawer.

  **They do not need to be told apart, and that is why mixing them costs nothing** (user,
  2026-09-15): *"You click on what you want and it might open a drawer of settings or it might pick
  up a tool. The two being mixed isn't confusing to me."* The column is a list of things to press,
  and what each one does is its own business. Two highlights at once are two true statements — one
  drawer is open, one tool is in hand — not an ambiguity anything has to resolve.

  **This corrects what this section used to argue**, and the difference is worth keeping. It claimed
  the two were told apart by *shape* — a panel a word, a verb a glyph — and that the shape was what
  **paid for** two things being lit in one column. That treated the mixing as a debt. It is not one:
  the answer is not a better distinction but that the question does not arise.

  The shape distinction was real until 2026-09-14, when *One drawer per thing pressed* made the group
  opener a glyph like the verbs and left the caption an unpressable word. Its pressed state — an
  underline rather than a fill, written *"so it cannot be mistaken for the armed verb's pressed glyph
  two rows down"* — went with it, and the stylesheet kept the orphaned rules until 2026-09-15.
  **Measured the day they were deleted**: a pressed panel and an armed verb compute to the same fill,
  the same text colour and no box-shadow on either. Nobody had raised it in the rooms between.

  **One exception, and it is deliberate** (user, 2026-09-14): opening a panel puts the verb back to
  **Pan**. The verbs here are little fixes where the parameters are the main event, so a GM who has
  gone to read a group is about to look around rather than keep painting — and an armed brush under
  an open panel is a press waiting to happen. It also settles the collision cleanly: a tool's own
  controls and a group's controls can never both want the drawer.

  **Nothing open is still a state**, and a better one than before: pressing the open group's button
  again shuts the drawer entirely and the strip slides to the window edge, leaving the map plain.
  That used to be a hard-won exception to the accordion; it is now what the mechanism does anyway.

Switching what you are doing and switching what you are reading stop being the same gesture, which is
the whole of the complaint.

**One workspace, one panel button.** Where you land is state restoration, not a mode choice. The
hand-off went with the split: saving used to offer to open the editor, because the editing tools were
on another page and invisible from the reading controls. They are on this one now, so there is
nowhere to hand off to.

**The commit action moved into the persistent bar**, beside the way out. It is the surface's whole
purpose and should not be a step's footer — it used to sit at the foot of the third accordion section
with closing committing nothing, so a GM could tune for twenty minutes, press Escape and get nothing.

**The graph is simply always derived and drawn.** There is no "generate" act to perform.

**The warning is rare and specific.** Editing a wall bumps a count on the document; changing a
reading setting while it is non-zero asks, and names the price. At zero — most of the time — nothing
interrupts.

**Which graph is on screen follows from the same count**, through one predicate both the partition and
the wall layer read, because those two disagreeing is a defect this project has already paid for. The
saved graph wins when it carries hand edits, or when nothing has been derived yet — which is how the
surface opens on a map that has been through it before. Otherwise the derivation wins, which is what
keeps tuning the ink meaningful: **the rooms change as the threshold moves, and that is where a merge
is actually visible.**

**One handle per setting.** The spur limit was declared in both wall groups while they were separate
pages, so a GM would not have to find a limit twice — safe only because one page was on screen at a
time. On one page it would be two sliders writing one setting. It lives with the other derive-time
control now; the button in Edit walls spent the same number destructively, which is what you needed
once re-deriving is no longer free.

### Undo becomes load-bearing

A soft boundary is easier to wander across than a hard one. Today a GM cannot accidentally destroy
wall edits because the door is in the way; under this they can, and the count plus the warning are the
only guard.

**So undo shipped with it.** The compensations that exist — red previews, confirmations naming what
goes, counts before committing — all work by helping the GM *predict*, and do nothing for a judgement
that looked right and was not.

**Snapshots, not inverse operations.** Every edit already replaces the graph wholesale and a graph is
tens of kilobytes, so keeping the old one costs almost nothing and cannot disagree with what an
inverse would have reconstructed. Twenty deep, oldest dropped first.

**Each entry carries what it would undo**, so the button names it — *"Undo pruning the dead ends"* —
because the whole reason it is needed is that a GM has just done something whose effect they
misjudged, and a bare "Undo" asks them to remember what that was.

**The count comes back down with it.** Undoing every edit returns it to zero, at which point
re-deriving is free again and stops asking. That is true, and it is what counting buys over latching
a flag.

**It covers both documents the GM edits by hand** — the graph and the painted ink — since 2026-09-13.
It was the graph alone, and this said the paint layers were "a raster document with their own Discard
and Clear ... a different mechanism against a different document". A room asked the obvious question,
*"Why wouldn't undo cover ink edits, too?"*, and the answer is that a GM expects one Undo that takes
back the last thing they did, whatever it was. Two histories with different names was the tool's
structure showing through.

**Settings are still outside it**, and that part was always right: turning a slider back puts the
walls back, because a derivation is not spent by being redone.

**What made the raster affordable** was already in the codebase. A snapshot is **run-length encoded**
with the codec the scene store uses — an untouched layer is a single run and ordinary brushwork a
couple of runs a row — so twenty snapshots of two layers cost almost nothing, where twenty raw clones
would be hundreds of megabytes on a large map. The cost is one pass over the raster per **stroke**,
not per pointer sample.

**An entry is a way back, not a document.** The stack holds closures, so it never learns what kind of
thing it is restoring: `stage.ts` writes a graph to the scene, `paintTool` puts a raster back and asks
for a recompose. That is what keeps the stack free of both owners, and so free of the import cycle a
union type would have forced.

**No confirmation, and the reason is structural.** Mixing the two raised the question of an undo that
loses downstream work, since walls are derived from ink. It cannot arise, and the argument no longer
leans on any clearing rule — which is what let the clearing be narrowed twice in one day without a
confirmation appearing anywhere. **Undo is last-in-first-out**, so it returns to a state that existed.
And **the two documents are independent in the direction that matters**: undoing a stroke moves the
*preview* partition and never the stored graph, and undoing a wall edit moves the graph and never the
ink. Neither can reach across and destroy the other's work.

> This used to read *the stack is cleared when walls are saved and when the map changes, so
> everything on it happened since the last save*, and warned that relaxing that rule meant a
> confirmation had to replace it. The rule was relaxed and no confirmation was needed, because the
> clearing was never what made this safe — it was standing in front of the independence argument
> above.

**Two details a room will notice if they are wrong.** A paint undo **reopens the paint mode** if the
brush has been put down, because putting it down releases the working copies — and that is exactly
when a GM looks at what they drew and wants it back. And a stroke that changed no pixels pushes
nothing, so a click never fills the stack with entries that undo to the state they are already in.

**Confirmed in a room (2026-09-13), the pair and both documents.**

**The staleness rule is the part worth pinning, and it is where the tests are.** A snapshot describes
the document as it was, and two events make it describe something else: a **derive** replaces the
graph with a fresh function of the ink, and **loading another map** replaces it entirely. Restoring
across either would put back walls belonging to a graph the GM is no longer looking at — and since a
graph is stored in graph units of *a* map with nothing saying which, that would not look wrong until it
reached the scene.

### What draws: everything, from the moment there is a map — 2026-09-14

**The ink, the rooms and the walls are on always.** Layers used to be declared per
group and proposed by whichever was open, so the picture changed as the GM moved around it. A room
called that confusing, and it caused a real defect: arming a wall tool clears the drawer, and the
drawer proposed the empty set on its way out, so *the walls disappeared exactly when you picked up
the tool for editing them.*

**What made the old arrangement necessary was that a group was a mode. It is not; the tool is.** So
the picture is constant and the only marks that come and go belong to the thing in your hand.

**Affordances belong to the tool, not to the layer.** A handle at every point is not the graph — it is
the *grab target*, and with a brush selected it is a dot you cannot use, several hundred times over.
So **handles appear only for wall tools**, and two whole layers are tool-specific: the gap finder's
rings, which mean nothing when it is not running, and **the GM's own paint** — because the ink layer
already draws the composite, so what they suppressed and what they added are in the picture as ink.
Seeing the two apart is what a *brush* needs, and putting the brush down is how you stop needing it.

**A tool's layers get no switch**, and the tool is the switch. Offering one would be two handles on
the same state, and the switches are about the resting picture rather than about what is in hand.

**The ink layer draws the COMPOSITE, and the base only while a brush is in hand.** It drew the base
always, on the rule that the composite makes invented pixels indistinguishable from read ones. That
was right about the risk and wrong about where to pay for it: the rest of the time what a GM wants is
*the current state of the ink*, which is what everything downstream is derived from — and showing
them the base while the walls come from the composite is a picture of something else. The distinction
survives where it matters, since with a brush armed the base is drawn and the two paint layers sit
over it in their own colours. The **point probe** is unchanged as the per-pixel fallback: it still
says whether what you are pointing at was painted or read.

**One caller computes the whole proposal**, and that is a correctness rule rather than tidiness.
`proposeLayers` **replaces** and `requireLayer` **adds**, so two callers meant the answer depended on
which ran last — which is exactly how the defect above happened. The strip owns it, because the tool
is the mode.

**The state kept is what the GM switched *off*, not what is on.** Holding the positive set instead
would mean every proposal deciding whether it was allowed to add. A layer the GM has hidden stays
proposed, so its switch stays — which is the whole of how it comes back.

**The drawer has one slot.** It held four fixed children with three hidden at any moment, which was
the shape of the **pinned head** it replaced — that was always on screen, so a child per content kind
cost nothing. Under a drawer it was history kept live, and it bit: `#layer-row` set a `display` of
its own, which outranks the user agent's `[hidden]` rule, so the switches appeared inside every
drawer with nothing anywhere to say why. `[hidden] { display: none !important }` is the guard, and
building only what is showing is the fix.

**The switches moved out of the pinned head into their own drawer, behind the eye.** They were pinned
because a tool may turn a layer on and never off, so what was drawn *accumulated* and the switches
had to be somewhere a GM would meet them. Nothing accumulates now, and hiding one of four always-on
layers is something they go looking for. **The drawer carries a show-all/hide-all**, because with
everything on, getting back to the bare map image was otherwise four presses — and seeing the map
plainly is the state this surface most needs.

**One subject, everything else reference.** Most of the crowding is a *strength* problem rather than a
presence problem — the ink mask, the paint layers, the gap marks and the wall centrelines all want the
same few pixels of a wall stroke. **Context-dimming was proposed and is not built** (user,
2026-09-14: the ink faint while in Walls, the walls faint while in Ink). It is worth knowing that it
reverses two recorded decisions rather than extending them: per-layer opacity was removed outright in
September, and automating *which layer is the subject* was rejected because that is a judgement and
guessing it wrongly is more annoying than leaving it. It may well feel better than the record
predicts; only a room can say.

*Reassurance on scale: the densest state today is already four layers together in the Walls step, and
that has been through a room. Everything-on is five.*

### The derive, with no step to hang it on

**The trigger question only exists while the edit count is zero.** Once the graph has hand edits it is
never re-derived, so the expensive case and the consequential case are disjoint.

**The old trigger was "you opened the Walls step"**, which was a proxy for *"you are now looking at
this"*. There is no such moment any more, and the resting state above draws wall lines always — so
"derive when visible" would degenerate into "derive always".

**Pay it anyway.** A derive is ~700ms on a cached mask against a ~690ms reading, so chaining them
roughly doubles the cost of a slider release. The argument for spending it is the strongest one here:
**the merge failure is visible in the partition, not in the mask.** Two rooms leaking into one is hard
to see in a threshold change and obvious the moment the region fills merge. A live partition shows the
failure this project cares most about at the moment it is caused, instead of after the GM goes to look.

**Cropping to the viewport does not help**, unlike for the mask. Faces are topological, so a graph
cropped to the visible region gives wrong faces at every cut edge — and wrong rooms near the edge of
the screen is a worse failure than slowness. The derive cannot be made cheaper by looking at less of
the map; it has to be made *not block*.

**So: a worker is the real answer, and a debounce is what ships first.** Derive when the ink settles
rather than when a step opened. Same behaviour on a slow drag through a range; it freezes at the end
instead of never until you look.

#### Two indicators, and they are different states

- **Working** — a computation is in flight, bounded. `cursor: progress`, plus a thin indeterminate
  strip along the top edge of the canvas. Peripheral, covers nothing.
- **Behind** — what is drawn was computed from older settings. **A ghost mark on the slider's own
  track, at the value the picture was actually computed from.** The handle sits at 0.38, the ghost at
  0.34; when the derive lands the ghost slides up and vanishes.

**Put staleness on the control that caused it.** The existing signal is a line of small monospace text
in the bottom-right corner, while the GM's attention is on the slider they just moved or on the map.
The information is not missing — it is nowhere near where anyone is looking, which is why it has been
reported as awkward. A per-control marker is also legible when several controls are ahead, which one
status line can never be.

**Do not dim the panel to show work in progress.** It reads as *"you cannot touch this"*, which is
true while the derive blocks and **false** once it moves to a worker — and a signal that changes
meaning when the implementation changes is one that has to be unlearned. The cursor and the strip mean
the same thing in both worlds.

> **Implementation trap: while the derive blocks, nothing animates.** A 700ms synchronous computation
> holds the main thread, so a spinner will not spin — and worse, a cursor change or a class applied
> immediately before the computation **never paints at all**, because the browser needs a frame and the
> computation took it. Any working indicator must set its state, **yield one frame**, then compute.

### The markup palette

Two rules come before any hue.

**Visibility is structural, not chromatic.** We do not control the map, so no hue is reliably legible
on it. What is controllable is the mark's construction: a light casing under a saturated core, which
is already how wall centrelines are drawn and why they read on dark linework and pale paper alike.
**Generalise it to every mark that must be seen** — then hue carries meaning and casing carries
visibility, and the two stop competing.

**Avoid the map's own territory.** Map artwork lives in warm, low-chroma pigment: tans, browns,
ochres, muted greens and blues. Saturated **cyan, magenta and violet essentially never occur in it**,
which makes them the safest families.

#### Two axes, not one list

- **Hue** says what kind of thing it is.
- **Treatment** says how real it is: **solid is committed, hollow or dashed is proposed.**

That removes "information" as a category. The gap finder is not a third kind of thing — it is the
**additive** category in its *proposed* state, which is literally what it does. It also makes
structural a distinction that has already caused a defect, when an unexamined gap was painted solid
and became indistinguishable from ink the repair had really invented. Proposals are not solid, so it
cannot recur.

| category | hue | covers |
|---|---|---|
| **Ink** | violet | what the trace read |
| **Structure** | blue | the wall graph, cased |
| **Additive** | cyan | your added ink, gap proposals, a snap target, a span about to be placed, a collapse's star, and every ring a click is aimed at |
| **Subtractive** | amber | your suppression, and the marks that suppress a region |
| **Destructive** | red | **reserved** — erase target, the walls a dissolve or a collapse would take, a mark a click would remove, doomed spurs, nothing else |
| **Rooms** | a generated cycle | not semantic |

**Red earns its alarm value by being rare.** It did three jobs — default ink, emitted wall lines in
the preview, and destructive previews. The ink moved to violet, and the preview's wall lines are
**gone entirely** rather than recoloured (2026-09-15), so red is down to the one job it was reserved
for.

**Ink stops being red for a second reason beyond "it reads as an error": it is the largest area on
screen**, worn for the whole session, and it should be the calmest thing there rather than the
loudest.

**Rooms are not a picker.** The colour carries no meaning beyond *"this room is not that room"*, so it
wants a rotation at fixed low chroma and lightness, generated rather than chosen. The rule that
matters is that **no room fill is ever more salient than any mark**, which a hand-picked cycle cannot
promise.

**Colour vision: attach is cyan, not green.** An earlier draft used green for *will attach* against
red for *will remove* — the classic unreadable pair. Folding attach into the additive family fixes it
and is more correct anyway, since a snap target *is* an addition.

**Five pickers, grouped by category rather than by layer**, so adjusting for an unusually tinted map
moves one control and everything additive follows. They adjust the **core** hue only; the casing is
not adjustable at all, because it is the part doing the visibility work and tinting it would let a GM
tune away the mechanism the hues rely on.

**Changing one republishes the custom properties**, so a blurb naming a colour — *"covered areas show
in amber"* — cannot outlive the mark it describes.

**No colour keeps swatches** (user, 2026-09-13: *"Ink should be just like all of the other categories
with colors"*). Ink kept a palette of seven until then, on the argument that it is the one colour
covering real area and worth a one-click spread of hues, where the other four are marks a few pixels
wide whose meaning is fixed. **The cost of dropping it, stated:** nothing makes a colour good here but
contrast against a particular map, and every change is now a trip through the operating system's
colour picker — slower, and a worse place to compare two candidates. What is bought is that a category
is a category: five rows, one shape, and nothing to learn about why one of them is special.

### The measured typography finding — judged, and left as it is

**Contrast: `0.65` for a disabled glyph, and it is measured.** The tool strip's disabled tools and the
undo pair use it, at 5.35:1 against the strip for a glyph — over the 3:1 floor for non-text UI, where
the `0.4` it replaced computed to 2.7:1. (The 3.7:1 figure this used to quote was the locked accordion
header against the panel, which no longer exists.)

**It is not the only value, and this used to say it was.** Locked sliders and the buttons inside a
drawer dim to `0.5`, and a disabled bar button to `0.45`. None of those was measured. Recorded rather
than unified, for the reason below.

**Size: below the floor, and fine** (user, 2026-09-16: *"All of the text sizes look fine to me."*).
Measured on 2026-09-15 against a 13px base: the band captions at **11px**, a group's blurb at
**10.4px**, the map name and the undo label at **10.14px**, and the state line at **9.75px**. The
proposal was a 14px base with an 11px floor for the smallest text, held back because it changes the
look of every control at once and wanted a GM's eye first. **That eye has been given and the answer
was no change.**

**What the floor was standing in for was that look**, so the look retires it. It does not establish
that 11px never matters: the band captions went up to it because a room found them hard to read at
9.1px of uppercase (2026-09-10), and that stays true. Two observations, not a rule — small uppercase
was too small, and everything on the surface today is not.

**Standardising was left optional, and not done.** The stylesheet carries a scatter of near-identical sizes
(0.72, 0.75, 0.76, 0.78 and 0.8rem) and three dimming values, which reads as drift rather than intent.
Collapsing them would tidy the file and move pixels a GM has just approved, so the scatter stays.

### What does not change

Worth stating, because it is most of the project:

- **The whole of `trace/`** — about 12,900 lines across 24 modules. The reading, the paint
  composition, the gap search, thinning, the graph, the faces, the planar edits.
- **The emit path** — about 1,550 lines.
- **Storage** — settings, paint layers and the wall graph in scene metadata, unchanged apart from the
  colour parameters.
- **The gesture deciders** — `dragGesture`, `paintGesture`, `gapGesture`, `maskRequest`, about 630
  lines of pure, tested logic about what a gesture *means*. They survive because they were already
  split from the pointer plumbing.

**The cost, stated: this lands almost entirely in the untested half.** The surface touches the SDK, so
it cannot be imported into a node test, and the ~6,800 lines of workspace code it reworks have no
coverage. The tests stay green throughout and were never evidence about any of it. **A room is the
only instrument here**, which is an argument for building it in stages that can each be looked at
rather than as one landing — and which is exactly how it went: two sessions, fifteen faults, and
several of them invisible from a desk by construction.
---

## 8. Testing and diagnostic practice

**1,051 tests across 75 files**, all pure — everything that needs a DOM or a scene is not tested, which
is why the gesture *decisions* were pulled out into pure functions after three defects in a row came
from sequencing left in the event handlers.

The practice below is the reason this project works at all, on a problem where most failures are
invisible. It costs almost nothing to keep.

### The rules

- **Mutation testing earns its keep.** Break the code deliberately and confirm a test fails. **A green
  suite on first run is evidence about the *tests*, not the code.** Every non-trivial module here has
  been through it, and the counts are recorded in the code (`nine mutations, nine caught`) so a later
  reader knows what was actually checked.

  It has repeatedly found tests asserting less than their names claimed — including one the record
  believed was a check's own failure test, which never ran that check at all.

  **A mutation that survives is a question about the case, not only about the test — and the answer
  is a measurement.** Removing the mend tool's split-first step survived its fixture, and the tempting
  reading was that the step guards something vanishingly rare. A random sweep said otherwise: without
  it, 7,926 of 19,061 mends ended beside the vertex they should share (2026-09-16). An estimate of
  rarity is reasoning; a sweep over the input space is the check.

  **Sometimes the answer is that two rules overlap.** Dissolve region had a check for walls with the
  region on both sides and a separate rule by the sign of a loop, and disabling the check survived
  every test — because once a loop of zero area goes, a wall walked out and back is such a loop, and
  the check never decided anything (2026-09-16). It was deleted rather than tested, leaving one rule.
- **An oracle that restates the implementation is not an oracle.** The island profile's sweep walked
  components with a queue and a `Set` where the code uses an index stack — genuinely independent — and
  then binned the results with a **copy of the expression under test**. A mutation swapping in a
  different binning formula survived the whole sweep. Rewriting the oracle to scan the band boundaries
  — saying what a band *means*, the spans it covers, rather than restating how one is computed — then
  failed, and the implementation was the wrong one (2026-09-18). **Check every step of an oracle for
  shared reasoning, not just its headline algorithm.**
- **A surviving mutation sometimes means the mutant is equivalent.** Replacing "open the original mask
  at each radius" with "open the previous result" survived every fixture and 120 random masks, because
  openings by square structuring elements compose as a granulometry: opening at 1 then at 2 *is*
  opening at 2. The fixture written to catch it could not, and the comment justifying it was wrong.
  The measurement is the mutation run itself; what it asks for is a corrected comment, not a better
  test.
- **A mock drawn to settle a design cannot verify the code that follows it.** The ink profiles were
  designed by rendering candidates over a mock slider, which worked — and the mock was hand-written
  HTML whose SVG was sized by its container, so it could never exhibit the fault the real one shipped
  with (§9, the replaced-element trap). Two rounds of a room's judgement were spent on a picture whose
  axis was a third of the width it claimed. **The picture settles the design; only the running thing
  settles the build.**

  **And a mock can be drawn in a colour the surface does not use.** The cover's four candidates and
  its three border strengths were all drawn in `#7aa7ff`, taken from `wallsMark`'s *fallback* — the
  live `--structure` is `#1d4ed8`, a far deeper blue, so what was chosen by looking was a hue nothing
  on the surface renders (2026-09-20). Caught before it shipped, by reading `palette.ts` while wiring
  the lid rather than by looking again. **A fallback is not a value**: take a mock's colours from the
  declaration, and where a mock and the palette disagree, say which one the build followed.
- **An optimisation is a new implementation, and its oracle has to run again — once, heavier.** Span's
  search was made fast with a grid of the walls, and the rewrite broke exactness twice in ways every
  written fixture passed: rays aimed only at vertices within the bound, and rays stopped at the bound
  when a wall inside it ran beyond (2026-09-16). The random sweep against sampled directions caught
  both. Run it at its suite size afterwards and once at four times that, since the second fault was 1%
  on one graph in hundreds.

  **The heavier run pays for itself even when the optimisation is innocent** (2026-09-21). After
  *Collapse small regions* got its grid of the walls, the four-times sweep passed the grid and failed
  something else: *Collapse all* taking a region that had never been ringed, in nine graphs of seven
  hundred and none within the usual size. The rule is about the sweep's reach, not about the change
  that prompted it.
- **A cap on rounds is not a bound on work — check the invariant instead** (2026-09-21). *Collapse
  all* was given a cap of one round per region after a mutation hung it, and the next mutation hung
  under the cap: its rounds created regions, **doubling** them each time, 4,588 to 8,854, so each round
  cost twice the last. What bounds both the rounds and the work is the property a correct round has —
  here, fewer regions after than before — checked every round, with a round that fails it undone.
- **A sweep has to be shown to reach the case, not only to pass.** Dissolve region's oracle sweep ran
  over the derivation's own random linework and agreed on every region of 510 maps — while keeping
  not a single wall, because skeletons of random ink runs almost never put one closed room inside
  another, which is the whole of what the rule decides (2026-09-16). A sweep that never meets its case
  is a green light about nothing. **Count what it exercised and assert the count**: the replacement
  generator hangs small shapes off existing vertices and asserts that walls were kept, and kept from
  an outer cycle, before it asserts anything else.
- **A fixture that is easy to read can be too symmetric to fail.** The mend tool's first two landing
  fixtures — a horizontal wall, then a slanted one picked by hand — both attached with or without the
  step they were written for. A tangent test on a horizontal run cannot detect a search being
  disabled when the fallback is `(1, 0)` — the right answer for that
  fixture. One rewritten shared-wall test turned out to have a *straight* divider, so the shared wall
  simplified to two nodes that are pinned whichever way the fitting is done, and nothing was left to
  drift.
- **Change one variable at a time.** Questions have been called closed twice before they were, both
  times after changing two things at once.
- **Treat a clean diagnostic as evidence about the diagnostic** until it has failed at least once. A
  coverage line once reported "0.00% bare" on a map with visible bare patches — and was believed
  twice, and used to reject the correct answer.
- **A string crossing from a module to a page is a contract nothing typechecks.** Element ids and CSS
  selectors return `null` when the markup moves under them, every call site guards, and the symptom
  is a control that silently is not there. `elementIds.test.ts` checks every literal `getElementById`
  against the page that hosts it; a selector built from a template is still unguarded, and the answer
  there is structural — do not reach across a module boundary with one.

  **A registry that keeps one entry per slot loses the other without a word** (2026-09-21).
  `renderWallAmounts` and `renderFrameAction` were both filed under the Walls step's `bottom` slot,
  and `content.set(id, { ...content.get(id), [place]: render })` keeps the last — so **Straighten and
  Prune were never drawn at all**, from the day pruning joined straightening until a room noticed the
  drawer looked thin. The two registrations are three days and two commits apart, so nothing about
  either line looks wrong on its own. Same lesson as the keyed table below, one scope out: **a write
  that silently replaces is a contract with no reader**, and the fix is to make the collision
  impossible rather than to report it.

  **A declaration that decides whether a control EXISTS is a contract too** (2026-09-20). *Suppress
  region*'s drawer opens because a group in `steps.ts` names the tool, and the module drawing the
  button inside it cannot say so — it imports the SDK, so nothing testable can reach it. Delete the
  group and the button is not misplaced but **unreachable**, with the press that should open the
  drawer clearing it instead: no error, no failing test, a control that is simply not there. That is
  `elementIds.test.ts`'s failure one layer up, and the answer is the same — pin the contract from the
  side that can be imported, and assert the list being walked is not empty, or the check is satisfied
  by having nothing to check.

  **Keys are contracts too, and a test that reads only values cannot see them.** The mend tool's layer
  went into `TOOL_LAYERS` keyed by the layer's name where the strip looks it up by the tool's id, so
  picking up the tool drew nothing — and the test over that table walked its values (2026-09-16). It
  checks the keys now.

  **A class that is set is not a selector that matches.** A sweep that compares the classes a
  stylesheet styles against the classes the code sets cleared `button.tool-band` because `.tool-band`
  was live — on a `<p>`, so every rule scoped to a button was dead (2026-09-15). The sweep finds names
  nothing sets; the element a selector needs has to be read.
- **Diagnostics that fire unconditionally are worth their noise.** One that only fires when something
  is known to be wrong cannot distinguish "fine" from "never ran".
- **Say what a check *is* the first time it comes up.** None of them is self-explanatory, and an
  algorithm's name is not an explanation.
- **8-connectivity means single-pixel junctions barely exist.** Every pixel beside a junction is
  itself degree 3+, so a tee traces to eight chains, not three.

### Search the whole history of a thing, not the window you suspect

**Twice in one session the answer was outside the window chosen** (2026-09-21). A room reported that
the ink filter had stopped being robust; the report was dated 09-18, so the search ran 09-16 to
09-18, found nothing behavioural, and concluded *no regression*. That was **wrong in scope and
stated too confidently**. The user pushed back — *"that bit of code must be pretty old, can you check
if there have been changes to it or things immediately downstream"* — and the full history found two
removals that mattered, on **08-30** and **09-05**, both outside every window searched.

**So when a report says something changed, run `git log --follow` on the thing and on everything
immediately downstream of it, with no date bound at all**, then narrow. `git log -S` on the exact
expression is the sharpest form, and it is cheap. The counter-instinct — that the report's date
bounds the change — is wrong whenever a capability is *removed*: nobody notices the day it goes, they
notice the day they next need it.

### A probe settles a mechanism faster than reasoning, and it will correct the variable you named

Three throwaway probes answered in minutes what an afternoon of morphology-in-the-head had not
(2026-09-21), and one of them **overturned the premise**: a missed gap was reported as *staggered by
a pixel*, that was taken as the variable, and a probe sweeping stagger against gap width showed
stagger changed nothing at all — the gap simply exceeded `2 * radius`. The real variable was the
**angle** of the wall, which no amount of thinking about the report would have produced.

**Write the probe before the explanation.** It is a throwaway test that reports by throwing, it costs
one file, and it is deleted the moment it has answered.

### An oracle follows the implementation, and changing one means revisiting the other

When the severance bridge stopped being a symmetric closing, the oracle that checked it was still a
symmetric closing — and it agreed with the old behaviour, not the new. **An oracle is only
independent in its *method*, never in its *specification*.** Changing what a function is supposed to
do means rewriting the oracle to the new specification, and the mutation run is what proves the
rewrite still bites.

### Never look at map images

This is the big one for an image-processing project. **Pipeline fixtures are generated in code** —
small pixel grids built by `maskFromRows`, drawn as text — so tests never load an image file and
nothing needs to be viewed to be verified.

Judgement about real maps happens in a room, where the user looks and the dev log reports numbers.

*Rejected: a trace harness.* The sibling built one and the plan here inherited it without examining
the premise. Two things caught that. The user, who used it, reports looking at it once or twice and
testing naturally sliding into an Owlbear room instead. And the sibling's own record shows why: nearly
every mention of its harness is a **number**. It was a measurement rig with a viewer attached, and the
viewer is the part nobody needed.

Numbers do not need a page. Measurement on synthetic input belongs in unit tests; measurement on real
maps belongs where the real maps already are, which is Owlbear. **And running inside the extension is
strictly better on the point the harness was worst at**: the sibling diagnosed a real bug only after
harness and room disagreed *in direction*, because the harness never ran world placement. Code inside
the extension cannot diverge from itself that way. That was originally an argument for the dry-run
button, which is unwired now — it survives unchanged as an argument against a harness, because what it
turns on is *where* the code runs rather than which button starts it.

*Kept in reserve:* a throwaway local page that renders an intermediate raster. Owlbear cannot display
one at all, so it is the single capability neither tests nor a trace inside the extension supply.
Perhaps thirty lines
at the moment something is inexplicable, and building it before then would be infrastructure guessing
at its own question.

### The live checks, and what each can and cannot say

- **The orphan count** — a skeleton pixel no chain claimed. It is ink, so it is not space; no edge
  represents it, so it is not a wall. Linework that fell out between the two representations.
  **Its limit, stated:** it says every pixel was *claimed*, not that it was claimed **correctly**. A
  walk that routed a pixel into the wrong chain claims it just the same.
- **Euler's identity**, on the wall graph — *vertices − walls + enclosing cycles = pieces of
  linework*, the left side from geometry and the right from a union-find. It catches a missed
  half-edge, a cycle partition that does not partition, and a successor rule tracing the wrong way
  round — that last as soon as there are two rooms.
  **It does not catch a crossing**, and **a doubled wall makes it fail legitimately** (two coincident
  segments are not an embedding it describes, and that is a legal state to pass through). So it is a
  line in the log rather than a gate.
- **Planarity** (`findCrossings`) — the separate check Euler does not imply.
- **Sliver detection**, which is a definition rather than a check: a cycle enclosing no lattice point,
  by Pick's theorem in doubled integers, counting **distinct** boundary points.

### The area check is gone — do not reintroduce it

It compared two routes to one number: the labelling **counted the pixels** in a region, the traversal
**computed the area its polygon enclosed**, and they had to agree exactly. It caught real defects in
rooms — the weld radius on the second map ever tried, and a stranded pixel no eye could find.

**It has no subject any more.**

> *"Since we aren't treating faces as the underlying data, we don't need to check that every part of
> the map is under a face — it is by definition."*

The document is a planar graph, a planar graph partitions the plane by construction, and faces come
from walking it. What the check uniquely covered was the **raster-to-graph conversion**, which is the
orphan count above.

**What it was really doing was serving as a test oracle at runtime**, and that is where it went.
`faces.test.ts` has a room, a room with a stub, a nested box, a lollipop and a freestanding line, with
the answers written down. **A written answer is the stronger statement**, because an identity can hold
over two consistently wrong numbers.

Two things from it that still bind:

- **Winding IS defined on the graph.** The signed area of a cycle is what separates an enclosing ring
  from an outward-facing one, and reversing it inverts every room. Euler's identity guards it now.
- **Holes can be mis-parented**, which is why a cycle is only ever tested against cycles of *other*
  pieces (§5).

### The randomised sweep

`graphSweep.test.ts` generates **700 skeletons across three sizes** and asserts the invariants: orphans
zero, sliver removal settled, Euler and planarity over the wall graph, every ring a real polygon,
and every segment either covered by a ring or emitted as a wall line.

**It pins invariants, never values**, so changing the generator does not force a rewrite. Both of the
defects that welding and the degree confusion produced lived in configurations no hand-written fixture
contained, **because a fixture is a shape somebody thought of**.

**It runs with fitting OFF, deliberately.** Douglas–Peucker moves a boundary half a lattice unit at a
time, so checking the ring decomposition and the fitting together would need a tolerance, and a
tolerance would hide the thing being tested.

### A warning is not a safeguard

**Nobody reads the log, and probably nobody reads the small print on the panel either.** So a control
is not made safe by warning about what it might have done. **Either it is right, or its failure is
evident in something the GM is actively looking at.**

**What this does not mean.** The log is not being cut back — it remains how a fault a GM *reports* gets
diagnosed without either party looking at pixels. What changed is what a warning may **license**: it
may not be offered as the reason a risky control is acceptable.

> **A new control that can be wrong needs a visual channel before it ships.**

The two ink filters are the model: a global width filter is defensible because the damage appears under
the GM's cursor as they drag. The gap repair draws every proposal in its own colour. The prune
preview draws the doomed walls in red. Each of those is the licence.

### When a GM reports a gap, probe it — do not reason about it

Every other diagnostic reports a **total**, and a total cannot say what is happening *there*.

**"What is here?"** — a click on the map, in every step — answers with the luminance actually read,
whether that was called ink, and whether the ink was *drawn by the GM* rather than read from the map.
It survived the cull of the censuses for a precise reason: **it answers what looking cannot.** The
picture shows ink; it cannot show that a pixel read 0.991, or that what you are pointing at was
painted.

It takes a **fraction of the map**, so the surface never needs to know the trace's raster.

**Both censuses are deleted.** The region census existed so a fault could be diagnosed "without either
party looking at pixels", which was written when the panel was a popover with no picture; the workspace
draws the partition in six colours now. The scene census's question — do our shapes derive Dynamic Fog
walls — is closed.

**The merge alarm went with them**, and its argument is the one worth remembering: it assumed a dungeon
of many small rooms with one dominant exterior, so a single large cavern trips it legitimately; nothing
acted on it; and it was a numeric proxy, in a log nobody reads, for something now visible in the drawn
partition.

### Rejected: scoring extraction against hand-drawn walls

A map whose walls the GM has already drawn looks like ground truth, and the appeal is obvious — it
would turn "does this look about right" into a number. It does not survive contact with what a wall is.

- **Where a wall goes along a stroke of ink is a judgement.** Inner edge, centre and outer edge are all
  defensible, and whether an opening in the linework is a doorway or a gap the drawing failed to
  close is a *reading* of the map rather than a fact about it. A diff would score the extractor down for disagreeing with an arbitrary choice, driving
  tuning toward reproducing one GM's habits.
- **One map cannot generalise.** The sibling has already paid for this in a different costume: its wall
  margin's safety turned out to be *a property of the test map*.

The compounding danger is that such a score would look rigorous while measuring the fixture. **The
surviving form of evaluation is topological, not geometric**: not whether a boundary is within some
distance of where a human would have put it, but whether regions *merge*.

---

## 9. Constraints and pitfalls

### Platform constraints — measured in a room, not guessed

**Do not re-derive these.** Each was established by observation in a real Owlbear scene, several of
them expensively; where the cost is instructive it is named.

- **The SDK cannot be imported into a headless test.** Its index calls `getDetails()` at module load,
  which reads `window.location.search`, so any node-environment test importing it dies with
  `ReferenceError: window is not defined`. **This dictates the layering:** every module touching the
  SDK is split from its pure half, and the pure half is where the tests live. Type-only imports are
  erased and therefore safe.
- **Items cap at exactly 8192 array entries.** Bisected to the single command: 8192 accepted, 8193
  refused. A fixed constant, not a shared budget.
- **Writes are rate limited**, and this is *distinct* from validation failure. Distinguish them at every
  call site: retrying a size failure is futile, giving up on a throttle loses data.
- **SDK rejections are not `Error`s.** The SDK rejects with the parent frame's raw payload, so
  `instanceof Error` is false for every failure it can hand back and `.message` is `undefined`.
- **Dynamic Fog's walls and lights are LOCAL items**, read via `OBR.scene.local.getItems()`. Querying
  the scene returns zero in a room where the fog plainly works, and `scene.items.onChange` never fires
  for them.
- **Walls are not there at startup.** Dynamic Fog materialises them ~1.2s after a fresh load.
- **Check-then-subscribe is a race.** Subscribe *before* checking `isReady()`, and make the operation
  idempotent. A popover's connection going ready is **not** the scene being ready; the sibling lost two
  days to that one.
- **Asking the scene a question before `onReady` throws — it does not return empty.** Anything reading
  scene items or metadata waits for the start-up sequence; only DOM that needs no answer is wired at
  load.
- **Scene metadata has no limit below 512KB per key** — measured.
- **The grid covers only `MAP`-layer images.**
- **An inline `<svg>` is a replaced element, so `left: 0; right: 0` does not stretch it.** With
  `width: auto` it takes its width from the viewBox's ratio against whatever height is given — a
  100:20 viewBox at 17px tall is 85px, about a third of the drawer, which is how the ink profiles
  shipped. **Set `width` explicitly on any SVG that must match something else's width**, and treat a
  drawing whose horizontal axis *is* another control as a correctness question rather than a
  cosmetic one: every band was placed somewhere other than the stop it described.
- **Rasters cannot enter a scene.** `data:` URLs draw a broken-image placeholder at 0.3KB, are refused
  at 21.6KB, and wedge the message bus at 1.37MB. Asset upload is the only mechanism that delivers
  pixels, and `Image` has no opacity or tint. **This is why the workspace's view can never be scene
  content.**
- **Map pixel access works cross-origin.** `crossOrigin = "anonymous"` is mandatory regardless of what
  the CDN sends, or the canvas is tainted.
- **`iframe == viewport`, always**, and Owlbear's map canvas is the full window with its tools floating
  over it — so `viewport.transformPoint` output is directly usable as page coordinates.
- **There is no viewport change event.** `Player` carries `syncView`, not the transform. *The workspace
  makes this irrelevant by owning its own transform.*
- **Storage is partitioned.** The extension runs in a third-party iframe, so Firefox buckets
  `localStorage`/IndexedDB per top-level site. Keep durable state in scene metadata; treat any local
  cache as something that can vanish.

### Likely pitfalls

Named in advance so they are recognised rather than discovered.

- **Splitting a region to fit the item cap creates a wall across the middle of a room.** Dynamic Fog
  derives a wall from *every* shape boundary. The cap must be met by simplifying harder, and an
  oversized region is a signal that simplification is too timid. **This is the sharpest trap in the
  design, because chunking is the obvious remedy and is correct everywhere else in Owlbear.**
- **Inverted ink polarity produces a confident, complete, exactly wrong answer.** A binarizer assuming
  dark ink on a light ground, run on light-on-dark linework, traces the complement of the structure.
  Spectacular when noticed, and aggregate statistics will not catch it.
- **Diagonal leaks.** The connectivity pairing in §4. A one-pixel diagonal gap in ink is invisible to
  the eye and merges two rooms.
- **Hatching and texture traced as rooms.** Cross-hatching outside walls encloses hundreds of tiny
  areas. The ink filters are the guard, and they are the sibling's `minContourLength` trap in a new
  costume: set high enough to kill hatching, they eventually eat a genuine closet.
- **Re-running over hand edits.** A push replaces everything of ours. Our metadata tag makes "replace
  only ours" possible; making it *safe* is a product decision, not a technical one.
- **Pre-existing fog.** A scene may already have fog shapes drawn by the GM or by Forecast. Ours add to
  them rather than replace them, and Dynamic Fog derives walls from theirs too. The test map's scene
  carries 419 hand-drawn `LINE` fog items plus 8 paths, so this is live rather than hypothetical.
- **Wall count is twice the contour count, not the region count.** Every closed contour becomes two
  `Wall` items, and a region with a pillar has two contours. Any budget reasoned from "one shape per
  room" is out by more than a factor of two.
- **Hole containment is checked one step across, not transitively.** A discarded face that itself
  contains a surviving one leaves its hole filled. Nothing on the test map produces that shape.
- **A room thinner than the smoothing tolerance is lost when the wall graph is built**, because both its walls fit to
  the same line and one of the pair is dropped. Counted and reported, never silent.

### Things an optimisation pass would take, and must not

- **`Float64Array` for the integral tables.** A `Float32Array` mantissa exhausts at exactly 16
  megapixels, and the failure is silent — thresholds slightly wrong everywhere, worst in the
  bottom-right.
- **The `Math.max(0, …)` variance clamp**, against a `NaN` that would mark every pixel as ground.
- **`strictPort: true` in the dev server**, which is what stops a URL registered in Owlbear pointing at
  another project's build.
- **`npm ci` rather than `npm install` in CI**, which catches a lockfile assembled on Windows and
  missing the Linux entries.
- **Four functions that look test-only to an export sweep and are not** — `erodeMask`, `dilateMask`,
  `eraseSpecks` and `isPostReading` each have an in-module caller and are exported so the halves can be
  tested separately, which is the right shape for modules whose whole risk is the two halves
  disagreeing.
- **`src/pagesBase.ts` and `src/probe/fogProbeGeometry.ts` look unreachable and are not.** The first is
  read by `vite.config.ts`, which a grep for production callers does not see; the second supplies
  fixtures for eleven assertions about live emit-path code.
- **`probe/viewTransform.ts` is live production code.** The shell imports seven of its functions, so
  every pan, zoom and wheel gesture goes through it. It sits under `probe/` only because that is where
  the navigation constants were settled.
- **`themeVariables` returns only the entries it could fill.** Emitting a key with an empty value
  overrides the stylesheet's own default with nothing, rather than falling back to it — so a theme
  missing one colour would blank that colour instead of leaving it alone.
- **The theme and `onReadyChange` are subscribed to *before* being read**, not after. A change landing
  between the read and the subscription would otherwise never be observed, silently. This is
  "check-then-subscribe is a race" above, applied where it is least obvious.
- **Slider rows are drawn from the defaults and disabled, not withheld until the SDK answers.** A
  surface that renders nothing until a round trip completes looks broken; one that renders its
  controls greyed says what it is waiting for.
---

## 10. Open questions and what is next

### Where the project stands

**The whole chain works, confirmed in a room on real maps**: read a map, tune the ink, correct it by
hand, generate the graph, edit the walls, put it on the map. Dynamic Fog respects a moved wall, and the
fog on the table is what the GM edited.

**Everything structural holds.** Euler's identity has held on every derive of a real map. Placement is confirmed correct in all four corners, and rotation pivots about the bounding-box
centre.

### The partition has been judged, and it is good — 2026-09-13

**The thing the project exists to get right has its first answer.** The user took a test map through
the whole chain and reports it *"drawing good walls and partitions"*. Until this, the record said
nobody had gone room by room and said whether these were the rooms they would have drawn; someone
now has, and the answer was yes.

**What it establishes, and what it does not.** One map, one GM, their own test map. It says the
pipeline as it stands produces a partition a GM accepts on at least one real map — which is the first
evidence of that in the project's life, and much more than the structural checks could ever give.
It says nothing yet about the range of map *styles*: hatched stonework, a printed floor grid, a
hand-drawn scan, a map whose walls are a texture rather than a line. Those are where the reading is
expected to be hardest and none has been tried.

**The corrections needed were for walls the map does not draw.** *"I have to insert some walls
manually to finish it, but that's because they are not drawn on the map itself."* That is the design
premise holding rather than failing: §1 says the output is a **proposal** a GM corrects, and ink that
does not exist cannot be read. The interesting part is not that hand insertion was needed — it is
**which tool the work was done with**, because drawing ink before the derive and drawing walls after
it sat on opposite sides of the save. (That seam was answered on 2026-09-14 by deleting the save:
decision 1 below.)

**The most informative thing that can happen to this project is now a second map**, one whose style
differs from the first.

### The surface redesign is built, and has been used

**§7a is complete** — one workspace instead of two, a tool strip holding the verb, the drawer that
replaced the rail, undo, the derive indicators, the markup palette, the layer switches and the colour
pickers, and no save between reading the map and editing its walls.

It came out of using the thing: the accordion made switching tasks expensive, and the two doors into
the workspace read as artificial. Both turned out to have one cause — the mode boundary ran across the
grain of the task, and what it was protecting is a property of the document rather than a place.

**Rooms on 2026-09-13, -14, -15 and -16 went through the whole surface**, and everything they found is
fixed. The partition was judged in the first of them (above); the tools built on the last are in the
next section.

### Where to pick this up

**The automatic prune — built and confirmed in a room, 2026-09-21** (user: *"that looks right in a
map. No more stubs."*). Every derive removes dead ends of up to **two measured ink widths** before it
hands the graph over, prompted by a room's *"a lot of tiny spurs and very small enclosed loops"*. §4's
*The hairs come off in the derive* has the whole of it. On *The Incandescent Grottoes* (3.4px ink, so
a 6.7px limit) the log shows 193 to 419 dead ends taken per derive depending on the ink settings.

> **This is new, not a restoration, and the record said otherwise for a day.** It called the missing
> prune a regression — *"the trace pruned as it built"* until 2026-09-18. It did, but only from a
> stored limit whose **default was zero**, on the written ground that *"the first thing a GM should
> see is the graph as fitting produced it, hairs and all"*. So a fresh map was never pruned unless the
> GM had set a limit, and what 09-18 removed was a GM's own setting being re-applied. That argument
> was about a handle reaching the longest wall on the map; it does not describe a fixed two ink widths.

***Collapse small regions* — built 2026-09-21 and confirmed in a room 2026-09-22** (user: *"That works
great in the room."*). The tiny loops from the same report, which the prune did not take and which the
user put down to *"a lot of details drawn alongside the walls"*. §10's *Collapse small regions* has the
whole of it. **Confirmed as a whole rather than point by point**: nothing has been reported either way
on long slivers along curved walls, on whether eight square ink widths is the right start, or on the
glyph at its real size.

**Noted, to look into later: saves are very slow on this map** (user, 2026-09-21: *"I'm having a lot
of very slow saves. I'm usually not waiting for them to finish, since we're just testing."*). The log
says which save and roughly why. A push on close at 21:54 was **60 regions and 3,419 wall lines**; the
GM stopped it after **49 seconds with 2,280 of the 3,419 written**, which is about 46 wall segments a
second. The latest derives of *The Incandescent Grottoes* hold 3,242 wall lines against 67–70 regions
— **82% of all segments are bridges**, each a `LINE` item of its own, and the total is past the
1,500-item push warning and not far short of the 5,881 that once could not be written at all. So the
lead is the **item count** rather than the write path: detail drawn alongside the walls becomes open
linework, and open linework is one item per segment. Two directions, neither examined: fewer items
per wall (one item per wall *run* rather than per segment, which §6 decided against for nudging in
Owlbear), or fewer walls (*Collapse small regions*, and the thin-lines ink tool). **Not
established:** whether the per-edit graph writes are also slow; the log has no timing on them.

> **Measured the next day, and the item count was the lead** (user, 2026-09-22: *"having those
> simplification tools helped the closing time enormously"*). Two pushes on close of the same map in
> `dev.log`: at 03:20, **70 regions and 3,242 wall lines took 1 minute 46 seconds**, about 31 items a
> second; at 12:11, after pruning, collapsing and suppressing, **17 regions and 145 wall lines took 1.3
> seconds**. Twenty times fewer items, eighty times faster. So the write path is not the problem at
> this size and the linework is; what is left open is only a map whose honest walls are that many
> segments.

**Waiting for a room: *Prune the dead ends* as a ringed tool — built 2026-09-22.** One ring per
piece the whole cascade would take; a click takes that piece, the button takes every ring; the length
starts at four ink widths every opening. §10's *Prune became a ringed tool* has the whole of it.
**What to look at**: whether a star of short strokes reads as one ring, whether four ink widths is a
good first guess, and that the red junction is gone and not missed.

**Then the five parked items**, none started. (*Mend moves below Prune* went in with *Collapse small
regions*, and *Prune acts like Mend* is the item above.)

1. **Toggle Map Frame** — rename *Add walls around the map edge*, and make the press toggle. The
   detection half exists: `addFrameWalls` already has a strict already-framed test that asks whether
   a segment lies *along* an edge. **The open question is what a toggle does to walls the frame
   split** when it went on, which cannot be unsplit without knowing which splits it caused.
2. **The frame should be undoable**, and may already be: it goes through `saveEditedWalls`, which
   pushes an entry unconditionally. Check before building.
3. **Delete a whole connected chain or network of walls**, complementing Dissolve region. Raised
   again 2026-09-22 (user), so it is wanted rather than only noted.
4. **Draw a chain of walls** (user, 2026-09-22): each click starts a new wall joined to the last, and
   the chain stops on Escape, on right-click, or on a click on an existing vertex, which closes the
   shape. Draw's two-click form already re-aims a far end between clicks, so this is that form not
   stopping after one wall.
5. **Straighten gets a *Done* button** (user, 2026-09-22) that commits and closes the drawer, so its
   interaction matches Prune and Collapse: adjust a slider, then press a button. Today the commit is
   caused by leaving — putting the tool down or arming another — which the drawer's note says and
   nothing on screen shows.

**Parked from the ink investigation**, both recorded with measurements and neither built: the stroke
slider's **stepping** (about ten stops per distinct radius, so six nudges do nothing and the seventh
severs), and **`round` versus `floor`** in `radiusForWidth`, where floor would guarantee the
effective threshold never exceeds what was asked for.

**Looked at in a room and fine** (user, 2026-09-22): dimming, and the handles Straighten and Prune
draw at every vertex. **The red junction on a doomed stub is gone** with Prune's rework, where a ring
makes a tiny stub visible without marking a vertex that stays.

**Noted, not built — the review's drawing order** (user, 2026-09-22). When the cover's review draws
what a regenerate would take and bring back, *what comes back* should be drawn **over** *what goes*.
Straightening replaces nearly every wall, so both sets lie on top of each other almost everywhere, and
with *what goes* on top the picture reads as everything being deleted when it is being replaced.

**Noted, not built — the panel is too wide** (user, 2026-09-22). The popover Owlbear shows, not the
workspace, is still sized for when it held the whole interface. It is three buttons now — *Open the
workspace*, *Remove ours*, *Clear everything* — and should be narrowed to fit them.

**42 commits are not pushed** (measured 2026-09-22 with `git rev-list --count origin/main..main`,
before the commit that writes this line). **A push deploys**, so it waits for the user to want the
public build to have them.

### The workflow rework — designed in full 2026-09-18, part built

**What it is for.** The lock that stops a GM destroying their wall edits was organised around a
*consequence* — *"what will regenerate the walls"* — and that cuts across every category a GM already
has. The Ink group holds nine controls of which five regenerate, so the guard had to be **per control**;
two graph sliders were members for an unrelated reason; and the map picker, the most destructive thing
on the surface, was not a member at all. **A GM cannot predict membership of that set**, so they cannot
hold it, and the surface has to tell them each time with a mark.

The rework organises it around a **cause** instead: *what the walls are made from*, which is the map and
the ink. That is the same division as stage one and stage two, and it fits in one sentence — the walls
come from the ink, so changing the ink makes new walls.

**It is not a return to two modes**, and the difference matters because §7a's argument against them
still stands. What 2026-09-14 killed was *navigation cost*: two pages, two panel buttons, a save between
them, controls that moved when you crossed. None of that returns — one page, one strip, every group a
click away, no save. The live objection from that decision is narrower and was answered directly:
*"the ceremony fires on crossing the boundary whether or not anything is at stake."*

> **So the cover exists only when there is something to lose**, gated on the stored base differing from
> the document. No hand edits, no cover. That makes it **a state the document is in rather than a place
> the GM is** — which is §7a's own formulation of the irreversibility, drawn properly for the first time
> instead of scattered into per-control marks.

**Reasoned, not measured:** the loop the mode boundary used to cut across — spot a merged room, go fix
the ink — mostly happens *before* any wall editing, because spotting a merge is reading the partition
and hand-editing walls means the partition has been accepted. So the cover costs nothing in the common
case, and when it does appear the cost it names is real.

#### Straighten and Prune became actions

**Both apply an amount to the walls in front of the GM** rather than feeding a parameter to the derive.
That is what lets them work on a hand-edited graph, and it is what takes them out of the lock — after
this, the only things that regenerate the walls are the map and the ink.

**The word for this was "dose" for two turns and is retired** (user, 2026-09-18: *"let's not use the
term, I'll have trouble remembering it"*). There is deliberately **no category noun**: the buttons say
*Straighten* and *Prune the dead ends*, the slider beside each says how much, and where the contrast is
needed it is spelled out — *applied to the walls you have* against *read by the derive*.

**What it costs, stated.** Applied to the current graph the operation is cumulative, so the handle
cannot describe a state: straighten at one amount then a smaller one and the detail does not come back,
because the document no longer holds it. A GM can add more or undo; they cannot drag back to a previous
result. **That is the ratchet accepted and made visible** rather than eliminated, and it is only
tolerable because undo is behind it.

**The latch is what buys the slider back.** Opening the Walls drawer pins the graph; the handle previews
against that fixed base, so dragging back and forth *inside one opening* is free and exact; closing the
drawer applies the result once, as one undo entry. **The handle starts at zero on every opening**, which
is the load-bearing half — at any other position it would describe work already done, and one nudge
would re-apply it to the already-straightened base, which is the ratchet returning through the side
door. Three things fall out for free: a drawer closed untouched applies nothing, a drawer stolen by
another press commits nothing, and one opening is one entry.

**The staleness rule is the only subtle part.** An undo or a derive landing replaces the document while
the drawer is open, and an operation computed against the vanished base would discard the replacement
silently. So the latch is **void** the moment the current graph is not the object that was latched —
identity rather than equality, because every edit replaces the graph wholesale and two equal-but-distinct
graphs are still a replacement. It is enforced at the commit as well as while the handle moves, and a
void latch applies nothing at all, which is the loud answer: the GM sees walls unchanged rather than
quietly re-straightened.

**The preview substitutes rather than overlays** (user, 2026-09-18). While the amount is non-zero the
walls *and* the room fills on the canvas come from the straightened graph. The question a GM is
answering is *do I want these walls*, which only the result can answer — and straightening replaces
every wall, so an overlay would draw a dense map twice, where Prune's red preview gets away with it by
marking a subset. `regions.ts` holds one variable for it and the walls layer delegates its source there,
because the fills and the walls coming from different graphs is a defect this project has already paid
for. `editableGraph` deliberately still answers the document, since a tool must edit that rather than a
proposal.

#### The fitting tolerance is computed, not chosen

**Two numbers had been one.** The tolerance that turns pixel chains into fitted edges — and escalates
map-wide to meet Owlbear's 8192-command cap — lives inside the derive by construction: fitting happens
once per edge *before* the wall graph exists, which is what stops two faces of a shared wall drifting
apart. It cannot move to the current graph. Straightening the *document* is the separate operation
above.

**So the handle went and the number stayed**, computed as a quarter of the measured ink width. The
premise that the automatic step made a control unnecessary needed one correction first: **the escalation
ladder doubles**, and its loop is guarded `tolerance > 0` with the reason beside it — *"doubling zero is
zero, so a caller asking for no simplification at all would spin here forever on any face over the
cap."* The ladder therefore needs a non-zero start and cannot supply one; and it only guarantees each
**face** is emittable, never that the whole graph is storable, which is the limit the 751px map hit.
What makes the handle unnecessary is that the seeded figure is a *measurement* and a better answer than
a GM's guess — the report while it was on screen was *"I haven't looked at them while adjusting
settings."*

**Removed rather than hidden.** A stored value with no handle would govern every fit for ever, silently,
on any scene tuned before the change — the unit-rename failure arriving by another route. And the round
trip went with it: the seed divided a pixel figure by raster pixels per graph unit and the derive
multiplied it straight back, a hop that existed only so a *stored* number could outlive the raster.

**Measured, and it says the handle was not load-bearing for size.** Across the 38 derives in `dev.log`,
every one ran at a **seeded** tolerance with **zero escalations**, and the two maps emitted **318 items
(6 regions + 312 wall lines)** and **514 (10 + 504)** against the large-push warning's threshold of
1,500. What that does *not* establish: two maps, both line-drawn; the 5,881-segment catastrophe of
2026-09-07 predates seeding, so what is known is that seeding fixed *that*, not that the seed suffices in
general; and zero escalations means **the ladder has never been watched working on a real map.**

**The residual cost, stated:** there is no automatic guard on item *count*, before or after. The ladder
fires per face above 8,192 commands, which is a different failure. The slider was the manual guard, so
removing it leaves the large-push warning as the only thing standing there.

#### The clear family — one verb, one meaning

Three tiers, each aimed at exactly what its name says: tool-level at one layer, area-level at all of my
edits here, scene-level at everything.

| control | where | takes |
|---|---|---|
| **Clear layer** | a brush's own drawer, unchanged | that one paint layer |
| **Clear ink edits** | the foot of the **Ink band** in the strip | **both** paint layers |
| **Clear wall edits** | the foot of the **Walls band** in the strip | the wall document, **leaving the marks** |
| **Clear all marks** | *Suppress region*'s drawer | the suppression marks |
| **Clear everything** | the panel, unchanged | the scene as though the extension never ran |

**The two area-level ones are in the STRIP, not in a drawer** (user, 2026-09-20). They were designed
to sit at the foot of each group's drawer, beside the controls they clear up after; they belong in the
band, **under the tools whose work they take**. That makes them a **third kind of button in the
strip**, which has carried a *drawer opener* and a *verb* chosen independently of each other. An
**act** opens nothing and arms nothing, so it never draws pressed and carries no `data-opens` — and
the argument that lets the first two share a column covers it, since the column is a list of things to
press and what each one does is its own business.

> **The cost, stated:** a destructive press now sits one row under the tools, in the column a GM
> reaches for constantly, where a drawer would have put two presses in front of it. What stands there
> instead is the confirmation, which is what stands in front of *Clear layer* too.

**Both wear the same glyph — a bin — and the band caption says which subject** (user, 2026-09-20,
chosen from four candidates drawn at strip size). That is the strip's own ordering rule, *what a
button acts on is said by where it is*, and the column already repeats a glyph on exactly that
argument: the sliders are drawn for Ink, Walls and View. The three candidates that put the subject
*into* the glyph each cost more than they bought — the band's heavy ink stroke or a wall between two
vertex rings is about a fifth of a glyph at 18px, a struck-out wall is very nearly *Erase* three
buttons above it, and a slashed pair was the busiest thing in the column. **The cost:** two identical
destructive buttons in one column, told apart by reading the caption rather than the picture; and a
bin is the first piece of *furniture* in a strip whose glyphs otherwise all draw the map — which is
also what makes it read as an act rather than as a tool.

**"Clear" means destroy the stored thing and nothing else does.** *Discard changes* — which reverted one
layer to its last save — **is deleted**, and the reason is not that undo replaces it. Undo does not: it
is twenty entries deep, so a spell of more than twenty strokes cannot be fully reverted, and the ladder
now has a hole between *the last twenty strokes* and *everything on the layer*. The reason is that the
button's **extent was unknowable**: it reverted to "the last save", and the save is an event the surface
stopped marking when the save button was deleted — putting the brush down saves, switching group saves,
closing saves, none of them announced. Undo's extent is one named act per press.

**Every clear is undoable in one step but *Clear everything***, which is the rule the family now runs
on (user, 2026-09-20). *Clear layer* already was; *Clear all marks* is, by going through `saveMarks`
like every other placement and removal; and *Clear wall edits* is, which needed a second discard in
`stage.ts` beside the one that already existed. The two differ in one line: `discardWalls` is consent
to **regenerate**, so it clears the walls' history because its snapshots describe a document derived
from ink the GM has just changed, while `clearWallEdits` is a press aimed at the graph with nothing
upstream moved — the old document is a state that existed a moment ago and is a perfectly good one to
return to. *Clear everything* stays the single exception, which is why it is the one place "this
cannot be undone" is true.

**Both layers, not one** (user, 2026-09-18). The per-brush control is deliberately narrower, on the
stated ground that *"discarding the suppression because a stroke of added ink went wrong would be one
button destroying work it was never pointed at"* — but that argues against widening a button sitting in
*a brush's* drawer, not against an area-level one. A GM does not perceive two layers; they perceive
their edits.

**What *Clear ink edits* takes is what is DRAWN, not only what is stored.** In a drawer it could never
have met a brush, since opening a group puts the verb back to Pan, which commits both layers and lets
the working copies go. In the strip it is reachable with a brush still down and strokes still
unwritten, so the snapshot it takes — and therefore what one undo hands back — is the layers on
screen. An open brush has its working copies re-taken against the layers that now exist, rather than
being abandoned, or it would go on drawing ink that has just been thrown away.

**Emptiness is answered at the press, not by greying the button out.** The strip's rule that *a
control offered where its presses do nothing is a control that lies* is about what is structurally
unavailable — no map, no graph — and that is what these are gated on. Whether there is anything to
clear *right now* means walking the raster, and an untouched working copy is the case with no early
exit: nine million comparisons a layer on the largest map tried so far, in a strip that redraws on
every tool change. So it is asked once, when pressed, the way the Defaults button answers the same
question.

**The two area-level buttons are not peers in cost, despite the parallel names.** The ink is upstream, so
clearing both paint layers changes the composite, which re-derives the walls, which takes the wall edits
with it. *Clear ink edits* is therefore also a wall-edit discard; *Clear wall edits* touches nothing
above it.

> **The cascade is the cover's to name, not the confirmation's** (user, 2026-09-20). This used to read
> that the name stays about what the button does directly and *the confirmation carries the cascade*.
> It does not: *"the cover over the map and ink tools delivers a warning that these tools will remove
> wall edits, so by the time the user can touch the tools, they don't need another warning."* The
> button is a member of that cover like everything else on the ink side, so by the time it can be
> pressed the question has been asked and answered and the walls are already a derivation. Its own
> confirmation speaks about the ink alone.
>
> **The stand-in went with the cover, on 2026-09-20.** Until then the button wore the walls mark and
> a press raised the review rather than clearing. It is at the foot of the Ink band, so the lid is
> over it in exactly the case that was true — and by the time it can be pressed the question has
> been asked and answered and the walls are a derivation again.

**The marks survive a wall-edit clear** (user, 2026-09-18, against a first instinct to couple them). A
mark is a point in graph units that suppresses whatever region holds it, and it already survives a
**rebuild** — the whole graph refitted from changed ink, far more violent than this button. Taking the
marks would make the gentle, explicit recovery **strictly more destructive than the accident it exists
to undo**, which reads as a bug. Three things compound it: the name says *wall edits*, and placing a
mark is not a hand edit; marks can never go stale, since they are points rather than region references;
and it would re-create the cross-document reach that was a reported defect — *"changing parameters on
the walls shouldn't delete ink edits"* — fixed by tagging undo entries per document. **One rule
instead of a split:** marks survive anything that re-derives the walls, and only their own tool or
*Clear everything* removes them.

**Clearing them gave *Suppress region* its first drawer.** The tool has no settings, so nothing
declared one — and `toolHasControls` asks the step declarations alone, on the argument that *a tool
acquiring its first setting gets a drawer without anything else being told*. It now has a group in
Walls with **no parameters**, which is the same hook used for an action rather than a slider; a
second list of "tools with a drawer" beside the list of "tools with settings" would be one fact told
twice. `steps.test.ts` pins it, because without the group the button is not misplaced but
**unreachable**, with the press that should open the drawer clearing it instead — no error, no
failing test, a control that is simply not there. **What changes for a GM:** arming *Suppress region*
now opens a drawer, where it used to clear one, exactly as Mend and the brushes do.

#### Straighten and Prune became tools, and the Walls drawer went — 2026-09-21

**They had never been drawn at all**, and that is the finding rather than the change. `wallAmounts`
and the frame button were both registered into the Walls group's **bottom** slot, and the registry
keeps one render per slot — so the second silently displaced the first from the day pruning joined
straightening. Nothing said so: no error, no failing test, a drawer that simply looked thin. It is
the failure §8 already names one level down, *keys are contracts, and a test that reads values
cannot see them*, and it is why neither amount had ever been in a room.

**They are two tools now** (user, 2026-09-21): *"They should be distinct tools in the rail."* Each
sits in the Walls band with a drawer of its own holding its one slider.

- **The latch is untouched, only the event is renamed.** It pinned when the Walls group's drawer
  opened and applied when it closed; it pins when the tool's drawer opens and applies when that
  closes. Arming the tool *is* opening the drawer.
- **`drag: "pan"`, which no other verb may take.** Neither takes a gesture — an amount applies to
  the walls in front of the GM rather than to a point they aim at — so a plain drag goes on panning
  while one is in hand. `steps.test.ts` names the two as the exception rather than counting them,
  because a cap would let a third through.
- **No parameters, and a group each so the drawer exists.** The handle is not a setting: nothing is
  stored and it starts at zero on every opening. The group is *Suppress region*'s precedent —
  without one the press that should open the handle clears the drawer instead.

> **The cost, stated:** each holds its own latch, so arming one commits the other. They shared a
> pinned base and a single undo entry, and with both aimed the straightened result was substituted
> while Prune's red marks went with it. **That interaction is gone** — two presses, two entries, and
> never both aimed at once.

**The frame button became the second act in the strip**, at the foot of Walls above the clear bin,
and it is **the first act that adds rather than destroys** — so "an act is a destructive press" turns
out to have been a coincidence of there being one example. It asks nothing before it runs, which it
never needed to. `bandActs.ts` states the order once, adds before destroys, so the bin is the last
thing in every band and the foot of the column means the same wherever the eye lands.

**And the Walls group lost its opener**, because nothing is left to open: a button offered where its
press does nothing is a control that lies. `stepHasDrawer` asks the three things the body actually
draws rather than `stepParameters`, which counts a *tool* group's controls — the same confusion that
made Walls' **Defaults button orphaned**, resetting the two Mend settings from a drawer holding
neither. Defaults now follows what the body drew.

**The glyphs, chosen at strip size from ten candidates** (user, 2026-09-21). *Straighten* is the same
wall twice, crooked then straight, with vertex rings at both ends because the fitter keeps both ends
and drops what is between; **nothing sits between the two**, and a dot that said *one thing, twice*
was the smallest mark in the band while dimming the crooked side was ruled out because the strip
already dims a disabled glyph to 0.65 and the two would stack. *Prune* is a long wall — running off
both edges, wearing no end rings, which is what says it is long — with a stub and a single slash
through the stub, borrowing Dissolve region's rule that **where the mark sits says what goes**.
*Add walls around the map edge* is the map picker's own picture with a vertex ring at each corner,
which is what the button builds: four segments as one closed run, corners shared by construction.

**The band is ten buttons now** and has no settings opener, which is the first group without one.
(Eleven since *Collapse small regions* joined it the same day, under Prune.)

##### Three corrections from the first room — 2026-09-21

**The readout was printing inside the label** — *"Straighten7"* — and that was the whole of the
original complaint. The amount rows set `setting` and `readout`, and **neither class exists in the
stylesheet**, so the label and the readout were two inline elements with nothing placing them and
nothing colouring them. They use the ordinary row's markup now: `row > top > (label, value)`, where
`.row .top` is the flex that pushes the readout right and `.row .value` makes it monospace and
yellow. No `track` wrapper, which exists to position a ghost mark and an ink profile against the
rail; an amount has neither.

> **This is §8's class sweep from the other side, and it now has a test.** That sweep finds a *dead
> rule* — a selector nothing matches, like `button.tool-band` scoped to what had become a `<p>`.
> This is a class something **sets** that no rule styles, which fails more quietly still: the element
> is there and merely unstyled, so nothing is missing and nothing is misplaced. `elementIds.test.ts`
> carries it, beside the id contract it already held, and a module's own source counts as a
> stylesheet so `confirmDialog.ts` keeps carrying its rules in a template string. **Five mutations,
> five caught**, the last only after a fixture was written for `classList.add`: every class added
> that way happens to be styled today, so the branch was never exercised by the real sources.

**The readout is the handle's place, 1 to 100, not the amount** (user): *"the values are not user
friendly anyway, let's turn them into 1-100 just for remembering your place while trying them."* It
printed graph units in exponential notation — a graph unit is a fraction of the map's longer side,
so the useful settings sit around a thousandth and the readout was a mantissa and an exponent. **It
is a position and makes no claim to be a measurement**, which is honest: nothing is stored, the
handle starts at zero on every opening, and the only question it answers is *where was I before I
dragged past it*. The real figure still reaches the log on every commit, and **"off" is read from
the amount rather than the handle**, so a latch voided by an undo says so even with the handle left
where the GM put it.

**Both amounts draw handles.** The set that decides was *the tools that grab a point*, which is why
Mend, Dissolve region, Suppress region and Span have none; the rule it states is now **the tools
whose work is at the vertices**. Straightening drops the ones between a run's ends, and pruning
needs them for the correction below. Neither grabs anything.

**A doomed stub's junction goes red with it** (user): *"when a stub turns red, its base vertex
should, too, even though it's not actually disappearing. That will help with visibility for tiny
stubs."* **This reverses a recorded decision**, and the reasoning it overturns was sound: marking the
junction is the preview claiming something the button does not do, since that vertex keeps its other
walls and stays exactly where it is. What the room weighed against it is that a stub worth pruning is
a couple of pixels at map zoom, and two red handles either end of it are far easier to catch than
one — a preview nobody can see is worth less than one that over-claims by a vertex.

> **The over-claim is confined to the drawing.** `spurEdgesToPrune` returns the junctions as their
> own set, `anchors`, beside the `vertices` that actually go; the operation and the log read the
> honest one and only the layer unions them. The two are **disjoint and cover** the doomed edges'
> endpoints, which is what lets the caller union them without asking anything else, and is asserted.
> **Five mutations, five caught** — one only after the off-state test was made to assert the set it
> had never looked at.

#### Prune became a ringed tool — 2026-09-22

**Built, not yet in a room.** *Prune the dead ends* rings what it would take, a click takes one ring,
and a button takes them all — Mend's and *Collapse small regions*' gesture. **As an amount it "feels
inconsistent"** (user) beside the two ringed tools under it, and the parked item was already there.
Straighten stays an amount, because it changes every wall at once and has no piece to ring.

**The whole cascade runs before the rings are placed** (user: *"so the rings and the red marks agree
with what will actually happen"*). That forced the unit of a ring, and the shape of a cascade supplied
it: **every connected lump of doomed runs is a tree hanging off exactly one vertex that stays**, or off
none when it goes entirely. It cannot hang off two, because a run on a path between two surviving walls
never becomes a dead end at any round. So **one ring per piece** (user, over one per run): a hair, or a
whole star of short strokes, and the red inside a ring is exactly what a click on it takes. A ring per
run would have put a ring on a star's middle arm whose click could not take that arm alone without
leaving the strokes beyond it floating.

- **`trace/prunePieces.ts` groups the doomed runs through the vertices that go and never through the one
  that stays**, so two hairs off one junction are two pieces. It reads the existing decision,
  `spurEdgesToPrune`, and adds only the grouping, so the rings, the red and the button cannot disagree
  with the prune every derive already runs. **Six mutations, six caught** — the last after a fixture
  pinned that a piece's points include the vertex it hangs off, which the ring is built from.
- **The oracle checks the tree claim over random linework** rather than trusting the argument: the
  pieces partition the doomed walls, each is a tree, each touches at most one surviving vertex read
  straight off the walls that stay, **taking any one alone strands nothing** by a union-find of its own,
  and taking all of them is exactly `pruneWallGraph`. Every case is asserted as reached — a freestanding
  piece, an anchored one, a star, two pieces off one vertex.
- **The length starts at four ink widths every opening**, decided in building: twice the automatic
  prune's two, so the first rings are the next band of dead ends above what every derive already took.
  **Reasoning, not measurement.** The track is unchanged — off, then log from the shared floor up to the
  longest wall run.
- **The red junction is gone.** It was the over-claim a room asked for on 2026-09-21 so a two-pixel stub
  could be seen; the ring does that without marking a vertex that stays. The handles stay red for the
  vertices that actually go.
- **The latch is Straighten's alone now.** Prune's half of it would have been dead code the moment Prune
  stopped being an amount, so it came out: one amount, one undo label, nine mutations nine caught.
- **The ring hit-test is shared** with *Collapse small regions* — `ringGesture.ts`, which takes points
  and knows neither tool's shape — rather than copied.
- **The walls layer's red preview is unchanged in look**: wall width, red handles, drawn under the
  rings. Only its source moved, from the latch to the tool's own search.
- **One press, one undo step; the button, one step.** The old amount applied once on closing the drawer;
  each click is an ordinary edit now, as Collapse's and Mend's are.

**Costs, stated:** a click takes a whole star, not one arm of it — the price of never stranding a
stroke; and the ringed pieces are the cascade *at this length*, so a hair a GM wants kept inside a star
means taking the star and redrawing the hair, or shortening the length until the star breaks up.

#### The band's order: Collapse, Prune, Straighten — 2026-09-22

**The order a GM works in, found by working** (user: *"the natural order of operations for simplifying
this map is Collapse - Prune - Straighten"*). It is also the order the operations feed each other:
collapsing turns small loops into junctions and dead ends, pruning takes the dead ends that leaves, and
straightening last fits what remains rather than fitting walls about to be deleted. The strip is read
top down, so the order it draws is the one it teaches. Mend follows the three, then the hand verbs.

#### Dimming the side you are not working on

**Keyed on the last side the GM touched**, not on the tool in hand and not on the open drawer. Arming an
ink tool, moving an ink control and pressing *Clear ink edits* all mean *I am working on the ink*, and
the same for the wall side. Keying it to the drawer would put the pre-2026-09-14 arrangement back, since
a group stopped being a mode.

- **Wall side → the ink dims. Ink side → the walls dim.**
- ~~**Nothing dims until the first interaction**, so the workspace still opens on the plain
  picture.~~ **Reversed 2026-09-20** (user): the workspace opens with a side already chosen, and the
  document chooses it. **No wall edits → open with the ink undimmed**, which is where a GM with
  nothing to lose is going anyway. **Wall edits → open with the walls undimmed**, which is the side
  they can still work on, since the other one is under the cover.

  **The auto-advance goes with it.** `mapSource` calls `advanceTo("ink")` the moment a map loads,
  which opens the Ink *parameters* drawer — a guess at which controls the GM wants rather than at
  which half of the map they are looking at, and the one route to a drawer that is not a press. A
  start-up dim says the same thing without opening anything, so `advanceTo` and the cover guard
  added to it on 2026-09-20 both come out.

  **What that costs, stated:** the workspace no longer opens on the plain picture, so the very first
  thing a GM sees is already a judgement about what they are here for. It is a judgement the
  document can actually make — unlike *which layer is the subject*, which was rejected for being a
  guess — but it is one more thing that is dim before anyone has done anything.
- **The room fills never dim** (user, 2026-09-18: *"they're already pretty faint"*). They are also the
  consequence a GM paints to fix, and the crowding the record complains about is at the *stroke*, where
  the centrelines are and the fills are not.
- **Ink at 0.3, walls at 0.45**, and they differ for a reason: the ink is a flat area fill, while the
  centrelines are **cased** — a light stroke two pixels wider under a saturated core — and the casing is
  what makes them read on dark linework at all, so one number would make the walls vanish before the ink
  did. A starting guess, to be moved by eye.
- **Only two layers move, and the other six fall out rather than being exceptions.** The room fills
  never dim by the decision above; `paint`, `gaps` and `blob` are drawn only while an ink tool is
  armed, which *is* the ink side, and `mends` likewise on the wall side, so a tool layer can never
  **be** the dimmed side; `delta` belongs to the review, which is a question about both halves at
  once.
- **No toggle, for now** (user): *"let's see if requiring it feels ok."* **The cost:** once work begins
  one side is always dim, and there is no both-full state. That is what a toggle would buy.

**It reverses two recorded decisions and the reason they no longer bite is worth keeping.** Per-layer
opacity was removed outright in September, and automating *which layer is the subject* was rejected
because that is a judgement and guessing it wrongly is worse than leaving it. The subject is not being
guessed here — the GM has explicitly picked up a brush or a wall tool.

##### As built — 2026-09-20

**One place applies it: the paint loop in `shell.ts`.** It already walks the painters in registration
order asking whether each layer is active, and it now sets the canvas alpha on the way past and
resets it after — so no layer module learns that dimming exists. That is `proposeLayers`' own
argument one level down: two callers deciding a layer's appearance means the answer depends on which
ran last. `regions.ts` sets its own alpha internally and restores 1, which would stamp on an outer
value; harmless, and not a coincidence, since the room fills are the layer that never dims.

**`workspace/subject.ts` is the decision, pure and tested** — which side is the subject, and the
table saying which side each layer belongs to. **The table is total over `LAYERS` by type**, so a
ninth layer has to be filed rather than defaulting to *never dims*, which is a layer that stops
obeying the rule with nothing to say so. **Twelve mutations, twelve caught.**

**Seven places say which side the GM is on**, and the first covers almost everything: arming a tool
in `apply`, since a brush, a gap, a blob, a wall verb, a mend, a span and a mark are all tools. Then
a slider release in `settingRows`, the two amounts in `wallAmounts` which draw their own tracks, the
frame button, the two clear acts in the strip, agreeing to regenerate, and `startOn` at the load.

**Decided while building, and worth checking in a room:**

- **A slider release says its side before the no-op check**, so a handle dragged away and back still
  counts as working on that half even though it writes nothing.
- **Agreeing to regenerate moves the subject to the ink**, because unlocking the ink is why anybody
  presses the lid — and the walls a moment later are a fresh derivation rather than anything of the
  GM's, so there is nothing on that side left to be working on.
- **`startOn` is not `workOn`.** It is the document speaking rather than the GM, and it has to move
  the subject in **both** directions: loading a clean map after an edited one is reachable by
  nominating a different image, and it has to come back to the ink.

**The drawer opens on nothing, and that took a second attempt.** Deleting the advance left the
drawer at its initial value, which was the **Map picker** — so a map that had already been nominated
opened with the drawer asking the one question that had been answered, and a room found it the same
evening (2026-09-21). The initial value is `null` now, and `mapSource` opens the picker in the one
case that needs it: a load that finishes with **no map**, which is the only thing a GM can do
anything about from there. **It needs no guard against stealing a drawer they opened in the
meantime**, unlike the advance it replaces, because with no map every other opener in the strip is
disabled — the only drawer they could have opened is the picker itself.

**Two deletions fell out of it.** `advanceTo` went, with the cover guard added to it that morning —
it was the only route to an open drawer that was not a press, and a drawer is a guess at *which
controls* where a dim is a statement about *which half of the map*. And `touched` went with it:
five presses wrote it and `advanceTo` was the only thing that ever read it, so it had become
**write-only state**, which is the reachability question this project asks of every export one scope
down. `loadNominatedMap` lost its `opening` flag at the same time, since nothing behaves differently
on the first call any more.

#### The cover

**One cover over the map picker and everything on the ink side**, raised only while the stored base
differs from the document. **The map picker is a member and was not before**: nominating a different map
discards the graph outright, since a graph is stored in graph units of *a* map and the marks record their
map too, so it was the most destructive thing sitting outside the lock.

**Clicking the cover raises the existing review state, not a dialog** (user, 2026-09-18). The dialog was
deliberately removed on 2026-09-15 because *"panning is required to answer the question, and a modal is
the thing that prevents panning"* — the dialog asks *do you understand the cost* and the review asks *is
the cost acceptable*, which can only be answered by looking around the map. Unlocking destroys nothing;
only using a tool that re-derives does.

**One edge the picker's membership creates.** The gate reads "no base, or a base for another map" as
*assume it was edited*, which is deliberately the loud answer — so a scene whose nominated map has gone
missing would raise a cover over the picker warning about wall edits that may not exist. The wording has
to survive that case rather than assert something false. **As built it says what the comparison
measures** — *these are not the walls the trace derived* — which is true every time it fires.

##### As built — 2026-09-20

**It is a lid, and there is no glyph on it** (user). The strip is a column of glyphs, so another
glyph in it is another tool to read past; a lid is plainly not a button of the kind underneath it.
Four glyph candidates were drawn at strip size beside their real neighbours and all of them lost to
this. The lid is **flush to the rail** on three sides — the rail's own padding at the top and both
sides — and rests on the rule between Ink and Walls at the foot, with a 2px blue border, a little
corner rounding and an embossed edge that is the one raised object on a surface of flat fills and
hairlines.

**It lightens rather than darkening**, which is the part doing the real work: the tools underneath
stay legible at half strength, and *readable but unreachable* is the honest picture of the state,
where a dark scrim says gone. **The covered half is `inert`, not disabled** — dimming does not stop
a tab reaching a control and the lid stops only a pointer, while `disabled` would dim every glyph a
second time on top of the 0.5 and put the strip's measured 0.65 into a sum nobody has computed.

**The lid is a child of what it covers**, which is why nothing measures it. The strip builds the Map
and Ink bands into a wrapper and the lid fills that wrapper, reaching past it to the rail's padding
by three offsets that are `#tools`' own padding and `.tool-rule`'s own margin. The alternative was
reading the band's extent off `getBoundingClientRect`, and a measurement taken in the same tick as a
render is what once anchored the drawer at 10px while its button sat at 82.

**Three things decided while building, and worth checking in a room:**

- **The cover closes an ink-side drawer as it raises** (user). It is reachable by the one pair of
  controls that ignores everything else on the surface: undo and redo sit in the bar and are pressed
  with any drawer open, so redoing a wall edit while the Ink settings are on screen would otherwise
  leave live sliders behind a lid meant to be in front of them. The same press also **puts an ink
  brush down**, on the rule that already puts the verb back to Pan when a group is opened.
- **The lid brightens where another button would draw pressed.** While the question is up the strip
  marks whatever raised it, and the lid belongs to neither selection group, so it has no pressed
  state to draw.
- **`advanceTo` refuses a covered group**, which is the one route to a drawer that is not a press. A
  map opening with hand edits already in its walls raises the cover before the GM has touched
  anything, and `mapSource` advances to Ink the moment that map loads — and whether the graph or the
  map arrives first is not ordered, so closing on the stage change alone answers one order and not
  the other. Refusing there answers both, and the GM lands on the plain map with a lid on the ink
  side.
- **A literal blue rather than `--structure`.** The walls' own hue is `#1d4ed8`, which over a
  near-black column is a dim navy rather than the blue this was chosen as by looking; the strip's
  other chrome is literal for the same reason. **The cost: retuning the walls colour does not move
  the lid**, and with no glyph and no word on it the blue is carrying the meaning alone — *this blue
  is your walls* reads to somebody who knows the palette and says only "locked" to somebody who does
  not, who learns why on pressing it.

**Membership is declared, and it is deliberately not `stepRegeneratesWalls`.** That question is
asked of a step's *parameters* and the map picker declares none, which is exactly how the most
destructive control on the surface came to sit outside the lock. `stepIsInkSide` and `toolIsInkSide`
state the rework's own division instead — the map and the ink, and the ink band's four tools — and
are the one part of the cover a desk can check. **Four mutations, four caught**; everything else
about it is markup in a module that imports the SDK, and whether it reads as a lid at 52px is a
room's question.

#### What is built, and what is next

**Built and committed**, each commit green under `tsc`, the suite and a build:

1. **The straighten decision hardened.** `simplifyWalls` had been written, tested and called by nothing
   since the editor's button went on 2026-09-14, so its tests had never guarded live code. Seven
   mutations, three survived, each answered by measurement over 174,156 wall runs: a fixture for the
   collapse threshold of four (4,391 of 23,436 closed runs fit to exactly three, 18.7%, and a threshold
   of three turns every one of those rooms into a pair of coincident walls); the `a !== b` self-edge
   guard **deleted** as decided by nothing, zero self-edges on the path the code takes; and
   `run.length > 1` **kept and surviving deliberately**, guarding a cross-module invariant rather than an
   observed case.
2. **`workspace/graphLatch.ts`** — the latch, pure and tested, nine mutations nine caught.
3. **`workspace/wallAmounts.ts`** — both sliders at the foot of Walls, the substituting preview, and
   the commit when the drawer closes.
4. **The fitting tolerance out of settings**, computed in the derive; the `derive` cascade stage deleted
   for having no members; the contingent "a stage cannot be read off a step" assertion deleted.

5. **Prune joined it**, sharing one pinned base and one commit. **The Walls group now regenerates
   nothing at all**, which is the rework arriving: the set of things that rebuild the walls is exactly
   the map and the ink. `steps.test.ts` pins that Walls is unmarked, and says what it would mean if it
   ever went back.

   **Decided while building, and worth checking in a room:** the substitution is used **only when
   straightening is aimed**. Straightening replaces every wall, so the only way to judge it is the
   result; pruning *removes* runs, and the established channel for that is the **red marks**, which say
   *what goes* where a result can only say what is left — a single missing hair being far harder to
   spot than a red one. So pruning alone shows the walls as they are with the doomed runs in red,
   exactly as the slider did, and with both aimed the result is substituted and the red goes with it.
   The commit prunes first either way, so what is drawn is what closing applies.

   The doomed preview also stopped asking `showingSaved()`. Its stated reason was that a fresh
   derivation already had the limit applied because the trace pruned as it built — untrue now that
   nothing applies it on the way through, and it would have hidden the marks on every unedited map.
6. **The graph-only machinery is deleted**, emptied by the same change: `GRAPH_ONLY` and
   `isSkeletonOnly`, the re-prune dispatch with `repruneRegions` and `markGraphOnlyApplied`,
   `graphScaleTop` and `settingRows`' whole measured-track branch, and the mask fingerprint's exclusion
   filter. **This closes the carried question about a fourth cascade stage**, in the direction nobody
   expected: the *third* was the one to delete, and this list went with it.

   Three pieces of reasoning were kept in words where a future control would meet the same trap —
   capping a measured track top at the declared ceiling (a room stored 0.707 against a ceiling of 0.5),
   recording a parameter as applied when the picture cannot show it (or a ghost marks a delay that never
   ends), and the pinned floor, which is live in `wallAmounts.ts`.

7. **The large-push warning names the two amounts**, where it used to tell a GM to raise a slider that
   no longer exists. Its advice is more expensive than it was — both act on the graph rather than being
   free and reversible — so it says so, and that one step of undo puts it back. The module also now
   carries the measurement above, and the fact that **this warning is the only guard on item count**
   there has ever been: the escalation ladder bounds a *face* at 8,192 commands, which is a different
   failure entirely, and the manual guard was the slider that just left.

8. ***Discard changes* is deleted**, with `abandonPaint` and `discardPaint` beneath it — each had
   exactly one caller, which was the chain above. `hasUnsavedPaint` stays, because the automatic save
   loop asks it to skip an untouched layer. *Clear layer*'s confirmation named the deleted button as
   what brings a clear back; it names **undo** now, which is true and was already true.

9. **The three clear buttons**, and a fourth thing fell out of them. *Clear ink edits* and *Clear
   wall edits* are acts at the foot of the Ink and Walls bands in the strip; *Clear all marks* is in
   *Suppress region*'s drawer, which this gave the tool for the first time. The section above carries
   the whole of it — where they went and why, the shared bin glyph and the three candidates it beat,
   the cover owning the cascade warning, and every clear but *Clear everything* being one step of
   undo.

   **New machinery, in three places.** `workspace/clearActions.ts` is the family in one module — the
   three acts, their confirmations, and the two the strip draws, declared as a list so the band a
   press belongs to is stated once. `paintState.ts` gained the one path by which a whole layer is
   replaced, used by the clear and by its undo, which snapshots what is **drawn** rather than what is
   stored and re-takes an open brush's working copies afterwards. `stage.ts` gained `clearWallEdits`
   beside `discardWalls`, differing in the one line that decides whether the history survives.

   **Decided while building, and worth checking:** the strip's act buttons are gated on the same
   structural question their band's tools ask — the ink needs a map, the walls need walls — and
   emptiness is answered at the press instead, because asking it per redraw means walking the raster.
   The marks button wears `chip quiet`, which is what *Clear layer* wears one tier up. And the act
   button takes a little air above it in the strip, since it is not a verb.

   **Almost none of this is testable from a desk.** The one contract that is, and the one that would
   have failed silently, is that *Suppress region* declares a group — without it the button is
   unreachable. `steps.test.ts` pins it: two mutations, two caught, with a third recorded as
   equivalent.

10. **The cover**, as the section above describes it: a lid over the map picker and the ink side,
    raised while the stored base differs from the document, and clicking it raises the existing
    review rather than a dialog.

11. **The per-control gate deleted**, which the cover made dead. Five exports went from
    `regenerateGuard.ts` — `stepIsMarked`, `controlIsMarked`, `toolIsMarked`, the `wallsMark` glyph
    they wore and the `wallsNotice` that explained it — with the per-row lock in `settingRows.ts`,
    the three marked branches in the strip, `ClearAct.marked` and `pressClearAct`, and four orphaned
    stylesheet rules. One layer down, `regeneratesWalls` and `stepRegeneratesWalls` went with their
    only callers.

    **The review collapsed with them.** It held *what* the press was and *what to do* if the answer
    was yes, because a marked tool handed over its own arming; the cover hands over nothing, so
    `reviewRegenerate` is `reviewFromCover`, the `Review` record is a boolean, and the drawer's
    review variant lost its anchor. **Answering now closes the drawer** rather than reopening what
    the anchor described — a lid is not an opener, so there is nothing behind it to go back to.

    **The claim the deleted functions guarded is kept and asked directly**: nothing under Walls is a
    `pipeline` parameter, and Ink is a mixture. `steps.test.ts` reads `PARAMETER_KIND` for both,
    which is all `regeneratesWalls` ever was. **Four mutations, four caught.**

12. **Dimming**, the last item: the side the GM is not working on turned down, keyed on the side
    they last touched, with the document choosing where a map opens. *Dimming the side you are not
    working on* above carries the whole of it.

**Nothing is next — the rework is built.** The walls glyph, which stood here as the last item, is
**moot** (user, 2026-09-20) and dissolved exactly as predicted rather than needing a redraw: it was
a mark on a per-control gate, and both went. The complaint it was raised over generalises and is
worth keeping — *a subject glyph cannot carry a negative consequence* — and it is why the cover is a
lid rather than a picture of walls.

**Only the cover has been in a room.** The rest is all surface, which has no coverage by construction,
so `tsc` and the suite are evidence about the pure halves only. The straighten preview's cost is logged
past 50ms, which is what would say whether the quadratic crossing sweep needs splitting out of the
preview — the geometry-only preview with the sweep left to the commit is the change to make if a room
reports the handle dragging heavily.

### The suspected regression in the ink finding — leads closed 2026-09-21, no code change found

**Every lead the note below named has now been checked, and none of them is a regression.** Measured
from `dev.log`, which covers 2026-09-18 21:29 onward and so includes the window the report came from:

- **The filter's default is `0`** — off — and `git log -S` finds no commit that has ever changed it.
  Every run in the log has it on because the GM turned it on, at settings from 0.55 to 1.75.
- **`morphology.ts` and `inkMetrics.ts` are untouched since 2026-09-15**, so neither the opening
  itself nor the ink-width measurement moved in the window. The radius is computed in `pipeline.ts`
  from the setting times the measured width, and that line is unchanged too.
- **The second candidate is confirmed exactly.** *The Incandescent Grottoes* measures **2.9–3.4px**
  of ink and *Lair of the Lamb* measures **5.3–5.9px** — about half, which is what the megapixel
  budget's factor of 2 does to a raster. The same slider position is therefore a different radius,
  and **"it didn't do that before" can be true with no code having changed: the input changed.**

**What the control actually costs, which is the part worth keeping.** The radius is `round(setting ×
ink width / 2)`, an **integer**, and an opening removes marks narrower than about twice it — so at any
setting near or above **1.0 ink widths the threshold lands at or past the measured width of the
linework itself**. The log says what that costs: 1.2 on the Lamb map's 5.7px ink removes **26.1%** of
all ink; 1.15 on the Grottoes' 3.2px removes **58.9%**; 1.75 on the Lamb map removes **94.2%**. The
maxima are meant to reach absurd values, and these are not the maxima.

> **So the mechanism the user proposed is right and it is the control rather than a defect.** An
> opening retracts a stroke's **end**, because the shape is locally narrow there along its own
> direction — so a radius one notch high leaves exactly the reported artefact, *little bits missing
> at the ends of walls, making small gaps all over the map*. And the slider has about **ten stops per
> distinct radius**, so a nudge crosses into the next one with the map redrawing identically on the
> way.

#### And then the symptom was described properly — 2026-09-21

**The framing above is answering the wrong question**, which the user said outright: *"maps that used
to have continuous walls robustly against the ink settings now get little gaps at corners. It's a
tiny amount of change in the ink that becomes wall, so checking how much ink is lost won't catch
it."* That is correct about every figure quoted above, all of which are **totals over the map**.

Three more leads were closed on that reading, and one of them by a measurement worth keeping:

- **`inkIslands.ts`' rewrite is faithful.** The diff was read rather than reasoned about: `walkIslands`
  was extracted, the labels stayed consistent (island `i` carries label `i + 1`), and the test
  `span >= minSpan` is unchanged. The note below dismissed it with a connectivity argument that has a
  hole — the stroke filter runs *first* and can disconnect a corner — so it is worth saying that the
  diff, not the argument, is what closes it.
- **The fitting tolerance becoming computed did not change the fit.** `dev.log` happens to straddle
  `0a6d734`, because the commit landed at 21:15 and the running page was not reloaded until after
  21:29 — so there is a run on each side, on the same map at the same tolerance. **6331 points in
  6256 commands before, 6332 in 6257 after**, both at 1.42px, both dropping 2 collinear points, 1
  coincident segment and 2 of no length. One point.
- **The coincident and zero-length drops are not new.** They are 1 and 2 on *both* sides of that
  commit, so whatever they are costing, they were costing it before.

**What was missing was an instrument, and now there is one.** Every figure the derive reported is a
sum over the map, and a handful of broken corners moves none of them enough to see. `describeWallFaces`
now prints **pieces** and **free ends** on every run, both of which were already computed —
`components` is the right-hand side of Euler's identity.

> **`freeEnds` is the sensitive figure and `components` is not**, which a fixture corrected while it
> was being written. **A loop broken once is still connected the long way round**: it stops being a
> loop and becomes an open chain, so the piece count does not move at all. A parted wall turns no
> free ends into two. `components` moves only when a break *severs* something — a stub coming away,
> a network splitting — which is the louder failure and the rarer one. **Four mutations, four
> caught.**

#### A severance costs an ink width, and that is why it belongs on the ink side — 2026-09-21

**Measured in a room** (user): at the reported point, *"there's a 2 pixel gap in the ink, resulting
in a ~9 pixel gap in the graph."* That is the amplification, and it is exactly what thinning's
recorded free-end retraction predicts — Zhang–Suen pulls a free end back by `(w + 1) / 2`, and a
severance has **two** ends:

> **A break of `g` pixels in the ink becomes `g + w + 1` pixels in the graph.**

On that map's 5.7px ink that is `2 + 6.7 = 8.7`, against a measured ~9. **The penalty is additive and
does not shrink with the break**: a one-pixel nick in the ink still costs 7.7px of graph, because the
retraction is a property of the stroke's width rather than of the damage.

**Three things follow, and the third is the design conclusion.**

- **Welding could never have healed this**, which corrects the section below: its radius defaulted to
  3 and the skeleton gap here is ~9. The severance and its retraction both happen before any weld
  would run. That section stands as the history of the only automatic healer there has been, and not
  as the explanation of this gap.
- **There is no such thing as a small break in the graph.** Every mend has to bridge at least an ink
  width, which is why Mend's distances are seeded at 20 and 40 raster pixels rather than at
  something small — a figure that looks generous and is not.
- **Two pixels of ink is a far cheaper thing to fix than nine pixels of graph** (user's instinct,
  2026-09-21: *"that might be the place to put it, since it comes from an ink parameter change"*).
  Repairing before thinning means no free end, no retraction and no break at all; repairing after it
  means bridging the full `g + w + 1`. The deleted comment said the same thing from the other side —
  the repair *"has to see the damage"*.

**What the ink side has ever had**, since the question was asked directly: `applyGapFill` ran inside
the pipeline immediately after the stroke filter from 2026-08-23 until 2026-09-05. Its default was
**12 for part of its first day, then 0** until it became a tool — so it was automatic *per derive*
but never on unless a width was set. The tool's search default is 12 again today, which would find a
two-pixel gap easily; what it does not do is run without being armed.

#### The automatic healer was welding, and it went on 2026-08-30

**Ruled out first** (user, 2026-09-21): the break repair below is *not* what they remember, because
it required setting a slider. *"I feel like the ink sliders just worked and didn't create small gaps.
Not that I could repair them easily when they appeared."* That is a sharper claim and it points at
something with **no interaction at all**.

There has been exactly one such thing, and its own documentation says what it was:

> *"How far apart two ends of the skeleton may be and still count as one node, in raster pixels …
> **it is the same operation as closing a gap**, so a radius that reaches across a doorway welds the
> doorway shut, and a radius longer than a short wall welds that wall into nothing."*

**`weldRadiusPx` defaulted to 3** and applied on every derive. It collapsed any two skeleton chain
ends within three raster pixels onto one shared node — which is precisely what an opening leaves at
a corner. Nothing had to be set, and nothing announced it. `5c5acf3`, *Stop the graph moving points,
and find the slivers instead*, deleted it on **2026-08-30**.

**It was deleted for a measured reason and must not come back.** Welding moves a chain's endpoint to
a node it was not on, and the moved end is then walked there along an invented lattice path that can
cross other linework — so the embedding stops being planar and a half-edge traversal stops meaning
anything. Measured over generated linework: **21 failures in 600 at radius 0, 459 in 600 at the
radius 3 that shipped.** §4 carries the table and the rule it produced — *deleting is allowed,
inventing is not* — and the control was **deleted rather than defaulted to zero** for that reason.

**So the capability was real, the memory is accurate, and the removal was right.** What is missing is
a successor that closes a break *without moving a point*, and one exists: **Mend** does exactly this
on the graph, planar-safely, with distances seeded per map at 20 and 40 raster pixels. The difference
is that it is a tool a GM arms, and welding was a number that was simply on.

> **The timing does not line up on its own, and that is worth stating rather than smoothing over.**
> Welding went on 08-30 and the gaps were reported on 09-18. The reconciliation that fits is that
> the stroke filter's destructiveness was unexercised in between: the **ink profiles shipped on
> 09-17 and 09-18**, and their whole purpose is to invite moving that handle. So the filter may have
> been severing since 08-30 with nobody pushing it far enough to see. **Unverified** — `dev.log` only
> reaches back to 09-18, so there is no record of where that slider sat before.

#### A second thing went too, and it is not what the user means

##### The stroke filter also lost its repair — 09-05

**The user was right and the two sections below are both too narrow.** They said the complaint was
not *where* on the slider the cliff sits but that the result *used to be more robust to slider
position*, and asked for the full history of the filter and everything downstream. Every window
searched before this one started at 2026-09-16; **the change is 2026-09-05**.

`e118e00`, *Gap repair becomes a tool inside Add ink*, took the automatic repair out of
`pipeline.ts`. The comment it deleted states the dependency in the code's own words:

> *"Runs after the minimum stroke width specifically: **part of its job is repairing what that
> control severed**, so it has to see the damage."*

**The two were a designed pair.** The stroke filter severs thin things — which is what it is for —
and the repair ran immediately after it, saw the damage, and closed it. Since 09-05 the filter
severs and nothing closes. That is the robustness that went, and it went without the filter or any
of its downstream changing: `radiusForWidth` has not been touched since it was written on 08-23,
`morphology.ts`' only later change was an aliasing fix at radius 0, `inkMetrics.ts` has not changed
since 09-01, and `inkIslands.ts`' rewrite is faithful.

**Measured, and it bounds who this affected:** `gapFillPx` defaulted to **0**, so the repair was off
unless a GM set a width. Anyone who had set one — which is the case here — got severances sealed on
every derive.

**Reasoned, not measured:** a corner severance should be exactly what that search finds. A gap is *a
narrow channel of ground whose banks of ink are far apart measured along the ink*, and the two halves
of a parted wall are as far apart along the ink as going the whole way round the room. What is not
established is whether the width and travel settings in use would have caught these particular
breaks.

**Nothing here argues the change was wrong.** The reason it was made stands and is in §4: an
automatic threshold *re-invented ink on every recompose*, so it was never one-time consent, and as a
tool the writing is an act. What was lost with it is the pairing, and **the surface no longer says
anywhere that the two controls belong together** — which is the part to fix, not the tool.

> **Three candidates, none of them built.** Run the search automatically after the stroke filter
> moves and *ring* what it finds without filling, which restores the visibility without re-inventing
> ink. Or say it in the stroke control's own text, which is one sentence and no machinery. Or note
> the severance count from the filter itself, which it already knows.

#### Answered by a room — 2026-09-21: it is the rounding boundary, but that is not the complaint

**The user found the setting it happens at**: on the map where they first saw it, *"for thinnest
line, a gap opens between 0.85 and 0.9"*, near a named point with similar features nearby. That
settles it, and the arithmetic is exact.

`radiusForWidth` is `round(width / 2)` where `width = setting × inkWidth`, and that map's ink
measures **5.7px**:

| setting | width | radius | marks removed under |
|---|---|---|---|
| 0.85 | 4.845px | **2** | ~4px |
| 0.90 | 5.130px | **3** | ~6px |

**One notch of 0.05 moves the threshold from 4px to 6px, across linework that is 5.7px wide.** At
0.85 the filter cannot touch a wall; at 0.9 the threshold is above the ink width — and **a corner is
locally narrower than the stroke along its own direction**, so corners go and the rest survives.
That is the reported symptom exactly: robust, then a few tiny gaps, with no visible change in bulk.
It is also why a total cannot see it.

**Two consequences worth keeping.**

- **`Math.round` gives more filtering than was asked for.** 0.9 requests 5.13px and gets a threshold
  of about 6px, which is **1.05 ink widths**. `Math.floor` would guarantee the effective threshold
  never exceeds the request — at the cost of a weaker control at every setting, and of changing
  what every scene already tuned does. **A decision, not a fix**, and not taken.
- **The cliff moves with the measured ink width**, which is how *"it didn't do that before"* can be
  true with nothing changed. The radius flips 2→3 when `setting × inkWidth ≥ 5`, so the boundary is
  at `5 / inkWidth`: **0.94 on a 5.3px reading and 0.85 on a 5.9px one**, and that map measures
  anywhere in 5.3–5.9 across the log depending on blur, k and window. A small change in the reading
  moves the cliff across a notch and a setting that was safe stops being safe.

**So there is no regression, and the control is working as built.** What is wrong is that it is
*unreadable*: about ten slider stops per distinct radius, so six nudges do nothing and the seventh
takes the corners off the map. The stroke profile already draws the distinct outcomes — nine bands
on that map — beside a track with sixty stops.

> **The fix, when it is taken, is the one this project has already used once**: step the control so
> consecutive positions are consecutive outcomes, as the gap width is stepped in twos *"because the
> value is halved and rounded to a closing radius, so consecutive odd and even settings produce the
> identical repair."* Here the stops would have to be **measured per map**, since the radius depends
> on the ink width — which is the graph amounts' own pattern, a track whose top is measured when the
> tool opens.

**Free ends are still the instrument for confirming it**, and now cost nothing: derive at 0.85, read
the count, derive at 0.9, read it again. The difference is two per broken corner.

**What is still not established**, and it is the honest remainder: nothing here compares the *same
map at the same setting* across the suspect commits. The decisive test is a room on an older build,
and it is not worth one — the leads that would have made it a code change are closed, and
`inkIslands.ts`' rewrite still cannot produce this symptom for the reason the note gives: a bit at a
wall's end is connected to the wall network, so it belongs to the one giant island and is never
removed.

**Held, not built:** the stops-per-outcome problem is real and now has a figure against it. Stepping
the slider so that consecutive positions give consecutive radii is the fix, and it is the same
defect this project already treated once — the gap width is stepped in twos *"because the value is
halved and rounded to a closing radius, so consecutive odd and even settings produce the identical
repair."*

#### The original note, kept because it is what the checks above answered

### A suspected regression in the ink finding — reported 2026-09-18

**Reported (user, 2026-09-18), and nothing here is confirmed:** *"I get little gaps in the ink now
that I never got before. I think they come from the setting for the thinnest line to keep. If it's
too high I lose little bits at the ends of walls, creating small gaps all over the map. I'm pretty
sure it didn't do that before."*

Deliberately not investigated at the time — it was raised as a sidebar during the workflow
conversation and parked so the surface rework could proceed. **This is the note that has to survive a
cold session**, so it carries the leads rather than only the symptom.

**The mechanism the user proposes is sound.** *Thinnest stroke to keep* is a morphological opening —
erode by k, then dilate by k — and an opening retracts a stroke's **end**, because the shape is
locally narrow there in the direction along the stroke. So a radius one notch too high genuinely
does leave small gaps at wall ends, which is the worst artefact this project has, since a gap merges
two rooms.

**What actually changed in that window, by commit rather than by memory:**

- **`morphology.ts` was NOT touched** — so the opening's own code is not the change. The four commits
  in the window (`5a29ea5`, `aacf124`, `c21a674`, `ad65e3b`, `7eb8d72`) leave it alone.
- **`inkIslands.ts` WAS substantially rewritten** in `c21a674` — 61 insertions against 18 deletions,
  when `walkIslands` was extracted so the island profile could share the filter's own walk. That is
  the only ink-path file whose behaviour changed. **But it probably cannot produce this symptom:** the
  island filter removes 8-connected components short on both sides, and a bit at the end of a wall is
  connected to the wall network, so it belongs to the one giant island and is never removed. A lead to
  rule out rather than the prime suspect.

**The two candidates that do not require any code to have regressed**, and the first is the one to
check first:

1. **The setting may simply be higher than it was.** The stroke profile shipped in this exact window
   and its whole purpose is to invite moving that handle — and the record already notes the slider has
   about **ten stops per distinct outcome**, so a nudge can cross into the next real radius with the
   map redrawing identically on the way. **`dev.log` records the settings on every derive**, so this is
   answerable by a grep over the log rather than by reasoning. Do that before reading any code.
2. **The radius is derived from the measured ink width**, which is a property of the map rather than of
   the setting. *The Incandescent Grottoes* is the first map in the project's life to trigger the
   **megapixel budget** — reduced by a factor of 2 — so its ink is about half as wide in raster pixels
   as an uncapped map's. The same slider position therefore means a different radius than it did on
   any earlier map. **So "it didn't do that before" may be true and still involve no regression: the
   input changed.**

**What would settle it**, in order of cost: the log grep above; then the stroke profile itself, which
draws ink per stroke width against the slider's own track and will show the linework sitting in a band
the handle has passed; then, only if both come back clean, a mutation run over `c21a674`'s changes to
`inkIslands.ts`.

### The decisions, in the order to take them

1. ~~**The fractured save-then-buttons workflow.**~~ **Answered and built on 2026-09-14.** It was the
  largest, and three of the others waited on it.

  **What it was.** The graph was a *derivation* before the save and the *document* after it, so
  straightening and pruning changed from free live sliders into buttons with confirmations —
  through a second setting in straightening's case — and the operation a GM had just spent time
  tuning was offered to them again as though it had not happened. The seam was crossed by a button
  called *Put the walls on the map*, and closing without pressing it committed nothing.

  **What answered it: the seam is not a place, so it stopped being one.** There is no save button.
  The wall tools act on the graph that is **drawn**, so a map that has been read can be edited
  immediately, and the first edit that changes something adopts the derivation as the document —
  because that is the moment a document becomes necessary. Closing commits and pushes.

  Straightening and pruning are one live slider each. Changing either regenerates the walls exactly
  as a threshold does, which leaves the surface with **one rule instead of two shapes**: *anything
  that regenerates the walls discards what you edited into them.*

  **The irreversibility is priced where it costs something.** A mark on the groups whose controls
  rebuild the walls, whenever the graph is no longer what the trace derived; a line inside those
  groups saying what the mark means; and the dialog at the release that actually destroys. Marker at
  the navigation, dialog at the mutation — a dialog on *opening* a group would ask the question every
  time a GM went to look at a number, which is how someone learns to dismiss the one warning that
  matters.

  **Consent is the document being thrown away**, not a flag recording that consent was given. With
  nothing stored the derive is free to run and the push adopts what it produces, which is the state a
  map that has never been edited is already in — so there is one path rather than a consented one
  beside it.

  **Three costs, stated.**

  - **You can no longer tidy a graph you have already hand-edited.** Draw three walls, then decide to
    prune hairs, and the three walls go with it. The sliders are free until the first edit, which
    matches the order the work naturally goes in — pruning and straightening clean up trace
    artefacts, hand edits add what the trace could not find — but it is a real loss against what the
    editor's buttons allowed.
  - **A slider release does not commit.** A scene write is the better part of a second, so between a
    derive and a push the stored document is deliberately behind what is drawn. `commitDerivation`
    closes that gap before anything reaches the scene.
  - **It is unproven.** None of it has been in a room. Every behavioural change here is in the
    surface, which has no coverage by construction.

  **The delta view is built — 2026-09-15.** `trace/wallGraphDiff.ts` computed it and nothing drew
  it; `workspace/layers/delta.ts` now does, over the map, for as long as the regenerate dialog is
  up. What the GM added is **amber**, because a derivation would not contain it and it would go;
  what they erased is **cyan**, because the derivation has it and it would come back. The diff's own
  words run the other way — `added` is what the GM did — and the swap is the point: this draws the
  future rather than the past.

  **It is a third kind of layer**, declared as `QUESTION_LAYERS` beside the always-on set and the
  tool layers, and `steps.test.ts` asserts the three cover every layer there is. A layer nothing
  proposes is a painter that never runs, and the alternative was an exception in the test, which
  would have retired that guarantee for the next layer as well as this one. It gets no switch, on
  the tool layers' rule: what turns it on is the thing it is about, so a second handle would be a
  way to answer the question by hiding it.

  **And the dialog went with it, the same day.** Panning is required to answer the question, and a
  modal is the thing that prevents panning (user: *"maybe the dialog isn't the right idea if there
  is interaction needed"*). The prompt was asking two questions at once: *do you understand what
  this costs*, which a box holds fine, and *is what it costs acceptable*, which can only be answered
  by looking around the map. It had already compromised once — drawing the delta behind itself and
  lightening its own backdrop — and the `reveal` flag that did that is gone again.

  What replaces it is a **review state**. Pressing the lock's key puts the delta on the map and two
  answers in the drawer, level with the button pressed; the surface stays entirely live. Nothing is pending while the GM looks, because
  nothing has happened: the walls are exactly as they were, so wandering off and arming another tool
  is a perfectly good answer and simply takes the marks down. This is `confirmDialog.ts`'s own rule
  one step on — *show the boundary first by disabling what would cross it and saying why* — except
  that it now shows what is behind the boundary rather than describing it.

  **The press is pending, not the walls.** A marked *tool* hands over what to do if the answer is
  yes, so agreeing regenerates and arms the tool in one go, as the dialog did. A locked slider hands
  over nothing: unlocking is the whole act.

  **The answers were in the bar for a few hours, and that was the wrong place** (user, same day:
  *"it's easy to miss those buttons down on the bar"*). The bar was chosen because the question
  arrives from two places — a locked slider inside a drawer and a marked tool in the strip — and it
  is the one piece of furniture both can reach. Reachable from both turned out to mean near neither,
  which is **the same defect the state line had** (decision 2 above, fixed the day before): a message
  about a press arriving as far from the press as the window allows is what once made three working
  buttons read as dead. The fix is placement, not emphasis — colouring the bar louder would have
  treated the same defect as a visibility problem. **Twice in two days**, which is worth reading as a
  pattern rather than as two incidents: this surface's default gravity puts a response in the bar,
  and the bar is nowhere near the rail almost everything is pressed in.

  So the drawer, which is where a press already puts things. It costs the two buttons stacking rather
  than sitting side by side, and a locked slider's own drawer being taken over by the question about
  it — fair, since the slider cannot be touched until it is answered. **Every opener answers the
  question with *keep* on its way past**, which is what makes "wandering off is a perfectly good
  answer" true rather than aspirational: the review is the one drawer owning something outside
  itself, and a press that replaced it silently would strand the marks on the map with nothing able
  to take them down.

  **Two costs, stated.** The destructive action is no longer behind a modal, so a stray click can
  reach it — which is why it is the **second** of the two in a drawer that has just appeared, so a
  reflex press lands on the harmless one, and why it is the only urgent chip on screen. And it is a
  **mode**, on a surface that has been shedding them; the mildest kind, since it changes nothing and
  leaves on any other action, but one.

  Escape answers *keep*, and is stopped there — the shell's own Escape closes the workspace, and the
  reflex that used to dismiss the prompt would otherwise shut the surface. A failed discard leaves
  the review up, which is the honest state rather than a stuck one: the marks still describe the
  walls exactly.

  **The legend names no colour.** It prints *what goes* and *what comes back* in the palette's own
  `subtractive` and `additive`, read as custom properties. Saying "amber" in prose is a copy of a
  value the GM can retune, and it is the one form of that copy no published property can keep
  honest.

  **The counts go to the dev log, not to the dialog.** A delta can be entirely outside the view — a
  GM who edited a corner and then zoomed elsewhere is looking at an unchanged map — and *nothing to
  lose* and *nothing in view* are the same image. The log separates them; the dialog says in words
  that the marks are wherever the edits were. Putting a number in the dialog would be reinstating
  the instrument this whole feature replaced.

  **Unproven.** The delta itself has not been in a room: it needs a map, a derived graph and hand
  edits on it, none of which exists outside Owlbear. The **review** has been driven from a desk, and
  what that establishes is the state machine rather than the picture — the drawer opens level with
  the button that raised the question and that button stays pressed, answering puts the drawer back
  to what the anchor shows, Escape answers *keep* without closing the workspace, reaching for any
  other drawer answers *keep* too, a failed discard leaves the review up and does not run the
  pending press, and the legend takes its two colours from the palette rather than from a hardcoded
  hue.

2. ~~**The state line is in the wrong place.**~~ **Fixed on 2026-09-14, recorded here on 2026-09-15.**

  **What it was.** The line sat bottom-right of a full-screen window while every control that writes
  to it is in the left rail, so a message about a press arrived as far from the press as the window
  allows. That is what made three working buttons read as dead.

  **What answered it: the bar stopped being only the buttons.** The bar now spans the bottom as a
  three-column grid — the message in the left track, the actions centred on the *window* rather than
  on whatever is left of it, and nothing on the right. So the line sits directly under the rail that
  writes to it, and the message and the actions are one piece of furniture rather than two things
  kept from colliding by arithmetic. The old clearance arithmetic and the `:has()` rule that relaxed
  it when the controls were hidden are both gone; the grid track does the bounding.

  It stays **outside `#panel`**, which is the constraint that did not change: it has to remain
  visible with the controls hidden, or a slow close reads as a hang.

  **What that establishes.** The placement is fixed and the surface has been in rooms since — the
  five findings of 2026-09-15 include nothing about it. That is absence of a complaint, not a test:
  nobody has been asked whether a message now lands where they are looking.

3. ~~**The ink-width readouts state a guess too confidently.**~~ **Removed 2026-09-16.**

  **What it was.** The measured ink width is an erosion estimate — biased thin, saturating at 2px,
  and unrepresentative on a hatched or stippled map (§4) — and three derived lines quoted it as a
  fact: the stroke filter's *"under ~4px goes (ink is 3.2px)"*, the two graph sliders' *"…, 1.31 of a
  3.2px ink width"*, and the add-ink brush's *"…, 3.8x the map's ink"*.

  **What answered it was not a better unit.** The candidate here was to report pixels instead; but
  the stroke filter's pixel figure is the setting times the same estimate, so it is the guess in
  another unit. The user's report settled it the other way (2026-09-16): *"I haven't looked at them
  while adjusting settings. Just playing with the sliders works well."* So they went. The stroke
  filter has no derived line now and shows its bare setting at the right; the other three keep the
  pixels and grid squares that come from the raster and the grid, and lose only the ink-width tail.

  **The field went with its last reader.** `Measured`, the bundle of last-run figures a readout is
  handed, no longer carries the ink width, so a readout cannot quote it without `tsc` refusing — that
  is the guard, alongside a test that the stroke filter has no derived line. The pipeline still
  measures ink width, because it seeds the straightening default when a map is first read.

  **Derived lines in general stay, for now** (user, same day). The same report — sliders are tuned by
  watching the map — may apply to all of them; that is a separate question and was not taken.

4. ~~**The one *put on the map* button that is left.**~~ **Kept (user, 2026-09-16).** The question was
   whether *Put on the map* in the bar is needed now that closing pushes, given a GM cannot see the
   result without leaving anyway. The answer is to keep it. The case §6 already makes for it stands:
   it is the mid-session push, for a change a table is waiting on, made without giving up the surface.

5. ~~**Wording for the frame button.**~~ **Settled 2026-09-14** as *Add walls around the map
  edge*, after *Make the outside a room* was doubted in a second room: the exterior is not
  something a GM necessarily thinks of as a room, so the name was guessing at why they were
  pressing it. §7a carries what that cost to learn.

6. **Per-colour opacity wants a GM's eye before it lands**, because it may not fit the design
   language — that is the conversation, and it is explicitly not to be built before it. The **14px
   base size** that shared this item is ~~open~~ **settled 2026-09-16 as no change**: the eye was
   given and every size on the surface looks fine. §7a's typography note carries the figures.

7. ~~**Reconsider the walls mark in the strip.**~~ **Closed 2026-09-20 by deletion.** The mark rode
   on a group's settings button at **18.19px**, the size of the glyph beside it, because the strip's
   `button.tool svg` rule outranked the 13px it gave itself — every size it was ever meant to be
   there was smaller. The cover replaced the whole per-control gate, so there is no mark to resize.
   The measurement is kept because it is the trap: a glyph sized by a rule scoped to its container
   is not the size its own attributes claim.

**And the thing that is not a decision at all: a second map.** The reading is least proven on styles
unlike the one that has been tried — hatched stonework, a printed floor grid, a scan, walls drawn as
texture rather than line. Everything above is refinement; that is where the next real finding is.

### Rules the rooms left behind

Four constraints a later change could break without noticing. Each is enforced somewhere in the code;
these are here so the reason survives the enforcement.

- ~~**The prune limit's slider is in Walls and its button is in Edit walls.**~~ **Retired
  2026-09-14**, and it is worth knowing why rather than only that it went: the rule existed to stop
  one setting growing two handles across two groups, and the button that was the second half of it
  no longer exists. What it was protecting is still true and is now structural — one live slider,
  one handle, and nothing else to declare it to.
- **A control offered where its presses do nothing is a control that lies.** The tool strip always
  obeyed this; the wall actions did not, and answered a press by writing to a state line in the
  opposite corner of the window. Gate before the press, and say why the gate is down.
- **`0.65` is the measured value for a disabled glyph** — the tool strip and the undo pair, at 5.35:1
  against the 3:1 contrast floor, where 0.4 was below it. Locked sliders and drawer buttons use 0.5
  and bar buttons 0.45, unmeasured; §7a says why they were left.
- **The undo stack is cleared when the map it describes goes, and not otherwise.** A different map
  — or a different raster under an open brush — invalidates both documents at once, so those clear
  everything; discarding the wall graph clears that document's entries alone. **Pushing clears
  nothing**, since 2026-09-15: a push is an emit rather than a save, and an emit has no business
  invalidating history. `undoHistory.ts` and `stage.ts` carry the arguments.

  **It is cleared per document since 2026-09-15**, and that narrowing is the fix for a real defect
  (room: *"changing parameters on the walls shouldn't delete ink edits"*). Discarding the wall graph
  cleared the whole stack, so agreeing that a wall setting may rebuild the walls also took away the
  ability to undo a brush stroke — and the paint entries were perfectly good, describing a raster
  nothing in that path had touched. Entries carry an **opaque tag**, so the history still never learns
  what it is restoring; it can only compare. Clearing with no tag still clears everything, which is
  the safe default: a caller that forgets its tag loses history, where one that clears too little
  leaves entries describing a document that no longer exists.
- **Every hand edit goes on the stack, including the one that creates the document.** Saving an
  edited graph pushed an entry only when there was already a graph to go back to — so the **first**
  edit on a map, which is the one that turns the derivation into a stored document, went to the
  scene with nothing on the stack describing it. Undo then reached past it into whatever was below.
  On a shared stack that was a brush stroke, and the room's account is the symptom exactly:
  *"sometimes I thought undo wasn't working, so I probably clicked multiple times"* — four clicks,
  1,795 pixels of painted ink gone, and the reduced layer written to the scene the next time a tool
  changed. Fixed 2026-09-15 by giving the way back a shape that can say **"nothing is stored"**: a
  `WallGraph` has no such value, and nothing was missing from the store, which already clears both
  keys together.

  **One undo track, never scoped to the tool in hand** (user, 2026-09-15). The stack holds both
  documents and stays strictly last-in-first-out across them, so undo after a wall edit can still
  walk into the painted ink once the wall entries run out. Scoping it to whatever the tool is about
  was considered and rejected: it makes the button's meaning depend on a mode, and *take back the
  last thing I did* is the one promise undo makes.

  What answers the risk instead is **saying what the next press will do, in the open**. The name was
  always there and always in a tooltip, on the tool strip's argument that a glyph's name goes on
  hover. That is right for a mode, which you pick once and hold; it is wrong for a reflex. A room
  pressed undo four times without hovering anything, and each press took a brush stroke while they
  were trying to take back a wall edit. **A tooltip cannot answer a question the GM does not know
  they have** — they were not asking what the button does, they were sure they knew.

  So the undo side's label sits beside the pair, dimmed and clipped like the map name. Redo keeps
  its tooltip: one element says one thing, and redo follows an undo the GM has just watched. And it
  prints the **label**, never the tag — the tag is opaque so the history can forget one document's
  entries without learning what it holds, and showing it would make it meaningful and take that
  back. The words already separate them.

### Six tools built from conversations

**1. Dissolve region — built 2026-09-16, and confirmed in a room in part the same day** (*Where to
pick this up* has which part). Click inside a region and the walls around it go.

This is **the small-area-face tool**, which stood here as wanted and undesigned, and it is the
smallest-room control returning in the form this record already said was correct. That control was
deleted because it removed a *region* when what is usually wrong is a *wall*; in the editor, deleting a
region *is* deleting the walls that bound it. The questions it was carried with, and their answers:

- **Which walls go?** All that enclose it — so it merges with every neighbour at once — **and the walls
  of closed regions inside it stay** (user, 2026-09-16).
- **A threshold, or a click?** A click. A threshold was the deleted control.
- **What unit is the area in?** None: nothing measures an area.
- **A stub?** **A wall with the region on both sides goes** — a stub hanging in, a freestanding wall, a
  lollipop's stem — while a stub sticking *out* is its neighbour's on both sides and stays, left
  freestanding (user, 2026-09-16).

**Named** *Dissolve region*, after the map-making operation that merges areas by deleting the
boundaries between them, and drawn as **a room with a single slash through each wall** (user, same
day): where the mark sits says what goes. The room with a cross in the middle and its walls solid is
*Suppress region*'s, which strikes the room and keeps the walls. It
was that room dashed and crossed for its first day; a dashed wall is how the surface draws one that is
going, so the tool that keeps its walls could not take it as it stood. *Clear* was ruled out by *Clear everything* in the panel, *Merge* by being this
project's word for its worst failure, and *Erase room* by guessing intent — the region may be a table.

**As built** — `trace/dissolve.ts` is the decision, pure and tested; the tool is a fifth wall tool, so
a dissolve saves through the one path every wall edit does.

- **One test decides every case: the sign of a loop.** The region's walk is split into simple loops
  wherever it returns to a vertex it is already on, and the traversal keeps the region on the same side
  of every half-edge, so a loop around the region is positive, a loop around something it surrounds is
  negative, and a wall walked out and back encloses nothing. Positive and zero go; negative stays.
- **The loops are forced by a room joined to the outer wall** — by a stem, or at a single shared vertex.
  It is the same piece of linework, so the traversal walks it as part of the region's *outer* cycle,
  and "on the outer cycle" does not mean "around the region".
- **A stub drawn twice goes.** Two walls on the same pair of vertices are a legal state to pass through,
  and the traversal files the sliver between them under the outside — so a rule asking whether a wall
  has the region on both sides left both copies standing (measured). Their loop encloses nothing, and
  zero goes.
- **The region under a point** is the first whose walked outer cycle contains it and none of whose holes
  do. A walked cycle can be tested as it stands: slits cancel, and a joined inner room reads as outside.
  *The smaller wins* is not the tie-break, because a region's area is net of its holes.
- **The traversal now hands out `sourceEdges`**, because a half-edge id is not a graph edge index once a
  segment of no length has been left out of the walk.
- **The highlight is Erase's**: the destructive colour at Erase's width, over the walls a click would take,
  and drawn only against the graph it was found on. No handles, since the tool grabs no point. A crosshair
  inside a region, the hand outside every region, where a press pans.
- **The traversal is rebuilt once per graph**, not per pointer move — keyed on the graph object, which an
  edit or a derive replaces.

**Checked against an oracle that shares none of its reasoning**: a region is inside the clicked one
exactly when it cannot reach the outside, crossing walls, without passing through it. It agrees on every
region of 1,303 random graphs and of 280 derivations of random ink. **Fourteen mutations, fourteen
caught.** Two survivors on the way were answered rather than explained: one was the doubled stub above,
and one was a check the loop rule had made redundant, which was deleted (§8).

**Three costs, stated.**

- **A region with no area can never be clicked**, since no point is inside it. One with a little area can,
  zoomed in far enough.
- **Dissolving a room on a building's edge takes out part of the building's outer wall**, so it and every
  room it merged with join the outside and become unrevealable. Loud — their fills vanish — and Undo
  takes it back.
- **Walls that ran up to the deleted boundary are left as dead ends**, and the pruning slider cannot take
  them, because it rebuilds the walls and this is a hand edit. Erase takes them a segment at a time.

**2. The mend tool, the graph's gap tool — built 2026-09-16, used in a room and not yet checked
carefully.**

The idea: pair free endpoints by graph distance, which is exact where a pixel closing is a guess, and
turns the bounded flood into a shortest path.

**Decided (user, 2026-09-16):**

- **What it is for: flaws in the derived graph**, such as a wall line that thinned out and left a break
  in the walls. **Not doorways.** It may find some in some drawing styles, but it is not a door tool
  and is not to be designed as one.
- **An accepted proposal is a drawn wall**, no different from one drawn by hand once it is placed. So
  it is a hand edit, and everything a hand edit brings comes with it: the first one adopts the
  derivation as the document, the controls that regenerate walls lock, and the delta shows it going
  if a regenerate is agreed. That existing machinery is how the interface says what the paragraph
  below asks for — nothing new is needed to say it.
- **Units native to the graph** — graph units, like every other stored graph quantity.
- **Proposals in the additive colour**, the palette's colour for content being put in.
- **Accept-all is one undo step.**

- **Each mend is ringed and accepted by a click inside its ring**, as the ink tool's gaps are, with the
  same sizing rule. The flaw this tool is for leaves a mend a pixel or two long at map-wide zoom — too
  small to see or hit — and a ring with an 11-screen-pixel floor is what keeps a four-pixel gap
  clickable in the ink tool already.
- **A proposed mend is dashed, in the additive colour**, as a wall being drawn already is: solid means
  it exists and dashed means it is proposed, and accepted mends become ordinary solid walls. The cost:
  at map-wide zoom a short mend is too small for dashes to read, and the ring carries it there.
- **Defaults of 20px and 40px, set per map** when a map is first read, as the straightening default is
  — converted by raster pixels per graph unit, which is exact. A single fixed figure was ruled out by that
  default's own history on a small map. 20 rather than the ink tool's 12 because thinning pulls each
  free end back about half an ink width, so a break is wider in the graph than in the ink (reasoning,
  to be checked in a room).
- **Pruning can widen or remove a gap before this tool sees it**, since each half of a broken wall is a
  dead end. Accepted as it is. **Since 2026-09-21 every derive does this at two ink widths** (§4), so a
  fragment shorter than that between two breaks is gone before Mend looks; a long half is untouched.
- **Two sliders, as the ink tool has**: the largest gap to look for, and how far apart along the walls
  the two sides must be. A fixed ratio in place of the second was considered; kept as two, to be
  revisited if the second never gets used.
- **What a mend attaches to, in order of preference.** A nearby **free end** first, even when a segment
  is nearer. Failing that, a nearby existing **vertex**. Only then a **point on a segment**, which
  splits it. The ink tool has no equivalent: pixels do not distinguish a wall's end from its middle.
- **The direction of a mend onto a segment splits the difference** between the free end's own heading
  and the perpendicular to that segment, and the mend lands where that line meets it. To be tried
  rather than argued: the heading alone skids along a wall met at a shallow angle, and the
  perpendicular alone ignores which way the broken wall was going.

**As built** — `trace/mends.ts` is the search and the accept, pure and tested; the tool is a fourth
wall tool beside Move, Draw and Erase, so an accepted mend saves through the one path every wall edit
does.

- **One side is always a free end** (a node with one wall): a wall that stops is what a break looks
  like in a graph, and two nodes with walls on both sides are whole walls running close together.
  "Nearby" is within the largest-gap slider for all three kinds of target.
- **Each end ranks its own candidates by kind, then by score** — length stretched by how far off the
  end's heading the target lies, doubling square to it and trebling straight behind, so alignment ranks
  and never rejects.
- **They are then taken best first across the whole graph, and by kind before score there too.** Each
  end is used once, and a mend that would cross a wall or a mend already taken is skipped, its end
  falling back to its next choice. *By kind across ends* means two ends joined to each other win over
  a shorter mend onto a wall that would cross them, on the argument that an end joined to an end is
  the stronger evidence of a break. Proposed in building and agreed (user, 2026-09-16); a fixture pins
  it.
- **Accepting splits every wall a mend lands on first, then adds the walls.** This is load-bearing,
  and it was measured rather than argued. Adding a wall whose end lands inside another already splits
  the other — but at the point the crossing test computes along it, sharing the new wall's end only if
  the two quantise to the same float32. **Over 19,061 random mends, adding each that way left 7,926
  ending beside the vertex they were meant to share** — drawn closed, and open. Splitting at the
  landing first left none. The two fixtures written for it first — a horizontal wall, then a slanted
  one picked by hand — attached either way, which is how a mutation removing the split survived them;
  a deterministic sweep replaced the second.
- **Rings use the ink tool's floor and padding**, centred on the middle of each mend, and the layer
  draws what the hit test answers. A press inside a ring accepts on release, as an erase does; a press
  anywhere else pans.
- **The search re-runs when the walls change and when a mend slider is released — not while one is
  dragged.** Tool settings apply live as the handle moves, and searching a large map on every pixel of
  a drag is work nobody is looking at; the ink tool re-runs on release for the same reason. Picking the
  tool up searches at once and says the count; putting it down, or picking a tool outside the Walls
  band, drops the rings.
- **The two settings are filed `read`**, as every tool control is and a test pins, and are `tool` in
  kind, so they rebuild nothing and lock nothing. **Both are seeded per map** at 20 and 40 raster
  pixels, alongside straightening's seed, in `seedDefaults.ts` — one module because *untouched means
  equal to the static default* is one rule.
- **The same-wall distance carries a hint**, the third on the surface, with the ink tool's sentence:
  same label, same backwards direction. Proposed in building and agreed; the named-hints test was
  updated to say so.
- **Both tracks have a declared top** — a tenth of the map's longer side for the gap, four tenths for
  the same-wall distance — because the graph has no longest gap to measure one off. Also proposed in
  building and agreed, as was re-running on release rather than while dragging.

**Seventeen mutations across the search, the rings and the seed, seventeen caught** — two of them only
after the tests were strengthened, which is recorded in the test file.

**It does not replace the pixel tool, and this is the thing most likely to be got wrong.** A **scanner
artefact** — a thin light line across a scanned map — severs linework in *pixel* space, before any
skeleton exists. The graph then has no gap to pair up; it has two pieces whose ends may be nowhere
near each other. **Only a pixel tool can see that fault.** Repairing before thinning is also different
in kind, not merely earlier: ink mended first becomes one stroke with one centreline, where the same
mend on the graph leaves two edges that happen to meet. Two tools, two faults.

**One property to design in from the start: the two differ in durability.** The pixel tool writes what
the GM accepts into the added-ink layer, which is an *input* and survives a re-derive. A graph tool
adds an **edge**, which lives in the wall graph and does not — so mending a gap on the graph flips the
document from purely-derived to edited, like any other wall edit. (This said it "should count toward
the hand-edit total"; the count is gone, and the comparison against the stored base sees a mended
gap with nothing added.) Same conceptual tool, opposite durability, and the GM has no way to know
that unless the interface says so.

**3. Suppress region — built 2026-09-16, and confirmed in a room the same day.** Click to leave a
mark; a region
holding one gets no fog shape and its walls stay.

**What it is for**: a region the walls enclose that is not a room — solid rock between rooms, a large
pillar. It becomes what the outside already is: fogged, and never revealable. That is also why it is
not the tool for a table inside a room, which would become a permanent hole in the room's fog;
Dissolve region is.

**Decided (user, 2026-09-16):**

- **A mark is a point in graph units**, and a region is suppressed when it holds one. Regions have no
  identity across an edit, so the point decides afterwards, and the consequences are the intent:
  erase or dissolve the wall between a suppressed region and a room and the merged room is
  suppressed; draw a wall through one and only the side holding the mark stays suppressed.
- **Marks survive a rebuild of the walls**, landing in whatever region the new walls make. So they are
  stored beside the walls rather than in them, placing one is not a hand edit, and it locks nothing.
- **The emit rule is §3's, unchanged**: a wall is a line exactly when no emitted region covers it. A
  closed room inside nothing, suppressed, emits as a closed chain of lines — **more items than one
  shape, and that cost is accepted**.
- **A click places a mark, anywhere; a click on a mark removes it.** Outside every region a mark
  suppresses nothing until walls are drawn round it, which is why the tool takes every press and a
  plain drag does not pan — Ctrl does.
- **Drawn as a cased cross in the subtractive colour, with the Rooms layer**, dimmed when it suppresses
  nothing. Always drawn, because an unfilled region is also how a room that has leaked to the outside
  looks, and the mark is what tells the two apart.
- **Named and drawn as Dissolve region's other half**: the same room, crossed in the middle.

**As built:**

- **`trace/suppression.ts` is the decision**, pure and tested: the regions the marks suppress, found
  with Dissolve region's own lookup, and the traversal as emitted without them. The traversal now
  hands out **`ringEdges` per region** — which walls its rings cover — so the walls can be recounted
  with a region taken out rather than re-walked.
- **The preview and the push apply it with the same two functions.** The workspace's partition goes
  through one place for both its sources, and a change to the marks re-applies them to the traversal
  on screen without walking it again. The push reads the marks from the scene for itself, as the trace
  reads the paint, since a push has two sources and only one has a workspace behind it.
- **Stored under its own key**, recording its map, and read all or nothing. **No marks is no key.**
  *Remove ours* leaves them, as it leaves the paint; *Clear everything* takes them.
- **Each place or remove is one undo step**, the third kind of entry on the one stack. Rebuilding the
  walls clears the walls' entries and leaves these; loading another map clears everything.
- **A mark is quantised when it is placed**, with the same helper a wall's points use, so the marks in
  memory are the numbers the store hands back.
- **A press that travels does nothing**: a mark is placed by a click, and the release is where it acts.
- **The hover shows what a click would do** — a dashed ghost where one would be placed, or the mark
  under the pointer in the destructive colour — repainting as the ghost moves, as a wall being drawn
  does.
- **The room count on the state line** counts emitted rooms and says how many are suppressed.

**Checked against the rule as §3 states it** rather than against the rings: a wall is a line exactly
when no emitted region lies on either side of it, or the same region lies on both — sides taken from
the walk, coverage computed from the rings. Over 514 random graphs it agrees for every region
suppressed alone and for a random half at once: 4,103 suppressions, turning 10,765 walls into lines.
**Fifteen mutations, fifteen caught**, after three survivors were answered — the test file says how.

**Costs, stated:**

- **A suppressed room is unrevealable for good**, exactly as the outside is — the point of the tool,
  and the reason it is the wrong one for furniture.
- **A plain drag does not pan with this tool in hand**, since every press is a mark; Ctrl pans.
- **Marks hide with the Rooms layer**, and so does the tool's ghost — a GM who has switched rooms off
  and picks up the tool sees no preview until they switch it back.

**4. Span — built 2026-09-16, and confirmed in a room the same day.** Click in an opening and a straight wall goes
across it: the doorway tool, since Dynamic Fog's doors cannot be made from here.

**Decided (user, 2026-09-16):**

- **Through the click, unless near it is far shorter.** The through wall is the shortest whose line
  passes exactly through the click, ending at the first wall met each way. The near wall is the
  shortest passing within **12 screen pixels** of the click. The near wall is taken only when it is at
  most **two-thirds** the length of the through wall. Through alone gives a doorway between two wall
  ends its door only from a click exactly on the line between them — a pixel off, the wall crosses the
  room — and near alone would pull a corridor's wall onto a kink beside the click.
- **No guard against cutting a corner** beside the click, deliberately; the preview shows it first.
- **Both numbers fixed**, not sliders: *"we should get them right rather than provide controls that
  are hard to interpret."* The wall is drawn before every click.
- **A preview**, on hover — agreed on the condition that it is fast, which is measured below.
- **Named** *Span*, and drawn as two walls with a new wall across between them, their vertex rings
  hollow and the click a small solid dot on the new wall.

**As built** — `trace/span.ts` is the decision, pure and tested; the tool is a seventh wall tool, and a
span saves through the one path every wall edit does.

- **Near ends at a vertex**: between two vertices, or square from a vertex onto a wall. That is where a
  doorway's ends are, and it is a definition rather than a shortcut — a wall between two plain
  stretches gains nothing from leaving the click.
- **The through search is exact.** Between two directions aimed at the ends of the walls in reach, the
  first wall met each way cannot change, so the length is two fixed lines and a bracketed search finds
  its lowest point. Sampling 2,000 directions never beats it over 400 random graphs.
- **The shortest through wall under the floor refuses the click**, rather than the next longest being
  offered — a hairline slit is not a place for a longer diagonal — and it still bounds the near search.
  Near candidates under the floor are skipped, since those are a fixed set.
- **Placing splits first, then adds**, by the same `splitEdgesAt` Mend uses, pulled out for both.
- **The preview is searched at most once a frame.**

**Fast enough, and measured, twice.** Every ray against every wall gave a median of 11ms and a worst
click of 6.7s on a 10,107-segment graph. A grid of the walls, and two exact windows — two vertices are
joined near the click only if nearly opposite across it, a square drop only from a wall nearly square
to the line to the click — brought that graph to a median of 2.1ms and a worst of 170ms, and a
36,022-segment graph to 9ms and 114ms. The densest graph on record, 5,881 wall segments, could not
be pushed. **The worst clicks are all in open space**, where nothing bounds the search; the sibling's
vision work met the same thing — *"the radius is the whole cost"* — so a longest span offered is the
remedy if a room feels it, and it changes what the tool finds, so it is a decision not taken.

**The grid broke exactness twice on the way, and the sampling oracle caught both** (§8). Aiming only
at vertices within the bound let a far wall change what a ray met partway through a stretch — and in a
corridor with no vertex near the click, nothing was searched; stopping each ray at the bound, when a
wall within it runs beyond it, skipped a stretch holding a wall 1% shorter.

**Eighteen mutations, eighteen caught**, after three survivors were answered — the test file says how.

**Costs, stated:**

- **A click in open space can take a tenth of a second** on a dense graph, as above.
- **Near a corner, a span can cut the corner**, by the decision above.
- **A span's end can split two walls at once** where two walls lie closer together than the crossing
  test's tolerance — measured twice in 3,072 random clicks, both on near-degenerate walls. The span
  itself stays one uncrossed wall.

**5. Suppress blob — built 2026-09-17, after a spike a room approved.** Click a solid blob on the
map — a pool, a hole drawn as a big black spot — and everything of that tone joined to it stops being
ink.

**What it is for**: map detail that is not linework. *"With the current tools, I would paint
suppression over it, but a blob fill provides a shortcut"* (user, 2026-09-17).

**Decided (user, 2026-09-17), and two of these overturned a design in progress:**

- **It floods the map IMAGE, not the derived ink.** This is the decision the tool turns on. A big
  solid spot derives as an **outline**, because Sauvola's window is uniformly dark in its middle and
  finds no contrast there — so suppression aimed at the derived ink leaves a ring, and the parameters
  move the outline's thickness underneath it. The sentence the tool is for is *"this mark on the map
  is not ink."*
- **A blob joined to the wall network takes the whole network, and that is correct** — *"that's just a
  bad use for the tool, not something for us to guard against."* Everything built to guard it was cut
  on that ruling.
- **No barrier, and no second criterion.** A version using Sauvola as a *stop* — flood only what the
  reading calls ground, then extend a bounded distance into ink — was designed and cut as not worth
  the complexity, and it was answering a question that barely arises: on an ordinary map the blob and
  the linework are the same black, so the tone flood walks from one to the other before any second
  test is consulted.
- **A tolerance slider rather than a fixed number.** Span's two constants are geometry and are the
  same on every map; tone is a property of the *map's contrast*, so one number cannot be right
  everywhere and a faded scan is the case that breaks it.

**Named** *Suppress blob*, after the verb of the brush that does the same job by hand. *Suppress
mark* was ruled out by a collision inside the same strip — **mark** is already the word for the point
*Suppress region* places. Three Suppresses is not a collision but a family: a stroke you paint, a blob
you click, a region you mark. **Drawn as Suppress's own swipe across a solid blot instead of a
stroke**, with the swipe empty rather than drawn over the fill (user), and built as two lumps either
side of it rather than one path with a hole — even-odd is a symmetric difference, so the parts of the
capsule outside the blot would have filled solid instead of cutting.

**As built** — `trace/inkFlood.ts` is the decision, pure and tested; the tool is a fourth Ink tool
beside Suppress, Add ink and Gaps, on the brush pointer path the Gaps tool already uses.

- **Against the seed's tone, not the neighbour's.** Measuring against the neighbour lets the flood walk
  a gradient and come out on tones the click never had, which on a map with a wash is the page.
- **8-connected.** §4's pairing — 8 for ink, 4 for space — and a blob is ink-like. It shipped
  4-connected for an hour, on an argument from *consequence* (this removes ink, so leaking is the
  expensive mistake) rather than from what is being connected, and a room found the cost in one click:
  a map's edges are anti-aliased, so the dark fringe along a diagonal is a staircase whose corners
  touch only at their corners, and a filled pool came back ringed with the pixels the flood had
  stepped around.
- **The fill goes into the suppression layer**, through the same `paintPixels` accepting a gap uses.
  So it is paint: an input, one undo step, locks none of the rebuild controls, and survives a
  re-derive. It asks for a recompose where a brush stroke does not, because the ink layer draws the
  base only while a *brush* is in hand and the composite otherwise.
- **The luminance is already there.** `rawField` — the unblurred field the point probe reports from —
  is retained at the pipeline's raster, which is the raster the suppression layer lives at. The tool
  needed no new cache, no new storage and no second read of the map.
- **The tolerance is `read` in stage and `tool` in kind**, so it recomputes nothing and needs no
  post-reading entry — tool parameters never enter the reading fingerprint. Linear in tone with a
  percentage readout, and **the one tool distance with no per-map seeding**: pixels and graph units
  mean different lengths on different maps, luminance is 0 to 1 on all of them.
- **A preview under the pointer, at most once a frame**, drawing only the box the fill lies in. §8
  requires a visual channel before a control that can be wrong ships, and this one can take the whole
  map's linework in a click. Every other raster layer rasterises the whole raster once; a hover
  rewriting nine million RGBA pixels per frame is not available.

**Nineteen mutations, nineteen caught**, against a **fixpoint** oracle — sweep the grid repeatedly
adding any pixel adjacent to one already taken, until a sweep changes nothing — which shares no code
path with the implementation's queue. One survivor was answered with a fixture: dropping the `left`
bounds comparison passed, because that test's seed sat at the fill's own top-left corner and three of
the four comparisons never had to move anything.

**Measured before the preview was built**, at the 3626×2598 raster of the map that first hit the
megapixel budget: a blob-sized fill is under a millisecond, a fill taking the whole connected ink
network — 1.09 million pixels — is 44 to 50ms, and the hard ceiling, a field with no boundary anywhere
and every one of its 9.4 million pixels taken, is 242 to 339ms.

**Costs, stated:**

- **A click on open ground approaches the ceiling**, and the preview will visibly lag there. Against
  Span's accepted worst of 170ms.
- **It works on a solid mark only.** A pool drawn as stipple or wavy line texture has no single
  interior tone, so the click takes one cell between two strokes. The suppression brush stays the tool
  for a textured mark.
- **A plain drag does not pan with this tool in hand**, since every press is a fill; Ctrl pans.
- **An anti-aliased or dusty edge can leave a scatter of survivors** that no tolerance cleanly
  reaches. The two proposed ink tools above are the answer if a room finds it.

**6. Collapse small regions — built 2026-09-21, confirmed in a room 2026-09-22** (*"That works great
in the room"*). Rings every region under a size;
a click inside a ring collapses that one, and a button collapses every one ringed.

**What it is for**: the cells that detail drawn alongside a wall encloses — texture just inside it,
pebbles against it — which the automatic prune does not take, because they are loops rather than dead
ends (user: *"it's prevalent on this map because of a lot of details drawn alongside the walls"*).
**Dissolve region is the wrong tool for them**, and that is why this exists: it takes every wall
around the clicked region, so a cell against a building's outer wall takes that wall too, and the room
beside it joins the outside and can never be revealed.

**Decided (user, 2026-09-21), and the operation is the user's own design:**

- **The star.** The region's walls go; a new vertex at the average of the *connections* — the
  vertices on its outline with a wall running elsewhere — is joined to each. *"A circle with many
  connections collapses into a star."* **Nothing else moves**, which is why the star replaced a first
  version that merged the connections into one point: that dragged every wall ending at them, and on a
  long sliver dragged its far ends to the middle. With nothing moving, the neighbours keep their shape
  everywhere except inside the collapsed outline, where their boundaries now dip to the centre.
- **Two connections make a straight wall through its own midpoint**, which Straighten takes at its
  smallest amount — the user's reason not to special-case it. The commonest case, a cell against a
  straight wall touching it twice, puts the centre on the wall, so the wall stays exactly where it was
  drawn. **Fewer than two, no centre**: the loop just goes, since one spoke would be a new dead end.
- **Measured by area** (user: *"we are really looking for things with small area, that are visually
  small, whatever their shape"*), where the ink island filter measures its longest side because an ink
  line has small area and large extent. **Area inside the outer boundary, holes included**, which was
  raised in building and agreed: a wall drawn as two lines makes a thin ring of region round a whole
  room, whose own area is small, and collapsing it would take the room inside with it.
- **Rings and a button, like Mend**, and **a slider reading "off" to 100** like Straighten and Prune.
  **The top is the whole map's area, on a log scale** (user: *"in keeping with Straighten, where we
  intentionally made going too far possible so the user can find a middle ground"*). **The start is
  eight square ink widths, every time the drawer opens**, never stored — a good guess for a Mend-style
  control. Eight rather than the four also offered, because areas are measured between wall
  centrelines and a cell with an ink width of open floor already measures about four. **Reasoning, not
  measurement.**
- **Its own tool, placed under Prune and above Mend** (user) — **and moved to the head of the band on
  2026-09-22**, when the band became Collapse, Prune, Straighten in the order a GM works (below) — rather than a *Simplify* drawer holding it with
  Straighten and Prune: those are amounts with a latch, and accepting a collapse replaces the document,
  which would void a pinned amount in silence. Placement gives the grouping instead. Mend moved up to
  meet it, closing a parked item.
- **Named** *Collapse small regions*, **drawn** as a small loop with three walls running off it and a
  single slash through the loop — Prune's slash, one row up, on Dissolve region's rule that *where the
  mark sits says what goes* (user, from four drawn at strip size). *Clear*, *Merge*, *Dissolve*,
  *Pinch*, *Shrink* and *Remove* were ruled out, each for a collision or a false promise.

**As built** — `trace/collapse.ts` is the decision, pure and tested; the tool is a wall tool, so a
collapse saves through the one path every wall edit does.

- **The region's outline is Dissolve's**: the outer cycle split into simple loops, the one positive
  loop going round the region. **Exactly one positive loop was measured, not assumed** — 9,521
  regions over 2,100 random graphs, every one — which is also the topology: a region is connected.
- **Two checks decide whether a region is offered.** Every spoke must stay inside the region, since a
  spoke that left it — from a C-shaped sliver whose centre falls in the room it curls round — would
  slice that room into wedges **without crossing a single wall**, the region's own walls being the ones
  deleted. And no spoke may meet a wall that stays, **by the crossing predicate the edit's sweep uses**,
  which the oracle added (below): the sweep then has nothing to split.
- **A neighbour touching the region in two places ends up touching itself at the centre and stays one
  region.** The plan said it would split in two, and Euler's identity says it cannot — one vertex in,
  walls unchanged, one region out. The oracle meets the case and checks it.
- ***Collapse all* runs in rounds**, smallest first, skipping any region sharing a vertex with one
  already taken that round, until nothing ringed is left under the size — one undo step. **It takes
  only regions ringed at the press**, remembered by a point inside each, which stays inside because a
  surviving region only ever gains area. That had to be enforced (below). **And every round must
  reduce the number of regions**, or it is undone and the loop stops, because two mutations looped
  there and one doubled the regions every round.
- **A grid of the walls**, built once per graph, so each region looks only at walls near it. **Measured
  before it was built**: on a mesh of 2,500 regions and 7,000 walls, *Collapse all* at the top of the
  track took 14 to 15 seconds, with every region scanning every wall twice. After it, 6 to 7.5 seconds
  there, a quarter of a second at the starting size, and a full drag across the track a median of a
  quarter of a millisecond a step and a worst of 7ms. The top-of-track press runs under the working
  indicator; the real map has 70 regions.
- **The size applies live as the handle moves**, at most once a frame, which Mend's settings do not —
  measured above, because the areas are worked out once per graph and a new size is a filter.

**Checked against an oracle that shares none of its reasoning** — Dissolve's region lookup over sample
points, asking whether any two regions outside the collapsed one merged or any one split, plus
planarity, Euler, and that every segment afterwards is either one the graph had or a spoke to a point
it had. Over 1,566 collapses from both random generators, with every case asserted as reached: no
connections, one, two, three or more, a region refused, contents taken with it, a neighbour left
touching itself. **Twenty-one mutations, eighteen caught**; one answered by deleting the redundant
check it disabled, one measured as deciding nothing on a valid graph, one defence in depth.

**Two faults found, both by the oracle, neither by a fixture.**

- **Two vertices a float32 step apart** — about 1e-8 of the map, a quirk of the random generator's
  fractional coordinates — either side of a region's boundary. The containment test passed a spoke
  within that distance of the second; the edit's sweep split it there and left a doubled segment. What
  fixed it was asking the sweep's own question before offering.
- **At four times the usual sweep size, after the grid went in**: a region under the size but refused
  qualified once a neighbour had gone, and *Collapse all* took it without its ever having been ringed —
  nine graphs in seven hundred, none within the usual size. The grid itself was innocent; the heavier
  run is what the house rule for optimisations asks for, and it paid for itself on something else.

**Costs, stated:**

- **A long thin sliver along a curved wall has its wall replaced by straight spokes.** Bounded, by
  reasoning: two strokes cannot thin to centrelines much closer than an ink width, so area caps length,
  and the dashed star shows it before the click.
- ***Collapse all* can leave a ringed region**: one that grew past the size when its neighbour went,
  or whose spokes now leave it. The rows-of-cells fixture pins the first.
- **The top of the track takes seconds on a dense map.** Measured on a synthetic mesh, not a real map.
- **It trusts the ink width for its starting point**, as the automatic prune does. Without one the start
  is a fixed guess from the test map's figures.

### Two ink tools proposed and not built — 2026-09-17

**Both are an existing slider turned into a tool**, which is the move Dissolve region already made
against the deleted smallest-room filter and which the record judged correct: a threshold decides
globally and silently, where a click decides one case with the answer drawn first.

- **Small patches of ink** — *Smallest mark to keep*, the island filter, as a gap-finder-style tool:
  find the candidates, ring them, click one to take it or a button to take them all, and what is
  accepted goes into the suppression layer as paint.
- **Thin lines** — *Thinnest stroke to keep*, the morphological opening, the same way.

**Why they belong together, and why now** (user, 2026-09-17): between them they would clear the
speckling and the halo a blob removal can leave round its edge. A tone flood stops where the tone
stops, so an anti-aliased or dusty edge can leave a scatter of survivors that no tolerance setting
cleanly reaches — and those survivors are exactly small patches and thin strokes, which is what these
two filters already know how to name.

The unfinished-tool costs the two filters carry (§4) are the argument for the tool form rather than
against it: both deliberately run past useful, and set high enough to kill hatching they eventually
eat a genuine closet. A click never has to be set high at all.

**Explicitly not now** (user, same day). The blob tool's own full implementation comes first.

### Orphaned data when the map goes — raised 2026-09-20, not designed

**What happens when the nominated map has disappeared or changed, and the scene still holds ink and
wall data for it?** Today three things answer separately and none of them says anything to the GM
about the others: the resolver falls through to the largest image and the picker reports the stale
nomination under its rows; the wall store treats a map mismatch as *no graph here*; and the cover
reads "no base, or a base for another map" as *assume it was edited*, so a lid goes up over a picker
warning about walls that may no longer mean anything.

**The proposal** (user): a dialog on opening that explains what happened and erases the orphaned
data, with an option to **cancel the open without deleting anything**, so a GM can go and restore the
map in Owlbear first. The cancel is the half that makes it safe — the destructive answer is never
the only way out.

**The hazard it has to survive, and it is recorded rather than solved.** *"A stale nomination is
reported, never cleared"* is a standing decision with two reasons behind it, and one of them is not
about taste: **the map list is briefly empty while a scene loads**. So *the map has gone* and *the
scene has not finished arriving* are the same observation at the wrong moment, and a dialog offering
to erase an evening's work would fire on the second one. Anything built here needs a settled scene
before it may ask, and *settled* is not something the SDK reports.

**Not now** (user): *"Might not have to be done right now."*

### Carried open questions

- **OQ6. What partition granularity does a GM actually want?** One region per room, or per room plus
  its adjacent corridor stub? Only answerable by running a real map at a real table. **This is the
  blocking question above wearing its original name.**
- **OQ7. What does the GM review, and how?** Largely answered by the workspace. What remains open is
  whether anything is wanted on top of it — jump to the next suspect region, or a re-run diff — and
  that is best judged after a real session rather than guessed at now.
- **Should the graph-only recompute become a fourth cascade stage?** One fact — "changing this rebuilds
  the graph but not the mask" — is spread across three declarations that agree today, with a test
  pinning that they do. Collapsing them would make it one fact in one place, at the cost of a stage
  that is not a step and does not appear in the UI. **A question about the shape of the cascade, which
  is architecture rather than tidying.** The spur limit is the only member.
- **Who is `index.html` for?** It says "Pre-release — nothing to install yet", while the manifest is
  served from the same Pages site and can be added to Owlbear by URL. So the only public front door
  tells a visitor who *could* install it that they cannot. Either the page carries the manifest URL, or
  it says plainly that this is not ready for strangers. **Both are honest; they are different decisions
  about who the project is for.**
- **Should `overlay-probe.html` keep shipping?** It is in `rollupOptions.input`, so a retired probe and
  its page are built and published on every deploy — and nothing can open them. **The probe's source
  stays either way**; this is only about whether it is built.

### Gaps in coverage, rather than missing features

- **The handle cap has never been exercised.** It suppresses handles above 2,000 *on screen*, and the
  test map has 410 points in total, so no amount of zooming out reaches it.
- **The gap tool has never been in a room.** Whether a ring is easy to hit, whether the reshuffle
  after an accept reads as working or as flickering, and whether accept-all does what it is for on a
  map with many gaps are all open.
- **What Owlbear does with a zero-area path at zero stroke width is unmeasured.** Retiring the
  empty-face invariant means such a face is now drawn *and* emitted. Our arithmetic is fine — a
  degenerate ring contributes nothing to any area total — but that is a statement about us, not about
  Skia's stroker or Owlbear's storage. The count is already reported, so it is cheap to look at.
- **Switching maps.** The picker's *listing* is exercised; the reload path is not.
- **The stage side of undo has no tests at all.** The stack itself is well covered — the tagging went
  in under eight mutations, eight caught — but `stage.ts` has none, so the way back from an edit, the
  entry that the document-creating first edit now pushes, and the three clearing rules are all held up
  by `tsc`, the rest of the suite, and a browser driven by hand. It writes through the SDK and nothing
  here mocks that. **The cheap route, if this is ever worth closing, is to split the decision from the
  write**: *which write does this restore make, and what do `saved` and `base` become* is pure, and the
  SDK call is the only part that is not.
- **A large map, with the dev log running.** A 52.9-megapixel map is the only one that can answer three
  things: why closing it was slow (the decoded-source-versus-budget note in `rasterPlan.ts` is the
  first candidate and is explicitly unproven), whether gap rings land correctly at a reduction factor
  of 2, and three log lines a receiver missed. **None is closable from a desk, none is urgent**, and
  the map is the expensive part of the setup — so do all three in one sitting whenever it is loaded for
  some other reason.

### Two things that look like loose ends and are decisions

Recorded here so they are not re-opened as to-dos.

- **The preview draws wall lines at a fixed 2 screen pixels** rather than the fog stroke width. *"That
  has felt fine to me."* It is a **preview** affordance, and the emitted stroke is the scene's own fog
  width regardless.
- **Nothing removes the frame walls again, and no un-frame button is wanted.** *"It's easy enough to
  remove manually like any other wall."* Once added they are ordinary walls.

### One unexplained observation

A derive has twice been seen to run twice, two milliseconds apart, with identical output. Synchronous
and sub-millisecond at this size, so it costs nothing today; **the route to it has not been found, and
it is recorded rather than assumed understood.**

---

## 11. Copied code, and what it obliges

**Image loading, binarisation, the geometry helpers, thinning and chain chopping** were copied from
the sibling rather than shared as a package. The overlap is small enough that a package would be
mostly ceremony — versioning, a release step, a second lockfile and CI for both, to share a few
hundred lines of pure functions.

**The cost is real and should not be dressed up as a virtue: bug fixes will not propagate.** A defect
found in binarisation here stays present there, and nothing tells either project. **Note fixes in
both design records when they happen.** Already paid once: two dev-log defects found here exist
unfixed in the sibling.

That is the whole of the live relationship. The Owlbear and Dynamic Fog facts the sibling supplied
are in §2 and §9, and several have since been superseded by measurements taken in this project's own
rooms — so where the two records disagree, **this one is current**.

`reference/dynamic-fog/` is a separate thing: a local shallow clone of Dynamic Fog itself,
gitignored. Someone else's GPLv3 code, deliberately not committed, since vendoring it would
distribute it.

---

## 12. Licence — GPL-3.0-or-later

Free-tier Pages requires a public repository, so a licence had to exist before the first push. Matching
the sibling, and chosen as the option least likely to need changing rather than on principle:

- **Relicensing is one-directional in practice.** The copyright holder can relicense at any time, but
  anyone who took a copy under the old terms keeps those rights to *that copy* permanently, and once
  outside contributors land code they hold copyright on their parts. With no contributors, moving to
  something permissive later stays easy; the reverse direction is the one that gets stuck.
- **The coupling that would have forced it has mostly dissolved.** What this project emits is a standard
  item type on a standard layer, which is no closer a relationship to Dynamic Fog than using the SDK is.
  The exception is any eventual door work, which would write into its namespace — still interoperation
  rather than derivation, but the closest this project gets.
---

## Appendix A: the code map

One line each. **`pipeline.ts` is the spine and the only place the trace is orchestrated**; everything
under `trace/` is pure and headless-testable.

### Entry points

`background.ts` (an inert logger) · `panel.ts` + `panel.html` (the popover) · `workspace.ts` +
`workspace.html` (the full-screen surface, both modes) · `overlayProbe.ts` and `workspaceProbe.ts`
(retired probes, kept as the record of how the platform facts were got). **Each must call
`setDevLogLabel`.**

**Both probes are unwired now**, the workspace one since 2026-09-09 with the rest of the diagnostics
band. Neither is deleted, and the workspace probe is the one with a live reason to come back: **its
leak detector is the only way to re-check that a change has not started leaking input to Owlbear.**
Re-import `openWorkspaceProbe` *and* `closeWorkspaceProbe` together — the sheet is opaque, so one the
panel cannot close is worse than the overlay's click-through equivalent. The overlay probe's design is
closed outright.

### The trace

| module | what it does |
|---|---|
| `trace/luminance.ts` | pixels to luminance |
| `trace/binarize.ts` | Sauvola threshold and blur |
| `trace/field.ts` | the integral images behind it |
| `trace/polarity.ts` | which luminance class is ink |
| `trace/inkMetrics.ts` | ink width, by erosion |
| `trace/morphology.ts` | separable open/close, O(1) in the radius, and `healSeverances` — putting back the ink an opening severed, bridged by a dilation eroded one short (which is what heals a **diagonal** wall) and **intersected with the reading**, so it restores and never invents |
| `trace/inkIslands.ts` | `walkIslands`, the one definition of an 8-connected lump of ink, and the island filter written in terms of it |
| `trace/inkFlood.ts` | **Suppress blob's decision**: the connected set of map pixels within a tolerance of a clicked one's tone, 8-connected and measured against the seed |
| `trace/inkProfile.ts` | **what each ink filter would take, band by band** — a granulometry over openings for stroke width, `walkIslands` binned by span for islands, and both placed on their own slider's track |
| `trace/inkBlobs.ts` | ink component labelling (reporting only) |
| `trace/inkPaint.ts` | the GM's two raster layers: the brush, the run-length codec, and `composePaint` — the one statement of the stacking order |
| `trace/gaps.ts` | gap **detection**; it proposes and never fills |
| `trace/thinning.ts` | Zhang–Suen skeletonisation |
| `trace/wallGraph.ts` | skeleton to nodes and edges (moves no point, ever), plus `eraseSpecks` and `rasterizeGraph` |
| `trace/faces.ts` | the half-edge walk and sliver detection, and nothing else |
| `trace/spurs.ts` | **which** dead-end wall runs a limit removes — the decision alone, no geometry and no raster |
| `trace/simplify.ts` | Douglas–Peucker (`simplifyIndices` is the decision, `simplifyPolyline` that plus a lookup), `dropCollinear`, and `COMMAND_CAP` |
| `trace/deriveWalls.ts` | ink in, a **wall graph** out: thin, chain, de-sliver, fit, build, **the automatic prune** (`autoPruneLimitPx`, two ink widths), and the escalation ladder that meets the command cap, pruning on every rung. It also keeps a space labelling, for the point probe and nothing else |
| `trace/label.ts` | region labelling |
| `trace/wallGraph.ts` | the document: build, encode, decode, compact, prune, and the two track measurements |
| `trace/wallFaces.ts` | faces of the wall graph with no raster: the walk, containment grouping, the bridges, Euler's check |
| `trace/wallGraphDiff.ts` | what the GM changed: two graphs compared by **segment endpoints**, never by node id, so compaction and renumbering cannot affect the answer. A move falls out as a removal plus an addition |
| `trace/planarGraph.ts` | the crossing predicate and the planarity check |
| `trace/planarOps.ts` | the edits — add a wall, move a vertex, merge two, erase one or several, split walls where a new wall will land — and the two queries the tools aim with |
| `trace/dissolve.ts` | **dissolving a region**: which region a point is in, and which walls go — the region's walk split into simple loops, each kept or removed by the sign of its area |
| `trace/frameWalls.ts` | the four walls at the map's extent, and the strict already-framed test |
| `trace/mends.ts` | **mends**: the graph gap search — candidates per free end, paired across the graph — and accepting them, splits first |
| `trace/graphUnits.ts` | the graph's unit — the map image's longer side is 1 — the extent, and raster pixels per unit |
| `trace/probePoint.ts` | the one surviving diagnostic |
| `trace/prunePieces.ts` | **what Prune rings**: the doomed runs grouped into pieces through the vertices that go — each a tree hanging off at most one vertex that stays — and taking them |
| `trace/collapse.ts` | **collapsing small regions**: which regions a size qualifies — area inside the outline, holes included — the two checks that decide whether one is offered, the star, a grid of the walls, and *Collapse all* in rounds, taking only what was ringed |
| `trace/span.ts` | **spans**: the wall through or near a click — the exact through search, the near search's two windows, and a grid of the walls built once per graph |
| `trace/suppression.ts` | **suppression**: which regions the marks suppress, the traversal as emitted without them, the mark hit test, and the marks' stored codec |
| `trace/fixtures.ts` | `maskFromRows`, the text-grid fixture builder every pipeline test uses; `randomInk`, straight runs of ink crossing and ending in the open, which the prune and dissolve sweeps derive from; and `randomWallGraph`, the generator whose shapes nest and touch — what the region tools' sweeps need |

### Scene, emit and state

`map/mapImage.ts` list, nominate, resolve and load · `map/mapChoice.ts` the unnominated-map rule, split
out so it can be tested · `map/placement.ts`, `map/placeRegions.ts`, `map/rasterPlan.ts` raster-to-world
placement, reused at a raster the size of the map's extent because that *is* graph-unit space · `emit/fogShapes.ts` the shape items
and the four emission constants · `emit/wallLines.ts` the wall `LINE`s · `emit/wallEmission.ts` the
wall graph's faces placed in the world · `emit/emitRegions.ts` batch it into the scene ·
`geometry/ring.ts` ring maths · `wallGraphStore.ts`, `inkPaintStore.ts` and `regionMarksStore.ts` the
three metadata documents — the first holds **two** keys, the document and the graph as the trace last
derived it ·
`settingsStore.ts` the settings.

### Settings and shared UI

`confirmDialog.ts` is **the one way a dangerous action is confirmed**, on either surface: plain DOM
carrying its own styles, which is what let it leave `workspace/` when the panel needed it. It reads
`--bg`, `--text` and `--dim` with the workspace's own values as fallbacks, so the workspace looks
exactly as it did and the panel follows Owlbear's theme.

`settings.ts` is **the single declaration** of limits, stages, kinds and the post-reading boundary —
read it before touching any parameter. Then `controls.ts` (every control a GM can turn),
`sliderScale.ts` (log sliders), `overlay/maskImage.ts` (`paintMask`), and `theme.ts`,
`describeError.ts`, `namespace.ts`, `devlog.ts`.

### The workspace

**One page.** `steps.ts` declares the groups and the tools; `workspace.ts` is the composition root
only. There is no `mode.ts` — the two workspaces merged, and nothing branches on which one you are in.

- **Shell** — `shell.ts` (transform, input, canvas stack, chrome, the way out, `withEscapeHatch`,
  `whileWorking`) · `drawer.ts` (**the drawer**: which group's settings *or* which tool's controls are
  showing — never both — and rendering that one thing) · `reading.ts` (the mask request cycle,
  subscribed to by the layers) · `regions.ts` (the lazy derive cycle, and `showingSaved` — the one
  predicate deciding which graph is on screen) · `stage.ts` (the stored graph, the hand-edit count and
  undo)
- **Map and push** — `mapPicker.ts` · `mapSource.ts` · `pushAction.ts` (the bar's commit, the close
  hook, and `commitDerivation` — **where the save button went**) · `workspaceControl.ts`
- **Controls** — `settingRows.ts` (a row, its ghost mark and the discard warning) · `recompute.ts`
  (**what a settings change invalidates** — the one place the three stages are spent, shared by a
  slider's release and a group's Defaults) · `settingsState.ts`
  (working and *applied* settings) · `ghostMark.ts` (where a slider's ghost goes — pure and tested) · `colourRows.ts` (the five colour
  pickers) · `graphScale.ts` (the two graph-derived track tops — `bendTop` for Straighten, `spurTop` for pruning) ·
  `seedDefaults.ts` (**the per-map defaults** — straightening from the ink width, the mend tool's two
  distances from the raster) · `inkProfiles.ts` (**the two distributions drawn on the ink filters'
  rails**, asked for a frame after a reading lands rather than inside it)
- **What a press means** — `toolPalette.ts` (the strip: owns the verb, maps a tool to a drag, and
  **anchors the drawer**, because it is the module that knows where its own buttons are) ·
  `toolIcons.ts` (the strip's and the undo pair's glyphs, inline) · `wallEdit.ts` and `paintTool.ts`
  (the pointer events — Mend's press and accept are `wallEdit`'s) ·
  `dragGesture.ts`, `paintGesture.ts`, `gapGesture.ts`, `maskRequest.ts` (**what a gesture means —
  pure and tested, which is where the sequencing defects were fixed, and what survived the redesign
  untouched**) · `mendGesture.ts` (a mend's ring and which one a click lands in — pure and tested) ·
  `paintControls.ts` (the tool in hand, drawn into **its own drawer**) · `mendControls.ts` (the mend
  tool's drawer) · `collapseControls.ts` (*Collapse small regions*' drawer: the size, back at its start every opening, and the button) · `ringGesture.ts` (the ring round what *Collapse small regions* and *Prune the dead ends* would take, and which one a click lands in — shared, pure and tested) · `pruneControls.ts` (Prune's drawer: the length, back at its start every opening, and the button) · `pruneScale.ts` (the length's track and the start of four ink widths — pure and tested) · `pruneSearch.ts` (the dead-end search, following the walls on screen and the handle as it moves) · `collapseScale.ts` (the size's track, off then log up to the whole map, and the start of eight square ink widths — pure and tested) · `collapseSearch.ts` (the search, following the walls on screen and the handle as it moves) · `markControls.ts` (*Suppress region*'s drawer, which is one button and no
  settings) · `paintState.ts` · `gapSearch.ts` · `mendSearch.ts` (the mend search, following the
  walls on screen and the settings on release)
- **Acting on the document** — `undoAction.ts` (the undo/redo pair in the rail head, and their
  keystrokes) · `undoHistory.ts` (**the one
  stack, for the graph, the painted ink and the marks**: entries are labelled closures, so it never
  learns what it is restoring — pure and tested) · `regionMarks.ts` (the suppression marks for the map
  in hand: loaded with it, saved on every change, undone like any other act) · `editHistory.ts` (the bounded stack under it, pure and
  tested) · `frameAction.ts` (the button that walls the map's edge) ·
  `wallAmounts.ts` (**Straighten**, the one amount: its slider, the substituting preview, and the commit when
  the drawer closes) · `graphLatch.ts` (**the latch** — the graph pinned when Straighten's drawer opens, the
  amount aimed at it, and the staleness rule that voids it when the document is replaced: pure and tested) ·
  `actionGate.ts` (**why a wall action cannot act, decided before the press**: no saved graph, or its
  own limit at zero — pure and tested) ·
  `clearActions.ts` (**the clear family**: both paint layers, the wall document, every mark — each
  confirming, each one step of undo, and the two the strip draws at the foot of their band)
- **What is drawn** — `regenerateGuard.ts` (**the cover and the question behind it**: whether the
  walls hold anything the trace did not derive, which is what raises the lid over the map picker and
  the ink side, and the **review state** a press on it opens — a delta on the map and two answers in
  the drawer, level with the lid, rather than a dialog. The per-control marks it replaced are gone) · `layerToggles.ts` (pure and tested: groups
  propose, the GM disposes, a tool may only add) · `layerRow.ts` (the switches) · `palette.ts` (the live colours; `src/palette.ts` holds
  the values and is pure)
- **Layers** — `layers/ink.ts` · `layers/paint.ts` (repainting only the rectangle a stroke changed) ·
  `layers/gaps.ts` (proposals, ringed) · `layers/regions.ts` (the partition as vector paths) ·
  `layers/graph.ts` (the walls, with handles only for the tools that can use them) ·
  `layers/delta.ts` (what a regenerate would take and bring back, while the question is up) ·
  `layers/mends.ts` (the proposed mends, dashed, and their rings, while the tool is in hand) ·
  `layers/collapses.ts` (the small regions on offer: rings, the walls that would go in red, the star dashed) ·
  `layers/prunes.ts` (the rings round the pieces Prune would take; the red is the walls layer's) ·
  `layers/blob.ts` (what a fill would take, under the pointer — only the box it lies in, since a
  hover cannot rewrite the whole raster every frame) ·
  `bitmap.ts`

---

## Appendix B: build and deployment

**Stack:** Vite, TypeScript, vitest, `@owlbear-rodeo/sdk`, Node 24 / npm 11. **No React**, by choice
rather than deferral.

**Live at** `https://captainchocolatedessert.github.io/fog-nudger/`, Pages built **from Actions**. A
push to `main` tests, builds and publishes.

Four structural facts a developer needs:

- **`.nojekyll` is deliberate.** Pages runs Jekyll by default, which silently discards files and
  directories beginning with `_` — that would eventually eat Vite build output. It needs to be in
  `public/` too so it survives into `dist/`.
- **The Pages subpath is hardcoded in ten places** — Vite's `base`, four fields in *each* of
  `manifest.json` and `manifest.dev.json`, and the dev URL handed to Owlbear. Vite rewrites its own
  into built HTML but does **not** touch `public/`. Change one, change all. Nothing in `src/` should
  hardcode it; build from `import.meta.env.BASE_URL`. Drift is loud rather than subtle: a stale path
  404s and the extension fails to load outright.
- **New HTML pages that ship must be added to `rollupOptions.input`**, or they are silently absent from
  `dist/`.
- **The manifest field is `popover`, not `popover_url`** — the obvious guess by analogy with
  `background_url`, and wrong. And an **`action`** is declared in the manifest where a **`tool`** is
  registered through the SDK; they are different things.

**Two builds can be installed at once.** `public/manifest.dev.json` differs from the published one in
exactly five fields: the name, the button title and the description carry "(dev)", and **both** icons
point at distinguished copies. There are two icon fields and they are easy to confuse — top-level
`icon` is the **extensions list**, `action.icon` is the **button in the room**.

The two are distinguished in *different* ways, and that is not inconsistency: the action icon carries a
filled dot in a free corner, because it is drawn at the size it was authored for; the list logo
**inverts the whole plate**, because the list applies some mask or downscale of its own that loses a
corner badge. `src/manifest.test.ts` asserts the 128-character description cap, subpath correctness,
and that the two manifests differ in the five permitted fields and **nothing else**.

**Dependencies: regenerate the lockfile, never accrete it.**

```bash
rm -rf node_modules package-lock.json && npm install && npm ci
```

The trailing `npm ci` is the actual check — it validates lockfile/package.json sync, which plain
`npm install` papers over. Incremental installs resolve the optional-dependency graph for **only the
platform that ran it**, and those packages are WASM/native shims: invisible on Windows, fatal on Linux.
`npm audit fix` accretes the same way and is covered by the same rule.
