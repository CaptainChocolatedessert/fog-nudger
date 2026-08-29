# fog-nudger — design record

An Owlbear Rodeo extension: **trace a map image into the fog regions a GM reveals room by room —
and, with Dynamic Fog installed, the walls that block sight, from the same shapes.**

This file is the design record — architecture, constraints, rejected alternatives, open questions,
build order. It is the place reasoning lives. Operating context for Claude lives in `CLAUDE.md`,
which is private and gitignored; where the two disagree, this one wins.

**Sibling project.** `../W - cartographers-fog` is a working Owlbear extension by the same author,
public at [CaptainChocolatedessert/cartographers-fog](https://github.com/CaptainChocolatedessert/cartographers-fog).
It is readable from here and it remains this project's most valuable asset: a year of Owlbear SDK
facts that were expensive to learn, and a testing culture worth copying wholesale. **Read its
`DESIGN.md` before designing anything here.** Note that its *pipeline* turns out to transfer less
than first assumed — see §5.

---

## 1. What this is for

Owlbear's fog is **subtractive**. The whole map starts hidden, and shapes drawn on the `FOG` layer
are the regions that *can* be revealed. Anything falling inside no shape stays hidden permanently —
which is the correct behaviour for the solid space between rooms, and it means the artifact a GM
prepares is essentially **one shape per room and corridor**.

Drawing those by hand, over every room of every map, is the single most tedious piece of prep in the
tool. But the map already shows where the rooms are — they are drawn on it, in ink. A trace pipeline
can turn the ink into the regions.

**One artifact, two payoffs.** Those same shapes are what Dynamic Fog derives walls from: it strokes
each drawing on the `FOG` layer and takes the contour, so a region's boundary becomes a wall (§3). So
the tracing produces a complete manual fog-of-war map on vanilla Owlbear with no extension at all,
and line-of-sight occlusion for free the moment Dynamic Fog is present. Nothing extra is emitted for
the second case.

That framing sets the shape of the whole project, and it is why this is a nudger rather than an
extractor:

- **Automatic extraction will never be perfect** on a hand-drawn map. Doors, arches, curtains,
  windows, secret passages and rubble all read as ink and none of them means "solid wall".
- So the output is a **proposal**, not a result. It must be reviewable, editable piece by piece, and
  rejectable in pieces without discarding the rest.
- A tool that gets a GM 85% of the way in one click and lets them fix the rest is a large win. A
  tool that claims 100% and is wrong in three places nobody notices is *worse than nothing*, because
  the failures are invisible until play: a gap in the ink merges two rooms into one region, so
  revealing one reveals three, and a region grown slightly too far shows a secret door that was
  meant to stay hidden.

---

## 2. Why a separate extension from cartographers-fog

Both trace a map image, and the temptation to merge them should be resisted:

| | cartographers-fog | fog-nudger |
|---|---|---|
| Relationship to fog | **consumes** visibility, to draw where the party has been | **produces** the regions and, downstream, the walls |
| When it runs | continuously, all session, on every client | once per map, GM only, at prep time |
| Output | aesthetic — a hand-drawn sketch | functional — geometry the fog engine obeys |
| Cost of being slightly wrong | a slightly ugly line | a room the party can see into |

The lifecycles have nothing in common. A GM who wants one may not want the other, and bundling
would mean a play-time extension carrying an authoring tool's weight on every client.

---

## 3. How Owlbear and Dynamic Fog handle fog and walls

The foundation everything else rests on. Assembled 2026-08-04/05 from three sources of very
different strength, and marked accordingly throughout:

> - **Read from Dynamic Fog's source** — [owlbear-rodeo/dynamic-fog](https://github.com/owlbear-rodeo/dynamic-fog),
>   GPLv3, published by Owlbear as an SDK example. Strong, but it establishes what *Dynamic Fog*
>   does, never what *Owlbear* does — the renderer is in Owlbear's closed client. The repository was
>   last pushed 2025-08-14, so the deployed extension may have moved; and the wall, door and light
>   reactors, the reconciler, the batching layer and the wall geometry helper were read, not the
>   whole repository.
> - **Read from the SDK's own type definitions** — strongest available, since it is what we compile
>   against.
> - **Reported** — from Owlbear's documentation, relayed 2026-08-05, not verified here. Consistent
>   with everything else but flagged where load-bearing.

### Fog is subtractive, and fog shapes are ordinary items

Everything is hidden by default; shapes on the `FOG` layer are the revealable regions. Space in no
shape can never be shown, which is what makes "fog the rooms, not the rock" correct rather than
merely convenient.

**There is no fog-shape API.** The SDK's fog API is styling only — get and set the fog colour, the
stroke width and whether fog is filled, plus a change subscription. Nothing creates, reads or
enumerates fog shapes. They are ordinary `Shape`/`Path`/`Curve`/`Line` items on the `FOG` layer,
distinguished by nothing else. This is what collapses the "emit native fog shapes" and "emit
drawings Dynamic Fog can read" options into a single act.

### Walls and lights are first-class SDK types, and local-only

`Wall` carries `points`, `doubleSided` and `blocking`; `Light` carries an attenuation radius, source
radius, falloff, inner and outer angles, and a `PRIMARY | SECONDARY | AUXILIARY` type. The wall
builder defaults `doubleSided` and `blocking` to `true`, puts the item on the `FOG` layer, and sets
`zIndex` 0 with auto-z disabled.

**Reported: both types can only be added to `OBR.scene.local`, not the networked scene.** Consistent
with everything observed — the sibling's item census found Dynamic Fog's walls and lights only in
the local set, and Dynamic Fog writes only there. If true it closes the old "do networked walls
occlude" question from a different direction: the SDK refuses them outright. Worth confirming,
because the confirmation is a thrown rejection rather than a judgement about a screen (§6, OQ3).

**Reported: `zIndex` on walls and lights is not draw order in the usual sense.** It gates which
walls affect which lights — a light only sees walls at or above its own `zIndex`, intended for
multi-storey maps — and decides whether the item draws under or over static fog. Not relevant yet;
recorded so the builder's default of 0 is not mistaken for meaningless.

### Dynamic Fog is an editor for Owlbear's engine, not the engine

It builds ordinary `WALL` items with the SDK's own `buildWall()`. The occlusion rendering is
Owlbear's.

Its architecture is a **one-way binding** from the shared scene to local children. A `Reconciler`
subscribes to networked item changes; registered `Reactor`s filter for items they care about; each
matching item gets an `Actor` that owns the derived local items; a `Patcher` batches the writes,
every one of which targets `OBR.scene.local`. Its own source comment states the constraint that
follows: because it cannot observe the local scene, its children must be unselectable and
non-copyable, or an item added or deleted outside the reconciler leaves it in an invalid state.

**That is Dynamic Fog deliberately making its walls un-clickable**, and it is why editing means
editing the drawing rather than the wall.

### The wall filter is layer plus type, and nothing else

```
WallReactor.filter(item) === item.layer === "FOG" && isDrawing(item)
isDrawing === isShape || isPath || isCurve || isLine
```

The reconciler applies the reactor's filter and no condition of its own; the entry point registers
the reactors plainly. **No metadata is involved.** An ordinary drawing on the `FOG` layer, from any
source, becomes walls.

**Correction on record.** An earlier draft of this document asserted that feeding Dynamic Fog would
mean matching undocumented metadata, and that `doubleSided`/`blocking` had to be encoded somewhere.
That was wrong, and it was one of two stated reasons for preferring to emit `WALL` items directly.
The reasoning that survived it should be trusted no more strongly than it was.

### A wall drawn in Dynamic Fog is an ordinary `LINE` — read from source, 2026-08-29

**There is no second abstraction to interface with, and this is the fact the whole architecture turns
on.** Dynamic Fog's line mode builds a plain `LINE` item on the `FOG` layer, at the scene's own fog
stroke width and fog colour, snapped to the grid. Not a `WALL` item. Not a zero-area region. An open
segment, of exactly the same *kind* of object as a fog region — just one with no interior. The wall
the GM then sees is derived from it a moment later by the same machinery that derives walls from a
room's boundary.

So there is **one** abstraction — drawings on the `FOG` layer — with two consumers reading different
aspects of the same object:

| | reads | for |
|---|---|---|
| Owlbear | the **interior** | what can be revealed |
| Dynamic Fog | the **stroked boundary** | what blocks sight |

A closed filled region has both. An open line has only the second.

**The choice is therefore never "Owlbear's abstraction or Dynamic Fog's".** It is whether the things
we emit have interiors — and the answer is that some must and some must not. §4 settles which.

**Stroking an open segment yields one contour**, a capsule around the line, so an open line gives one
wall where a closed loop gives two (§3, two walls per closed contour).

### Walls are derived state, recomputed from the drawing

On any change, the actor recomputes the wall's `points` from the parent drawing, adding or deleting
walls as the contour count changes. The geometry helper:

- converts the drawing to a path,
- **strokes it to the drawing's own `style.strokeWidth`**, in Skia's sense of the word — `stroke()`
  does not draw a stroke, it *replaces the path with the outline of the stroked region*. See below,
- samples curves at a fixed interval (10 units by default),
- subtracts every *open* door from the result with a boolean path operation, in world space, after
  simplification (its comment notes subtraction interacts badly with curves).

Heavy lifting is Skia compiled to WebAssembly.

**So the wall lands at the boundary of whatever shape is on the `FOG` layer.** A filled region's
edge becomes its wall. That is the mechanism the whole design depends on, and it is **confirmed in a
room** — roadmap step 1, §6.

### Two walls per contour, and why — 2026-08-15

Stroking a *closed* loop yields an annulus, and an annulus has two boundaries: an outer contour
offset `+strokeWidth/2` and an inner one offset `−strokeWidth/2`. Each becomes its own polyline and
each polyline becomes its own `Wall`. So the rule is **two wall items per closed contour** — not per
shape, and not by anyone's decision. It falls out of the geometry.

- **They do not look like two walls** because they are exactly `strokeWidth` apart. Owlbear's fog
  tool uses 5, against a grid cell of typically 150 world units — about 3% of a cell, which at any
  normal zoom is one line rendered slightly fat.
- **This explains the zero-stroke measurement** (§4), which was recorded as a fact with no mechanism
  under it: at width 0 the two offsets coincide precisely, so the stroker still emits two contours
  and they superimpose. Observation and source agree, which is as strong as an explanation gets
  here.
- **A shape with a hole has two contours, so it yields four walls.** The count scales with contours,
  not regions — see §10.

**Walls are built with the `VISIBLE` and `COPY` attachment behaviours explicitly disabled.** This is
load-bearing for us and was very nearly an untested assumption: we emit with `visible: false` to
match Owlbear's fog tool (§4), but every step 1 measurement was taken with `visible: true`. An
invisible fog shape still produces a live wall *because Dynamic Fog opts out of visibility
inheritance*, not by luck. Worth one confirming glance in a room, but it is no longer a gamble.

**Dynamic Fog does not draw walls, and there is nothing to imitate.** The thin white lines a GM sees
while the fog tool is active are **Owlbear's own rendering of `WALL` items**. Walls are constructed
in exactly one place in Dynamic Fog, carrying no styling at all — points, attachment, and the
parent's transform. Its overlay system, which activates on the fog tool, registers only light and
door overlays. So wall visualisation comes free with emitting walls, and costs us nothing to
provide.

### Doors ride on the same drawings; lights do not

`DoorReactor` filters on **exactly the same condition as walls** — `FOG` layer plus being a drawing.
Doors are therefore annotations carried on the drawings themselves, and the wall derivation
subtracts the open ones. Whatever their metadata shape is (unread), it lives on items we would
already own.

**Door subtraction is global, not per-drawing — read from `WallActor`, 2026-08-29.** The actor asks
the door reactor for **every** door in the scene, and the geometry helper subtracts each open one
from its polylines **in world space**. A door therefore cuts whatever wall geometry it overlaps,
regardless of which drawing it hangs off or who created that drawing.

Two consequences, and the second is a scheduling decision:

- **A wall represented twice needs only one door.** Two adjacent rooms emitted as separate fog shapes
  put two boundaries along the wall between them, close together. One door spans both and cuts both.
  An earlier draft of this record inferred the opposite — that a door would need duplicating per
  drawing — and offered it as an argument for emitting walls as lines. **That inference was wrong**,
  and the argument it supported does not exist.
- **So doors can be left to Dynamic Fog entirely.** A GM adding them with its own tool afterwards
  cuts our walls with nothing emitted by us. Doors are off this project's critical path by choice
  rather than by postponement (user, 2026-08-29).

`LightReactor` is the exception: it filters on `rodeo.owlbear.dynamic-fog/light` being present in an
item's metadata. **There is no metadata-free route to a light.** Walls are free; lights are gated
behind Dynamic Fog's private namespace. Do not assume symmetry.

### Forecast — noted, not pursued

Owlbear 2.4 shipped a first-party computer-vision pipeline that fogs a battlemap automatically,
[announced here](https://blog.owlbear.rodeo/owlbear-rodeo-2-4-release-notes/), in beta and limited
to a paid tier, with the caveat that it "won't always get 100% of the way there". It produces the
same artifact this project produces, which is a strong independent signal that the artifact is the
right one.

**Deliberately not treated as a blocker** (user, 2026-08-05): this project is primarily for its
author's own use, that tier is not available to them, and the work is largely done. Revisit if it
becomes broadly available — the interesting question then is whether this becomes the *nudging* half
on top of Forecast's extraction, which is the half nobody ships.

---

## 4. The decision: a wall graph is the document, fog items are its rendering

**Revised 2026-08-29 (user).** The emitted artifact is unchanged in kind — ordinary drawings on the
`FOG` layer of the networked scene — but what the project *works in* is now a **graph of wall
centrelines**, and the fog items are derived from it at emit time.

```
ink mask  →  wall graph (skeleton + GM edits)  →  { fog shapes for the faces, lines for the rest }
```

**What did not change**, and it is most of the original 2026-08-05 reasoning:

- The output is **useful with nothing else installed**. Vanilla Owlbear renders the shapes as manual
  fog of war and the GM reveals room by room. **This is the primary play-time function, not a
  fallback**, and it is why an edges-only emission was never on the table: a line has no interior to
  reveal and nothing to click, so it would leave a GM with correct line-of-sight over a map that is
  still entirely black.
- It **degrades gracefully rather than failing**, and is **not coupled to a private schema** — the
  filter that matters is layer plus item type (§3).
- Regions are still emitted one per enclosed walkable area.

**What changed** is that regions stopped being the thing we reason in. They are now derived, late and
thin, and the reasoning is below under "Why a wall graph rather than a partition".

### The target: emulate a careful human's scene — user, 2026-08-29

The clearest available statement of what correct output means, and it is worth holding onto because
it settles arguments that abstract reasoning does not:

> **Where possible, produce the scene a person would have got by drawing fog shapes in Owlbear, then
> switching to Dynamic Fog, making any necessary additions, and adding doors.**

That person's scene contains one fog shape per room and corridor, plus Dynamic Fog line items for the
walls no room boundary covers, plus doors. So does ours. Three things follow directly:

- **Redundancy that the human version also has is not a defect.** Two adjacent rooms are two shapes
  whose boundaries run along the same wall. That duplication is inherent in the requirement that
  rooms reveal *independently*, and a hand-drawn scene has it too.
- **We are not obliged to use Owlbear's tools to produce it**, only to produce what they would have.
- **Doors are the human's last step and they can stay that way** — see §3, door subtraction is global,
  so doors added natively afterwards cut our walls for free.

### Fog the rooms, not the rock

The wall geometry is identical either way, since the boundary curve between rock and room is shared.
But only fogging the enclosed walkable areas produces useful native behaviour: unexplored rooms
hidden, revealed one at a time. Fogging the solid material would hide decoration and nothing else.

### Emit the outside as well, rather than working out which region it is — 2026-08-16

User's decision, and it dissolves a problem rather than solving one. The pipeline does **not**
classify regions into interior and exterior. It emits every enclosed region it finds, and the space
outside the dungeon becomes one more revealable shape — or one large one wrapping the rest.

- **The classification is not reliably solvable.** "Touches the image border" fails on maps whose
  rooms run to the edge. Tone fails because the convention varies by map: on this author's style
  room interiors are largely white and the surrounding area is flooded with a mid tone, but shaded
  interiors with white margins are just as plausible elsewhere (user, 2026-08-16). **Do not
  generalise from one style** — that is the sibling's "property of the fixture" trap wearing a new
  costume.
- **Nothing needs the answer.** Fog is subtractive, so an unrevealed exterior region is visually
  identical to space in no shape at all. A GM who simply never reveals it sees exactly what they
  would have seen had we discarded it.
- **So the worst case disappears.** A wrong classification on an unusually-styled map would have
  discarded every room and kept the rock. That failure mode no longer exists, because no decision is
  taken.

**Costs, stated rather than minimised.** The exterior's boundary runs alongside every room's outer
wall, so Dynamic Fog derives a second wall pair a wall-thickness away from each — roughly doubling
the wall count, redundant for occlusion but not free. And the exterior is the most complex path in
the output: an outer boundary plus one hole per enclosed room cluster.

**Both are cheaper than they look, because the exterior is exempt from the rules that protect
rooms.** §10's "never split to meet the cap" exists because a join between two adjacent regions
becomes a wall across a room; outside the dungeon there is no room to cut in half and nobody to cut
off, so the exterior may be **chunked freely** — which defuses the 8192-entry cap on precisely the
item most likely to hit it. Simplification conservatism protects doorway gaps and room shape;
neither applies out here, so the exterior can be simplified far harder than any room. Whatever
tuning the rooms get, the exterior should be a separate and much looser setting.

### There are two polarity questions, and only one still matters

Worth separating, because the record previously ran them together:

1. **Ink polarity** — is the linework darker or lighter than the ground it sits on? Real, must be
   handled (§10), and answerable by measurement: the dry run's global split reports which class is
   the minority, and on line art the ink is the minority.
2. **Fill polarity** — is the enclosed interior lighter or darker than the exterior? Varies by
   drawing style with no reliable signal, and **no longer needs an answer** given the decision
   above.

**Colour is discarded and that is a real loss.** Binarisation runs on luminance, so a water-filled
room drawn in a mid tone can land in the same band as this style's exterior — separable by hue,
which we have thrown away (user, 2026-08-16). It does not affect *connectivity*, since regions are
separated by ink rather than by tone, so such a room is still its own region. The live risk is
narrower: if a mid-tone fill ever falls on the ink side of the threshold, that room fills with
"ink" and vanishes as a region entirely. Watch for it; hue is the reserve if it happens.

### Why a wall graph rather than a partition — settled 2026-08-29 (user)

**A wall is a blockage, not an area.** A partition of the map into regions can only express a wall
as *the thing between two regions*, and a map contains walls that are between nothing.

#### The case that decides it: a stub wall

Take a square room with a short wall extending out from one corner into open space. Both faces of
that stub touch the **same** ground region — the outside. So:

- It is not a boundary between two regions, because there is only one region there.
- The partition can still *represent* it, as a slot cut into the outside region's polygon, with the
  boundary running up one face, round the tip and back down the other.
- But **any operation that grows regions into the ink destroys it**, because the slot is attacked
  from both sides at once and closes. The wall does not merely thin — it disappears, and shortens
  from the tip as it goes.

That matters because growing regions into the ink is not optional; it is the half-wall reveal below.

#### The proof, from the *correct* version of that operation

The crude implementation is a global outward offset, and it was rejected in 2026-08-05 for being
unreliable against variable ink width. That is true and it is the shallow reason. The real one:

The right way to reveal half a wall is a **watershed** — give every ink pixel to the nearest ground
region. Where two regions compete the boundary lands on the ink's medial axis: exactly half the wall,
everywhere, under any ink width, with no radius to guess. Where only one region competes, every pixel
goes to it and the feature is consumed.

> **So the correct region operation deletes precisely the walls that are not region boundaries.**
> That is not a bug in an implementation. It is the partition reporting what it can represent.

And a watershed from ground regions *is* the medial axis restricted to its separating branches — half
a skeleton. The region-first design would have us compute half the skeleton, discard the other half,
and then patch the missing half back with special cases (user, 2026-08-29: "re-inventing
skeletonization with a series of tweaks").

#### Verified: the partition is already deleting pillars

Not a prediction. A pillar — ink enclosed by floor, containing no region — becomes a hole in the
room's region, and the containment rule fills any hole that encloses no surviving region. **The
emitted polygon covers the pillar, so it derives no wall, blocks no sight, and is revealable floor.**
Same for any freestanding barrier that closes on itself. Live today, and unnoticed only because no
one has traced a map with a prominent pillar.

That is the stub argument one topology up, and the containment rule cannot simply be relaxed: keeping
every hole would make a wall ring around every speck of ink in a room.

#### The real argument is parameter *coupling*, not parameter count

Lines do not remove parameters. Spur pruning replaces the pullback; the gap threshold survives almost
unchanged. What changes is that **each parameter does one job**:

| | region model | wall graph |
|---|---|---|
| reveal extent | pullback — which **also** decides which thin features survive | an inset on the derived region, which cannot delete a wall because walls come from lines |
| feature survival | the same pullback, plus the hole rule | spur pruning, beside the island filter, asking the same question a GM already answers |

The region model forces one number to set how much wall is revealed *and* which walls exist, because
the representation ties them together. §8's standing rule already forbids that: one parameter doing
two jobs means neither can be tuned.

The patched version needs a coupled budget — pullback plus simplification tolerance under half the ink
width — to avoid eating thin features, and a stub still shortens by the pullback at its free tip. The
graph has no such coupling.

#### The gap repair becomes a graph question

What a repair asserts is that two wall segments are **connected** — a claim about the wall network,
which is what a skeleton is made of. Today that is reconstructed from pixels with a closing, bank
grouping and a bounded flood, and then expressed by inventing raster ink. On a graph it is two free
endpoints and a graph distance: exact rather than budgeted, which also deletes the "guessed break"
state (§11 item 3) that has never once been observed.

#### Editing, and the freeze point that already exists

A GM thinks *"shift this wall a little"*, not *"this room is slightly bigger and the region beside it
is coincidentally slightly smaller"* (user, 2026-08-29). Moving one line is the natural edit; moving
two polygon boundaries in step is not.

The obvious objection — that a vector edit is an **output** a re-trace clobbers, where raster paint is
an **input** that survives — does not hold, and it is worth recording why so it is not raised again.
**The project already has a freeze point**: stage-three edits are made with Owlbear's tools and a
re-run discards them. The graph does not introduce one, it *moves* it earlier, to where the edit is
meaningful and local rather than one that leaves a join Dynamic Fog turns into a wall across a room.

Finer than that: **additions and deletions can stay durable inputs**; only a *move* needs identity on a
derived line, and identity is not stable when the ink threshold changes. So moves imply the freeze,
editing in general does not.

#### What it costs — stated, not minimised

- **Thinning, never the medial axis, and this decides whether the stub claim is even true.** The medial
  axis of a rectangle retracts half a wall width from each free end, so a distance-transform skeleton
  shortens stubs by exactly as much as the pullback would and the whole argument evaporates.
  Topology-preserving thinning explicitly preserves endpoints. It is the sibling's algorithm and it is
  the right one; the distinction is load-bearing and easy to lose.
- **Spurs are a new failure mode.** Preserving endpoints also preserves the spur from every bump on a
  hand-drawn edge, and a spur that separates nothing emits as a stub wall blocking sight where nothing
  does. Pruning is one honest parameter, but per §8 it needs a visual channel before it ships — which
  the workspace gives it.
- **The area check stops covering the emitted walls.** It still covers derived regions, so it is not
  lost, but the wall artifact becomes the unchecked part and there is no equivalent invariant for it
  yet.
- **Raw skeletons are enormous** — one vertex per pixel. "Simpler than what we store today" is a
  property of the fitting stage, not of the skeleton.

#### Expected size — reasoning, not measurement

- **The internal graph is roughly half** today's geometry: one centreline replaces the two boundaries
  flanking the same wall. Compounded a little by a looser simplification tolerance (below).
- **The emitted scene is about the same.** One shape per room still means two adjacent rooms duplicate
  their shared boundary — now exactly coincident instead of a wall-width apart, but still two copies.
- **The graph adds content the boundaries never had** — stubs, pillars, freestanding walls. New
  geometry, and the point of the exercise.

### Reveal about half the wall — solved by the graph

A revealed region should extend into the wall, roughly to its centre, rather than stopping at the
ink's inner edge (user, 2026-08-05). The reasoning is a product judgement, not a technical one: the
wall is part of the drawing and makes the room look complete, sometimes carries detail worth seeing,
and a region that stops at the floor reads as though the party is being shown a partial room.

The risk is symmetrical and understood: too much wall can reveal a secret door. That sets the safe
direction for tuning — **err toward showing less wall**, because a GM notices a room that looks
clipped far more readily than a door they were never meant to see.

**Under the wall graph this needs no parameter at all.** Regions are the faces of the line
arrangement, so a face's boundary *is* the wall centreline and the reveal reaches half the wall by
construction. If the safe direction is wanted, it is a pure inset on the derived region — and unlike
the pullback it **cannot delete a wall**, because walls come from the graph rather than from the
region's edge.

*Superseded with it:* the global outward offset, which was the only automatic implementation available
under the partition and is the operation shown above to destroy stub walls.

### Reconsidered: the two 2026-08-05 centreline rejections — 2026-08-29

Both were sound against what was proposed at the time, and **neither reaches the wall graph**. Recorded
in this form so they are not quoted back at it.

- **"Centreline extraction is unnecessary."** The argument was that the hollow gap between two rooms'
  boundaries is inside solid ink, unreachable, and blocked by either boundary — so nothing can stand
  in it. All true, and it addresses **only walls that separate two regions**. It says nothing about a
  wall that separates nothing, which is the case above, and nothing about half-wall reveal, which it
  explicitly left deferred.
- **"Centrelines emitted as thin drawings make Dynamic Fog a hard dependency."** A thin line emitted as
  fog is a thin revealable sliver, so that design did nothing without Dynamic Fog. Correct — and it
  rejects emitting lines **instead of** regions. The wall graph emits lines **as well as** regions, so
  vanilla Owlbear still gets a complete manual fog map and the dependency never arises.

### What emits as a shape and what emits as a line — the bridge criterion, 2026-08-29

Regions are the **faces** of the wall-graph arrangement, and each emitted face is a fog shape. A face
boundary already carries every wall along it, so most walls need no line of their own. The rule for
the rest is exact:

> **A wall emits as a line exactly when no emitted face boundary covers it.**

Two cases produce that, and both are computable from the graph:

- **Bridges** — edges with the same face on both sides. A stub wall is a bridge, and no region boundary
  can ever cover one because there is only one region there. Bridge-finding is standard linear-time
  graph work.
- **Edges bordering a face that was not emitted** — a face the smallest-room filter discarded. The far
  side contributes no boundary, so the edge is uncovered.

Everything else is covered by the two faces it separates and is emitted only as their shared boundary.
This is what produces the human-equivalent scene of "The target" above, with no coincident duplication
beyond the duplication a hand-drawn scene already has.

**A pleasant consequence: the pillar judgement falls out of a control that already exists.** Whether a
pillar should block sight or merely decorate is a GM's call, and the smallest-room filter makes it. If
the pillar's interior survives as a face, the pillar is a hole in the room — blocks sight, stays dark.
If it is discarded, the pillar emits as a line loop — blocks sight, and the room reveals over it so the
artwork shows. One knob, both behaviours, and it is the knob that already means "how small a thing
counts".

### The document and its rendering — settled 2026-08-29 (user)

**Our wall graph is the document. The scene is a rendering of it.** Emitted items are an output, not
the working state.

**This is forced rather than chosen: Owlbear cannot hold the graph.** Items are independent, each with
its own geometry and transform, and there is no shared vertex between two items. Emit a room as a shape
and its stub as a line and all they share is a coincidence in world space — drag the room's corner
natively and the stub stays behind, silently, at a scale where the break is invisible until it is a fog
leak. Attachment does not help: it carries the parent's **transform**, not its geometry, and the proof
is Dynamic Fog itself, whose wall actor recomputes a wall's points from scratch on every change to the
parent drawing. If attachment propagated geometry it would not need to.

**Precedent worth noticing:** this is exactly Dynamic Fog's own shape, one level down. Drawings are its
document; walls are derived, recomputed, never read back. A one-way binding from a document to a
rendering is the pattern the platform pushes you toward, and we are applying it one level up.

*Rejected on the way: bundling a stub into its room as a second subpath of one `Path`.* Fill would
ignore the open subpath and the stroke would give correct walls, so the two could not be separated by a
whole-item move. Declined because it invites trouble it does not repay — a **bent** stub, implicitly
closed for filling, encloses and reveals a sliver — and because it fails the general case anyway: a
junction shared by three faces belongs to no single item (user, 2026-08-29).

#### Reading a scene back

- **Vertex matching is exact. There is no epsilon** (user, 2026-08-29). Anything we emitted is exact by
  construction, and anything we did not is not ours to assume about. A GM who wants two near-misses
  joined has the gap tool, which is the honest place for that judgement.
- **Every vertex carries a stable integer id, stored per item alongside its points.** Two items meeting
  at a corner carry the same id; grouping by id reconstructs the graph outright. Deliberately **not**
  cross-references of the form "vertex 2 of this line is vertex 3 of that shape" — a local label means
  no item needs to know another exists, so nothing breaks when one is deleted or copied.
- **What the ids buy is specifically the ability to tell "these came apart" from "these were always
  separate".** Geometry alone cannot: a doorway is two wall endpoints deliberately close and
  deliberately unjoined, so a purely geometric check would flag every doorway on the map, which is the
  permanently-noisy warning §8 rules out.
- **A separated join is flagged, never re-joined automatically** (user, 2026-08-29). Same rule as the
  gap repair being off by default: nothing writes into the GM's work unasked.
- **Degradation is named.** If a GM inserts or removes a vertex with Owlbear's tools, that item's id
  list and point list fall out of step. Detectable — the lengths disagree — and we fall back to geometry
  for that item alone.
- **Fog we did not emit has no ids**, so importing someone else's work is geometry-only and infers what
  it can. **A permanently second-class path, accepted as a cost** rather than chased to parity (user,
  2026-08-29): a map already fogged by hand yields shapes with no provenance and a graph we guessed.

### Rejected: emitting `WALL` items directly — 2026-08-05

Three independent reasons, any one sufficient:

- Reported to be impossible on the networked scene at all (§3).
- Local walls are per-client and unpersisted, so **every participant would need this extension
  running**, which is absurd for an authoring tool used once per map at prep time.
- Dynamic Fog's tools edit drawings and would ignore a `WALL` item entirely, so the output would be
  geometry nobody can nudge — which defeats the project.

### Rejected: mimicking Dynamic Fog's private format for walls — 2026-08-05

Unnecessary. There is no private format for walls to mimic. Retained here only so the option is not
re-proposed; it remains the shape of the eventual *door* work (§11).

### What an emitted fog shape must look like — measured in a room, 2026-08-06

Roadmap step 1 placed hand-built shapes and compared them against one drawn with Owlbear's own fog
tool. The differences that matter:

| | ours | Owlbear's fog tool | decision |
|---|---|---|---|
| `fillOpacity` | 0.5 | **1** | **match — required** |
| `visible` | true | **false** | **match** |
| `fillRule` | evenodd | nonzero | **differ, deliberately** |
| `strokeWidth` | 9 | 5 | free |

- **`fillOpacity` must be 1.** Below that, ground the party has *revealed* keeps a translucent tint
  of the fog colour — for the GM and for players alike. Confirmed from both directions: a probe
  shape at opacity 1 had no tint, and Owlbear's own tool sets 1.
- **`visible: false`**, because that is what Owlbear's fog tool produces. Not known to be
  load-bearing — our `visible: true` shapes behaved correctly as fog — but there is no reason to
  differ from the tool we are imitating, and an unexplained difference is one that surprises
  someone later.
- **`fillRule: "evenodd"`, deliberately unlike Owlbear's `nonzero`.** Under even-odd an inner ring
  cuts a hole regardless of winding, so winding direction never has to be got right. Dynamic Fog
  maps anything that is not `"nonzero"` onto Skia's even-odd, so the two ends agree. **This retires
  the winding-direction pitfall from §10 entirely.**
- **`strokeWidth` is free, including zero.** Measured per shape, not inferred from a total: a
  zero-stroke shape produced exactly as many walls as a stroked one. The silent failure this was
  guarding against does not exist.
- **A `SHAPE` is positioned from its corner; a `PATH`'s commands are relative to its position.**
  Found by a control shape sitting half its width down and right of where its path equivalent
  landed. Costs nothing since we emit paths, and it confirms the positioning semantics world
  placement (§9 step 7) depends on.

### Review by staging on another layer — settled 2026-08-06

**Fog shapes ignore their own colour.** They render in the scene's fog colour whatever the item
says, which kills the cheapest review option this record ever considered: draw the proposal in a
distinct colour and let the GM delete what is wrong.

**The workaround is better than the thing it replaces** (user, 2026-08-06). Emit proposals onto the
`DRAWING` layer with `visible: false`, and promote them to `FOG` when accepted. Measured:

- On `DRAWING`, an item **does** render in its own colour, so proposals are visibly distinct.
- With `visible: false`, the **GM sees it ghosted and players do not see it at all** — so a staged
  proposal does not leak the dungeon's layout during prep. With `visible: true` players see it,
  which is why the flag is not optional.
- A ghosted staged item is still **selectable and editable**, so the GM can nudge a proposal before
  accepting it.
- Staged items produce **zero walls**. Dynamic Fog filters on the `FOG` layer, so a proposal is
  inert by construction rather than by our being careful — it cannot affect play until promoted.

**Full coverage, not the fog layer, is what makes a proposal hard to see — corrected 2026-08-22.**
The first guess was that fog paints over `DRAWING`, which it does sit above; the GM's own reading is
better and the evidence is theirs. **Owlbear's fog is transparent**, so a proposal underneath it is
not hidden. What defeats the eye is that the proposals cover *everything* except the ink — the
exterior is emitted like any other region (below) — so there is nothing for a filled shape to
contrast against and the whole map reads as one flat tint. Hiding fog helps only because it removes
one of the two tints. See §9's first-run notes; the fix belongs in how a proposal is *drawn*, not in
which layer it sits on.

**Accepting is a property update, not a re-emission**: layer to `FOG`, `visible` to false,
`fillOpacity` to 1. Ids survive, and sixty items are one call rather than sixty. The magenta is
left in place deliberately, so demoting back to `DRAWING` restores the marking with no extra
bookkeeping.

**This makes provenance metadata load-bearing** (user, 2026-08-06). Promote, remove and re-run all
need to find exactly our items and never the GM's, so every emitted item carries a key under
`io.github.captainchocolatedessert.fog-nudger`. That is already how the probe's removal avoids
touching hand-drawn fog, and it is the same mechanism §10's re-run pitfall depends on.

### Three stages, and why the ordering is architectural — revised 2026-08-23 (user)

*Superseding the two-stage split of 2026-08-22. The reasoning below is that argument corrected, not
a new one: what changed is where the boundary falls, not why there is one.*

**The binary mask determines the partition completely.** Connected-component labelling has exactly
one choice in it — the connectivity pairing — and that is forced by the diagonal-leak paradox, so it
is a correctness requirement rather than a knob. Nothing downstream of the mask can split or join a
region: the minimum-area filter can only *remove* one, simplification is bounded below half an ink
width precisely so it cannot change topology, and tracing and placement are exact.

Counted rather than asserted: of the eight parameters in the pipeline, five decide what is ink and
three act after it — a size filter, a smoothing tolerance, and a ceiling on that tolerance. **None of
the three can change which rooms exist.**

Supporting evidence from the same week: the hole rule used to carry a threshold, and replacing it
with containment **removed the parameter entirely** and made the result strictly better. Downstream
parameters kept turning out to be the wrong lever because downstream is not where the decisions are.

**But "downstream" is two things, not one, and the first version filed them together.** The
minimum-area filter is not a pure delete. A hole is kept only when it encloses a surviving region
and **filled in when it encloses nothing**, so dropping a sliver also dilates whatever surrounds it
into the space the sliver held. Measured on *Lair Of The Lamb*, mask unchanged — the ink share is
6.5% in both runs, which is the basis for saying only the minimum moved:

| smallest room | regions | discarded | **holes kept** | bare floor |
| --- | --- | --- | --- | --- |
| 0.1 squares | 211 | 169 | **15** | 0.99 squares |
| 0.0074 squares | 277 | 103 | **51** | 0.16 squares |

Fifteen holes to fifty-one from one slider. Every one of those is a change to the *polygon of a
surviving region*. That is abstracting ink into regions, not reading ink — so the size filter and
the smoothing tolerance belong with the regions, and the earlier split put them with the threshold
on the strength of their *destructiveness* rather than their subject.

**So the GM's work divides in three, and the ordering is forced rather than stylistic:**

1. **Reading the map** — what is ink. Every control acts on the mask, so changing one re-partitions
   wholesale and **discards both later stages, by construction**.
2. **Deriving the regions** — abstracting that ink into the shapes that will define walls. Neither
   control can split or join a region; both regenerate every polygon, so both **discard hand edits**
   and neither touches the reading.
3. **Adjusting** — what the GM wants, which no amount of the first two can express: merge these
   because they are one room to me; do not fog that at all; show me the proposals differently while
   I judge them. **Destroys nothing.**

**Destruction cascades one way**, and that cascade is the numbering. The two-stage version bought a
tidier claim — "stage one destroys stage two, full stop" — at the price of being wrong about what
stage one *was*. Three stages is the honest shape: the ordering was always three-deep and the binary
hid the middle rung.

**Each stage is now exactly what one representation can show**, which is the second payoff and was
the argument that decided it. A pixel overlay explains all of stage one and nothing else; the
coloured region view explains all of stage two. Under the two-tab split, neither view covered its
own tab — the overlay explained three of stage one's five controls, and the region view explained
none of them. The tab boundary and the representation boundary are now the same line.

**This answers a question the roadmap has been carrying.** Step 9 has always said "a re-run destroys
hand edits, so it must be deliberate and warned" without saying what to *do* about it. The answer is
not to engineer around it: the stages are inherently ordered, and the honest tool makes that
ordering visible instead of pretending edits are durable. Hence three tabs, numbered.

### Six steps, and the panel that is left — settled 2026-08-29 (user)

Nearly all the work moves onto the workspace, with a last confirmatory look at the real scene. The
three stages above **remain** as the cascade — what a change destroys, which is what cache invalidation
reads. The six steps are a *presentation and interaction* layer on top of them, and the two must not be
conflated.

1. **Map** — pick the image. **Built 2026-08-29.** The workspace opens with no map and draws nothing
   until one is chosen, which handles the chicken-and-egg of a surface that needs a map to draw.
2. **Ink** — threshold, blur, detail window, and the break repair under its own sub-heading. (Was 1a
   plus the breaks.) The repair rides here rather than in a step of its own because it **invents
   ink**, and because it is provisional: step F retires it, so nothing is arranged around it.
3. **Walls** — minimum stroke width, smallest ink island; spur pruning joins them. (Was 1b.)
4. **Edit walls** — suppression, ink painting and line editing. **Not built, and deliberately not
   created early to hold the gap repair**: this is the first step where a drag paints, and there is
   nothing to paint with yet.
5. **Regions** — smallest room, edge simplification, the partition drawn in the six-colour cycle. Ends
   with "stage these". Deliberately **thin and late**: it is the export, not the main event.
6. **Doors** — a stub, and probably permanently (§3).

Plus a **View** group that is persistent rather than a step — ink colour and opacity, proposal fill and
outline. The argument is the one already made for putting overlay opacity beside the reading controls:
navigating away from the thing you are tuning in order to recolour it is absurd, so view controls must
never be somewhere you go.

**An exclusive accordion — revised 2026-08-29 (user), from tabs.** Each step paints something
different on the canvas *and* gives a drag a different meaning — pan in 1, 2, 3 and 5; a brush in 4 —
so two open at once would be a lie: you cannot paint suppression and place a door with the same
gesture. That was the case *against* collapsing sections, and it is an objection to the **implication**
rather than to the shape. Enforce exactly one open and the implication is gone, and two advantages
arrive with it:

- **The ordering stays legible.** Every header is on screen in sequence, so where a step sits in the
  cascade is a shape rather than something to remember. A tab strip flattens the order into a row.
- **The controls column is tall and narrow**, which is what vertical stacking suits. Six tabs in a
  22rem column would wrap, or shrink to abbreviations.

**The cost, stated rather than argued away:** an accordion header is a weaker "you are here" than a
selected tab, and a mis-click collapses what you were working in. The open header is marked in the
accent colour and down its edge; nothing answers the second except that reopening is one click.

**This dissolves a problem already on the books.** The workspace was recorded as owing a trackpad user a
modifier-drag and a hand tool because "a left-drag becomes the brush". Under steps, a left-drag is only
the brush in the steps that paint; elsewhere it stays pan, for free. The hand tool becomes a per-step
affordance rather than a global mode.

**A fourth axis, and it must not stand in for the other three.** `section` was declared presentation-only
with "nothing may switch on it", because a control moved between headings for tidiness would silently
change what it recomputes. The step now *does* carry behaviour — which layer is painted, what a drag
means — so the rule is replaced rather than kept: **the step owns paint and tool binding and nothing
else.** What a change destroys, what it recomputes, and which half of the reading cache it touches stay
independently declared, with a test pinning what can honestly be pinned. Cache logic is untouched
by this rework, which is most of what makes it low-risk.

**What that test can and cannot assert — built 2026-08-29.** It pins independence where the
declarations genuinely disagree: the View group holds a reading-stage control (overlay opacity) beside
two adjusting ones (proposal fill and outline), and the reading stage is spread across three steps, so
neither of step and stage can be recovered from the other. It deliberately does **not** demand the same
of the kind or the post-reading boundary. Every parameter in the ink step happens to be a pipeline
parameter and every walls parameter happens to be post-reading — facts about today's twelve parameters,
not rules — and a test demanding they diverge would fail the day a step legitimately holds one of each,
which is the freedom the separation exists to give. What is pinned for those is that each declaration is
**total on its own**, since the only way to classify a parameter with no entry is to guess from a
neighbouring axis, and every such guess is silent.

**What stays in the panel:** the button that opens the workspace (an Owlbear action needs a popover,
there is no skipping it); accept, back-to-staging and remove, because they act on scene items and the
GM should be looking at the real scene to judge them; and the diagnostics. Everything else goes,
including the dead overlay-probe buttons whose surface was deleted.

**"What is here?" becomes a click on the canvas** rather than a button that probes the viewport centre —
available from every step, like an inspector. A straight upgrade to the one diagnostic §8 insists on
using instead of reasoning.

**Staging is kept, for the interlock alone.** Staged items sit on a non-`FOG` layer and therefore derive
zero walls, so a first run cannot affect play whatever it gets wrong — a property of the layer rather
than of our care. Its *other* justification, native editing, is genuinely weakened by §4: editing a
region is editing the output, where editing a line is editing the input. Revisit once painting exists
and it is clear how often a hand edit is still wanted.

#### The order within step A — split before growing

The workspace is already a thousand lines and would absorb the panel's settings rendering, the derive
stage, partition drawing, painting and eventually doors. **Split it first, then add steps** — the same
refactor gets harder every session it is deferred.

1. **Split the workspace into a shell plus per-step modules, with no behaviour change — DONE
   2026-08-29.** The shell owns the transform, input handling and the canvas stack; a step owns its
   controls, what it paints, and what a drag means.

   What came out of the thousand-line file, and why each piece is where it is:

   - **The shell** draws the map and then hands the frame to a list of **painters** in registration
     order. That list *is* the canvas stack, and it is the registration argument as code: every layer
     is drawn into the map's own rectangle, computed once and passed down, so no two painters can
     derive it differently.
   - **The reading** — asking the pipeline for a mask and deciding whether the answer is still wanted
     — is its own module rather than a step's, because *three* steps change the reading and all three
     want the same mask back. Steps subscribe. A listener that cannot take a reading returns false and
     the generation is marked failed, so a step that fails to allocate cannot leave a half-updated
     surface looking current.
   - **A settings holder**, because the steps share one settings object and the alternative is each
     keeping a copy and reconciling them.
   - **The slider row** is shared, since what a row does on release is a property of the parameter
     rather than of the step drawing it.
   - **Four steps today** — ink, walls, breaks, and the persistent View group. Walls has no painter and
     is fifteen lines; it is the obvious home for spur pruning.

   **Verified as far as it can be without a room:** types, the whole suite, a production build, and
   the page loaded outside Owlbear — where the rows render disabled from the defaults with their
   derived readouts, the swatches are there, the pointer and wheel handlers are live, and the frame
   loop sizes the canvas to the viewport. The reading path itself needs the SDK and therefore a room.
2. **Promote `section` to a first-class step declaration** carrying paint layer and tool binding, with
   a test pinning that the step, the stage, the kind and the post-reading boundary are declared
   independently — **DONE 2026-08-29**, and it brought the accordion with it, because a declaration
   nothing reads is a declaration that drifts.

   - **`steps.ts` is the fourth axis**: the ordered steps, each with a title, a blurb, the **layers**
     it shows and what a **drag** means in it, plus the total parameter-to-step map. `section` is gone
     from the control declaration entirely.
   - **A layer is drawn because the open step asks for it**, not because it exists. The shell keeps
     painters keyed by layer and runs the ones the open step names, in registration order. That is
     the user's convention: each step has its own display style — ink over the map here, linework and
     coloured faces there.
   - **One deliberate exception, and it is argued rather than incidental:** the walls step shows the
     breaks as well as the ink, because the minimum stroke width is the one control that can *sever a
     wall* — so it is the likeliest manufacturer of the thing the rings warn about, and hiding them
     there would take the warning away from the place it is earned.
   - **The hand tool button is gone.** A step owns the drag binding now, so a button that sets what is
     already set was a control with nothing to do. Ctrl still pans whatever the step says.
   - **A step still drawn by the panel is marked `pending`** and left out of the accordion, rather than
     appearing as an empty section a GM can open and find nothing in. An explicit flag rather than
     "skip a step that renders empty", because the derived version would silently hide a step that
     legitimately has neither controls nor layers — picking the map is exactly that. It dies at A.5.
3. **Sweep what is already dead — DONE 2026-08-29.** The overlay-probe buttons went: that probe asked
   whether a *click-through* sheet over the map was possible at all, and the design it was for is
   closed — the workspace owns its input instead, and the workspace probe answered a harder version of
   the same question. **The probe itself stays**, unwired, in the posture the shape-placing buttons
   already have: the code and its page are the record of how the answer was got, and re-importing one
   function brings the buttons back. The stale note above the workspace button went with them, since
   it still described stage one as two sections of this panel.

   A scan for orphaned modules found none — every source file is reachable from an entry point, a
   test, or another module.
4. **Move the map picker in as step 1 — DONE 2026-08-29.** The panel loses it entirely: the picker,
   its scene-items watcher and its styles are now the Map step's, and the panel keeps only the
   actions that need the real scene in view.

   - **The Map step shows no layers**, deliberately. Its question is *which image*, and the answer is
     the image itself — a mask drawn on top would be answering the next question over this one. It is
     also what resolves the chicken-and-egg of a surface that needs a map to draw: with nothing
     chosen there is the picker and no canvas content, which is a complete state rather than an empty
     one.
   - **Choosing a map reloads everything**, because a different map is a different image, a different
     reading and a different place in the world. The mask cache is keyed on map identity, so the
     reading that follows is genuinely fresh rather than the previous map's.
   - **Start-up moves the GM on once**, from Map to Ink, when a map is already chosen — the common
     case, and where they were going anyway. It never moves them after a deliberate click on a
     header, and never at all when there is no map, which leaves them in the one step that can fix
     that.
   - **The picker had to be gated on `onReady`**, found by loading the page outside a room: asking
     Owlbear for the scene's items before it is ready does not return an empty list, it **throws**,
     and the message landed on the state line where the map's name belongs. Same rule as the
     disabled sliders, sharper failure — the surface is built at module load, but anything that asks
     the *scene* a question waits.
5. **Move region derivation in** as step 5, drawing the partition. The largest piece, and the one that
   makes OQ6 answerable at last.
6. **Reduce the panel** to open-workspace, accept / back / remove, and diagnostics.

**Do not renest the stored settings to match the six steps.** This was refused once already for the
three stages, and the reason is unchanged: renesting means either a migration or a normaliser that
resets a GM's whole tuning. The step mapping carries the semantics; storage keeps its existing groups.

### The cache boundary, and what it is not — 2026-08-23

Binarisation is the expensive half — **690ms of a 1.4s run**, against 360ms to label, 320ms to trace
and 10ms to simplify — and it depends on no stage-two parameter. So a mask is kept and reused when
the map and the reading are unchanged, and a stage-two sweep costs roughly half what it did.

**It is not a second implementation, and that distinction is load-bearing.** The chain stays one
linear function; the only thing that changes is whether the mask was computed just now or a moment
ago. A second copy of the chain re-opens the sibling's worst diagnostic failure, where a harness and
a real room disagreed *in direction* because the harness never ran world placement — 700ms is not
worth that.

**The decision is made from a fingerprint, never from which button the GM pressed.** Correctness
therefore never depends on them working the tabs in order; the numbering is about *their* work being
discarded, not about the code's sequencing.

**The fingerprint is deliberately over-broad.** It covers the map's identity and geometry, the
scene's grid — which sets pixels-per-square and therefore the Sauvola radius, so a regridded scene
needs a fresh reading even though the image has not changed — and the reading parameters. A wrong
reuse would derive regions from a stale mask and report them as current, which is §8's warning in
its most expensive form. Recomputing needlessly costs 690ms; reusing wrongly costs a diagnostic that
lies.

**Which half ran is logged on every run**, and a reused mask restates the few figures the rest of
the run is built on. A run that reused and a run that recomputed must not produce the same log.

### Superseded: the click-through ink overlay — built, measured, and deleted 2026-08-23

**The code is gone.** It was replaced by the workspace below, and `overlay.html`, `src/overlay.ts`,
`overlayControl.ts` and `panelPresence.ts` were removed with it.

**The reasoning is kept, and this subsection and the two under it should be read as history.** Two
things in them are still live: the argument for *why stage one needs a picture at all*, which the
workspace inherits unchanged, and the correction about the mask being binary. Everything else — the
poll, the settle interval, blank-and-restore, the reserved band, the heartbeat — describes machinery
that existed only because that sheet did not own the transform, and is worth reading only to
understand why owning it mattered.

Stage two's representation is the coloured proposals staged on the drawing layer. Stage one needs a
different one, because its data is a different *kind* of thing: a per-pixel verdict at native
resolution, dense and unsummarisable, answerable today only one pixel at a time by the point probe.
**The overlay is the point probe made total.**

*Corrected 2026-08-23 (user): stage one's mask is **binary** — ink or not.* An earlier draft of this
section called it a tri-state of ink, kept floor and discarded floor, and that was wrong on two
counts. "Discarded floor" is floor whose region fell below the **smallest-room** filter, which the
three-stage split (§4) moved into **stage two** — so a tri-state overlay would put a stage-two
outcome on a stage-one surface, breaking the property that makes the split worth having: each stage
is exactly what one representation can show. And it describes something that was never built;
`paintMask` has always painted ink and left everything else transparent. The code was right and the
prose drifted. Discarded floor is still visible where it belongs — as bare map under stage two's
proposals, which is how a GM found it — and the point probe still reports it, because a diagnostic
answering "what is here?" is deliberately allowed to cross stages.

**Rasters cannot go into the scene**, and that is settled rather than assumed: the sibling measured
`data:` URLs rendering as a broken-image placeholder at 0.3KB, refused outright at 21.6KB, and
wedging the message bus at 1.37MB, with asset upload the only mechanism that delivers pixels and no
opacity, tint or blend on an image item anyway. So the overlay cannot be scene content.

**The route that works is a full-screen modal** — `fullScreen`, `hideBackdrop`, `hidePaper`,
`disablePointerEvents` — drawing on its own canvas. The pixels never enter Owlbear's scene graph, so
none of the above applies. Neither Dynamic Fog nor the sibling opens a modal anywhere, so this was
unprecedented and `overlayProbe.ts` was written to settle it. **Every answer came back usable:**

- **It composites.** The map is visible through a translucent wash.
- **`disablePointerEvents` passes drags through.** Owlbear beneath stays clickable and pannable.
  This was the fatal one — a GM who cannot pan while the overlay is up has no overlay.
- **No calibration is needed.** `iframe 1205x925 · viewport 1205x925 — same rectangle`, in every
  run, and the crosshairs sit on the map's corners and follow pan and zoom. **Owlbear's map canvas
  is the full window and its toolbars float on top of it**, so there is no inset to discover. The
  "modal origin may not be the viewport origin" risk does not exist.
- **The modal covers everything** — map, Owlbear's tools, and our own panel. Click-through means
  nothing breaks, but the tint sits on the UI. The probe overstates this by construction, painting
  a flat full-screen wash so transparency would be unmistakable; the real overlay paints only where
  the mask says something, which is 6.5% of the raster on this map. If it irritates, the fix is
  lower alpha — where Owlbear's furniture sits is not discoverable.

**There is no viewport change event.** Verified against the types: the player record carries
`syncView` but not the transform, and no API exposes an `onChange`. Polling is the only mechanism.

**The poll costs 2–4ms**, over five runs of ~200 polls each, worst case 12/33/12/97/38ms. An order
of magnitude cheaper than the sibling's contended-bus note led this record to expect.

#### Superseded with it: blank and restore, and why the cheap poll did not retire it

**An overlay that lags does not merely trail, it lies.** It shows ink displaced from the linework it
exists to be compared against, and comparing those two is the whole of stage one — a GM would read
the offset as the tool having found the wall in the wrong place. So the rule is: **blank on any
movement, repaint only once the view is still.** The sheet is either absent or correct, never
present and wrong. That is the same posture as the mask fingerprint, where recomputing needlessly is
cheap and being confidently wrong is not.

**3ms does not mean tracking continuously would do instead.** At any poll rate the sheet during a
drag is offset by roughly velocity times the interval; a brisk pan at 2000 px/s with 16ms polling
still puts ink 30-odd pixels from linework about five pixels wide. What the cheap poll buys is the
fix to the one residual flaw — detection is itself a poll, so there is a window where the view has
moved and the sheet is still up. At 120ms that window is 120ms; at 3ms a poll we can afford 30–40ms,
about two frames.

**View changes need no recompute, only re-projection.** Render the ink mask once
into an offscreen canvas at raster resolution — 3300×2550 is about 34MB, and the pipeline already
draws a canvas that size to read the map's pixels — and every subsequent view change is one
`drawImage` with a different transform. So the blank is a flicker rather than a pause, and the
cropped-binarisation idea is needed only for live *slider* feedback, which is a separate question.

**Two calls do double duty.** Ask for the screen positions of two fixed world points: if either
moved, blank; when they hold still, those two points *are* the transform to draw with. Two points
rather than one because a zoom centred on a single probe point leaves it fixed, and the whole
gesture would go unseen. The polling is the drawing's input rather than a cost on top of it.

**Zoomed out the overlay is indicative, not diagnostic.** Squeezing 8.4 megapixels into a thousand
screen pixels filters five-pixel ink away. That is the same limit as everywhere else here — ink can
only be judged at a zoom where ink is visible — and not a defect to engineer around.

#### Superseded with it: keeping off the panel

A full-screen modal covers the panel, and at any zoom where the linework is thick the ink paints
over the sliders. The panel is exactly where a GM is working while the overlay is up, so this is the
common case rather than a corner.

**The overlay keeps a band on the left clear while the panel is open**, and only while it is open —
a permanent stripe would hide a third of the map on a 1205px window. Nothing in the SDK reports
whether a popover is open, so **the panel says so on a heartbeat**.

- **A heartbeat rather than open/close messages.** A popover is dismissed by clicking anywhere
  outside it, and whether a frame torn down that way gets to send a farewell is not worth betting
  on. A missed close leaves a permanent blank stripe with nothing to explain it. With a heartbeat
  there is no ending to miss, and the state repairs itself within one stale interval however the
  panel went away.
- **The stale window is comfortably over two beats**, because a band that flickers is worse than one
  that lingers: lingering costs a moment of hidden map, flickering makes the layout jump under a
  slider being dragged. The relationship is asserted in a test rather than left as two numbers.
- **The panel reports its own measured width**, so the band follows the manifest instead of a second
  copy of the number going stale the first time the popover is resized. The extra margin covering
  the gap between the screen edge and the popover is a **guess**, logged on every change so it can
  be corrected by looking once.
- **It clips rather than shrinking the drawn rectangle.** Shrinking would rescale the image into the
  remaining space and slide every pixel of ink off the linework — the same lie the blanking exists
  to prevent, arrived at from the other side.
- **It fails safe.** If the broadcast never reaches a sibling iframe, no band is ever reserved and
  the overlay draws over the panel exactly as before: the previous behaviour, not a new fault.

### Superseding all of the above: stage one becomes its own workspace — user, 2026-08-23

**Decided in principle, probe first.** The click-through overlay is not being kept and extended; it
is the thing being replaced. Everything in the two subsections above — the poll, the settle, the
blanking, the clip band, the heartbeat — is expected to be deleted rather than built on.

**The case.** Look at what the overlay actually contains: a 40ms poll of two `transformPoint` calls,
a settle interval, a movement threshold, blank-and-restore, a clip band, and a heartbeat from the
panel so the band knows when to exist. Almost none of that is about *showing the mask*. It is all
machinery for coping with the fact that **Owlbear owns the transform and publishes no event for it**,
so we are perpetually inferring where someone else has put things.

An opaque, interactive surface that draws the map itself owns the transform, and that deletes:

- **The polling**, entirely. Pan and zoom become our own state, updated synchronously in an event
  handler.
- **Blank-and-restore.** There is no window in which we could be wrong about where the map is, so
  there is nothing to be honest about by going blank. That was the one genuine wart in the design and
  it was a symptom of not owning the transform, not a design choice.
- **The registration risk.** Map and mask drawn into one canvas under one transform agree *by
  construction* rather than by our arithmetic agreeing with Owlbear's. A whole failure class goes.
- **The panel band, the heartbeat, and the note above about the band not lifting** — all moot, since
  stage one's controls would live inside the workspace rather than in a popover the overlay covers.

**The trigger is that painting cannot be added to what exists.** Pointer events are disabled, and
that is not incidental — it is what makes the sheet click-through, which is what lets the map be
panned while it is up. A mode toggle would mean "you cannot move the map while painting", which for
a painting tool is a bad trade. Three of the four things §11 lists next want interaction the current
surface structurally cannot provide.

**And the surface split follows a data split already settled.** §4 established that stage one's
artefact — a per-pixel classification — **can never be scene content**, because rasters cannot enter
an Owlbear scene. Stage two's artefact **is** scene content by definition: items, edited with
Owlbear's own tools, promoted to fog. So stage one gains nothing from Owlbear's renderer and stage
two depends on it entirely. Different surfaces is the same line drawn one level up, not a workaround.
Tabs 2 and 3 stay in the popover beside the scene; tab 1 becomes "open the workspace".

**The risks, and the first is the one the decision rests on:**

- **Pan and zoom feel.** Owlbear's viewer is good; ours would be minimal. Two navigation models in
  one product jar if wheel direction, zoom rate or drag behaviour disagree. This is the question
  nothing but a human's hands can answer, and it is why this is a probe rather than a build.
- **A small map viewer to maintain forever**, including whatever turns up on a trackpad, a
  touchscreen and a 4K display.
- **Performance is unproven.** An 8.4-megapixel map plus an 8.4-megapixel mask per frame during a
  drag *should* be fine — GPU-composited `drawImage` — but there is no measurement, and a pan that
  stutters is worse than one that blanks.
- **One unmeasured SDK question.** A full-screen modal *with* `disablePointerEvents` is proven. One
  *without* it is not: keyboard focus, scroll ownership and whether `hidePaper: false` gives a usable
  frame are all unknown.
- **Everything Owlbear renders is lost** — tokens, existing fog, the grid. None of it matters for
  deciding what is ink, which is the point; if judging scale against the grid turns out to matter, we
  draw one ourselves.

**The probe comes first and tests one thing.** A surface that opens opaque, draws the map, and pans
and zooms. Nothing else — no mask, no controls. The question it answers is whether the navigation
feels right beside Owlbear's own, and if it does not, the cost was a probe and the working overlay is
still there. Same posture as the modal probe, which paid for itself.

**Rejected for now, and worth recording because it is the cheaper schedule:** *let Owlbear do the
painting.* Keep the click-through overlay and have the GM draw with Owlbear's own pen on a designated
layer, read back as suppression or ink. Clicks already pass through, so it needs no viewer at all.
Costs: our working data becomes scene items, networked and GM-only only if we manage it; the GM must
select the right tool, colour and layer to mean "suppress" rather than "add", every time; and there
could never be a purpose-built brush or a live preview of what a stroke would do. The worse product
and the better schedule — declined because all four queued features want interaction.

**Where the dividing line actually falls** is "what does the map say" against "what do I want" — and
one operation moves across it on inspection. *Splitting a region because of something not on the
map* reads like a stage-three edit and belongs in stage one, as **GM-drawn ink**: draw the wall, and
the next trace splits the region. That survives re-runs because it is an *input* rather than an
output; it re-derives both halves with correct boundaries, where splitting a polygon by hand leaves
a join that Dynamic Fog turns into a wall across a room; and it uses tools the GM already has, which
is the same argument §4 makes for editing fog natively. Not built; the highest-value thing that is
not.

#### The workspace probe, input half — measured in a room, 2026-08-23

The unproven combination was a `fullScreen` modal **without** `disablePointerEvents`. It is proven
now, and the answer the surface rests on came back the right way. Fifteen runs.

**Input capture is total, and Owlbear gets none of it.** Drags arrive as drags — around 66 moves per
gesture, dense enough for a brush. Every wheel event arrives `cancelable`, 86 of 86, so a zoom can
be stopped rather than merely watched. Right-clicks reach us. Across every run, with hundreds of
polls, **Owlbear's viewport never moved once**.

**That zero is a measurement rather than an absence, and only because the detector was made to
fail.** The sheet is opaque, so the map it might be leaking to is exactly what it covers: the
question cannot be answered by looking, which is why the page polls two fixed world points and
blames any movement on whichever input channel fired most recently. Attribution by timing, and
labelled as a guess. It reported "moved 0 times" for four runs before anything checked whether it
*could* report anything else — §8's rule about a clean diagnostic, walked into again. So the probe
now moves the viewport itself, holds, and puts it back: **saw 2 of an expected 2**, every run since.

**The keyboard is a different animal, and it is the one real finding.** It is not given — it is
**taken**. Nothing reaches this modal unasked, ever: fourteen runs, waits from under two seconds to
thirteen, including one where the GM typed nine digits and not one arrived. Calling `window.focus()`
plus focusing an element claims it on the **first try, about 16ms** after the page's own script
starts, after which keys arrive with no click.

- **So the keyboard is the one channel that leaks, and it leaks completely** until claimed. Those
  keystrokes are not merely lost — they reach Owlbear's page and do whatever they do there, under an
  opaque sheet. The viewport detector cannot see that, because a key that triggers something other
  than a camera move moves nothing.
- **Escape belongs to whoever holds focus.** Before the claim, Owlbear closed the modal itself and
  our handler never ran — which is why a modal dismissed by Escape used to leave no closing line at
  all. After the claim, Escape is ours.
- **The dead window is the iframe's load, not the claim.** Measured at 2,396ms cold against 166ms
  for the claim, and the GM lost four keystrokes to it. **It is a development artifact, on the
  evidence**: two consecutive opens went from click to first line of code in **76ms**, thirty times
  faster, because the module graph was already fetched. Vite serves this page unbundled in
  development, SDK included. Worth re-measuring against a production build before treating it as
  real; if it survives, the panel is same-origin and already open, so prefetching the workspace's
  graph would make every open warm.

**`hidePaper` and `hideBackdrop` make no observable difference under `fullScreen`.** Both variants
report the same rectangle and look identical. There is no frame to evaluate, which retires that
question rather than answering it.

**`iframe == viewport` holds without `disablePointerEvents` too** — 1246x1242 both, every run. The
click-through overlay's finding was not a property of that flag.

#### The workspace probe, navigation half — measured in a room, 2026-08-23

**Item 0 is closed.** The surface works, the navigation is right, and the two constants it exists to
find are settled.

**Written rather than imported, after considering the alternative.** The requirement was never
"zooming works" — it was *"it feels like Owlbear's"*, and a library supplies someone else's feel to
be tuned through its abstractions instead of by changing a constant. The case here is one image, no
rotation, no tiling, one transform, on a surface that already owns every pointer event; what remains
is about sixty lines. The reasoning about a painting library, which is the same question one level
up, is in §11.

*The cost, stated:* device quirks are ours. That bill arrived immediately, below.

**The feel constants, found by sweeping them during a run rather than guessed:**

| | |
| --- | --- |
| Mouse wheel | **12% per notch** — right on the first try, unchanged after a sweep |
| Trackpad pinch | **1.00% of zoom per pixel** of finger movement |

Both are adjustable from the keyboard *while the probe is up*, which is what made one run enough.
"Too fast" is a complaint; a number is something to build with.

**It opens on exactly the view Owlbear was showing**, by asking where the map's own world corners
currently sit on screen. Confirmed by eye: nothing moves as the sheet goes up. That also makes a
comparison of *feel* honest, since both navigations start from the same framing rather than from two
different ones.

**A mouse notch and a trackpad gesture are three intents down one event**, and treating them as one
was the whole of the first round's trouble — a two-finger scroll zoomed the map, and a pinch was
unusably fast. Classified now: `ctrlKey` is a pinch, which is a browser convention rather than a
guess; a `deltaMode` other than pixels is a mouse; a coarse, integer, purely vertical pixel delta is
a mouse in a browser that reports pixels; anything else is a two-finger scroll and means pan.

- **A pinch scales with its delta and a notch does not**, and that is the speed fix rather than a
  smaller constant. A notch is one discrete event whose magnitude is a number the browser chose
  arbitrarily. A pinch is continuous, delivered as a stream of small events, and applying a whole
  notch to each was dozens of steps for one gesture. Exponential, so a pinch out exactly undoes a
  pinch in.
- **The classification is reported live**, because the last two rules are a guess about a device
  from the shape of its numbers. A misread gesture is visible while the hand is still on the device
  rather than being a mystery afterwards.

**Frame cost is a non-issue, with margin.** 1,202 frames, both map-sized layers drawn every frame:
**0.1ms mean and 1.0ms worst inside the draw call, against a 16.7ms frame**. The surface is bound by
the display, not by us, and §4's expectation that a GPU-composited `drawImage` would be fine is
confirmed rather than assumed. Measured during motion only — a still view redraws nothing and would
have reported a flattering zero.

**Owlbear's viewport never moved**, under real navigation, with the detector proving itself 2/2 on
every run.

##### Two platform limits, and neither is ours — 2026-08-23

Both were reported as defects, both were measured, and both turned out to be Firefox. **Owlbear
behaves identically** (confirmed by the user), which is what settles them: the bar was matching it.

- **A two-finger scroll is axis-locked when the gesture starts along an axis.** 624 of 1,200 events
  carried both deltas — so diagonals do arrive and are used, and a drag begun diagonally stays free
  — against 163 x-only and 413 y-only from gestures begun straight. The lock is applied upstream at
  gesture start and JavaScript receives only what is sent.
- **A pinch cannot carry a pan.** Of 291 pinch events, **none** carried any horizontal delta and
  **none** interleaved with a scroll event inside 200ms. Firefox delivers a pinch as pure vertical
  `ctrl`+wheel; the pan half of a combined gesture never reaches the page.

*A real bug was fixed on the way to that answer and was not its cause:* a pinch's `deltaX` was being
discarded outright, since the zoom path read only `deltaY`. Correct to fix — a component that
arrives and is thrown away is wrong regardless — but on this platform there is nothing for it to
act on.

**The design consequence, and it is the useful part:** the axis-lock applies only to the wheel.
**Click-and-drag panning has no lock at all.** But in the workspace a left-drag becomes the brush,
which would push a trackpad user back onto the locked gesture for panning. So the workspace needs an
unrestricted drag-pan on another binding — **a modifier held while dragging, and/or a dedicated hand
tool** (user, 2026-08-23). Probably both: a modifier for a moment's nudge, a tool for a while spent
navigating.

### The workspace — built 2026-08-23

`workspace.html`. An opaque full-screen modal that draws the map, paints the binary ink mask over
it, and carries 1a and 1b's controls on the same surface as the mask they decide. **Panel tab 1 is
now a single button that opens it.** Run in a room the same day; two defects found and fixed there,
both recorded below.

**Map and mask go into one canvas under one transform.** That is the whole architectural payoff: they
register **by construction** rather than by our arithmetic agreeing with Owlbear's, and the failure
class the click-through overlay spent a poll, a settle interval and a blank-and-restore guarding
against no longer exists. All of that machinery was deleted rather than ported.

**It opens on the view Owlbear was showing**, so nothing jumps when the sheet goes up — the probe
confirmed the behaviour and it matters more here, since a GM opening the workspace is continuing to
look at the same map and a jump costs them their place.

**Getting out is Escape or a button that survives hiding the controls, and there is no dismissal
timer.** The probe had one because an opaque sheet that might swallow every click is a trap; that
was true while input capture was unmeasured and is not now. Evicting a GM mid-tuning would trade a
certain cost against a retired risk.

#### The re-read happens on release — tried live, reverted the same day

Recomputing per drag frame was the intent and it was reported unusable from a room. **The coalescing
was not the problem and is untouched**: it blanks on change, keeps only the latest value, and drops
any answer a newer one supersedes.

**What defeats a live drag is that the re-read is synchronous.** Its ~690ms is 690ms the slider
itself cannot move, so the cancel-and-retry can never fire — the work it would cancel is holding the
thread that would do the cancelling. Live needs the work **off the main thread**, or **cropped to
the visible region**; the number that decides between those is what a stage-one re-read actually
costs on this surface, which the workspace logs on every mask. Measure, then choose.

**While a slider moves the mask stays up**, and that is not a breach of the blank-rather-than-stale
rule. That rule guards against ink drawn for settings the GM has *applied* and moved past; this is
ink for the last reading they applied — the thing they are dragging away from, and so the thing
worth seeing while they choose. Blanking there means adjusting blind, which was the complaint. The
state line says the slider is ahead of the map, and that message deliberately outranks a completed
reading's own: a mask started at load can land mid-drag, and announcing a figure for a value the GM
is leaving is the smaller truth.

#### Two defects found in the room, and what they have in common

- **The pan handler ate every click.** It listened on the surface, which covers the viewport with
  the controls drawn on top, so a press on a button bubbled up, started a pan, and
  `setPointerCapture` redirected the rest of the gesture away from the button. Nothing on the page
  could be clicked. It listens on the **canvas** now, which is *behind* the controls — structural
  rather than a filter on event targets, so there is no list of exceptions to keep in step with the
  markup, and scrolling over the controls scrolls the controls for free.
- **The canvas was not filling the viewport.** A `<canvas>` is a *replaced* element, so `inset: 0`
  does not stretch it the way it would a div: it keeps its intrinsic 300×150 until the first frame
  sets explicit dimensions. In a room that self-corrects on frame one, which is exactly the shape of
  a bug nobody can reproduce. Stated in CSS now.

Both were found by asking `elementFromPoint` where a press actually lands, rather than reasoning
about z-order — which had already been got wrong once.

### Stage one is two things in series — settled 2026-08-23 (user)

The GM's question changes partway through stage one, and the panel says so with two numbered
sub-sections. Both halves are reading-stage pipeline controls — either re-partitions the map
wholesale — so this is presentational and the cascade is untouched.

- **1a · What counts as ink.** Separating marks from paper, shading and background. **Local contrast
  is the only tool today**; selecting or ignoring by *hue* would join it here, since colour is
  another question about what a mark is. Colour is currently discarded at binarisation, and §4
  already names that as a real loss.
- **1b · Which ink counts as walls.** Filtering marks down to linework. **A width filter is the only
  tool today**; smoothing the nubs an opening leaves where a thick wall crossed a thin gridline
  would join it here.

Both lists are expected to grow, and the sections exist so that growth has somewhere to go that is
not one long column of unrelated knobs.

### The minimum stroke width — built 2026-08-23, previously rejected

A morphological **opening**: erode by `k`, dilate by `k`, so marks narrower than about `2k` vanish
and everything else keeps its original width. Denominated in measured ink widths, **default zero**.

**Why it was rejected before, and what changed.** It can sever a thin wall anywhere, and a severed
wall merges two rooms. That risk is unchanged and the control is still not safe. What changed is
that it is no longer *invisible*: the stage-one overlay shows the mask registered on the map at any
zoom, so a severed wall is a gap a GM can see, with the second-largest-region alarm behind it. The
objection was about visibility, and visibility is what got built.

**Why it earns its place beside the blur.** The blur is the other global lever and works on
**contrast**, so a floor grid printed as dark as the walls costs linework to remove. An opening
works on **width**, which is the axis a grid line actually differs on. The two are not redundant;
they attack different properties, and the grid sits on the one the blur cannot reach.

**It runs after the ink-width measurement, and that ordering is load-bearing.** The threshold is
denominated in ink widths, and measuring a mask this has already filtered would raise the mean width
— which moves the threshold, which changes what it removes. Measure the raw reading, then filter it.
Polarity is decided on the raw reading for the same reason.

**Implementation notes.** Separable square structuring element with running counts, so it is linear
in the pixel count and *independent of the radius* — the naive neighbourhood is a billion tests at
8.4 megapixels and a radius of five. Square rather than circular means a diagonal stroke must be
slightly thicker to survive than an axis-aligned one, which on a printed grid points the right way.
Borders **clamp** rather than counting off-image as ground: the opposite would erode a band off every
edge and delete a wall drawn along the map's border, which the dilation could not restore.

**The cost, stated rather than softened.** It deletes *everything* below the threshold — a thin
doorway marking, a lightly drawn secret door, a wall hatched as fine parallel strokes. It is a
scalpel for the grid only where the grid is thinner than everything worth keeping, and on some maps
it will not be. GM-drawn "not ink" strokes remain the better, local tool; this does not replace them.

### The smallest ink island — built 2026-08-23 (user)

The second tool in stage 1b, and it exists because the first leaves a residue. Once the minimum
stroke width has taken out a printed floor grid, what remains beside the linework is **decoration**:
high-contrast, thick enough to survive an opening, and **stubby** — a compass rose, rubble, a
furniture glyph. Reported from a room on the run that first cleared a grid.

**It separates those from walls by connectivity first, size second.** Not because a wall is large —
a wall segment between two doorways can be tiny — but because **walls join up**. The linework of a
dungeon is one enormous connected network; a decoration is an island floating inside a room. So the
threshold only has to be large enough to catch islands, and it is separating things that differ by
orders of magnitude rather than by a margin.

**The measure is the bounding box's longest side, in grid squares.** A GM can look at a map and say
"that compass rose is two squares across"; nobody estimates an area by eye, and an irregular glyph
makes that worse. It is also the measure that says *stubby*, which is the property distinguishing
what survives an opening from what should.

**Eight-connected, and here that is the conservative direction rather than merely the consistent
one.** A decoration touching a wall *even diagonally* counts as part of the network and is never
removed. Under 4-connectivity it would look separate, and deleting it would quietly edit ink that
the space labelling one stage later treats as load-bearing. Note that `findInkBlobs` labels ink
4-connected by inverting the mask — harmless there, since it only reports.

**The alarm:** the largest surviving island should span most of the raster, because that is what a
wall network is. If it drops below a quarter of the map's width the linework has been cut into
pieces, by this filter or by the stroke width before it, and the run says so.

**The cost:** a genuinely isolated short wall — a free-standing pillar, a lone threshold mark —
looks exactly like a decoration and goes with them.

### Both 1b controls go further than useful, deliberately — user, 2026-08-23

Their maxima are past the point of sense: far enough to erase a map's decoration and then its walls.
A control whose top end still looks reasonable gives no sense of where the edge is, and the GM is
left guessing whether they have gone far enough. Being able to push it until the ink disappears is
what makes the middle feel like a choice — too low, too high, then settle.

That is only safe because the overlay makes both extremes visible immediately. It would be a poor
trade on a control whose effect could not be seen.

### The controls

Three for stage 1a — ink threshold, texture blur, detail window. Two for stage 1b — minimum stroke
width, smallest ink island. Two for the breaks — largest break to repair, same-wall distance.

**Every control is independent of every other.** One pair briefly was not — a repair width expressed
as a share of a separate marking width — and it was withdrawn when the premise behind the split
turned out to be false (§11 item 3). What survives from it is that a derived readout is repainted
when a reading lands rather than only when its own slider moves, because several of them report a
setting against a *measurement* that does not exist until then. Two for stage two — smallest room, edge simplification. Two for stage three, both about how a
proposal is drawn while it is being judged. Plus the overlay's colour and opacity, which sit on the
reading tab but are **display** parameters (below).

- **One declaration decides which stage owns which parameter**, and both the panel's tabs and the
  pipeline's cache invalidation read it. Two lists would be two places to disagree about what a knob
  invalidates, and the disagreement would be silent in the direction that matters — a stage-two
  tweak reusing a mask it should have thrown away. A test asserts the mapping is total and that the
  three stages partition the parameters exactly.
- **A second declaration decides what a change *recomputes*, and it is not the same axis.**
  `pipeline` invalidates the mask, `display` nothing but the next repaint. The stage says which
  surface a control appears on; this says what turning it costs, and the workspace's rows are built
  from it — so a control moved between headings cannot silently change what it recomputes. Filing a
  display parameter as pipeline would re-binarise on every opacity nudge, which is the whole reason
  the axis exists.
- **A third declaration splits the pipeline parameters again**, into those that feed the reading and
  those composed on top of it, so binarisation can be cached separately. Written **by exclusion**:
  anything new invalidates the reading unless it is named, because a forgotten entry then makes that
  cache useless rather than wrong.
- **The stored shape was deliberately not renested to match.** Storage keeps its two groups and the
  stage mapping carries the semantics. Renesting would mean either a migration or a normaliser
  falling back to defaults for every field of a GM's existing tuning — and silently rewriting a
  stored setting merely because the panel opened is the worst failure a control can have, which is
  the same property the round-tripping tests exist to protect.

- **They live in scene metadata**, like the map nomination and for the same reason: the panel is a
  fresh iframe every time it opens and `localStorage` is partitioned in a third-party iframe. Tuning
  arrived at by looking at *this* map should also travel with it.
- **Everything read is normalised**, and the normaliser is total: it takes anything at all and
  returns a usable set, clamping rather than rejecting and falling back **per field** so one bad
  key cannot discard a GM's other four. A parameter panel that can put the pipeline into a state it
  cannot recover from is worse than no panel.
- **Edge simplification is capped below half an ink width** in the control itself, because that is
  the bound past which a boundary can cross the middle of a wall into the next room. A control whose
  top end silently merges rooms is not a control.
- **Sliders, not number boxes.** These are values arrived at by feel — drag until the map looks
  right — so the control should support a sweep rather than a typed guess. The readout and the
  derived figure update *during* the drag, on `input`; only releasing writes, on `change`, so one
  sweep is one write to scene metadata rather than a hundred.
- **The smallest-room control is logarithmic**, and that is not polish. It spans 0.002 to 6 grid
  squares — three orders of magnitude — with every value a GM would ever pick near the bottom. On a
  linear track its default sits **1.6% along**, three pixels from the stop, and the rest of the
  slider chooses between absurd and more absurd. On a log track the same default sits at 49%.
- **Two maxima were tightened once the widget made range legibility matter**: blur to 3px, window
  radius to 0.75 squares. Nothing usable was lost — a 5px blur against 5.7px ink erases the linework
  outright — and both defaults moved off the left stop.
- **Round-tripping is tested, and it is the property that matters.** A value from scene metadata
  positions the slider and the slider must reproduce it; if those disagree, merely *opening the
  panel* rewrites a GM's setting, which is the worst failure a control can have because nothing
  announces it.
- **Every hint says which way to turn the knob.** Raising Sauvola's `k` finds *less* ink, which is
  the opposite of what "threshold" suggests to most people, and a control whose direction has to be
  discovered by experiment is one that gets turned once and abandoned.
- **Settings are logged with every run**, so a set of numbers can be read beside the parameters that
  produced it — which is the entire claim §8 makes for comparison between runs.


---

## 5. The pipeline

```
load → binarize → filter ink → thin → prune → wall graph → faces → simplify → place → emit
```

*Superseded 2026-08-29, and kept for one turn because most of the code still has this shape:*
`load → binarize → fill and label → discard outside → trace boundaries → simplify → place → emit`.
Everything up to and including `binarize`/`filter ink` is unchanged — stage 1a and 1b are untouched by
§4's revision, because the ink mask is still what the skeleton is built from. `faces` reuses the
existing labelling and contour tracing, run on the rasterised graph rather than on the ink mask, so
the area check and the hole rules survive with a different input.

### What transfers from the sibling, and what does not

**Transfers:** image loading and the cross-origin pixel path; binarisation (Sauvola adaptive
threshold, blur); the geometry helpers; polygon simplification, with a changed constraint; and the
whole testing and diagnostic culture, which is the most valuable part.

**Now also transfers: thinning, and chain chopping — reversed 2026-08-29.** The expensive, well-tested
middle of the sibling's pipeline is back on the critical path, because §4's wall graph is built from a
skeleton. This reverses the 2026-08-05 assessment below, and it recovers the head start the earlier
note said was lost.

*The superseded reasoning, kept because it names the thing that changed:* "Region filling does not need
a medial axis. The head start on this project is concentrated in the parts that were never going to be
hard; the stages that took the sibling the longest are the ones we are not using." True while regions
were the artifact. §4 establishes that a partition cannot represent a wall that separates nothing, so
they no longer are.

**Two cautions carried from §4 rather than repeated here:** it must be topology-preserving **thinning**,
never a distance-transform medial axis, or stubs shorten by half a wall width and the whole reason for
the change evaporates. And thinning preserves spurs along with endpoints, so pruning is a required
stage rather than a refinement.

### Resolution — native, decided 2026-08-15

**We trace at the map's own resolution.** The cap that exists is a memory limit, not a speed limit,
and on an ordinary map it does not bite at all.

The sibling traces at 1024 pixels wide, and it would have been easy to inherit that as prudence. Its
actual reason does not transfer: **its tuning constants are raw pixel values measured at that
raster**, so changing the width silently invalidates every one of them. The width is a calibration
lock-in wearing the costume of a performance budget. We have no tuned pixel constants yet, so
adopting the same number would not be caution — it would *manufacture* the same trap, since we would
then tune against it and be stuck there permanently for a reason nobody could later reconstruct.

The positive case is stronger than the absence of a reason to downscale. **Downscaling resamples the
ink, and the ink's topology is the answer this project computes.** Averaging a thin dark line into
its lighter surroundings lowers its contrast, and any stretch that then falls below threshold opens
a gap that is not on the map — a manufactured leak between rooms, the failure mode this record
biases hardest against. The same averaging can also close a genuine doorway gap. Both artifacts are
real, they push in opposite directions, and which dominates on a given map is not predictable. At
native resolution neither is introduced.

The cost side inverts too. The sibling's downscale bought *thinning* — iterative and expensive per
pixel — and thinning is exactly the stage we dropped. Fill and label is a couple of passes, and this
runs GM-only, once per map, at prep time, where a slow answer is affordable.

**The cap is memory.** Roughly four bytes per pixel for the decoded image, one for the mask, four
for the labels, inside a third-party iframe. The budget is stated in megapixels, reported on every
run whether or not it bit, and when it bits the reduction is by an **integer** factor so it is
uniform across the image — a fractional ratio resamples different regions against different
sub-pixel phases and thins linework unevenly.

**Named cost:** when the budget does bite, the reduction is done by the browser's own resampler
during the draw, not by a box filter of ours. A box average would be better, but computing one needs
the full-resolution pixels in memory, which is precisely what the budget exists to avoid.

**The lesson worth carrying.** The sibling's real trap was denominating its parameters in raster
pixels, which made the raster load-bearing forever. Ink width is this project's natural unit where
it can be used, since the half-wall coverage target in §4 is stated as a fraction of the wall's own
thickness.

#### Amended 2026-08-23 (user): pixels are allowed, and there is no unit that is always right

The original rule was **"denominate in measured ink width or grid squares, never raster pixels"**.
Both halves have since failed, and the rule stated that way was hiding the fact that a choice has to
be made per parameter rather than once.

- **Grid squares fail when the grid is not the map's.** A GM who does not need a grid leaves it at a
  default, or sets it wrong, and nothing about that is visible or reported. The pipeline still runs;
  the control simply stops meaning anything. This is the failure that prompted the amendment.
- **Ink width is not trusted across map styles** (user). It saturates at 2px, is biased thin, and is
  measured by erosion on a mask that a heavily hatched or stippled map makes unrepresentative. It is
  a good unit when it is good and there is no way to know from inside which case you are in.
- **Raster pixels stop meaning the same thing only when the megapixel budget bites**, which is
  reported and rare — and they are always *exactly* what they say for the run in front of you.

So the amended rule is: **prefer ink width where the parameter is genuinely about the linework's own
scale; otherwise prefer pixels; use grid squares only where the quantity really is an area or a
distance on the map's own grid.** Nothing may depend on the grid *silently*.

Where each parameter landed:

| parameter | unit | why |
| --- | --- | --- |
| Texture blur | px | always was; it is a filter kernel size |
| Detail window | **px** (was squares) | a filter kernel size, and it is tuned beside the blur |
| Minimum stroke width | ink widths | genuinely a statement about stroke thickness |
| Smallest ink island | **px** (was squares) | a size on the image, and ink width is not trusted here |
| Largest break to repair | px | ink widths was the first plan; rejected by the user for the row above's reason — a threshold that moves with a measurement changes what is repaired invisibly |
| Same-wall distance | px | a distance travelled across the image; nothing about it is a stroke or a square |
| Smallest room | squares | it really is an area on the map's grid, and a GM thinks in squares |
| Edge simplification | ink widths | its safety bound *is* half an ink width |

**Stage one now depends on nothing but the image.** Stage two's smallest-room control still depends
on the grid, and squared — a grid off by four puts it off by sixteen. That is a known exposure.

*Rejected: choosing the raster to hit a target pixels-per-grid-square density.* The sibling tried
it, reasoning that pixel-denominated constants are only meaningful against the ink scale they were
tuned on. It broke on a map spanning 5.4 grid squares, where the rule picked a raster 174 pixels
wide and thinned every line out of existence. Grid-derived *sizing of the raster* remains a trap.

*Note on migration:* both controls were **renamed** rather than reinterpreted. Keeping the key while
changing the unit would have read a stored `0.25` squares as `0.25` pixels, which is catastrophic
and silent. A rename means the old key is ignored and the new default applies, which is the loud
version of the same event.

*Rejected: choosing the raster to hit a target pixels-per-grid-square density.* The sibling tried
it, reasoning that pixel-denominated constants are only meaningful against the ink scale they were
tuned on. It broke on a map spanning 5.4 grid squares, where the rule picked a raster 174 pixels
wide and thinned every line out of existence. Grid-derived sizing is a trap in its naive form; ink
width is the unit that survives.

### Connectivity — the pairing is not optional

Connected-component labelling must use **8-connectivity for ink and 4-connectivity for space** (or
the reverse, consistently). Using the same connectivity for both produces the classic paradox: a
one-pixel diagonal touch simultaneously connects the ink and fails to separate the space, so regions
leak diagonally through walls that look closed. This is a correctness requirement, not a tuning
knob.

### Simplification — the direction inverts, again

The sibling's warning was that a simplifier cuts concave corners *outward*, and outward beside a
wall means into the next room. Here, outward means **into the wall**, which is desirable up to about
half the ink width and harmful past it — and at a doorway gap, outward growth can bridge into a
corridor and merge two regions.

So simplification stays conservative, but for a changed reason: not because outward error is always
wrong, but because it is only correct within a bound the simplifier does not know about. Prefer more
vertices over fewer; nobody looks at a fog region's vertex count.

*Since built, that bound has a number* (step 6). Douglas–Peucker moves the boundary by at most the
tolerance, so a tolerance under **half the measured ink width** cannot carry a region's edge past
the centre of the wall beside it. The parameter therefore has to be denominated in ink width for the
sentence to mean anything, which is the same conclusion §5 reaches from portability alone.

Whatever half-wall coverage eventually arrives must be a **deliberate, separately-controlled**
stage, never a side effect of loosening simplification — otherwise one parameter is doing two jobs
and neither can be tuned. It is not in the initial pipeline at all (§4).

**The bound roughly doubles under the wall graph — 2026-08-29.** Everything above is about simplifying
a *region boundary*, where drifting more than half the ink width carries the edge past the wall's centre
and into the next room. A **centreline** that drifts by the same amount is still inside the wall; it only
leaves the ink at a full width. So the same risk tolerates about twice the simplification, which is where
part of §4's expected size saving comes from.

Two things do not change. Half-wall coverage still must not ride on the tolerance — under the graph it
needs no parameter at all, so this is easier to honour rather than harder. And the *region* simplification
that produces the emitted faces is still bounded the old way, because a face boundary is still a region
boundary whatever produced it.

### The two failure modes are not equally bad

- **Merging** (a leak through a doorway gap) puts several rooms in one region, so revealing one
  reveals all of them. Ruins a scene.
- **Splitting** (one room emitted as several regions) costs the GM extra clicks.

Bias toward splitting. This is the opposite of what "be conservative" suggests at first glance, and
it is worth stating because it decides several parameter choices — minimum region area especially.

---

## 6. Open questions

Each names how to answer it. The inherited rule: a diagnostic that cannot distinguish its outcomes
will be believed anyway and will invent findings, so these want direct tests.

### OQ1–OQ5 — closed in a room, 2026-08-06

All five settled by roadmap step 1, and every answer was the one the design needed. Details and the
resulting emission spec are in §4; in brief:

- **A programmatically-created filled `PATH` on the `FOG` layer is fog.** It renders as fog rather
  than as a drawing, propagates to the networked scene, reaches players, and reveals correctly.
- **A GM can select and edit one by hand**, so the refining half of the product is possible.
- **They list properly in Outliner**, named, on the fog layer, unlocked.
- **Dynamic Fog walls them**, at two wall items per closed contour. Measured per shape rather than
  inferred from a total, which the first run's single number could not have supported. The *why* was
  read out of the source afterwards and is in §3: stroking a closed loop produces an annulus with
  two boundaries.
- **Holes work**, under an even-odd fill rule: the ring is revealable and the hole is not.

**OQ6. What partition granularity does a GM actually want?** One region per room, or per room plus
its adjacent corridor stub? Only answerable by running a real map at a real table.

**OQ7. What does the GM review, and how?** *Largely answered by the staging decision in §4* — emit
onto the `DRAWING` layer where proposals are visibly distinct and inert, let the GM edit them with
tools they already know, and promote to `FOG` on acceptance. What remains open is only whether a
*bulk* surface is needed on top — accept-all, revert, re-run, jump to the next suspect region — and
that is best judged after a real map has been traced rather than guessed at now.

The skeleton project already declares an action with a popover, and **that is not an answer to
OQ7.** It exists as a second, independent signal: the background page reports through the dev log
and the popover reports on screen, so the two separate "the manifest never loaded" from "the
manifest loaded and the background script died". Whether the shipped surface is an action, a tool,
or context menu items is still open, and a tool remains the likelier fit for an authoring workflow.

### Closed without testing: are networked `WALL` items refused? — 2026-08-05

Previously an open question, and dropped deliberately rather than answered. With fog shapes settled
as the output, no decision anywhere in this project turns on the answer, so a test would produce a
fact with nothing attached to it. The reported local-only restriction stands as reported (§3).

---

## 7. Constraints inherited from the sibling — verified, not guessed

Every item here was measured in a real room by the sibling project. Do not re-derive them.

- **The SDK cannot be imported into a headless test.** Its index calls `getDetails()` at module
  load, which reads `window.location.search`, so any node-environment test importing it dies with
  `ReferenceError: window is not defined`. **This dictates the layering:** every module touching the
  SDK is split from its pure half, and the pure half is where the tests live. Type-only imports are
  erased and therefore safe. This is not negotiable without adding jsdom, and the sibling's entire
  trace pipeline is testable precisely because it obeyed this from the start.
- **Items cap at exactly 8192 array entries.** Bisected to the single command: 8192 accepted, 8193
  refused. A fixed constant, not a shared budget. **Live concern here** — a traced room boundary at
  pixel resolution can exceed it easily, and see §10 for why the obvious remedy is a trap.
- **Writes are rate limited** (`RateLimitHit: "Too many requests"`), and this is *distinct* from
  validation failure. Distinguish them at every call site: retrying a size failure is futile, giving
  up on a throttle loses data. Committing sixty regions at once is exactly this workload.
- **SDK rejections are not `Error`s.** The SDK rejects with the parent frame's raw payload —
  `{ error: { name, message } }` — so `instanceof Error` is false for every failure it can hand
  back, and `.message` on the rejection is `undefined`. `describeError` is already ported.
- **Dynamic Fog's walls and lights are LOCAL items.** Read via `OBR.scene.local.getItems()`;
  querying the scene returns zero in a room where the fog plainly works. `scene.items.onChange`
  never fires for them.
- **Walls are not there at startup.** Dynamic Fog materialises them ~1.2s after a fresh load.
  Nothing may assume they exist on load — including a probe checking whether our shapes produced any.
- **Check-then-subscribe is a race.** Subscribe *before* checking `isReady()`, and make the
  operation idempotent — checking first leaves a window where the transition happens unobserved and
  the work silently never runs. A popover's connection going ready is **not** the scene being ready;
  the sibling lost two days to that one.
- **Scene metadata has no limit below 512KB per key** — measured.
- **The grid covers only MAP-layer images.** Anything outside the map image is outside the grid.
- **No textures can ever reach a shader**, and **raster rendering is not available** — `data:` URLs
  do not render. Both are settled; do not re-propose. The extraction preview has to be vector
  geometry for the same reasons.
- **Map pixel access works** cross-origin, and the sibling ships a startup probe that asserts it.
  The trace harness there can take a pasted Owlbear asset URL to exercise the real path.

---

## 8. Testing and diagnostic practice — copy it

The sibling's culture is the reason it works, and it costs almost nothing to adopt from day one.

- **Mutation testing earns its keep.** Break the code deliberately and confirm a test fails. A green
  suite on first run is evidence about the *tests*, not the code.
- **A fixture that is easy to read can be too symmetric to fail.** A tangent test on a horizontal
  run cannot detect a search being disabled when the fallback is `(1, 0)` — the right answer for
  that fixture. Sampling has to actually visit the discontinuity it claims to check. **Applies
  immediately here:** a fixture of one square room cannot distinguish correct region labelling from
  code that returns the whole image.
- **8-connectivity means single-pixel junctions barely exist.** Every pixel beside a junction is
  itself degree 3+, so a tee traces to eight chains, not three. **Central again as of 2026-08-29**,
  since §4 puts skeletonisation back on the critical path.
- **A diagnostic that cannot distinguish its outcomes will be believed anyway and will invent
  findings.** The sibling paid for this seven times in five disguises. Its `CLAUDE.md` lists them;
  read that list before building any diagnostic here.
- **Change one variable at a time.** A question was called closed twice before it was, both times
  after changing two things at once.
- **Diagnostics that fire unconditionally are worth their noise.** One that only fires when
  something is known to be wrong cannot distinguish "fine" from "never ran".

### The area check, in plain terms — clarified 2026-08-29

It is **not** a measure of how well the map was read. It says nothing about the threshold, the ink, or
whether the linework was found correctly. It is a check on the **boundary tracer**, and it works by
computing the same quantity twice by two unrelated routes:

1. The labelling stage walks the mask and **counts pixels**: this region is 12,904 pixels.
2. The tracing stage independently produces the region's outline, and the **area enclosed by that
   outline** is computed from the polygon.

Those two numbers must be equal, exactly, for every region — plus any hole the fill swallowed, which is
added to the expected figure rather than excused from it. "Area check exact" on every run means the
shape we are about to emit encloses precisely the space the labelling found.

**Why it is worth keeping even though looking at the map is also required.** The bugs it catches —
winding direction, the diagonal turn rule, a hole attached to the wrong region — all produce polygons
that *render perfectly plausibly*. A hole parented to the wrong room draws as a room with a pillar in
it. Looking at that tells you nothing. It is the §8 silent failure in its purest form: wrong looks
exactly like right, so an exact numeric identity is the only channel available.

It is also the one check that runs against shapes no hand-written fixture will ever have — 285 rings,
16 holes, 5 of them nested inside the largest region — and nested holes containing regions is precisely
where a parenting bug lives.

**It survives §4's revision**, because faces are still derived by the same labelling and tracing, just
from a rasterised wall graph instead of the ink mask.

**One honest caveat, and it is this document's own rule turned on the check itself:** as far as anyone
has recorded, **it has never failed**. The difference from the coverage line that lied is structural —
that one had a wrong formula subtracting a whole ink total, while this is an equality between two
numbers that share no code. But *treat a clean diagnostic as evidence about the diagnostic until it has
failed once*, so it wants a test that deliberately corrupts a ring and confirms it reports FAILED. If
no such test exists, add one before trusting it further.

### A warning is not a safeguard — settled 2026-08-23 (user)

**Nobody reads the log, and probably nobody reads the little messages on the panel either.** So a
control is not made safe by warning about what it might have done. Either it is **right**, or its
failure is **evident in something the GM is actively looking at**.

This corrects a habit that had been accumulating. Several controls here were justified partly on the
grounds that the run "says so" when they go wrong — the minimum stroke width warns that it can sever
a wall, the island filter warns when the largest surviving island is too small, the trace warns when
the Sauvola window is too narrow for the ink. Every one of those is a real signal and none of them
is a safety mechanism, because the person who needs it is looking at a map.

**What this does not mean.** The log is not being cut back. It remains the instrument that lets a
fault a GM *reports* be diagnosed without either party looking at pixels, which is the census's whole
justification, and it is how this project debugs itself. The change is in what a warning is allowed
to *license*: it may not be offered as the reason a risky control is acceptable.

**What it means in practice**, and this is the design consequence rather than a slogan:

- The stage-one overlay is the model. It made a global width filter defensible where a log line
  could not, because the damage appears under the GM's cursor as they drag.
- **A new control that can be wrong needs a visual channel before it ships**, not a warning. The
  gap-bridging control below is the immediate case: a closing that seals a doorway looks exactly
  like correct wall, so bridged pixels have to be drawn in their own colour or the control should
  not exist.
- *Rejected on these grounds, 2026-08-23: a grid-plausibility check.* Comparing pixels-per-square
  against measured ink width would have detected a grid that is not the map's and reported it. It
  was the natural answer to §5's amendment and it was declined, because it is a warning — the fix
  was to remove the dependency instead.

### The region census — a troubleshooting instrument, not a quality signal

Every pipeline run reports, unconditionally: region count, coverage, the largest few shares, how many
regions clear a whole grid square, the median area, how many touch the raster border, and what the
minimum-area filter dropped.

**Settled 2026-08-17, and it settles the "revisit later" below.** The GM will judge the output by
looking at it; that was always going to be true and the census cannot substitute for it. Its role is
the *reverse* direction — when the user reports something wrong, the census is what makes the fault
diagnosable, and possibly autotunable, without either party looking at pixels together. So it stays
as it is and gets **no further investment for its own sake** (user, 2026-08-17). Add to it when a
specific fault needs a number it does not yet report.

*Declined on the same basis:* reporting bounding-box fill alongside area for the largest regions, to
tell long thin slivers apart from compact cells. It would answer a live question about the test map
(below) and it is a few lines, but it is diagnostic polish ahead of the first visible output.

**The claim being made for it is deliberately narrow** (user, 2026-08-05, sceptical and right to
be). Absolute thresholds across different maps are exactly the "property of the fixture" trap this
project has already recorded twice, and a healthy count varies wildly between a six-room dungeon and
a sprawling cave. What it is likely to catch is the catastrophic case — one region holding most of
the map area, which is rooms merged through a doorway gap — and what it is likely to be *good* at is
**comparison**: same map, one parameter changed, did the numbers move. That is a much safer claim
than "these numbers tell you if the output is right", and it is the one to hold until evidence says
otherwise.

There is a second, more reliable justification that does not depend on it being diagnostic at all:
it is the **only channel through which the output can be reasoned about without looking at pixels**.
An image-processing project where every judgement requires rendering and inspecting an image is
enormously expensive to work on. Numbers are cheap. Even a census that turns out to be a weak
quality signal earns its place by making the results discussable.

*Superseded 2026-08-17: "revisit once it has been run against several real maps; if it is measuring
the fixture, say so and cut it." It is not being cut, and it is not being trusted either — it is
being kept at exactly its current size for the troubleshooting role above.*

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

The compounding danger is that such a score would look rigorous while measuring the fixture.

**The surviving form of evaluation is topological, not geometric** — and the direction taken since
makes that more natural rather than less. What matters is not whether a boundary is within some
distance of where a human would have put it, but whether regions *merge*. The region census above is
that idea in its cheapest possible form, and it is already the plan.

---

## 9. Roadmap

Front-loads the unknowns: nothing downstream is worth tuning before the emit path is known to work,
and the emit path can be tested with hand-built geometry before any pipeline exists.

**0. Skeleton project — done, verified in a room.** Vite, TypeScript, vitest, manifest with a
background page and an action popover, Pages deploy workflow, dev log shim with per-surface labels,
`describeError` with tests. Confirmed loading in a real room on two independent signals.

**1. Validate the emit path in a room, with no pipeline.** Hand-build a handful of shapes through
the SDK and observe. Answers OQ1–OQ5, each on one variable: does a filled `FOG`-layer shape render
as revealable fog; does the native reveal tool cut it; can a GM select and edit it by hand; does it
appear usefully in Outliner; does Dynamic Fog produce a wall at its boundary and does that depend on
`strokeWidth`; does a shape with a hole work. **This validates the entire architecture before a line
of pipeline exists**, and a failure in the first three is a redesign rather than a bug.

**2. Dry-run mode in the extension — done, run in a room 2026-08-15.** A control that
traces the scene's own map, reports to the dev log, and **emits nothing**. This is where tuning
happens, and it replaces the separate trace harness the roadmap originally called for.

*What it does not yet report, stated plainly:* the roadmap called for the **region** census, and
regions do not exist until steps 4 and 5. What is built is the rig around the hole they will fill —
map selection, pixels, transform, luminance — and calling that a census would let a smaller set of
numbers wear a name it has not earned. Delivered:

- **Map selection**, closing §10's "which map". Candidates ranked by world area with anything far
  smaller than the largest discarded as a token stranded on the map layer; two comparable images
  means **refuse and name them**, since one may be a GM overlay. A panel picker carries the
  nomination because a scene map is normally locked and so cannot be nominated by clicking it, which
  is how the sibling's selection-based flow became unreachable in exactly the scene that needed it.
  The choice lives in scene metadata — local storage is partitioned in a third-party iframe and can
  vanish.
- **Pixels** at native resolution, per §5. `crossOrigin = "anonymous"` is mandatory regardless of
  what the CDN sends, or the canvas is tainted; that failure reports through `console.error` rather
  than the dev log, since the dev log compiles away in a production build and this is the one
  failure about the platform rather than the map.
- **Placement**, which is step 7's arithmetic arriving early because the dry run must *report* the
  transform even though nothing goes through it. Per-axis scaling, aspect mismatch with rotation
  named as the likely cause, and the far corner logged — the only corner that disagrees under every
  wrong transform.
- **A luminance histogram and a global Otsu split**, which is the one number here that is not
  bookkeeping: it answers step 3's polarity question by measurement rather than assumption. Not
  binarisation and no substitute for it — step 3 wants Sauvola, which is adaptive and local.

*Rejected: the trace harness — 2026-08-05.* The sibling built one, and the plan here inherited it
without examining the premise. Two things caught that. The user, who used it, reports looking at it
once or twice and testing naturally sliding into an Owlbear room instead. And the sibling's own
record shows why both are true: nearly every mention of its harness is a **number** — stroke costs
at 1024×768, `fieldMax` and `fieldMean`, a bug found by it returning zero, density targeting
settled by comparison, seven tuning constants. It was a measurement rig with a viewer attached, and
the viewer is the part nobody needed.

Numbers do not need a page. Measurement on synthetic input belongs in unit tests — note that the
sibling measured against a *synthetic parchment map*, which is a generated fixture with a UI wrapped
around it. Measurement on real maps belongs wherever the real maps already are, which is Owlbear.

The dry run is also strictly better on the point the harness was worst at. The sibling's record
states that a real bug was diagnosed only after harness and room disagreed *in direction*, because
the harness never ran the world-placement stage. A dry run inside the extension executes the same
code the emit path executes, so that class of disagreement cannot arise by construction.

**Kept in reserve, to be built when the question exists:** a throwaway local page that renders an
intermediate raster. Owlbear cannot display one at all — no textures reach a shader and `data:`
URLs do not render, both settled — so this is the single capability neither tests nor the dry run
can supply. It is perhaps thirty lines at the moment something is inexplicable, and building it
before then would be infrastructure guessing at its own question.

**Known cost of dropping the harness:** trying an unfamiliar map means uploading it to Owlbear
first. Cheap per map, not free. Mitigable later by letting the dry run accept a pasted asset URL,
which is what the sibling's harness took anyway.

**3. Binarisation — done, run in a room 2026-08-16.** Sauvola's local threshold over
summed-area tables, ported from the sibling, with an explicit Gaussian blur ahead of it as the
texture-suppression control. Plus **polarity handling**, which turned out to be the substantial part.

*Rejected: deciding polarity from which luminance class is the minority.* The obvious rule, and the
histogram already reports what it needs. It fails on a map with dark walls, light floors and a
**dark fill outside the rooms** — ink and exterior both land on the dark side, so "dark" is most of
the image while the ink is plainly still dark, and the rule inverts a map that needed nothing done
to it. This project's own test map is the near miss: its exterior is a mid tone, light enough to
fall on the ground side, and shading it a little darker would flip the verdict with nothing about
the linework having changed.

*What replaced it: ink is thin, not rare.* Linework is thin everywhere by construction; floors,
fills and exteriors are not, and that property survives whatever a map does with its tones. Measured
by eroding each candidate mask by one pixel and scoring the share of ink that fails to survive — a
hairline scores 1, a three-pixel stroke about two thirds, a blob near zero. The higher score is the
more line-like reading and therefore the polarity. Readings covering more than half the image are
disqualified outright, since ink is never most of a map.

Both polarities come from **one pass**: variance is invariant under negation, so a single pair of
summed-area tables yields both thresholds and the second mask is nearly free. The two masks are
*not* complements — Sauvola's threshold is asymmetric about the mean — which is itself why the
decision has to inspect the masks rather than reason about the histogram.

The dry run reports both readings, the verdict, whether the margin was wide enough to be confident,
and **whether the retired minority rule would have disagreed** — that disagreement is the signal
that this is one of the maps the rule was replaced for.

*Measured 2026-08-16, on the test map:* dark reading 7.1% ink at thinness 0.357, light reading 12.6%
at 0.235 — dark ink, correctly, but by a margin of 0.122 against a confidence threshold of 0.1. The
verdict is right and the daylight is narrower than an easy case deserves. Binarisation of 8.4
megapixels took 708ms, both polarities included.

### Ink width — the unit §5 asked for, free from the polarity measure

Eroding a stroke of width `w` leaves `w - 2`, so a long straight stroke has `thinness = 2 / w` and
the width is `2 / thinness`. The polarity decision already computes thinness, so the width costs
nothing beyond the arithmetic — and it is exactly the denomination §5 says every parameter in this
project should use instead of raster pixels.

On the test map: **ink about 5.6px wide at 48 raster px per grid square**, or 0.12 of a square,
which is a plausible wall. The Sauvola window at 25px is about 4.5× that, comfortably clearing the
condition the radius is supposed to satisfy — and the dry run now checks that ratio rather than
assuming it, warning below 3×. Below that a heavy stroke fills enough of its own window to become
the local *ground*, and Sauvola declines to call it ink; the failure loses the boldest linework on
the map, which is the opposite of what anyone predicts.

**What the figure will not support.** For a mask holding several stroke widths the result is the
area-weighted *harmonic* mean, which is dominated by its smallest terms — so a scattering of
one-pixel noise specks drags it below the real linework. And it **saturates at 2px**, since erosion
removes a one-pixel and a two-pixel stroke alike. Read it as a checkable indicator, not a
measurement: a map with visibly heavy walls has no business reporting 2.

*Not done, and worth considering later:* deriving the Sauvola radius from the measured ink width
rather than from a grid fraction. It is circular in one pass — the mask is needed to measure the
ink — but a second pass at a corrected radius would cost only another binarisation.

*Consequence for §5's memory budget:* the summed-area tables are eight bytes per pixel and there are
two of them, live at once, and they cannot be narrowed to 32-bit — the running total reaches the
pixel count while every window statistic is a difference of two such totals, so the answer lives in
the low bits that a 24-bit mantissa has already spent. Real peak is around 34 bytes per pixel, so
the megapixel budget dropped from 48 to 16. Tiling the binarisation with an overlap of the Sauvola
radius is the reserve if a larger map ever turns up.

**4. Fill and label — done, run in a room 2026-08-17.** Two-pass connected-component
labelling of the non-ink space over union-find, with the connectivity pairing from §5, a minimum-area
filter denominated in grid squares, and the census. **No interior/exterior classification** — the
outside is labelled and kept like anything else (§4), which removes the one stage here that had no
reliable rule.

*The checkerboard is the fixture that matters.* Under 4-connected space every light cell is its own
region; under 8-connected space they all join through the diagonals into one. A single number
separates the correct rule from the wrong one, on a fixture nothing else in the suite could
distinguish — and it doubles as pressure on the union-find, allocating a few thousand provisional
labels.

*Where the merge signal moved, now that the outside is kept.* The census was designed around "the
fraction of map area in the largest region", on the reasoning that one region holding most of the map
means rooms merged through a doorway gap. That reading is dead: **the largest region is now normally
the exterior, and its large share is correct.** Treating it as an alarm would fire on every healthy
map, which is how a diagnostic gets ignored. The signal moved rather than vanished — rooms merging
into each other show up in the *second* largest region growing; a room merging with the exterior
through a gap in an outer wall shows up in the largest growing while the count falls. Neither has an
absolute threshold, and both are obvious comparing two runs, which is the claim §8 makes for the
census anyway.

*Reported per run:* region count, coverage, the largest few shares, how many clear a whole grid
square, the median area, how many touch the raster border, and what the minimum-area filter dropped.
Border contact is **reported and never acted on** — it was the candidate rule for finding the
exterior and it fails on any map whose rooms run to the edge.

#### Measured in a room, 2026-08-17 — *Lair Of The Lamb*

**Not comparable with the 2026-08-22 figures below.** The map was resized in the scene between the
two, from 68.7 grid squares across to 64.7, so the raster density went from 48 to 51 px per square
and every grid-denominated constant moved with it. Both readings are of the same image; only its
placement changed.

> 260 regions covering 92.8% of the raster; largest first 75.0%, 1.5%, 1.2%, 0.6%, 0.5%; 115 at
> least a grid square, median 0.84 sq; 1 touches the border; dropped 247 below the minimum (0.1% of
> the raster). Labelled in 342ms; whole dry run 1259ms.

**No catastrophic merge.** The second largest region is 1.5% — about 55 grid squares. Wholesale
leaking through doorway gaps would have put it in the 5–15% range. This is the one thing the census
was built to catch and it says the ink is holding.

**The arithmetic closes**, which is a real check: 92.8% space + 7.1% ink + 0.1% dropped ≈ 100%.

**The minimum-area filter is doing its job and only its job** — 247 regions dropped holding 0.1% of
the raster between them, so it is eating specks rather than threatening a closet.

Open, and carried into step 5 rather than resolved:

- **Whether 115 room-sized regions is right for this map.** Only the GM knows how many rooms the
  dungeon has, and the question was asked and not yet answered. Excluding the exterior, 259 regions
  share 17.8% of the raster: mean 2.5 squares, median 0.84, with 144 of them *smaller than a single
  grid square*. That skew is normal; the absolute count may not be.
- **What the sub-square fragments are.** Candidates: walls drawn as double lines, leaving the gap
  between them as a thin region; furniture leaving slivers against a wall; a printed grid picked up
  in patches. A printed grid caught properly would give many hundreds of cells rather than 260, so
  at most it is partial. Bounding-box fill would separate slivers from compact cells and has been
  declined for now (§8).
- **A room merging with the *exterior* has no single-run signal.** It would show as the largest
  going 75% → 78% with the count down by one, indistinguishable from a correct result. Only a
  comparison between runs catches it.
- **That the 75% region is the exterior is an assumption, not a measurement.** Consistent with the
  histogram's 79% mid-tone and with only one region touching the border; not confirmed.

**5. Boundary tracing — done, run in a room 2026-08-22.** One closed polygon per region,
plus a ring per hole, traced along the *cracks between* pixels so every vertex lands on an integer
lattice corner. All three of the things it had to get right are done:

- **Corner coordinates, not pixel centres.** Two rooms either side of a wall meet it from opposite
  faces — the left one stops at the wall's left edge, the right one begins at its right — so neither
  claims half a pixel of the wall and neither claims a sliver of the other.
- **Holes**, falling out of the traversal rather than needing a containment test. The walk keeps the
  region on a fixed hand throughout, so an outer boundary has positive signed area and a hole
  negative, and the sign *is* the classification.
- **The exterior's shape**, one outer contour plus a hole per enclosed cluster, with no stage
  anywhere deciding that it is the exterior.

*The invariant that ties this stage to the last.* A region's ring areas sum exactly to its pixel
count — a room of 900 pixels with a 25-pixel pillar traces to +925 and −25. Every coordinate is an
integer, so this is exact rather than approximate, and a hole traced the wrong way round, a boundary
off by one, or a ring silently lost all break it. It is asserted per region in the tests and
reported on every dry run as "area check exact".

*The diagonal pinch, and the turn rule that decides it.* Where two pixels of one region touch only
at a corner, the traversal can continue two ways, and the choice decides whether the geometry treats
that touch as a join or a seal. Space is 4-connected, so it must be a seal: the contour turns toward
the region, hugging the pixel it is on. Getting this backwards writes a diagonal leak into the
geometry after the labeller has correctly refused one — the same paradox from §5, one stage later.
**A single number separates the rules on the fixture built for it**: the correct rule gives one
ring, the wrong one cuts a spurious hole loose and gives two.

*A hole is kept because of what is inside it, never because of how big it is — revised 2026-08-22
after a room.* A hole renders as bare map inside an area the GM has revealed. That is right when
something else will be revealed separately there, and wrong everywhere else.

**So the test is containment**: keep a hole when it encloses a surviving region, fill it when it
encloses only ink and specks the minimum-area filter discarded. Filling happens before any boundary
is traced — the pixels simply become part of the region — so no ring is produced and nothing
downstream knows it happened. A pillar is filled in under this rule, which is correct rather than
incidental: nothing is revealed separately inside solid ink, and an unrevealed pillar-shaped blob in
a revealed room reads as a bug.

*Rejected: keeping a hole when it clears the region minimum.* The first rule, on the reasoning that
anything too small to be a region is too small to be a hole. It does not hold, and a GM found the
symptom before the reasoning was re-examined: **a region's area is its own pixels, a hole's area is
everything its ring encloses — the thing inside plus the ink ring around it.** Equal thresholds
therefore leave a band where a feature is too small to survive as a region and its hole too big to
fill, and 44 decorative features on the test map showed through as white pockets because of it.

*And raising the threshold would have been worse than leaving it.* A hole big enough to clear a
room-sized cutoff can contain a **surviving** region, and a region covering another region means
revealing the one reveals the other — the merge failure §5 biases hardest against. 156 of the test
map's 269 regions are under a grid square. Containment cannot make that mistake and needs no
threshold at all, which is one fewer thing to tune.

*Fixtures are drawn, not computed.* Step 4 paid for this: two of its fixtures were wrong before its
code was, and both were predicates. A grid drawn as text cannot hide a comb whose teeth are secretly
joined, and the whole of step 5's suite is built that way.

**Steps 5 and 6 are a pair.** An item's command array caps at exactly 8192 entries (§7), and step 5
alone produces polygons that are correct and unusable. Do not read its vertex counts as a problem.

**6. Simplify — done, run in a room 2026-08-22.** Douglas–Peucker, ported from the sibling,
with the tolerance denominated in **measured ink width** rather than raster pixels (§5).

*That unit is the safety argument, not just portability.* Douglas–Peucker keeps a subset of the
original vertices and discards only points within the tolerance of the chord replacing them, so the
simplified boundary stays inside a band of that width either side of the traced one. Inward error
eats into the room and is merely ugly; outward error runs into the wall, which §4 *wants* up to
about half its thickness and which becomes a merge past it. So the rule is one inequality: **keep
the tolerance below half the measured ink width and the boundary provably cannot cross the centre of
a wall.** The default is a quarter, leaving room for the ink-width figure itself to be off.

**Named as a bound on displacement, not a promise about topology.** A doorway notch shallower than
the tolerance can still be cut off, and Douglas–Peucker on a closed ring can in principle
self-intersect. Both need a tolerance comparable to a room feature, which the default is far below —
but neither is excluded by the argument above, and saying so is cheaper than discovering it.

*Meeting the cap by simplifying harder, never by splitting.* A region over 8192 commands has its
tolerance doubled and is re-simplified, up to a ceiling of eight ink widths. Splitting is the
obvious remedy and it is §10's sharpest trap. A region still over the cap at the ceiling is
**reported rather than fixed** — emitting it fails at the SDK boundary, splitting it puts a wall
through a room, and crushing it further produces a room shaped like nothing on the map.

*The exterior gets no special case, though §4 grants it one.* It cannot: the pipeline deliberately
does not know which region the exterior is. The escalation ladder covers it without a guess — only a
region with an enormous boundary escalates at all, and the exterior's boundary wraps every room on
the map. It ends up loosely simplified because it is large, not because something decided it was the
outside. Every region escalated past the half-width bound is **named individually in the log**,
because "the outside" is the expected answer and a room in that list is not.

*Simplification never removes a ring.* A ring small against the tolerance flattens onto its own
diagonal and stops being a shape — for a hole that means the region covers what the hole was hiding,
for a small room it means the room is simply absent from the output. The original is kept instead,
which costs a handful of commands, because a ring that collapses is by definition tiny. Vertices are
the cheap thing here and a room is not.

*Checked rather than assumed: a rising tolerance ladder gives the same answer either way.*
Re-simplifying from the previous pass and re-simplifying from the original produce identical
polygons, because Douglas–Peucker's split point in an interval does not depend on the tolerance, so
the retained sets nest. Two hundred thousand random polylines found no rising ladder that differed,
and a *falling* one differed within four trials — which is what says the search could see a
difference at all. The code re-simplifies from the original anyway, so the tolerance a region
reports is the one its shape is within, with no appeal to that property needed to read it.

**No outward offset** — the half-wall reveal is deferred to the tweaking tools (§4, §11), so the
first output stops at the ink's inner edge and rooms look slightly clipped. Known and accepted.

#### Measured on a synthetic map-sized raster, 2026-08-22

Not a real map, and it is worth being clear about what it can and cannot say. A generated raster of
3300×2550 with wobbled walls and 91 regions, of which the outside carries 132 holes:

> label 1368ms, trace 507ms, simplify 144ms. 222 rings, 153,056 vertices; area check exact.
> Simplified to 18,008 vertices in 18,230 commands across 91 items — 88% of the vertices gone.
> Worst item is the outside at 4,673 commands of 8,192, reached after one escalation to 2.8px.
> Nothing over the cap.

**What this establishes:** tracing is cheap next to labelling, the escalation ladder works at scale,
and an exterior carrying over a hundred holes fits the cap with headroom. **What it does not:**
anything about real ink. The raggedness is a sine wave, and vertex count is exactly the quantity
raggedness drives, so the reduction figure is a property of the fixture. The real numbers come from
a room.

**7. World placement — done and settled 2026-08-22.** Confirmed by eye in a room: the regions sit
correctly on the map in all four corners, which is the one check no number can make.

Raster pixels to Owlbear world coordinates, per axis, with each region anchored at
the centre of its own world box and its rings expressed relative to that anchor — which is the
contract a `Path` wants, since its commands are relative to its `position` (§4, measured in a room).

*The transform is not composed by hand, and that is inherited rather than decided here.* It comes
from `getItemBounds`, because dpi, grid offset, image scale and rotation compose in an order the SDK
documents nowhere and this pair of projects has paid for guessing at an undocumented convention
once. The cost is that the box is axis-aligned, so a **rotated** map image reports the box its
corners span instead of its own footprint; the aspect mismatch is the signal, and the dry run warns
on it.

*Anchoring at the region's centre has one solid reason and one that is reasoning.* Solid: command
magnitudes stay small and symmetric about zero, so a wrong number looks wrong in a log rather than
being a small perturbation of a large world coordinate. Reasoning, and **unchecked**: an item's
`rotation` and `scale` almost certainly pivot about its `position`, so a GM rotating a proposed
region would swing it about its own middle rather than about a distant shared origin. Worth
confirming in the same room session as everything else here, since it is the difference between a
nudging tool that behaves and one that flings a closet across the map.

*What the tests establish, and what they cannot.* Per-axis scaling, the relative-to-position
contract, holes sharing their region's anchor, and an asymmetric shape keeping its orientation are
all covered — on a fixture whose two axes scale by deliberately different factors, since the test
map's 0.000% aspect mismatch would leave the per-axis machinery unexercised and a square fixture
could not tell a correct transform from a transposed one. **What no test here can settle is that
raster (0,0) is the world box's minimum corner.** That is a claim about Owlbear's conventions, and a
flip or a transpose fills exactly the same box, so every number the pipeline can produce is happy
with a mirrored map.

*So the pre-room diagnostic is aimed at that specific gap.* The dry run reports where each of the
largest regions landed as a **fraction across and down the map**, plus its size in grid squares —
figures a GM can check against the map in front of them without anything being emitted. Stated as
shares rather than world units deliberately: this project has already had world units read as image
pixels once. Alongside it, the placed geometry's world box is compared against the map's own and the
shortfall reported in raster pixels, which catches a scale error, the one class of failure that does
not need eyes on a map.

**Verifying this properly needs the emit path.** A transform nobody can see is not verified, and the
asymmetric shape §9 asks for has to be *looked at*. So step 7's room check is really step 8's first
run, the same way step 5 was unusable without step 6.

**8. Emit — done, run in a room 2026-08-22.** Four gestures on the panel: **stage**, **accept**,
**back to staging**, **remove** — plus **apply to staged**, which restyles proposals without
re-tracing, since appearance is a stage-two question and must be answerable without touching stage
one.

*Staging writes proposals to `DRAWING`, not fog*, per §4. Every property of that decision was
measured in step 1, and together they make a first run inert: a staged item renders in its own
colour so it is visibly a proposal, is invisible to players so a prep run does not leak the
dungeon, stays selectable and editable so the GM can nudge it, and derives **zero** walls because
Dynamic Fog filters on the `FOG` layer. Nothing about that safety is us being careful — it is a
property of the layer, which is why it holds even when the trace is wrong.

*Accepting is a property update, not a re-emission*: layer to `FOG`, `fillOpacity` to 1, `visible`
to false. Ids survive and hundreds of items are one call. The magenta is left in place, so demoting
restores the marking with no bookkeeping.

*The pipeline is one implementation with two modes, and that is load-bearing.* The dry run and the
emit path call the same function; the dry run simply declines to write. The sibling's trace harness
diagnosed a real bug only after it and a real room disagreed **in direction**, because the harness
never ran the world-placement stage — and anything keeping a second copy of the chain re-opens
exactly that gap. The log prefix changed from `dry run:` to `trace:` for the same reason: those
lines are now emitted during a real write, and a label that lies is worse than no label.

*Throttle and refusal are separated at the write, which is the only place the distinction can be
acted on* (§7). A throttled batch waits and retries on a short backoff; anything else stops the run
immediately, because retrying a refusal is a hang wearing the costume of resilience. The match for
a throttle is deliberately **loose** — either the name or the message will do — since the two
mistakes are not symmetric: a throttle read as a refusal silently loses regions, while a refusal
read as a throttle costs three pointless retries and then reports itself anyway.

*Writes are batched and paced.* Two limits, guarding different things: an item count that paces
against the rate limiter, and a command count that bounds one call's payload, since two dozen
regions near the 8192-entry cap is a quarter of a million numbers crossing a `postMessage`
boundary and that failure is not a clean refusal. **Both numbers are first guesses**; the item cap
was bisected in a room by the sibling, but nothing has ever measured where a write starts being
refused for size. Expect them to move, and move one at a time.

*A region still over the command cap is skipped and named, never truncated or split.* Owlbear
refuses an oversized item and the refusal fails the whole batch it travelled in, so attempting one
known-invalid shape would take a few dozen valid ones down with it. What lands is therefore correct
as far as it goes, with the gaps stated.

*A partial failure is left in the scene rather than rolled back.* Undoing it would mean more writes
through the limiter that just refused one, and the GM can see what landed. The panel says how far
it got and that removal is manual.

*Staging over an existing set is refused, not merged.* Emitting twice would double every region, and
choosing which copy survives is the re-run question — a product decision §10 assigns to step 9, and
one a first emit path has no business answering quietly. The remedy is the explicit remove.

**What the first room session has to settle**, in rough order of how much depends on it:

- **Whether the regions are in the right places at all**, which is step 7's check and cannot be made
  any other way. An asymmetric map, looked at.
- **Whether the partition is one a GM wants** — OQ6, and the first time it has ever been askable.
- **Whether an item's `rotation` pivots about its `position`**, which regions are anchored on the
  assumption of.
- **What the batch limits should actually be**, and whether the rate limiter is reached at all at
  260 items.
- **Whether 115 room-sized regions is right for this map**, carried forward unanswered since step 4.

#### First staging run in a room — 2026-08-22

The first time anything this pipeline computes has been looked at. Three findings, one of which
changes a design decision.

**Measured, 2026-08-22 — the whole chain on *Lair Of The Lamb*.** The map has been resized in the
scene since step 4's run, so it now spans 64.7 grid squares rather than 68.7 and the raster density
is 51.0 px per square rather than 48. Constants moved because the map moved, not because the code
did.

> 269 regions covering 92.7%; largest 74.9%, then 1.5%, 1.2%, 0.5%, 0.5%; 113 at least a grid
> square, median 0.74 sq; dropped 260 below the minimum (0.1% of the raster). Traced to 367 rings
> (98 holes, **0** diagonal pinches), 49,110 vertices, **area check exact**. Simplified to 10,298
> vertices in 10,665 commands across 269 items; worst item 2,029 of 8,192; **nothing escalated**.
> Whole trace 1.3s; staging 269 shapes in 12 batches 1.6s; accept 2.9s; remove 2.6s. **No throttling
> at any point, and no warnings.**

**Placement is exact and confirmed by eye.** The placed geometry fills the map's world box with zero
shortfall on both axes, and the GM reports the shapes sitting correctly on the map **in all four
corners** — which is what a numeric check cannot establish, since a mirror fills the same box.
**Step 7 is settled.** The one thing this scene still cannot exercise is per-axis scaling: the aspect
mismatch is 0.000%, so a single uniform scale would produce identical numbers.

**Accept and remove behave correctly**, so the review cycle works end to end.

**The command cap is not a live concern on this map, and the synthetic benchmark overstated it
threefold.** The exterior carries 55 rings and costs 2,029 commands against a cap of 8,192 — where
the generated raster of the same size predicted 4,673 for 132 rings. Its raggedness was a sine wave
and vertex count is exactly what raggedness drives, so that figure was a property of the fixture,
as it was labelled at the time. Real linework is cheaper than invented linework.

**Diagonal pinches: zero.** The turn rule has a fixture and a correctness argument and, on this map,
nothing to do. Worth knowing before anyone spends effort there.

**The batch limits are untested rather than validated.** Twelve batches went out with no throttling,
which means the limiter was never reached — so 24 items / 20,000 commands is *at most* conservative,
and where the ceiling actually sits is still unknown.

**The floor grid is traced as walls, and the GM counts that as correct.** Step 4 listed "a printed
grid picked up in patches" as one of three candidate explanations for its sub-square fragments, and
this is it, confirmed by eye rather than inferred from a count. The user's judgement is that nothing
could have known better, and that stands.

*What it costs, stated rather than waved past:* grid lines detected in patches are the worst of the
three outcomes for region shape — a fully-detected grid would at least be uniform, and an
undetected one leaves rooms whole, while a partial one wanders a boundary along a line that is not a
wall. It is a splitting failure rather than a merging one (§5), which is the side to fail on.

*And there is a signal, which is worth knowing even though nothing acts on it.* Grid rules are
thinner than walls, and the pipeline already measures ink width. A thickness-based filter is
therefore possible in principle; it is not free, because ink width is an area-weighted harmonic mean
over the whole mask rather than a per-stroke measurement (§9 step 3), so a real version needs a
per-component thickness. Logged, not scheduled.

**Proposals are hard to see, and the cause is coverage rather than layering.** The first reading was
that fog paints over the staging layer — `DRAWING` is third in the stack and `FOG` is eleventh, so it
does sit above. **That is not the operative cause**, and the correction is the GM's: Owlbear's fog is
*transparent*, so being under it does not hide anything.

What actually defeats the eye is that the proposals **cover the whole map**. The exterior is emitted
like any other region (§4), so every pixel that is not ink is under a magenta fill, and a fill with
nothing to contrast against is a flat wash rather than a shape. Turning fog off helped only by
removing one of the two tints laid over the same art.

**So the fix belongs in how a proposal is drawn, not in where it sits.** Which is fortunate, because
there is nowhere else to put it: every ordinary layer is below `FOG`, and the four above it —
`POINTER`, `POST_PROCESS`, `CONTROL`, `POPOVER` — are not places for editable content.

*Step 1 could not have caught this*, and it is worth seeing why rather than filing it as an
oversight. It placed six hand-built shapes at the viewport centre and asked whether a staged item
renders in its own colour, hides from players, stays editable, and derives no walls. Every one of
those answers is still correct. The question it never asked was what a proposal looks like when
there are two hundred of them and they tile the map, which is not a question six shapes can raise.

**Decorative features inside rooms show through as bare map, and the hole filter is why.** The GM
reported small areas inside rooms left unfilled. They are **kept holes**: of the 98 holes traced,
54 belong to the exterior and are the enclosed room clusters, which is correct — the other **44 sit
inside rooms**, and each one renders as untouched map inside an area the GM will reveal.

A hole is kept when it encloses at least the minimum region area, which is the same threshold used
to discard a region. **The two numbers are equal and do not mean the same thing**, which is the
error: a region's area is its own pixels, while a hole's area is everything its ring encloses —
the thing inside *plus the ink ring around it*. So there is a band where a feature is too small to
survive as a region and its hole is too big to be filled, and every feature in that band leaves a
white pocket.

**The obvious fix is wrong.** Raising the hole threshold to something room-sized would cover these
pockets and would also cover any *surviving* region that happens to be enclosed — and a room shape
covering another region means revealing the one reveals the other, which is the merge failure §5
says to bias hardest against. 156 of the 269 regions here are under a grid square, so this is not a
remote possibility.

**Fixed the same day, by containment rather than by size:** keep a hole when it encloses a surviving
region, fill it when it encloses only ink and discarded specks. Exact, incapable of merging
anything, and it removes the threshold rather than retuning it. Full reasoning at §9 step 5. The
mechanism is a flood of the region's complement inward from its bounding box — whatever the flood
cannot reach is enclosed, each enclosed component is exactly one hole, and one look at the label map
says whether anything inside it survives.

*Reported from now on:* the count and size spread of holes kept inside anything but the largest
region. Under the new rule every one of those encloses a nested region, which is unusual enough to
be worth seeing.

**Bare patches are discarded floor, and the diagnostic that ruled that out was broken — 2026-08-22.**
A GM reported light areas inside rooms showing through. Five explanations were offered before the
answer arrived, and the last four were all rejections of the right one:

1. Fog painting over the staging layer. Wrong: Owlbear's fog is transparent.
2. Tokens rendering above it. Wrong: they are map details.
3. Holes kept by a size rule. **Half right** — it was a real defect and fixing it removed 39 of the
   44 pockets, but it was not what remained.
4. A filled tone landing on the ink side of the threshold. Wrong, and the GM refuted it in one
   sentence: the patches are *white*, and a local threshold marks a pixel ink for being **darker**
   than its window's mean. No composition of that window calls white ink.

**The answer came from pointing at one pixel:**

> raster (772, 1640) luminance 0.991 is floor, but its region was below the minimum area and was
> discarded, so no shape covers it

Floor, genuinely white, discarded by the minimum-area filter — the one stage nobody had questioned,
because a diagnostic said it could not be responsible.

**That diagnostic was wrong, and it is the more important finding.** The coverage line computed bare
floor as *uncovered area minus total ink*. But some ink **is** covered — the containment fill
swallows ink whenever it fills a hole — so subtracting the whole ink total oversubtracts, and the
result went negative and was clamped to `0.00%`. It read as "nothing is bare" on a map with visible
bare patches, and it was believed twice.

The failure is the one §8 names, in its most expensive form: **a diagnostic that cannot distinguish
its outcomes will be believed anyway**. This one could not distinguish "no bare floor" from "bare
floor exists and the arithmetic conflated two quantities", it was consulted precisely when that
mattered, and it was used to reject the correct explanation. Building it felt like the disciplined
move; it cost two rounds.

*Fixed by measuring rather than inferring.* Tracing now counts, per filled hole, how much of what it
swallowed was **floor** rather than ink. Bare floor is then exactly the area the minimum-area filter
discarded less the floor that fills reached, and the run says so in pixels and grid squares and
warns when it is not zero.

**Why the containment fill does not reach these.** A feature whose ink joins the wall linework is
*not enclosed* by the room — the flood reaches its interior from outside the region, so it is no
component's hole and no fill ever sees it. Its interior is simply a region below the minimum,
discarded, covered by nothing. The same geometry makes it invisible to the compact-ink check, which
is recorded there as a limitation.

**The lever is the minimum area, and §5's bias points at lowering it.** A spurious region costs the
GM one click; a bare patch is a visible defect in a revealed room. The threshold is 0.1 grid squares
and every discarded region is by definition smaller than that, so the question is only how far down
to go — which is a judgement about *this* map's noise, and now has a number attached to it on every
run.

**And the lesson about instruments, which is worth more than the fix.** Every diagnostic this project
had reported a *total*, and a total cannot say what is happening at the place a human is pointing.
Four wrong explanations were argued from aggregates. The point probe — "what is here?", answering
region / ink / discarded floor with the luminance actually read — settled it on the first use.

**Staged proposals do sit under every scene item but the map and the grid**, which is true, was
found while chasing the wrong explanation, and is worth keeping. `DRAWING` is third in the layer
stack; props, mounts, characters, attachments, notes, text and rulers are all above it, and `FOG` is
eleventh — so acceptance reverses the order and a proposal's appearance changes on promotion. A
proposal is hardest to see exactly where a GM has put something. No layer avoids it: everything
above `FOG` is special-purpose. Review with tokens hidden.

**Rotation pivots about the bounding-box centre**, which is what step 7 anchored regions on the
assumption of. Note precisely what this does and does not establish: our anchor *is* the geometry's
bounding-box centre, so "rotates about `position`" and "rotates about the bounding box" name the
same point here and the observation cannot separate them. It does not need to — both give the
behaviour the anchor was chosen for, and the ambiguity is now permanently harmless rather than
merely unresolved.

**9. Re-run and review — next.** Idempotency — replace our own shapes, never touch the GM's — and
whatever OQ6 resolves to. A re-run destroys hand edits, so it must be deliberate and warned. Step 8
holds the placeholder for it: staging over an existing set is simply **refused**, which is safe and
is not an answer.

---

## 10. Likely pitfalls

Named in advance so they are recognised rather than discovered. Roughly in order of how expensive
they are to find late.

**Splitting a region to fit the item cap creates a wall across the middle of a room.** Dynamic Fog
derives a wall from *every* shape boundary, so cutting one oversized region into two adjacent shapes
puts a boundary — and therefore a wall — down the join. The cap must be met by simplifying harder,
and an oversized region is a signal that simplification is too timid, not an invitation to chunk.
This is the sharpest trap in the design, because chunking is the obvious remedy and is correct
everywhere else in Owlbear.

**Inverted ink polarity produces a confident, complete, exactly wrong answer.** A binarizer assuming
dark ink on a light ground, run on light-on-dark linework, traces the complement of the structure.
Spectacular when noticed, and the census will not catch it — the region statistics of a correct
answer and its complement can look similar. Note this is *ink* polarity specifically; the second
polarity question, interior versus exterior brightness, is retired by §4 and is not a hazard.

**~~The outside region.~~** *Retired 2026-08-16.* It was to be identified and discarded, and no rule
for identifying it survived contact with real maps — border-touching fails when rooms run to the
edge, tone fails because the convention varies by drawing style. The outside is now **emitted like
any other region** (§4), so nothing has to recognise it. The census should still report the largest
region's share of the map, but as information rather than as a decision waiting to be made.

**Diagonal leaks.** The connectivity pairing in §5. A one-pixel diagonal gap in ink is invisible to
the eye and merges two rooms.

**~~Holes and winding direction.~~** *Retired 2026-08-06.* Under an even-odd fill rule an inner ring
cuts a hole whichever way it winds, and even-odd is what we emit (§4). Fixtures should still include
a room with a pillar, but for the hole itself rather than for its winding.

**~~`strokeWidth` of zero.~~** *Retired 2026-08-06.* Measured: a zero-stroke shape produced exactly
as many walls as a stroked one. Stroke width is free.

**Hatching and texture traced as rooms.** Cross-hatching outside walls encloses hundreds of tiny
areas. The minimum-area filter is the guard, and it is the sibling's `minContourLength` trap in a
new costume: set high enough to kill hatching, it eventually eats a genuine closet.

**Re-running over hand edits.** Once a GM has nudged the output, a re-run that replaces everything
destroys their work silently. Our own metadata tag makes "replace only ours" possible; making it
*safe* is a product decision, not a technical one.

**Which map.** A scene can hold several `MAP` images — one of them may be a GM-only overlay that
must not be traced. The sibling needed an explicit nomination flow for exactly this and so will we.

**Pre-existing fog.** A scene may already have fog shapes, drawn by the GM or by Forecast. Ours add
to them rather than replace them, and Dynamic Fog derives walls from theirs too. Neither is wrong,
but the interaction should be a decision rather than a surprise.

**Wall count is twice the contour count, not the region count.** Every closed contour we emit
becomes two `Wall` items (§3), and a region with a pillar has two contours. Sixty rooms, three of
them with a pillar, is 126 walls rather than 60 — so any budget, rate-limit or performance
estimate reasoned from "one shape per room" is out by rather more than a factor of two. Cheap to
know now, expensive to discover at scale.

**Performance.** Labelling and tracing a 4000×4000 map in JavaScript. Typed arrays throughout,
single-pass where possible. Probably fine; worth measuring before it is a complaint.

---

## 11. Future ideas — logged, not scheduled

### Closed: half-wall coverage, and skeleton snapping as the way to get it — 2026-08-29

**Both halves of this are answered by §4 and neither is a future idea any more.**

The problem was that a region's boundary stops at the ink's inner edge, so a revealed room looks
clipped, and the only automatic fix available was a global outward offset — one radius against variable
ink width, under-covering heavy walls and over-covering light ones on the same map. The proposed
solution was to run skeletonisation *separately*, keep centrelines as a non-emitted overlay, and offer a
GM-invoked tool that expands a boundary outward until it meets a centreline and never past it.

**What happened instead is that the centrelines became the pipeline.** Faces are the graph's own
regions, so a face boundary *is* the centreline and half-wall coverage is true by construction, with no
tool, no search distance and no parameter. The snapping tool has nothing left to do.

**Two things from it are worth keeping, because they were right and still bind:**

- **The centreline is the ceiling.** Whatever inset is eventually offered for the "err toward showing
  less wall" direction moves the boundary *back* from the centreline, never past it.
- **Where the skeleton is noisy — thick filled walls, hatching — it proposes nonsense.** That risk did
  not go away by being promoted; it moved from a GM-invoked tool onto the critical path, which is
  strictly worse and is exactly why §11 step C looks at a real map before anything is emitted.

### Next, in order — user, 2026-08-29

**This supersedes the 2026-08-23 order below**, which is kept because items 0 to 3 of it are *built*
and their reasoning is how those features work. Items 4 and 5 of it survive into step A here.

The pivot in §4 does **not** disturb stage one. Every model starts from the same ink mask, so
"what counts as ink" and "which ink counts as walls" are untouched; only what happens after them
changes.

**A. The UI rework — six steps in the workspace.** Most of the work moves onto the workspace surface,
the panel shrinks to an entry point plus the actions that need the real scene in view, and the steps
become real modes rather than headings. Full description under "Six steps, and the panel that is left"
below. Agreed 2026-08-29; unaffected by the pivot, which is why it goes first.

**B. Dropped.** A partial watershed plus a hole-rule fix would have repaired every defect §4 names
while staying region-first. Correct, and not worth building on a representation we are leaving —
"re-inventing skeletonization with a series of tweaks" (user).

**C. The skeleton as a workspace *view*, before it is an emit path.** Thinning plus pruning, drawn over
the ink, emitting nothing. Spur density, junction behaviour and stub survival on a real hand-drawn map
are exactly what reasoning cannot settle, and finding out costs a view rather than a rewrite. Same
posture as the two probes that have already paid for themselves. **The one step to keep ahead of the
rest**: if the skeleton comes out hairy on a real map, that is known before anything is committed.

**D. Faces from the graph.** Rasterise the graph, label, trace contours — reusing the existing
labelling, contour tracing, area check and simplification with a different input. Half-wall reveal
falls out with no parameter.

**E. Emit.** Fog shapes for the faces, lines for the uncovered edges by the bridge criterion (§4),
vertex ids in metadata, exact matching on read-back.

**F. The gap repair moves onto the graph** — endpoint pairing and graph distance replacing the closing,
the bank grouping, the bounded flood and the guessed-break state. It **retires** the pixel repair
rather than joining it: that one is confirmed working in a room (2026-08-29) and is expected to be
deprecated the moment this lands, so it stays with the reading controls in the meantime and gets no
further investment.

**G. Vector editing.** Additions and deletions as durable inputs; a move implies the freeze point (§4).

*Deferred deliberately, not forgotten:* **doors** stay with Dynamic Fog (§3 — door subtraction is
global, so they cut our walls with nothing emitted by us). **Sizing the graph against the metadata
limit** and **measuring what Owlbear does with overlapping fog shapes** were both raised and both
dropped by the user on 2026-08-29 as not blocking the direction.

### The 2026-08-23 order, and what it built

Items 0 to 3 are done, and what follows is how those features work rather than a plan. Items 4 and 5
were never built and now live inside step A above.

#### 0. The workspace probe — CLOSED, 2026-08-23

**Stage one moves to its own opaque, interactive surface.** The reasoning is in §4 under "Superseding
all of the above"; the short version is that the click-through overlay is mostly machinery for coping
with not owning the transform, and that everything queued below wants interaction it structurally
cannot provide.

Both halves are answered and the full results are in §4 under "The workspace probe". In brief:

- **The surface owns its input.** Pointer, wheel and right-click are ours with no leak to Owlbear,
  against a detector made to fail before its zero was believed. The keyboard is *taken rather than
  given* — until claimed, every keystroke reaches Owlbear's page — and claiming it succeeds on the
  first try, about 150ms in. `hidePaper` changes nothing.
- **The navigation feels right**, at **12% per mouse notch** and **1.00% per trackpad pixel**, and it
  opens on the view Owlbear was already showing so nothing jumps.
- **Frame cost is negligible** — 0.1ms of a 16.7ms frame with both map-sized layers.
- **Two trackpad limits are Firefox's, not ours**, and Owlbear has them too, so we match: a
  two-finger scroll is axis-locked when begun along an axis, and a pinch cannot carry a pan.

**Carried forward into item 3 and 4:** because a left-drag will become the brush, the workspace owes
a trackpad user an unrestricted drag-pan on another binding — **a modifier held while dragging,
and/or a dedicated hand tool**. The wheel's axis-lock makes the two-finger gesture an inadequate
substitute on its own.

**The next thing is the workspace itself**, not another probe: the real mask instead of the
stand-in, stage one's controls inside the surface, and the click-through overlay deleted along with
its poll, settle, blank-and-restore, clip band and panel heartbeat. Items 1 to 4 are then built
**on that surface**.

#### 1. The workspace itself — BUILT 2026-08-23

Stage one now lives on the proven surface: the real binary ink mask, 1a and 1b's controls on the
same surface, and the click-through overlay deleted with all of its coping machinery. Panel tab 1 is
one button that opens it. Full write-up in §4 under "The workspace"; two defects were found in a
room and fixed the same day.

**Carried forward, and both are the reason the next items are next:** the re-read is on release
rather than live until the work moves off the main thread or is cropped to the visible region, and
the surface owes a trackpad user an unrestricted pan on a binding other than a plain left-drag
(**Ctrl held while dragging, and a dedicated hand tool** — both, user 2026-08-23) once that drag
becomes the brush. The hand tool exists as a button today with nothing to switch to.

#### 2. Gap marks — BUILT 2026-08-23, and merged into item 3

**These two items are one feature.** Marking and repairing were built as separate controls and
collapsed into one the same day — the reasoning is under item 3, and it is a fact about maps rather
than a change of mind about the UI. Everything below about *what counts as a gap* and how it is
detected survived that unchanged; only the controls and the drawing did not.

**Highlight small breaks in the ink.** A wall with a thin section eroded away — by the minimum
stroke width, or simply drawn faintly — leaves a break, and a break merges two rooms into one
region, which is this project's worst failure. There is an example on the current test map.

This is the visual channel §8 requires before the bridging control below can be justified: a break
must be *seen*, not reported. The mark is conspicuous rather than subtle, since it flags the failure
that matters most and the GM is scanning a whole map.

##### What counts as a gap — settled after two wrong answers

> **A gap is a narrow channel of ground whose banks of ink are far apart when measured *along the
> ink*.**

Two definitions were proposed and both were wrong, and they are recorded because each failed on a
case that reads as obviously correct once stated.

- **"A break that separates the space when sealed."** Exact-sounding, and it tests the wrong thing:
  the *space*, when the question is the integrity of the *ink*. **A freestanding wall standing in
  the middle of a room separates nothing**, so a crack in it would never be reported — yet it is
  just as broken, and a map may hold a great many meaningful walls inside one area of space (user,
  2026-08-23). It also costs a full space labelling, about 400ms.
- **"A break between two different ink blobs."** Fails on **a crack in a ring**, where both banks
  belong to one blob by way of the long trip round the other side.

The user's own formulation is what fixed it: *cracks between blobs of ink that appear to be
different blobs when cut off at a local area.* "Locally different pieces" and "far apart along the
ink" are the same statement. Two ink pixels three pixels apart across a crack, where getting from
one to the other through the ink means travelling most of the way round a room, are different pieces
of wall whatever the global labelling says. Two ink pixels three pixels apart across a ragged notch
in one wall's edge, where the trip through the ink is eight pixels, are the same stroke.

**Travel through the ink, not connectivity inside a cropped window.** A wall that bulges out of a
window and back is still one wall, and travel says so where a crop would not — and travel needs no
window shape, so it is rotation-invariant for free.

##### How it computes, and why only the first step is expensive

1. **A closing** at the gap radius. What it converts from ground to ink is exactly the set of narrow
   channels — cracks, notches, enclosed pockets, and the hollow interiors of double-line walls. The
   candidate set, and nothing more.
2. **The bank groups.** The ink touching one channel, grouped into the pieces it arrives in. **One
   group means a dead end**, because the banks wrap round it continuously; a channel that passes
   *through* has ground at both ends, so its banks arrive as two or more separate faces. This step
   alone throws out the ragged-edge noise a raw closing produces in quantity, and it costs nothing.
   Without it the marks are confetti.
3. **The travel test.** Flood through the ink from one **whole** bank group — whole, so a bank
   running the length of a long channel cannot be judged far from itself — stopping at the travel
   distance. Every other bank reached means the ink is locally one piece. Any bank unreached means a
   break.

**Both thresholds are GM controls, and both are in raster pixels** (user, 2026-08-23). Stage one
stays close to the raster, and the ink width is itself a measurement that can come out oddly on an
unusual map — a threshold that moved with it would change the marks for reasons the GM cannot see.
The travel distance is exposed rather than fixed in code deliberately, on the argument that if it
turns out never to be touched it can be dropped; it is the number in this design with the least
evidence behind it.

##### What it is expected to get wrong, predicted rather than discovered

- **A double-line wall.** Where a map draws walls as two parallel strokes with white between, that
  white is a narrow channel and the strokes meet only at the ends of a run — so every hollow wall
  gets marked. This is reasoning, not measurement. It comes out as one mark per wall run rather than
  a shower of them, the width control tunes it away, and on such a map bridging is arguably the
  right answer rather than the mark being wrong.
- **A speck of ink lying close to a wall.** Two locally different pieces, so a gap. Guardable by
  demanding both sides amount to a real stroke; not done, because a speck that close to a wall is
  worth a glance and the island filter is the tool for removing it.
- **A crack beside a corner or a T-junction** can be missed, since the two banks meet round the
  corner within a short travel. Lowering the travel distance is the answer, and it is the reason
  that control exists.

##### What it draws

**Breaks are painted in their own colour, on their own layer, at full alpha** — so tinting the ink
down to look at the map underneath does not also turn the warning down. That layer was built here to
satisfy §8's rule for the bridging control **before** the control that needed it existed; item 3
then arrived and the two became one feature, so it now carries the repaired pixels themselves.
Invented pixels and read pixels must never be indistinguishable.

**A ring in screen space at each break**, dark stroke then bright over one path so it reads against
pale paper and dark stonework alike. Screen space is the point: a break is a handful of raster
pixels and would be sub-pixel with a whole map on screen, which is exactly the situation the mark
exists for. It grows to enclose the break once the view is zoomed past it.

**The count goes on the state line in the neutral tone, not the error tone.** Most maps will have a
few, and a status line that is permanently red is a status line nobody reads — which is the §8
failure wearing different clothes. The rings are the channel that must be noticed; the count only
tells a GM whether the ones they can see are all of them.

**The gap colour is fixed rather than a swatch row.** The argument that makes the ink colour
adjustable — no colour is readable on every map — applies here too, and this is the honest cost: the
ring is what carries the identification when the colour collides. A picker is the fix if a room
reports the marks disappearing into the paper.

##### Superseded within a day: a third value on the kind axis

`PARAMETER_KIND` gained `gaps` here and lost it again under item 3. The reasoning while the marks
only *highlighted* was sound — derived from the mask so not `pipeline`, but costly enough that
treating them as `display` would have run half a second of morphology on every frame of a drag. Once
the repair became real every gap parameter fed the mask, the third value had no members, and a kind
with no members is a filter that silently matches nothing. The cost it was avoiding is answered by
caching the reading separately instead; item 3 has the account.

**What survived it, and is the durable part:** the workspace's row builder switches on the kind
rather than on which heading a control is drawn under. That was a live conflation — a control moved
between headings for tidiness would have silently changed what it recomputed.

##### Measured — the morphology inner loop, 2026-08-23

The separable pass addressed each pixel through a closure that chose between two multiplications,
twice per pixel. At 8.4 megapixels that is sixty-seven million decisions per opening, and a room had
measured an opening at 440ms. Replaced with a base and a stride. Measured in Node on the development
machine, at 3300x2550 with linework-shaped ink:

> radius 3 — old opening 310ms, new opening 236ms, new closing 208ms
> radius 6 — old opening 503ms, new opening 235ms, new closing 219ms

**The new one is flat in the radius and the old one was not**, which it should have been in both
cases — the algorithm is O(1) in the radius by construction, so the old version's climb was the
interpreter rather than the arithmetic. **This is not the room's number**: Node on a desktop is not
Firefox in a third-party iframe, and the 440ms figure needs re-measuring there. What the A/B
establishes is the ratio, not the absolute.

So a gap search costs roughly one closing plus a linear scan plus some bounded local floods — call
it the same order as a stage-1b filter, against 690ms for a reading. That is the whole reason the
search runs off the mask rather than off the map.

#### 3. Bridging small gaps — BUILT 2026-08-23, and it absorbed item 2

**One slider** (user, 2026-08-23, after two were tried and abandoned — see below). It sets the widest
break to find, and everything it finds is repaired.

**Confirmed in a room — user, 2026-08-29. It works.** The one-slider shape and the ring-plus-fill
drawing both do what they were built to do on a real map, which closes the last thing this feature
was waiting on.

**And it is provisional.** Step F moves the repair onto the wall graph — endpoint pairing and graph
distance in place of the closing, the bank grouping and the bounded flood — and this version is
expected to be **retired** rather than kept alongside it. Until then it stays where it is, with the
reading controls (user, 2026-08-29). Two consequences worth stating rather than discovering: it is
not a candidate for further investment, and the six-step layout should not be arranged around it,
since the step that would exist to hold it is the one thing here with a known end date.

**Repaired pixels are drawn purple, at full alpha on their own layer, with a screen-space ring round
each break.** Purple is the only ink on the surface that the map does not contain.

##### The fill is not a closing, and that is a safety property

Morphologically a repair *is* a closing, and the obvious implementation is to close the mask at the
fill radius and keep the result. **That would be wrong, and invisibly so.** A blanket closing also
seals channels that **failed the travel test**, and the clearest example of one is a narrow doorway
right beside a corner, where the two banks meet round the corner within a short travel. It would be
sealed with nothing at all to see — where an opening's failures at least leave a visible absence —
and Dynamic Fog would then derive a wall across an open door and block line of sight through it.

So the fill adds the pixels of **marked breaks** and nothing else. That gives the invariant the
whole design rests on:

> **Every pixel the fill invents belongs to a break that has a ring on it.**

Consequences worth stating:

- **A dead end is never filled.** It connects nothing to anything, so sealing it could not have
  helped, and it carries no mark.
- **A break the search only guessed at** — one where the flood ran out of budget — is marked but
  never filled. Marking on a guess is a warning; inventing ink on a guess is not.
- **A break only partly inside the fill width stays open.** A break sealed along part of its length
  is still a break at the rest of it, so a partial fill is no fill at all.
- **Filling defaults to off while highlighting defaults to on.** Looking costs nothing but time;
  inventing ink changes what gets emitted, and no control that writes into a map's linework should
  do so before a GM has looked at what it would write.

##### Superseded within a day: two controls, discover and fill — user, 2026-08-23

**Built, tried in a room, and abandoned.** One width highlighted candidates; a second, expressed as a
share of the first, selected which of them were repaired. Purple rings for a break left open, green
for one filled. The workflow it was for: settle the first to get a stable set of places worth
attention, then sweep the second and watch how many of that fixed set turn green, judging the trade
with the reference set held still underneath.

**The premise was false, and a map said so.** Breaks are not discrete items discovered one at a time
as the width rises. Where two uneven lines run close together — which is most hand-drawn linework —
a closing carves the space between them into **several channels at the pinch points**, and those
channels **merge into one** as the radius grows. A break therefore has no stable identity across
radii, so there is no reference set to hold still.

It was worse than merely odd. A channel was only repaired when **all** of it fell inside the fill
radius, so once several small channels merged into one large one, that one no longer fitted — and
**raising the highlight could prevent a repair that a lower setting allowed.** Non-monotonic, and
unexplainable to anyone turning the knob.

**One control is well behaved for a precise reason.** What a GM tunes is then the **set of pixels
repaired**, which grows with the radius, rather than a set of discrete marks, which does not. The
channel count still moves around as channels merge — it stays in the log and on the state line as a
diagnostic, and it is explicitly **not** a tally of distinct faults.

**What carried over unchanged**, because none of it depended on there being two controls: the
definition of a gap, the three-step detector, the targeted fill and its invariant, the separate
full-alpha layer, and the screen-space rings.

**What changed with it:**

- One colour, purple, for repaired pixels and their rings. The second colour survived only for the
  one case that is genuinely different — see below.
- `Control.format` was introduced so the share could read as `50%` rather than `0.50`, and went with
  it. So did `derive` taking the whole settings object: nothing is expressed relative to another
  setting any more, and a readout that cannot see its neighbours cannot go stale when one moves.
- The per-row hint repainting **stayed**, on a better justification than the one it arrived with.
  Several readouts report a setting against a *measurement*, and before a first trace they say "trace
  once for a figure"; without a refresh they would go on saying it until that row's own slider was
  touched.
- `gapWidthPx` was **renamed** to `gapFillPx` rather than reinterpreted. The old key meant "highlight
  only", so a scene storing it would silently have begun inventing ink at whatever width had been
  chosen for looking. A rename falls back to the default, which is the loud version.

##### One exception to "everything found is repaired"

A channel whose flood ran out of budget was never *proved* broken. **Marking on a guess is a warning;
inventing ink on a guess is not.** Those get a ring and no fill, which reads on the surface as an
empty ring — a state that is visibly different from a repair without needing a second colour. The
painter takes `null` for that state rather than a colour, so it cannot be drawn as though ink had
been added where none was. The state line names the count separately.

##### Off by default — user, 2026-08-23

**This is the only control in stage one that invents ink** rather than deciding what to make of ink
the map already has, and nothing should write into a map's linework before a GM has asked it to. It
was briefly on at 12px, on the argument that a break merges two rooms and the GM who never reaches
for the control is the one who needs it. That argument is about *warning*, and warning is no longer
what this control does — it repairs.

**The cost, named: a break goes unreported until the control is reached for.** The separate
always-on marking that covered that went with the two-slider split, so nothing between a GM and a
merged room announces itself except the second-largest-region alarm in the log — which §8 says
nobody reads.

**Accepted, and the reason is that the failure announces itself downstream** (user, 2026-08-23): a
break usually makes the *regions* visibly wrong, and a GM looking at a partition that has merged two
rooms comes back here to find out why. So the control is where you go once you have seen the
symptom, rather than a warning that fires before you have.

That is a real argument rather than a concession, and it is worth separating from the §8 rule it
looks like it contradicts. §8 forbids a **silent** failure — one with no channel at all. This one has
a channel: the proposals themselves, which the GM is already obliged to review before staging. What
§8 rules out is a control that can be wrong with nothing to look at, and stage two's output is the
something to look at.

If a room shows the symptom is *not* obvious enough — two rooms merging in a corner nobody was
studying — the answer is a warning that costs nothing and writes nothing, not a repair that runs
unasked.

##### The ink is composed from layers now — the user's framing, 2026-08-23

The mask the regions come from is no longer "the reading, filtered". It is a composition, and it was
built to take all four terms even though two of them do not exist yet:

```
basic ink  −  GM-suppressed areas  +  gap fills  +  GM-drawn ink
```

The order is not arbitrary. Suppression comes **before** the gap search, so repairs are derived from
ink the GM has already corrected. GM-drawn ink comes **last**, so nothing automatic second-guesses a
line drawn deliberately — which is the standing requirement for §11 item 5.

Two consequences already visible:

- **The surface draws the base ink, not the composite.** Handing it only the composite would make
  invented pixels indistinguishable from read ones, which §8 forbids. The fills arrive separately
  and are drawn in their own colours.
- **The gap search moved out of the workspace and into the pipeline.** While the marks only
  highlighted, computing them on the surface was right. The moment the fill became real they had to
  be the same computation that produces the mask — a second copy on a surface is the sibling's
  harness-versus-room failure waiting to happen.

##### The mask cache is now two caches

**Splitting is right** (user), and the composition above is the reason it is more than an
optimisation: the layers will keep multiplying, and every one of them acts on the mask rather than on
the image.

- **The reading** — binarise, decide polarity, measure the ink width — is cached on the map's
  identity plus the 1a parameters alone. About 690ms of a 1.4s run.
- **The composed ink** is cached on everything, and built from a reading that may have been reused.

So a sweep of a 1b filter or either gap slider re-runs only the cheap half. Without the split, every
notch of a slider whose whole purpose is comparative would have paid a full re-read.

**The boundary is declared by exclusion, and the polarity of that is the point.** Everything counts
as a reading input *unless it is named* as post-reading. Add a new binarisation parameter and forget
this file, and the reading cache goes **useless** — 690ms, obvious in the log. Write it as an opt-in
list, forget the same edit, and a reading gets **reused when it should not have been**, which is a
mask that is quietly wrong. This project has already paid once for a diagnostic that lied.

Four tests pin it: every non-excluded reading parameter moves the reading fingerprint; every excluded
one does not; every excluded one still moves the *mask* fingerprint, so none of them is a setting a
GM can change with no effect at all; and both sides of the boundary are non-empty, since every one of
those tests is a filtered loop and a filter matching nothing passes.

##### The third parameter kind lasted one commit

`PARAMETER_KIND` went `pipeline | display` → `pipeline | gaps | display` → back again. The `gaps`
value was right while the marks only highlighted: derived from the mask so not pipeline, but costly
enough that treating them as free would have run half a second of morphology on every frame of a
drag. The fill made all three gap parameters feed the mask — the highlighting ones included, since
the fill repairs only what is *marked* — and a kind with no members is a filter that silently
matches nothing. The cost it was avoiding is answered by the reading cache instead, which is a
better answer because it makes the 1b filters cheaper too.

The one test that would have caught a silently-empty kind is the one asserting every kind has a
member, and it is kept.

#### 4. Painting to suppress ink

**Let the GM paint areas where ink is ignored** — meaningless crosshatching being the motivating
case. Local where the global controls are blunt, and the counterpart to the global width and island
filters: those cannot distinguish hatching from linework by measurement, and the GM can by looking.

#### 5. Painting ink

**Let the GM draw ink that is applied after everything in stage one.** Already the record's
"GM-drawn ink", and long identified as the highest-value unbuilt thing. Applied last, so it is
immune to the opening and the island filter — the GM drew it deliberately and no automatic filter
should second-guess it.

Both 3 and 4 exist for the same reason: **they are how a GM fixes details once the general settings
are as good as they are going to get.** Every global control has a point past which it costs more
than it gains, and that point arrives with the map still imperfect. They also survive re-runs by
being *inputs* rather than outputs, which is what a stage-two hand edit is not.

**How the GM paints was the open question, and the workspace is the answer** (user, 2026-08-23).
The click-through overlay cannot be painted on: its pointer events are disabled, and that is exactly
what lets the map be panned while it is up. A mode toggle would mean no panning while painting,
which for a painting tool is a bad trade. An opaque interactive surface owns all input, so both of
these become ordinary — and a purpose-built brush with a live preview of what a stroke would do
becomes possible, which neither alternative allowed. This is the single biggest reason item 0 comes
first.

### Retired: the overlay's panel band did not lift — logged and dissolved 2026-08-23

**Dissolved rather than fixed.** The band, the heartbeat and the overlay that needed them were all
deleted when stage one moved to the workspace: controls that live *on* the surface need no space
reserved for a popover somewhere else. Kept because it is a clean example of the pattern this
project keeps meeting — a bug whose right fix turned out to be removing the thing that had it.

Measured in a room: the band is reserved correctly while the panel is open, but **closing the panel
does not bring the ink back**. The heartbeat stops, so the band should expire within one stale
interval and the next poll should repaint — it does not, and why is not yet established. My first
suspicion is that the repaint on a band change only fires from inside the poll's settled branch, so
a view that has not moved since may never take it; that is reasoning from the code, not a diagnosis.

**The user's fix is better than repairing this** (2026-08-23): when the panel is put away, the
overlay should **disappear entirely** rather than expanding to fill the space. It is a working
surface for stage-one tuning, and stage-one tuning happens in the panel — an overlay left painting
over a map nobody is currently tuning is clutter that hides the map at exactly the moment the GM has
signalled they are done with it. That also dissolves the bug rather than fixing it: there is no band
to lift if there is no overlay.

It would want the presence signal to distinguish "panel closed" from "panel never heard from",
since a stale heartbeat and a broadcast that never arrives currently look identical, and one of
those must not take the overlay down. Not urgent; the overlay is usable as it stands.

### The overlay colour controls want a second look — logged 2026-08-23 (user)

Built as seven preset swatches plus a native `<input type="color">`, with the swatches as the floor
because a native colour dialog inside a sandboxed third-party iframe is the rendering path that
already made the map dropdown paint white-on-white and look empty. **The native picker works** —
confirmed in a room — so the hedge turned out to be unnecessary.

The swatches stay anyway (user), because one click to cycle contrast on a difficult map is worth
having and the picker is several. But *how the two sit together* was never designed: a row of
squares and a system colour well side by side is what you get from adding the second control to the
first, not from deciding what the pair should look like. Revisit both the arrangement and whether
seven is the right number, alongside whatever other display controls the overlay grows.

Not urgent. Nothing here is wrong, it is merely unconsidered, and it will be easier to judge once
there is more than one thing being drawn on the overlay.

*Still open, and the controls moved 2026-08-23:* they live on the workspace now rather than in the
popover, beside the mask they colour instead of a tab away from it. That is the arrangement question
made easier rather than answered — and the "more than one thing being drawn" it waits on is now
concretely the next two items, since gap marks and bridged pixels each need a colour of their own
that cannot be confused with read ink.

### Erosion and a minimum line width are different tools — clarified 2026-08-23 (user)

Worth writing down because the record's own shorthand invites the confusion, and this session made
it: naming a filter by its *effect* rather than its *operation*.

- **Erosion** shrinks every ink region by `k`. Thin marks vanish; thick marks survive **thinner**.
- **An opening** — erode by `k`, dilate by `k` — deletes marks narrower than `2k` and returns
  everything else to its original width. This is what "minimum line width" means.

The difference is not academic, because **regions are bounded by ink, so thinning ink grows every
region**. Erosion alone therefore pushes every fog boundary outward by `k`, which makes it not a
crude minimum-width filter but *the global outward offset* — already considered and left out above,
since one radius against variable ink width under-covers heavy walls and over-covers light ones on
the same map.

**The two were rejected for different reasons, and only one has expired.** The offset's problem is
*accuracy*: it is wrong in both directions at once and no single value fixes both, which seeing it
does not help with. The minimum width's problem was *visibility* — it can sever a thin wall
anywhere, and nothing would say so — and the stage-one overlay is exactly visibility. That is the
one worth reopening, and §9 carries it.

### Doors

Wanted as soon as the fog works well. Dynamic Fog's door reactor filters on the same condition as
walls, so doors are metadata on drawings we already own — the smallest possible version of the
coupling, and it changes nothing about what we emit today. It does mean writing into
`rodeo.owlbear.dynamic-fog/…`, which is the one place this project would touch a private namespace.
Read `DoorActor` before committing to it; it is the one part of the wall/door path still unread.

### Lights — declined

Not extracted from map images, and nothing consumes a light without Dynamic Fog anyway. Dropping
them removes the only place where its private namespace was unavoidable.

---

## 12. Code sharing with the sibling — decided: copy, and the case has weakened

The genuinely shared surface is now **smaller than it was**: image loading, binarisation, the
geometry helpers. The middle of the sibling's pipeline — thinning, skeletonisation, chain chopping —
is not on this project's critical path at all.

**Still copying, and the reasoning holds but for a different reason.** It is no longer "the tuning
will diverge before it converges"; it is that the overlap has turned out to be small enough that a
shared package would be mostly ceremony. Versioning, a release step, a second lockfile and CI for
both is real cost, and it would buy sharing for a few hundred lines of well-tested pure functions.

**The cost of copying is real and should not be dressed up as a virtue: bug fixes will not
propagate.** A defect found in binarisation here will still be present there, and nothing will tell
either project about it. Note fixes in both design records when they happen. This has already been
paid once — two dev-log defects found here in the first session exist unfixed in the sibling.

**Revisit if** §11's skeleton tool lands, since that would put the two projects back on genuinely
shared ground.

---

## 13. Licence — GPL-3.0-or-later

Free-tier Pages requires a public repository, so a licence has to exist before the first push.
Matching the sibling, and chosen as the option least likely to need changing rather than on
principle:

- **Nothing is published until the first push**, so up to that point the choice costs nothing to
  revise.
- **Relicensing is one-directional in practice.** The copyright holder can relicense at any time,
  but anyone who took a copy under the old terms keeps those rights to *that copy* permanently, and
  once outside contributors land code they hold copyright on their parts. With no contributors,
  moving to something permissive later stays easy; the reverse direction is the one that gets stuck.
- **The coupling that would have forced it has mostly dissolved.** What this project emits is a
  standard item type on a standard layer, which is no closer a relationship to Dynamic Fog than
  using the SDK is. The exception is the door work (§11), which would write into its namespace —
  still interoperation rather than derivation, but the closest this project gets.
