/**
 * What undo remembers: the last few states of a document, newest last.
 *
 * Split from `stage.ts` for the reason everything pure here is split from the module that uses it —
 * that file imports the store, which imports the SDK, so nothing in it can be reached from a node
 * test. What is genuinely tricky about undo is not the writing, it is *when the history is no longer
 * about the document in hand*, and that is the part this holds.
 *
 * ## Snapshots rather than inverse operations
 *
 * Every edit here already replaces the graph wholesale, and a graph is tens of kilobytes, so keeping
 * the old one costs almost nothing. An inverse operation would have to be derived per edit — the
 * opposite of a merge, of a prune cascade, of a crossing split — and each derivation is a second
 * implementation that can disagree with the first. A snapshot cannot be wrong about what the document
 * was.
 *
 * The bound is what keeps that honest: without one, an evening of editing holds every state it passed
 * through. Twenty is far more than anyone reaches back for and still comfortably under a megabyte.
 *
 * Generic in the document type so the test can use a cheap stand-in. Nothing here reads the graph.
 *
 * Eight mutations tried, eight caught: pushing in the wrong order, the bound dropping the newest
 * instead of the oldest, the bound off by one, a peek that consumes, a clear that does nothing, and
 * three on the tag — a clear that ignores it, one that keeps the tagged entries instead of dropping
 * them, and one that forgets nothing at all.
 *
 * Pure: no DOM, no SDK.
 */

export interface Snapshot<T> {
  /** The document as it was *before* the edit this entry would take back. */
  readonly document: T;
  /** What that edit was, in words a button can say: "erasing a wall". */
  readonly label: string;
  /**
   * Which document this entry belongs to, **as an opaque string**.
   *
   * The history still never learns what it is restoring — it cannot read this, only compare it.
   * What it buys is that *forgetting* can be as narrow as the event that caused it: throwing away
   * the wall graph makes every graph entry stale and leaves every paint entry perfectly good, and
   * clearing both was taking back the GM's ability to undo a brush stroke because they changed a
   * wall setting.
   */
  readonly tag: string;
}

export class EditHistory<T> {
  private entries: Snapshot<T>[] = [];

  constructor(private readonly depth: number) {}

  /**
   * Remember the state an edit is about to replace.
   *
   * The caller passes what the document looked like *before*, not after, because that is what undo
   * restores. Getting this backwards would make the first undo a no-op and every later one restore
   * the wrong state — which looks like undo lagging by one and is easy to misread as a timing bug.
   */
  push(document: T, label: string, tag: string): void {
    this.entries.push({ document, label, tag });
    // Oldest first, so the bound drops what a GM is least likely to reach for.
    while (this.entries.length > this.depth) this.entries.shift();
  }

  /** What undoing would take back, without taking it. `null` when there is nothing. */
  peek(): Snapshot<T> | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /** Take back the most recent entry, or `null` when there is nothing to take. */
  pop(): Snapshot<T> | null {
    return this.entries.pop() ?? null;
  }

  /**
   * Forget everything, because the document these describe is no longer the one on screen.
   *
   * Two things call this and both are the same event in different clothes: a **derive** replaces the
   * graph with a fresh function of the ink, and **loading another map** replaces it with a different
   * document altogether. Restoring a snapshot across either would put back walls that belong to
   * something the GM is no longer looking at — and because a graph is stored in fractions of *a* map
   * with nothing in it saying which, that would not even look wrong until it was pushed.
   */
  /**
   * Forget everything, or only the entries carrying one tag.
   *
   * **Narrow by default is wrong here and wide by default is right**: a caller that forgets to
   * name its tag clears too much, which costs history, where one that clears too little leaves
   * entries describing a document that no longer exists — and restoring one of those puts back
   * something the GM is not looking at.
   */
  clear(tag?: string): void {
    this.entries = tag === undefined ? [] : this.entries.filter((entry) => entry.tag !== tag);
  }

  /** How many edits could be taken back. */
  get size(): number {
    return this.entries.length;
  }
}
