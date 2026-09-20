/**
 * The clear family: one verb, one meaning, three tiers.
 *
 * ## What "clear" means, and what it does not
 *
 * **Clear destroys the stored thing.** Nothing else on this surface does, and nothing else may use
 * the word. *Discard changes* — which put one paint layer back to its last save — was deleted on
 * 2026-09-18 precisely because it made "discard" mean the opposite one button away, and because its
 * extent was unknowable: it reverted to "the last save", and the save is an event this surface
 * stopped marking when the save button went. Putting the brush down saves, switching group saves,
 * closing saves, and none of them is announced.
 *
 * The tiers, narrowest first:
 *
 * | control | where | takes |
 * |---|---|---|
 * | *Clear layer* | a brush's own drawer | that one paint layer |
 * | *Clear ink edits* | the foot of the Ink band | **both** paint layers |
 * | *Clear wall edits* | the foot of the Walls band | the wall document, **leaving the marks** |
 * | *Clear all marks* | *Suppress region*'s drawer | the suppression marks |
 * | *Clear everything* | the panel | the scene as though the extension never ran |
 *
 * ## The two area-level ones are in the STRIP, not in a drawer — user, 2026-09-20
 *
 * They were going to sit at the foot of each group's drawer, beside the controls they undo the work
 * of. They belong in the band instead, under the tools they clear up after. **That makes them a
 * third kind of button in the strip**: it has carried a *drawer opener* and a *verb*, neither
 * disturbing the other, and these are an **act** — they open nothing and arm nothing, so they never
 * draw pressed. The argument that lets a panel and a verb share a column covers this too (user,
 * 2026-09-15: *"You click on what you want and it might open a drawer of settings or it might pick
 * up a tool"*) — the column is a list of things to press, and what each one does is its own
 * business.
 *
 * **The cost, stated:** a destructive press now sits one row below the tools, in a column a GM
 * reaches for constantly, where a drawer would have put two presses in front of it. What stands in
 * front of it instead is the confirmation, which is what stands in front of *Clear layer* too.
 *
 * ## Clear ink edits takes BOTH layers — user, 2026-09-18
 *
 * *Clear layer*'s is deliberately narrower, on the stated ground that *"discarding the suppression
 * because a stroke of added ink went wrong would be one button destroying work it was never pointed
 * at"*. That argues against widening a button sitting in **a brush's** drawer. It says nothing
 * about an area-level one: **a GM does not perceive two layers, they perceive their edits.**
 *
 * ## The cascade is the cover's to name, not this confirmation's — user, 2026-09-20
 *
 * The ink is upstream, so clearing it changes the composite, which rebuilds the walls, which takes
 * hand wall edits with it. The record had this confirmation carrying that. It does not: *"the cover
 * over the map and ink tools delivers a warning that these tools will remove wall edits, so by the
 * time the user can touch the tools, they don't need another warning."* This button is a member of
 * that cover like every other thing on the ink side, so by the time it can be pressed the question
 * has been asked and answered and the walls are already a derivation. Its own confirmation speaks
 * about the ink alone.
 *
 * **Until the cover is built, the per-control gate stands in for it**, exactly as it does for a
 * marked slider and a marked ink tool: pressing while the walls hold hand edits raises the review
 * rather than clearing, and hands the clear over to run if the answer is yes. That branch becomes
 * unreachable the day the cover lands, in the same way the per-control marks do.
 *
 * DOM here; the decisions are `paintState`'s, `stage`'s and `regionMarks`'.
 */

import { confirmAction } from "../confirmDialog";
import { devLog } from "../devlog";
import { describeError } from "../describeError";
import type { PaintKind } from "../inkPaintStore";
import { currentMarks, saveMarks } from "./regionMarks";
import { anyPaintToClear, replaceBothLayers, snapshotBothLayers } from "./paintState";
import { requestRecompose } from "./reading";
import { clearWallEdits as clearStoredWalls, wallsEdited } from "./stage";
import { invalidate, say } from "./shell";
import { pushUndo, type Restore } from "./undoHistory";

