/**
 * The manifests, checked against the limits and conventions that only a room enforces.
 *
 * Nothing here tests code. It exists because every one of these failures is invisible until an
 * extension is added to a real room, where the symptom is a refusal or — worse — a silent 404 and a
 * build that simply does not load. A unit test costs nothing and moves the discovery to the commit.
 *
 * Imported as JSON rather than read from disk on purpose: `tsconfig` declares no `@types/node`, and
 * reaching for `node:fs` here would break `tsc --noEmit`. The sibling project hit exactly that and
 * abandoned a Vite plugin over it.
 */

import { describe, expect, it } from "vitest";

import devManifest from "../public/manifest.dev.json";
import manifest from "../public/manifest.json";

/**
 * Owlbear refuses a longer one — reported by a room on 2026-08-22, when the dev build's 139
 * characters were rejected.
 *
 * Whether it counts characters or UTF-8 bytes is not known, and is not worth finding out: both
 * descriptions are ASCII and well short, so the two counts agree and the question cannot arise. An
 * em dash was the difference between the two counts before, which is precisely the kind of detail
 * that makes a limit feel arbitrary when it is hit.
 */
const MAX_DESCRIPTION = 128;

/** Deliberate slack. A description sitting one character under a hard limit is not a passing test. */
const COMFORTABLE_DESCRIPTION = 115;

const SUBPATH = "/fog-nudger/";

const manifests = [
  ["manifest.json", manifest],
  ["manifest.dev.json", devManifest],
] as const;

describe.each(manifests)("%s", (_name, subject) => {
  it("keeps its description inside Owlbear's limit", () => {
    expect(subject.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(new TextEncoder().encode(subject.description).length).toBeLessThanOrEqual(
      MAX_DESCRIPTION,
    );
  });

  it("leaves room to reword the description without hitting the limit", () => {
    expect(subject.description.length).toBeLessThanOrEqual(COMFORTABLE_DESCRIPTION);
  });

  it("points every path at the Pages subpath", () => {
    // The subpath is hardcoded in ten places and Vite rewrites none of the ones in `public/`. A
    // stale one 404s, and an extension that 404s its background page does not announce why.
    for (const path of [
      subject.icon,
      subject.background_url,
      subject.action.icon,
      subject.action.popover,
    ]) {
      expect(path.startsWith(SUBPATH)).toBe(true);
    }
  });

  it("declares both icons, which are different fields for different surfaces", () => {
    // Top-level `icon` is the extensions list; `action.icon` is the button in the room. The list
    // one was missing here entirely until 2026-08-22, and nothing rendered — no error, no space
    // reserved, just an entry with no picture.
    expect(subject.icon).toMatch(/\.png$/);
    expect(subject.action.icon).toMatch(/\.svg$/);
  });
});

describe("the dev manifest against the published one", () => {
  it("differs in both icons, not just one", () => {
    // The mistake the sibling made first: badging the action icon and leaving the list icon pointed
    // at the production logo, so the extensions list showed two identical entries. Two fields, and
    // the whole point of the dev manifest is lost if either is forgotten.
    expect(devManifest.icon).not.toBe(manifest.icon);
    expect(devManifest.action.icon).not.toBe(manifest.action.icon);
  });

  it("labels itself everywhere a human reads a name", () => {
    expect(devManifest.name).toBe(`${manifest.name} (dev)`);
    expect(devManifest.action.title).toBe(`${manifest.action.title} (dev)`);
    expect(devManifest.description).toContain("DEV BUILD");
  });

  it("differs in nothing else", () => {
    // Drift between two hand-maintained copies is the standing cost of having them, and it is
    // silent: the dev build would keep working while quietly not matching what ships. Only the five
    // fields above are allowed to differ.
    const strip = (m: typeof manifest | typeof devManifest) => ({
      ...m,
      name: "",
      description: "",
      icon: "",
      action: { ...m.action, title: "", icon: "" },
    });
    expect(strip(devManifest)).toEqual(strip(manifest));
  });
});
