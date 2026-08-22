# Fog Nudger

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension: **trace a map image into the fog regions
you reveal room by room.**

> **Pre-release.** There is nothing to install yet. The trace pipeline reads a scene's map and
> reports what it finds — resolution, placement, ink polarity and width, and the regions it would
> emit — but it does not yet write anything to a scene.

## The idea

Owlbear's fog is subtractive: the whole map starts hidden, and the shapes you draw on the fog layer
are the regions that can be revealed. So preparing a map means drawing one shape per room and
corridor, by hand, every time.

But the map already shows where the rooms are — they are drawn on it, in ink. A trace pipeline can
turn the ink into the regions, which changes the job from *drawing* them to *correcting* them.

**One artifact, two payoffs.** Those same shapes are what
[Dynamic Fog](https://extensions.owlbear.rodeo/dynamic-fog) derives its walls from. So the output is
a complete manual fog-of-war map on vanilla Owlbear with nothing else installed, and line-of-sight
occlusion for free the moment Dynamic Fog is present. Dynamic Fog is a bonus, not a requirement, and
nothing extra is emitted for it.

## Why "nudger" and not "extractor"

Automatic extraction will never be perfect on a hand-drawn map. Doors, arches, curtains, windows,
secret passages and rubble all read as ink, and none of them means "solid wall". So the output is a
**proposal**: reviewable, editable piece by piece, and rejectable in pieces without discarding the
rest.

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

`npm run dev` serves the extension on `http://localhost:5273/fog-nudger/`; add
`http://localhost:5273/fog-nudger/manifest.json` as a custom extension in an Owlbear room to load
it. Note that the SDK stays inert outside a room — running the dev server and opening it directly
in a browser executes the code but produces no Owlbear activity, and that silence is correct.

`npm run devlog` starts a small receiver on port 9998 that collects log output from inside the
extension iframe into `dev.log`.

Neither port is Vite's default. 5173 is left free deliberately, because it is what any
unconfigured project picks up by accident; the dev server is also set to fail rather than quietly
move to another port, so a URL registered in Owlbear can never end up pointing at a different
project's server.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