/**
 * One act at a time.
 *
 * Two confirmations cannot be up at once — `confirmAction` removes an existing dialog and leaves its
 * promise dangling — and a second press landing while a write is in flight would snapshot a document
 * halfway through being replaced.
 */
let busy = false;

/**
 * Wipe both paint layers.
 *
 * **Through one write path and one undo entry**, because this is one act the GM performed. The
 * snapshot is of what is *drawn* rather than what is stored, so a brush still in hand with strokes
 * still unwritten is covered — see `snapshotBothLayers`.
 *
 * **A recompose is asked for on the way in and on the way back.** The reading composes from the
 * layers, so the ink on screen and everything derived from it are stale until it runs; a paint undo
 * already asks for exactly this, for exactly this reason.
 */
export async function clearInkEdits(): Promise<void> {
  if (busy) return;

  /*
    Emptiness is answered at the press rather than by greying the button out.

    That is the Defaults button's rule — *"a button that is sometimes wrong about whether it would do
    anything is worse than one that always says what it did"* — and it is not a breach of the strip's
    own rule that a control offered where its presses do nothing is a control that lies. The strip's
    rule is about what is *structurally* unavailable: no map, no graph. This is about being empty
    right now, which is what walking the raster on every redraw would cost to know.
  */
  if (!anyPaintToClear()) {
    say("there is no painted ink on this map to clear");
    return;
  }

  const yes = await confirmAction({
    title: "Clear your ink edits?",
    body: [
      "Everything you have painted on this map goes — the suppression and the added ink together, " +
        "including gaps and blobs you accepted, which are paint like any other.",
      "The map, the reading settings, your walls and your region marks are untouched. One step of " +
        "undo brings all of it back.",
    ],
    confirmLabel: "Clear them",
    destructive: true,
  });
  if (!yes) return;

  const before = snapshotBothLayers();
  busy = true;
  say("clearing your ink edits…", "working");
  try {
    await replaceBothLayers({ suppress: null, ink: null });
  } catch (error) {
    // The write is what makes it real, so a failure leaves the GM the paint they had — or as much of
    // it as never reached the scene. Nothing goes on the stack, because there is no single state to
    // return to.
    const detail = describeError(error);
    say(`could not clear your ink edits: ${detail}`, "bad");
    devLog("error", "workspace: clearing the ink edits failed", detail);
    console.error("Fog Nudger — clearing the ink edits failed", error);
    return;
  } finally {
    busy = false;
  }

  pushUndo("clearing the ink edits", paintStateBack(before), "ink");

  requestRecompose();
  invalidate();
  say("cleared your ink edits — one step of undo brings them back");
}

/**
 * The way back to a pair of layer snapshots, which hands back the way forward again.
 *
 * `stage.ts`'s `restoreTo` in miniature, and deliberately the same shape: the state being left is
 * captured *inside* the restore rather than at the push, so undo and redo can be pressed alternately
 * for ever rather than one level each. Writing "forward is the clear" here instead would be right
 * exactly once.
 */
function paintStateBack(target: Readonly<Record<PaintKind, string | null>>): Restore {
  return async () => {
    const leaving = snapshotBothLayers();
    await replaceBothLayers(target);
    requestRecompose();
    invalidate();
    return paintStateBack(leaving);
  };
}

/**
 * Throw the wall document away, so the walls are a fresh reading of the ink again.
 *
 * **It touches nothing above it**, which is what makes it the cheaper of the two area-level clears
 * despite the parallel name: the ink is an input to the walls and the walls are an input to nothing.
 */
