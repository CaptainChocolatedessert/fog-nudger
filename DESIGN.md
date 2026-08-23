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

## 4. The decision: emit filled regions on the `FOG` layer

Settled 2026-08-05. One artifact — filled shapes, one per enclosed walkable area — placed on the
`FOG` layer of the networked scene.

**Why this and not the alternatives:**

- It is **useful with nothing else installed**. Vanilla Owlbear renders it as manual fog of war and
  the GM reveals room by room.
- It **degrades gracefully rather than failing**. Dynamic Fog adds line-of-sight; any other fog
  extension that follows the same convention gets the same input; neither is required.
- It is **not coupled to a private schema**. The filter that matters is layer plus item type.
- The GM edits it **with tools they already have** — the native fog tools — and editing the region
  edits the fog and the wall together, because the wall is derived from the region.

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

### Reveal about half the wall

A revealed region should extend into the wall, roughly to its centre, rather than stopping at the
ink's inner edge (user, 2026-08-05). The reasoning is a product judgement, not a technical one: the
wall is part of the drawing and makes the room look complete, sometimes carries detail worth seeing,
and a region that stops at the floor reads as though the party is being shown a partial room.

The risk is symmetrical and understood: too much wall can reveal a secret door. That is exactly
where the nudging comes in, and it sets the safe direction for tuning — **err toward showing less
wall**, because a GM notices a room that looks clipped far more readily than a door they were never
meant to see.

**Deferred out of the initial pipeline** (user, 2026-08-05). The only automatic implementation
available is a global outward offset, and a single radius against variable ink width is not expected
to be reliably right often enough to be worth having on by default. So the first version reveals to
the ink's inner edge and rooms will look slightly clipped — a known, named cost of shipping the
simple thing first, not an oversight. The precise version belongs with the tweaking tools (§11),
where it can be local and GM-invoked.

### Superseded: centreline extraction — 2026-08-05

The previous design reached for centrelines down the middle of the ink, on the argument that
contour tracing gives two lines per drawn wall with a hollow gap between them that the party can
stand inside. **That argument was correct in its context and does not apply here**, and the reason
matters enough to write down so it is not re-litigated:

- Under region tracing, two adjacent rooms' boundaries do sit on opposite inner edges of the wall
  between them. But the gap between those boundaries is **inside solid ink** — unreachable, and
  falling inside no fog shape, so it stays hidden permanently. It is not a place anything can stand,
  and sight is blocked by either boundary.
- The original failure was two lines derived from the silhouette of a *thin drawn line*, then
  treated as two independent walls with walkable space between them. That is a different geometry
  from the boundary of an enclosed region.

### Superseded: centrelines emitted as thin drawings — 2026-08-05

A late variant: emit centrelines as thin `FOG`-layer drawings and let Dynamic Fog stroke them into
walls. Correct walls, but **a thin line emitted as fog is a thin revealable sliver** — visually
useless on its own, so the whole thing did nothing unless Dynamic Fog was installed. Regions do
something in both cases. This was a hard dependency traded away for nothing.

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

### The stage-one overlay — measured in a room, 2026-08-23

Stage two's representation is the coloured proposals staged on the drawing layer. Stage one needs a
different one, because its data is a different *kind* of thing: a per-pixel classification at native
resolution — ink, kept floor, discarded floor — which is dense, unsummarisable, and today only
answerable one pixel at a time by the point probe. **The overlay is the point probe made total.**

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

#### Blank and restore, and why the cheap poll does not retire it — user, 2026-08-23

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

**View changes need no recompute, only re-projection.** Render the tri-state classification once
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

**Where the dividing line actually falls** is "what does the map say" against "what do I want" — and
one operation moves across it on inspection. *Splitting a region because of something not on the
map* reads like a stage-three edit and belongs in stage one, as **GM-drawn ink**: draw the wall, and
the next trace splits the region. That survives re-runs because it is an *input* rather than an
output; it re-derives both halves with correct boundaries, where splitting a polygon by hand leaves
a join that Dynamic Fog turns into a wall across a room; and it uses tools the GM already has, which
is the same argument §4 makes for editing fog natively. Not built; the highest-value thing that is
not.

