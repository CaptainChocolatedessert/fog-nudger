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
| Straightening | graph units | acts on the graph, and outlives the reading |
| Longest dead end to remove | graph units | same |
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
walls an opening straight across from a click. §10 carries all four; Suppress region edits marks rather than walls, and sits with the wall tools because what it
decides is which regions the walls make count. The alternative — hiding draw and erase behind modifier keys — was rejected for
putting a destructive action on an unannounced click and leaving both verbs undiscoverable.

- **All but two decide by looking.** Move takes a press only when a vertex is under it, Erase only
  when a wall is, Mend only inside a ring, Dissolve region only inside a region and Span only where it
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

**Straightening and pruning are single live sliders, applied on every derive — 2026-09-14.** They
were a slider each under Walls *and* a button each in the editor, and crossing the save turned one
into the other without saying so. There is one control each now, and changing either regenerates the
walls like any reading change: the mark says the graph holds work of yours, the dialog prices it, and
`editSimplifyFraction` is gone.

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

Both simplification and pruning act on the graph, which outlives any reading and so has neither a
raster nor an ink width of its own. **The answer is to denominate the stored value in graph units, and
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

**The three stages are the cascade, and destruction flows one way:**

1. **read** — what is ink. Re-partitions wholesale and discards both later stages.
2. **derive** — abstracting that ink into shapes. Regenerates every polygon, so it discards hand edits
   but not the reading.
3. **adjust** — destroys nothing.

**The evidence that the middle rung is real**, and it is not obvious: a minimum-area filter is **not a
pure delete**. A hole is kept only when it encloses a surviving region and filled in when it encloses
nothing, so dropping a sliver *dilates whatever surrounds it* into the space it held. Measured, mask
unchanged: **15 holes kept at one threshold against 51 at another.** That is abstracting ink into
regions, not reading ink.

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

**The prune limit has a fast path.** The built graph is kept, so a limit change is a run walk and
a traversal — single-digit milliseconds — rather than a full re-derive.

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
  probe), ink (suppress, add, gaps), walls (move, draw, erase, mend, dissolve region, suppress region, span). One click to switch, and switching a
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
| **Additive** | cyan | your added ink, gap proposals, a snap target, a span about to be placed |
| **Subtractive** | amber | your suppression, and the marks that suppress a region |
| **Destructive** | red | **reserved** — erase target, the walls a dissolve would take, a mark a click would remove, doomed spurs, nothing else |
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

**940 tests across 66 files**, all pure — everything that needs a DOM or a scene is not tested, which
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
- **An optimisation is a new implementation, and its oracle has to run again — once, heavier.** Span's
  search was made fast with a grid of the walls, and the rewrite broke exactness twice in ways every
  written fixture passed: rays aimed only at vertices within the bound, and rays stopped at the bound
  when a wall inside it ran beyond (2026-09-16). The random sweep against sampled directions caught
  both. Run it at its suite size afterwards and once at four times that, since the second fault was 1%
  on one graph in hundreds.
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

**Rooms on 2026-09-13, -14 and -15 went through the whole surface**, and everything they found is
fixed. The partition was judged in the first of them (above). What has been built since the last room
is the next section's list.

### Where to pick this up

