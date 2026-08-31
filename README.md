# Fog Nudger

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension: **trace a map image into the fog regions
you reveal room by room.**

> **Pre-release.** The pipeline runs end to end and has been run on real maps: it reads the scene's
> map image, reads the linework into a graph of wall centrelines, derives the enclosed regions as
> the faces of that graph, fits their boundaries and places them on the map. Placement is confirmed
> correct. **What is still unproven is whether the partition it finds is the one a GM wants** — that
> is judged by looking, and the looking has barely started.
>
> Everything is reviewed *before* it is written. A full-screen workspace draws the map, the ink it
> read, the wall centrelines it found and the regions it would produce, so a partition can be judged
> and the settings tuned without touching the scene. Putting it on the map is then one deliberate
> action, and it replaces whatever the previous run left — so the tool owns its own fog and nothing
> else, but a hand edit to those shapes does not survive the next run. Editing belongs in the
> workspace, and the tools for it are still being built.

## The idea

Owlbear's fog is subtractive: the whole map starts hidden, and the shapes you draw on the fog layer
are the regions that can be revealed. So preparing a map means drawing one shape per room and
corridor, by hand, every time.

But the map already shows where the rooms are — they are drawn on it, in ink. A trace pipeline can
turn the ink into the regions, which changes the job from *drawing* them to *correcting* them.

**One artifact, two payoffs.** Those same shapes are what
[Dynamic Fog](https://extensions.owlbear.rodeo/dynamic-fog) derives its walls from — it strokes their
boundary and takes the outline. So the output is a complete manual fog-of-war map on vanilla Owlbear
with nothing else installed, and line-of-sight occlusion for free the moment Dynamic Fog is present.
Dynamic Fog is a bonus, not a requirement.

The one exception is a free-standing wall — a stub off a corner, a pillar, a barrier across a room —
which separates no two regions and so appears on no region's boundary. Those are emitted as plain
lines, which have no interior and therefore reveal nothing on their own. On vanilla Owlbear they are
inert; with Dynamic Fog they are walls.

## Why "nudger" and not "extractor"

Automatic extraction will never be perfect on a hand-drawn map. Doors, arches, curtains, windows,
secret passages and rubble all read as ink, and none of them means "solid wall". So the output is a
**proposal**: something you look at and correct before it goes anywhere near the scene, rather than
an answer you are asked to trust.

A tool that gets a GM most of the way in one click and lets them fix the remainder is a large win.
A tool that claims to be finished and is wrong in three places nobody notices is worse than
nothing — the failures are invisible until play. A gap in the inked wall merges two rooms into one
region, so revealing one reveals three; a region grown a little too far shows a secret door that was
meant to stay hidden.

## Relationship to Cartographer's Fog

[Cartographer's Fog](https://github.com/CaptainChocolatedessert/cartographers-fog) is a sibling
extension by the same author. The two share a trace pipeline and nothing else: that one *consumes*
walls to draw where the party has been, and runs on every client all session; this one *produces*
walls, GM-only, once per map, at prep time. They are deliberately separate extensions.

## Development

```bash
npm install
npm test
npm run dev
```

`npm run dev` serves the extension on `http://localhost:5273/fog-nudger/`. Add
`http://localhost:5273/fog-nudger/manifest.dev.json` as a custom extension in an Owlbear room to
load it. Note that the SDK stays inert outside a room — running the dev server and opening it
directly in a browser executes the code but produces no Owlbear activity, and that silence is
correct.

The dev manifest exists so the development build can sit installed **alongside** the published one
and be told apart on sight: it carries "(dev)" on its name and button, an action icon with a filled
dot, and an inverted logo in the extensions list. Both builds read and write the same scene data,
so keep one enabled at a time — not because they corrupt anything, but because two identical panels
is a good way to spend ten minutes wondering why an edit did not appear.

`npm run devlog` starts a small receiver on port 9998 that collects log output from inside the
extension iframe into `dev.log`.

Neither port is Vite's default. 5173 is left free deliberately, because it is what any
unconfigured project picks up by accident; the dev server is also set to fail rather than quietly
move to another port, so a URL registered in Owlbear can never end up pointing at a different
project's server.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