### The controls

Three for stage one — ink threshold, texture blur, detail window. Two for stage two — smallest room,
edge simplification. Two for stage three, both about how a proposal is drawn while it is being
judged.

- **One declaration decides which stage owns which parameter**, and both the panel's tabs and the
  pipeline's cache invalidation read it. Two lists would be two places to disagree about what a knob
  invalidates, and the disagreement would be silent in the direction that matters — a stage-two
  tweak reusing a mask it should have thrown away. A test asserts the mapping is total and that the
  three stages partition the parameters exactly.
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
load → binarize → fill and label → discard outside → trace boundaries → simplify → place → emit
```

### What transfers from the sibling, and what does not

**Transfers:** image loading and the cross-origin pixel path; binarisation (Sauvola adaptive
threshold, blur); the geometry helpers; polygon simplification, with a changed constraint; and the
whole testing and diagnostic culture, which is the most valuable part.

**Does not transfer: thinning, skeletonisation and chain chopping** — the expensive, well-tested
middle of the sibling's pipeline. Region filling does not need a medial axis.

**That cost should be stated plainly rather than minimised.** The head start on this project is real
but it is concentrated in the parts that were never going to be hard. The stages that took the
sibling the longest are the ones we are not using. Skeletonisation may return later as a *tweaking*
tool (§11), which would recover some of the value, but not on the critical path.

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
pixels, which made the raster load-bearing forever. Ours should be denominated in **measured ink
width** — already this project's natural unit, since the half-wall coverage target in §4 is stated
as a fraction of the wall's own thickness. Keep it that way and the raster never becomes something
we cannot change.

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
  itself degree 3+, so a tee traces to eight chains, not three. Less central than it was now that
  skeletonisation is off the critical path, but it returns with §11.
- **A diagnostic that cannot distinguish its outcomes will be believed anyway and will invent
  findings.** The sibling paid for this seven times in five disguises. Its `CLAUDE.md` lists them;
  read that list before building any diagnostic here.
- **Change one variable at a time.** A question was called closed twice before it was, both times
  after changing two things at once.
- **Diagnostics that fire unconditionally are worth their noise.** One that only fires when
  something is known to be wrong cannot distinguish "fine" from "never ran".

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

### Half-wall coverage, and skeleton snapping as the way to get it

The initial pipeline leaves a region's boundary at the ink's inner edge, so a revealed room looks
slightly clipped (§4). The obvious automatic fix is a global outward offset, and it was considered
and left out: one radius against variable ink width under-covers heavy walls and over-covers light
ones on the same map, which is not reliably right often enough to have on by default.

The precise version is a **local** one: run skeletonisation separately, keep the centrelines as a
non-emitted overlay, and offer a tool that expands a region's boundary outward until it meets a
nearby centreline — **and never past it**. The centreline is the ceiling for expansion, which is the
half-wall rule expressed locally instead of globally, and it adapts to varying ink width for free.

This is attractive for three reasons: it recovers the value of the sibling's skeletonisation code
without putting it on the critical path; it is precisely the kind of *nudging* the project is named
for; and it fails safe, because a tool the GM invokes on a region they are looking at cannot quietly
corrupt a map.

Risks to design against: the nearest centreline may belong to a *different* wall across a thin
partition, so it needs a maximum search distance and an outward-only constraint; and where the
skeleton is noisy — thick filled walls, hatching — it will propose nonsense, which is survivable
only because it is GM-invoked rather than automatic. Recompute the skeleton from the map image on
demand rather than persisting it; pixel access is verified to work, and a stored skeleton goes stale
the moment the map changes.

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
