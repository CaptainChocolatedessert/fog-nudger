import { describe, expect, it } from "vitest";

// As source text, the way `elementIds.test.ts` reads the pages — importing it would run it.
import source from "./deriveWorker.ts?raw";

/*
  The worker's one import, pinned.

  A worker has no `window`, and the SDK reads one the moment it loads — so anything the worker imports
  that reaches the SDK kills it before its first message, and the page falls back to deriving on its
  own thread, which looks like working. The worker is not importable here (it wires itself to the
  worker's global scope), so its imports are read instead; the module they name is imported by
  `trace/deriveProtocol.test.ts`, in node, which has no `window` either — so the whole chain below
  the worker is covered by the two together.
*/
describe("deriveWorker.ts", () => {
  it("imports the derive protocol and nothing else", () => {
    const specifiers = [...source.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gms)].map(
      (match) => match[1],
    );
    const bare = [...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((match) => match[1]);

    expect([...specifiers, ...bare]).toEqual(["./trace/deriveProtocol"]);
  });
});