export async function clearWallEdits(): Promise<void> {
  if (busy) return;

  if (!wallsEdited()) {
    say("these walls are exactly what the trace derived, so there is nothing of yours to clear");
    return;
  }

  const yes = await confirmAction({
    title: "Clear your wall changes?",
    body: [
      "Every wall you moved, drew, erased, mended or spanned goes, and the walls become a fresh " +
        "reading of the ink again.",
      "Your painted ink and your region marks are untouched — a mark survives the walls being built " +
        "again, so it survives this. One step of undo brings the walls back.",
    ],
    confirmLabel: "Clear them",
    destructive: true,
  });
  if (!yes) return;

  busy = true;
  say("clearing your wall changes…", "working");
  try {
    await clearStoredWalls();
    say("cleared your wall changes — one step of undo brings them back");
  } catch (error) {
    const detail = describeError(error);
    say(`could not clear your wall changes: ${detail}`, "bad");
    devLog("error", "workspace: clearing the wall edits failed", detail);
    console.error("Fog Nudger — clearing the wall edits failed", error);
  } finally {
    busy = false;
  }
}

/**
 * Take every suppression mark off the map.
 *
 * **Through `saveMarks`**, which is the one path by which the marks change: it writes, pushes the
 * one undo entry, and tells whoever draws them. Writing the store directly here would be a second
 * mechanism for the same event, and the second one always loses something — here, the history.
 *
 * It sits in *Suppress region*'s own drawer rather than in the Walls band, because the marks are
 * that tool's document and nothing else places or removes one. The band-level *Clear wall edits*
 * deliberately leaves them alone.
 */
export async function clearAllMarks(): Promise<void> {
  if (busy) return;

  const marks = currentMarks();
  if (marks.length === 0) {
    say("there are no marks on this map to clear");
    return;
  }

  const yes = await confirmAction({
    title: `Remove ${marks.length === 1 ? "the mark" : `all ${marks.length} marks`}?`,
    body: [
      "Every region you marked becomes an ordinary room again, so it will be emitted as fog the " +
        "party can be shown.",
      "The walls are untouched. One step of undo brings the marks back.",
    ],
    confirmLabel: "Clear them",
    destructive: true,
  });
  if (!yes) return;

  busy = true;
  say("clearing the marks…", "working");
  try {
    await saveMarks([], "clearing every mark");
    say(`cleared ${marks.length === 1 ? "the mark" : `${marks.length} marks`} — undo brings them back`);
  } catch (error) {
    const detail = describeError(error);
    say(`could not clear the marks: ${detail}`, "bad");
    devLog("error", "workspace: clearing the marks failed", detail);
    console.error("Fog Nudger — clearing the marks failed", error);
  } finally {
    busy = false;
  }
}

/**
 * The two acts the strip draws, at the foot of the band whose document each one takes.
 *
 * **Declared as a list rather than written into the strip's loop**, so the band a press belongs to
 * is stated once and read by the thing that draws it. `step` is the group it sits under, which is
 * also the caption that says which subject the shared bin glyph means.
 */
export interface ClearAct {
  /** The step whose band this sits at the foot of. */
  readonly step: string;
  readonly label: string;
  readonly run: () => Promise<void>;
}

export const CLEAR_ACTS: readonly ClearAct[] = [
  { step: "ink", label: "Clear ink edits", run: clearInkEdits },
  { step: "walls", label: "Clear wall edits", run: clearWallEdits },
];

/*
  **`marked` and `pressClearAct` went on 2026-09-20.** *Clear ink edits* carried a flag saying its
  press would rebuild the walls, and a press fired the review instead of clearing — the per-control
  gate standing in for the cover. It sits at the foot of the Ink band, so the lid is over it in
  exactly the case the flag was true, and the cover owns the cascade warning now: by the time this
  button can be pressed the question has been asked and answered and the walls are a derivation
  again. Its own confirmation speaks about the ink alone, which is what it always said.

  *Clear wall edits* never carried one. Clearing the walls *is* the thing the warning was about, so
  asking "may this rebuild your walls" in front of it would have been asking the GM to agree to what
  they had just pressed.
*/
