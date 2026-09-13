/**
 * The metadata namespace, and the predicate that decides what belongs to us.
 *
 * **This is guarding a delete.** The full clear removes every scene item carrying one of our keys,
 * in a scene that also holds the GM's own fog — 419 hand-drawn items in this project's test scene.
 * Over-matching deletes their work and under-matching leaves ours behind, which makes "start over"
 * a lie. It is the one part of that feature reachable from a node test, which is why it lives in this
 * module rather than beside the delete.
 *
 * Mutation-tested: five mutations, five caught — the separator dropped so a neighbour's id
 * matches, the prefix searched for rather than anchored, anchored at the wrong end, and the
 * predicate forced true and false.
 *
 * Pure: no DOM, no SDK.
 */

import { describe, expect, it } from "vitest";

import { isOurKey, key, NAMESPACE } from "./namespace";

describe("our metadata keys", () => {
  it("recognises the keys this build actually writes", () => {
    // The real ones, spelled the way the stores spell them, so a change to `key` fails here.
    for (const name of ["settings", "graph", "map-choice", "paint.suppress", "paint.ink", "region"]) {
      expect(isOurKey(key(name)), name).toBe(true);
    }
  });

  it("recognises a key no build writes any more", () => {
    /*
      The reason the clear sweeps by namespace instead of by a list: a key written by an older build,
      whose name exists nowhere in this code, is exactly what a GM starting over needs gone — and
      exactly what a maintained list forgets.
    */
    expect(isOurKey(key("some-retired-thing"))).toBe(true);
  });

  it("does not claim another extension's key", () => {
    expect(isOurKey("rodeo.owlbear.dynamic-fog/wall")).toBe(false);
    expect(isOurKey("some.other.extension/graph")).toBe(false);
  });

  it("does not claim a neighbour whose id merely begins with ours", () => {
    /*
      **The separator is the whole of this test.** Without the trailing slash in the comparison, any
      extension published as `…fog-nudger-something` would be read as ours and have its items deleted
      by a control whose entire job is deleting. A prefix test on the bare name is the shape of that
      mistake.
    */
    expect(isOurKey(`${NAMESPACE}-lite/graph`)).toBe(false);
    expect(isOurKey(`${NAMESPACE}2/graph`)).toBe(false);
  });

  it("does not claim the bare namespace with nothing under it", () => {
    // Not a key we ever write, and treating it as ours would mean clearing a value no store owns.
    expect(isOurKey(NAMESPACE)).toBe(false);
  });

  it("does not claim a key that merely contains our namespace", () => {
    // Anchored at the start, not searched for: an id embedded in someone else's key is not ours.
    expect(isOurKey(`other.extension/${NAMESPACE}/graph`)).toBe(false);
  });
});
