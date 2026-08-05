# Fog Nudger

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension: **tools for creating and refining the
walls that drive dynamic fog.**

> **Pre-release.** There is nothing to install yet. This repository currently holds a project
> skeleton and its design record.

## The idea

Owlbear's dynamic fog needs walls as geometry. Today a GM draws them by hand, one line at a time,
over every room and corridor of every map they run.

But the map already shows the walls — they are drawn on it, in ink. A trace pipeline can pull out
their centrelines, which turns the GM's job from *drawing* walls into *correcting* them.

## Why "nudger" and not "extractor"

Automatic extraction will never be perfect on a hand-drawn map. Doors, arches, curtains, windows,
secret passages and rubble all read as ink, and none of them means "solid wall". So the output is a
**proposal**: reviewable, editable piece by piece, and rejectable in pieces without discarding the
rest.

A tool that gets a GM most of the way in one click and lets them fix the remainder is a large win.
A tool that claims to be finished and is wrong in three places nobody notices is worse than
nothing — a wall in the wrong place is an invisible bug that only surfaces mid-session, as a room
the party can see into.

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

`npm run dev` serves the extension on `http://localhost:5173/fog-nudger/`; add
`http://localhost:5173/fog-nudger/manifest.json` as a custom extension in an Owlbear room to load
it. Note that the SDK stays inert outside a room — running the dev server and opening it directly
in a browser executes the code but produces no Owlbear activity, and that silence is correct.

`npm run devlog` starts a small receiver on port 9999 that collects log output from inside the
extension iframe into `dev.log`.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