**The next thing is a room.** Graph units, the mend tool and the delta's review have been **used** in
one since they landed and appear to work (user, 2026-09-16: *"I haven't tested them carefully, but
I've used them."*) — so their lists below are what careful checking would look at, not a record of
nothing known. **Dissolve region** landed after that and has been in one since, in part.
**Suppress region** landed last and passed every room check it was given (below). Everything was
checked at a desk as far as a desk can: `tsc`, the suite with mutation counts recorded beside the
tests, a build, and the workspace loading clean.

**A scene still holding a graph saved before graph units** (format version 3) will not load its walls:
they are refused, not converted. *Remove ours* in the panel clears one, and the map derives fresh.

**Span** (§10, *Span*) — the newest, and nothing of it has been in a room:

- **Doorways**: a click in a doorway between two wall ends, on its line and a few pixels off it, gets
  the door; a click in a corridor gets a wall straight across through the click.
- **The preview** follows the pointer without lag, including in open space outside the walls, where
  the search is slowest.
- **Placing**: one click is one step of undo, *Undo spanning an opening*, and the ends join the walls
  they land on.

**Suppress region — confirmed in a room (user, 2026-09-16), all of it:** placing and removing a mark
takes the fill away and brings it back, a mark outside every region goes solid once walls enclose it,
marks survive a slider rebuild, and a suppressed room's walls, pushed as lines, still block sight with
Dynamic Fog.

**Dissolve region** (§10, *Dissolve region*). **Confirmed in a room (user, 2026-09-16):** the
highlight follows the pointer from region to region, pillars and rooms inside keep their walls on a
real map, and one click is one step of undo. Not yet looked at:

- **The rest of the rule on real walls**: a stub hanging in goes, and a room touching the outer wall at
  one point keeps its walls.
- **The first dissolve on a map never edited** adopts the derivation, and the locks appear on the
  controls that rebuild the walls.
- **A room on a building's edge** opens to the outside when dissolved, and the fills of every room it
  merged with vanish. Expected, and worth seeing once, since it is the largest thing one click here
  can do.
- **Hover on a large graph**, which is deliberately left for now (user). The traversal is rebuilt once
  per edit rather than per pointer move, and the region lookup is a bounding-box pass over the
  regions; neither is measured on a real map.

**Graph units** (§5, *What is stored*) — on the non-square test map:

- **The walls and rooms sit on the ink**, not stretched along one axis — the drawing moved from two
  scales to one.
- **The frame lands on the map's edge**, on the short side as well as the long one.
- **Hit radii feel the same up and down as across** for Move, Draw and Erase, and **a click inside an
  ink gap ring accepts it** above and below the centre — the ring's hit test refused those until
  2026-09-16.
- **The fog lands where the rooms are** after a push, including on a map stretched out of proportion.

**The mend tool** (§10, *The mend tool*):

- **Whether the proposals are the breaks.** The whole quality question, and only a look answers it:
  whether mends land on walls that thinned out, and how many land on things that are not breaks.
- **Whether 20 and 40 pixels are the right starting distances**, which rest on reasoning about how far
  thinning pulls a free end back.
- **Whether split-the-difference lands where a GM would have drawn the wall.**
- **The rings** appear when the tool is picked up — the first commit drew none, a key typo §8 records
  — are easy to hit, and show the crosshair inside.
- **Accepting**: one mend and *Mend every gap shown* each one step of undo, the search re-running
  after, and the lock appearing on the controls that would rebuild the walls.

**The delta and its review** (decision 1): the walls a rebuild would take and bring back, drawn on
the map while the question is in the drawer. It needs a derived graph with hand edits on it, which is
the one state that does not exist outside Owlbear, so what has been checked is the state machine and
not the picture.

**View's Defaults** restoring all five colours: the rows have been looked at; that button has not been
pressed.

**Held until after a room, deliberately.** Comments that describe code which has since moved, so that a
room test is not sitting behind a change:

- `reading.ts` argues a recompose needs no blanking *because the ink layer draws the base*, which
  stopped being true on 2026-09-14; `layers/paint.ts` says the paint is drawn in the Walls step.
- **The walls layer's red "doomed" marks** justify themselves by a prune *button* that no longer
  exists. This one is more than a word: whether marking what a limit would take on the saved graph is
  still the right behaviour, now that pruning is a live slider that regenerates, needs looking at.

That shape is behind four of the five defects the rooms found: **a justification that was true when
written and quietly stopped being true when the thing it described moved.** Most of the stale comments
the last two days turned up have been corrected; these are the ones left.

**Still open and not urgent:** per-colour opacity, which wants a conversation before code (decision 6),
and the walls mark's size in the strip (decision 7). And the thing that is not a decision at all: **a
second map**, in a style unlike the first.

**Two agreements, both learned expensively:** do not edit the running modules while a room is open,
and try a reopen before diagnosing anything. `CLAUDE.md` says why.

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

7. **Reconsider the walls mark in the strip — later, not now** (user, 2026-09-16). The mark riding on
   a group's settings button draws at **18.19px**, the size of the glyph beside it, because the strip's
   `button.tool svg` rule outranks the 13px the mark gives itself. Every size it was ever meant to be
   there was smaller. Whether that reads as a second icon rather than as a mark on one is a question
   for a look, and "Where to pick this up" carries the measurement.

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

### Four tools built from conversations

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
  dead end. Accepted as it is.
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

**4. Span — built 2026-09-16, never run in a room.** Click in an opening and a straight wall goes
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
| `trace/morphology.ts` | separable open/close, O(1) in the radius |
| `trace/inkIslands.ts` | the island filter |
| `trace/inkBlobs.ts` | ink component labelling (reporting only) |
| `trace/inkPaint.ts` | the GM's two raster layers: the brush, the run-length codec, and `composePaint` — the one statement of the stacking order |
| `trace/gaps.ts` | gap **detection**; it proposes and never fills |
| `trace/thinning.ts` | Zhang–Suen skeletonisation |
| `trace/wallGraph.ts` | skeleton to nodes and edges (moves no point, ever), plus `eraseSpecks` and `rasterizeGraph` |
| `trace/faces.ts` | the half-edge walk and sliver detection, and nothing else |
| `trace/spurs.ts` | **which** dead-end wall runs a limit removes — the decision alone, no geometry and no raster |
| `trace/simplify.ts` | Douglas–Peucker (`simplifyIndices` is the decision, `simplifyPolyline` that plus a lookup), `dropCollinear`, and `COMMAND_CAP` |
| `trace/deriveWalls.ts` | ink in, a **wall graph** out: thin, chain, de-sliver, fit, build, and the escalation ladder that meets the command cap. It also keeps a space labelling, for the point probe and nothing else |
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
| `trace/span.ts` | **spans**: the wall through or near a click — the exact through search, the near search's two windows, and a grid of the walls built once per graph |
| `trace/suppression.ts` | **suppression**: which regions the marks suppress, the traversal as emitted without them, the mark hit test, and the marks' stored codec |
| `trace/fixtures.ts` | `maskFromRows`, the text-grid fixture builder every pipeline test uses, and `randomWallGraph`, the generator whose shapes nest and touch — what the region tools' sweeps need |

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
  pickers) · `graphScale.ts` ·
  `seedDefaults.ts` (**the per-map defaults** — straightening from the ink width, the mend tool's two
  distances from the raster)
