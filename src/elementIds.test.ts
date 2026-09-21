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

/**
 * Every class a module sets, as a literal.
 *
 * `className = "a b"` and `classList.add("a", "b")` both, split on spaces because the first takes a
 * list. Anything built from a variable is invisible here and is meant to be — the point is the ones
 * that look like constants.
 */
function classesIn(source: string): string[] {
  const assigned = [...source.matchAll(/className = "([^"]*)"/g)].map((match) => match[1]!);
  const added = [...source.matchAll(/classList\.add\(([^)]*)\)/g)].flatMap((match) =>
    [...match[1]!.matchAll(/"([^"]*)"/g)].map((inner) => inner[1]!),
  );
  return [...assigned, ...added].flatMap((value) => value.split(/\s+/)).filter((name) => name !== "");
}

/** Every class name a stylesheet has a rule for, however the selector is built around it. */
function styledIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1]!));
}

/**
 * Which classes a module sets that its page has no rule for.
 *
 * **A function rather than a loop in the assertion**, for the reason above it: over the real sources
 * it can only return nothing, and so can a check that examines nothing.
 */
function unstyledClasses(files: readonly (readonly [string, string])[]): string[] {
  const missing: string[] = [];
  for (const [path, source] of files) {
    /*
      **The module's own text counts as a stylesheet**, because one module is one.
      `confirmDialog.ts` carries its rules in a template string rather than in a page — which is what
      let it leave `workspace/` when the panel needed it, since the two surfaces style everything
      else differently. Reading the source for selectors as well as for classes covers that without
      naming the module, so a second one doing the same thing needs no entry here.
    */
    const available = new Set([
      ...Object.values(pagesFor(path)).flatMap((html) => [...styledIn(html)]),
      ...styledIn(source),
    ]);
    for (const name of classesIn(source)) {
      if (!available.has(name)) missing.push(`${path} sets .${name}`);
    }
  }
  return missing;
}

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

/**
 * The same contract as the ids, from the other side: a class a module sets that nothing styles.
 *
 * ## Why this is its own failure and not the sweep already recorded
 *
 * §8 describes a sweep comparing the classes a stylesheet styles against the classes the code sets,
 * and what it found was a **dead rule** — `button.tool-band`, scoped to an element that had become a
 * `<p>`. This is the mirror: a class something sets that no rule matches. It fails more quietly,
 * because the element is *there* and merely unstyled, so nothing is missing and nothing is
 * misplaced — it simply looks wrong, and only to someone looking.
 *
 * **Found in a room on 2026-09-21.** The two amount sliders set `setting` and `readout`, neither of
 * which exists in `workspace.html`, so the label and the readout were two inline elements with
 * nothing placing them: the value printed as part of the name, *"Straighten7"*. The ordinary rows
 * use `row > top > (label, value)`, where `.row .top` is the flex that pushes the readout right and
 * `.row .value` is what makes it monospace and yellow.
 *
 * ## What it cannot cover
 *
 * A class set from a variable or a template, exactly as with the ids. And it asks only whether a
 * rule **mentions** the name — not whether the rule's own selector matches the element it is put on,
 * which is the dead-rule direction and needs the element read. The two together are what §8's sweep
 * does by hand; this is the half a suite can hold.
 *
 * **Five mutations, five caught**: a class pattern matching nothing, a selector pattern matching
 * nothing, the detection reporting nothing whatever it is handed, a multi-class string taken whole,
 * and `classList.add` going unread — the last only after a fixture was written for it, since every
 * class added that way happens to be styled today and the branch was never exercised.
 */
describe("class names", () => {
  it("finds classes to check, so a broken pattern cannot pass by finding nothing", () => {
    // The guard that makes the assertion below mean anything: "no class is unstyled" is satisfied
    // perfectly by a pattern that finds no classes.
    const found = sources.flatMap(([, source]) => classesIn(source));
    expect(found.length).toBeGreaterThan(20);
    expect(found).toContain("row");
  });

  it("reads a class added rather than assigned, and splits a list", () => {
    /*
      The fixture a mutation asked for. Dropping the `classList.add` half survived the whole suite,
      because every class added that way happens to be styled today — so the branch was never
      exercised by the real sources and only a written case can hold it.

      The split matters for the same reason: `className = "chip quiet"` is two classes, and taking
      the string whole would ask the stylesheet for a rule on `.chip quiet`, which nothing can have.
    */
    expect(classesIn('x.classList.add("under-cover");')).toEqual(["under-cover"]);
    expect(classesIn('x.classList.add("a", "b");')).toEqual(["a", "b"]);
    expect(classesIn('x.className = "chip quiet";')).toEqual(["chip", "quiet"]);
  });

  it("finds rules to check them against", () => {
    const styled = styledIn(workspaceHtml);
    expect(styled.size).toBeGreaterThan(20);
    expect(styled.has("row")).toBe(true);
  });

  it("styles every class the modules set", () => {
    expect(unstyledClasses(sources)).toEqual([]);
  });

  it("reports one that is not styled, so the check is known to be able to fail", () => {
    // The fixture the real sources cannot provide. `setting` is the name that actually shipped
    // unstyled, kept here so the case this was written for stays exercised.
    expect(unstyledClasses([["./workspace/made-up.ts", 'x.className = "setting";']])).toEqual([
      "./workspace/made-up.ts sets .setting",
    ]);
  });

  it("accepts a class the module styles itself, which is how the confirmation carries its own", () => {
    // `confirmDialog.ts` is the real case: plain DOM with its rules in a template string, which is
    // what let it leave `workspace/` when the panel needed it. Without this the check would demand
    // that every module's classes appear in a page, which is the opposite of what that module is.
    const carried = 'const css = `.mine { color: red }`; x.className = "mine";';
    expect(unstyledClasses([["./made-up.ts", carried]])).toEqual([]);
  });
});
