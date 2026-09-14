/**
 * Every element id the code looks up exists in the page that hosts it.
 *
 * ## The class of failure this is for
 *
 * `getElementById` takes a string, and a string crossing from a module to a page is a contract
 * **nothing typechecks**. Rename an element in the markup, or delete one, and the lookup returns
 * `null` — which every call site here handles, because they all guard. So there is no error, no
 * exception and no failing test: the control is simply not there, silently, and the first thing that
 * notices is a GM in a room saying a button does nothing.
 *
 * That is not hypothetical. The drawer's anchor found its button by a CSS selector twice in one
 * afternoon on 2026-09-14 and matched nothing both times — once because a class had stopped
 * existing, once because it matched the wrong button — and the only symptom was a panel sitting in
 * the wrong place. Nothing threw either time.
 *
 * **The structural fix is not to have these contracts**, and that is what moving the anchor into the
 * strip did. This is for the ones that remain, which is every piece of chrome the shell and the
 * panel wire up by id.
 *
 * ## What it does and does not cover
 *
 * It covers `getElementById` with a **literal** string, which is the bulk of them and the part that
 * can be read without running anything. It does **not** cover selectors built from a template, like
 * the `data-opens` query in the tool strip — those are still unguarded, and the answer there is the
 * one already taken: do not reach across a module boundary with a selector.
 *
 * ## Read rather than executed, and imported rather than opened
 *
 * `?raw` imports and `import.meta.glob`, for the reason `manifest.test.ts` imports its JSON:
 * `tsconfig` declares no `@types/node`, so reaching for `node:fs` here would break `tsc --noEmit`.
 *
 * Five mutations tried, four caught: a lookup pattern that matches nothing, an id-attribute pattern
 * that matches nothing, `pagesFor` handing every module every page, and the detection reporting
 * nothing whatever it is given.
 *
 * **The survivor is recorded rather than contrived away.** Removing the `.test.ts` filter on the
 * source glob changes nothing today, because no test file contains a literal lookup — so there is no
 * honest fixture for it. It stays because a future test fixture naming an id would otherwise be
 * asserted against the markup as though production depended on it.
 */

import { describe, expect, it } from "vitest";

import backgroundHtml from "../background.html?raw";
import indexHtml from "../index.html?raw";
import overlayProbeHtml from "../overlay-probe.html?raw";
import panelHtml from "../panel.html?raw";
import workspaceProbeHtml from "../workspace-probe.html?raw";
import workspaceHtml from "../workspace.html?raw";

/**
 * The pages a module that is not a probe may find its ids in.
 *
 * The probes are excluded deliberately rather than for tidiness. They are unwired pages kept as the
 * record of how the platform facts were established, and several ids exist *only* there — so
 * allowing every module every page would let a live module keep an id that survives only in a page
 * nothing can open.
 */
const SHIPPED = {
  "workspace.html": workspaceHtml,
  "panel.html": panelHtml,
  "index.html": indexHtml,
  "background.html": backgroundHtml,
};

const PROBE_PAGES = {
  "overlay-probe.html": overlayProbeHtml,
  "workspace-probe.html": workspaceProbeHtml,
};

/** Which pages a module's ids may come from. Only the two probe entry points reach the probe pages. */
function pagesFor(path: string): Record<string, string> {
  const probe = path.endsWith("/overlayProbe.ts") || path.endsWith("/workspaceProbe.ts");
  return probe ? { ...SHIPPED, ...PROBE_PAGES } : SHIPPED;
}

/**
 * Every `getElementById("…")` in a source file.
 *
 * Literals only. A lookup built from a variable is invisible here and is meant to be — the point is
 * to catch the ones that *look* like a constant and silently are not.
 */
function lookupsIn(source: string): string[] {
  return [...source.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]!);
}

/** Every `id="…"` in a page. */
function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
}

/**
 * Which lookups name an id their page does not have.
 *
 * **A function rather than a loop inside the assertion**, so it can be handed a case that fails.
 * Over the real sources it can only ever return nothing, and "returns nothing" is also what a check
 * that examines nothing returns.
 */
function missingLookups(files: readonly (readonly [string, string])[]): string[] {
  const missing: string[] = [];
  for (const [path, source] of files) {
    const available = new Set(Object.values(pagesFor(path)).flatMap((html) => [...idsIn(html)]));
    for (const id of lookupsIn(source)) {
      if (!available.has(id)) missing.push(`${path} looks up #${id}`);
    }
  }
  return missing;
}

/**
 * The modules, as text.
 *
 * Tests are excluded: this file names ids in its own prose, and a test fixture naming one would be
 * asserted against the markup as though the production code depended on it.
 */
const sources = Object.entries(
  import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
).filter(([path]) => !path.endsWith(".test.ts"));

describe("element ids", () => {
  it("finds lookups to check, so a broken pattern cannot pass by finding nothing", () => {
    /*
      The guard that makes the rest mean anything. Every assertion below is of the form "for each
      lookup…", which a pattern matching nothing satisfies perfectly — and this suite has been
      bitten by a check that passed because it never ran.
    */
    const total = sources.flatMap(([, source]) => lookupsIn(source)).length;
    expect(total).toBeGreaterThan(20);
  });

  it("finds ids in the pages that carry chrome, so a broken pattern cannot pass by finding none", () => {
    /*
      The two pages with controls on them, rather than all four — `index.html` is a static front door
      and `background.html` is an empty host for a script, and neither has an id in it. Asserting
      otherwise was this test's own first failure, which is the right kind: the guard was over-broad
      and said so before anything depended on it.
    */
    for (const page of ["workspace.html", "panel.html"] as const) {
      expect(idsIn(SHIPPED[page]).size, page).toBeGreaterThan(0);
    }
  });

  it("reports a lookup whose page does not have the id", () => {
    /*
      **The detection, against a case that actually fails.** Running it over the real sources only
      ever proves it returns nothing, which a check that looks at nothing also does — mutation
      testing caught exactly that: replacing the comparison with `if (false)` left the suite green.
      A fixture that cannot fail is not evidence, so the failing case is written down.
    */
    expect(missingLookups([["./madeUp.ts", 'getElementById("no-such-element")']])).toEqual([
      "./madeUp.ts looks up #no-such-element",
    ]);
  });

  it("accepts a lookup the page does have", () => {
    // The other half, or the one above is satisfied by a function that reports everything.
    expect(missingLookups([["./madeUp.ts", 'getElementById("panel")']])).toEqual([]);
  });

  it("looks up no id that its page does not have", () => {
    expect(missingLookups(sources)).toEqual([]);
  });

  it("does not let an ordinary module borrow an id that only a probe page has", () => {
    /*
      Pinned directly, because nothing in the codebase currently violates it — so the rule would be
      satisfied by a `pagesFor` that simply returned everything, and a fixture that cannot fail is
      not evidence. `#hud` exists only in the workspace probe's page.
    */
    const probeOnly = [...idsIn(workspaceProbeHtml)].find(
      (id) => !Object.values(SHIPPED).some((html) => idsIn(html).has(id)),
    );
    expect(probeOnly, "the probe page should have at least one id of its own").toBeDefined();

    const forPanel = new Set(Object.values(pagesFor("./panel.ts")).flatMap((html) => [...idsIn(html)]));
    expect(forPanel.has(probeOnly!)).toBe(false);

    const forProbe = new Set(
      Object.values(pagesFor("./workspaceProbe.ts")).flatMap((html) => [...idsIn(html)]),
    );
    expect(forProbe.has(probeOnly!)).toBe(true);
  });
});