- **What a press means** — `toolPalette.ts` (the strip: owns the verb, maps a tool to a drag, and
  **anchors the drawer**, because it is the module that knows where its own buttons are) ·
  `toolIcons.ts` (the strip's and the undo pair's glyphs, inline) · `wallEdit.ts` and `paintTool.ts`
  (the pointer events — Mend's press and accept are `wallEdit`'s) ·
  `dragGesture.ts`, `paintGesture.ts`, `gapGesture.ts`, `maskRequest.ts` (**what a gesture means —
  pure and tested, which is where the sequencing defects were fixed, and what survived the redesign
  untouched**) · `mendGesture.ts` (a mend's ring and which one a click lands in — pure and tested) ·
  `paintControls.ts` (the tool in hand, drawn into **its own drawer**) · `mendControls.ts` (the mend
  tool's drawer) · `paintState.ts` · `gapSearch.ts` · `mendSearch.ts` (the mend search, following the
  walls on screen and the settings on release)
- **Acting on the document** — `undoAction.ts` (the undo/redo pair in the rail head, and their
  keystrokes) · `undoHistory.ts` (**the one
  stack, for the graph, the painted ink and the marks**: entries are labelled closures, so it never
  learns what it is restoring — pure and tested) · `regionMarks.ts` (the suppression marks for the map
  in hand: loaded with it, saved on every change, undone like any other act) · `editHistory.ts` (the bounded stack under it, pure and
  tested) · `frameAction.ts` (the one wall action left; straighten and prune became live sliders) ·
  `actionGate.ts` (**why a wall action cannot act, decided before the press**: no saved graph, or its
  own limit at zero — pure and tested)
- **What is drawn** — `regenerateGuard.ts` (**the mark and the gate**: which control or tool would
  rebuild the walls, the glyph that says so — per control rather than per group, since Ink holds nine
  controls and five regenerate — and the **review state** the question is asked in, which is a delta
  on the map and two answers in the drawer, level with the button pressed, rather than a dialog) · `layerToggles.ts` (pure and tested: groups
  propose, the GM disposes, a tool may only add) · `layerRow.ts` (the switches) · `palette.ts` (the live colours; `src/palette.ts` holds
  the values and is pure)
- **Layers** — `layers/ink.ts` · `layers/paint.ts` (repainting only the rectangle a stroke changed) ·
  `layers/gaps.ts` (proposals, ringed) · `layers/regions.ts` (the partition as vector paths) ·
  `layers/graph.ts` (the walls, with handles only for the tools that can use them) ·
  `layers/delta.ts` (what a regenerate would take and bring back, while the question is up) ·
  `layers/mends.ts` (the proposed mends, dashed, and their rings, while the tool is in hand) ·
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
