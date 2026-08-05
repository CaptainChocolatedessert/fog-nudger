import { describe, expect, it } from "vitest";
import { formatDevLogLabel, serializeArgs } from "./devlog";

describe("formatDevLogLabel", () => {
  it("names the role, the client and the surface", () => {
    expect(formatDevLogLabel("GM", "aa30f19c-1234", "bg")).toBe("GM:aa30/bg");
    expect(formatDevLogLabel("PLAYER", "bb71f19c-1234", "ui")).toBe("player:bb71/ui");
  });

  /**
   * The point of the whole function. Four streams share one receiver in a two-client room, and a
   * label that collapses any two of them puts the shim back where it started.
   *
   * Asserting one label in isolation cannot catch that: a version ignoring the surface entirely
   * still produces a plausible-looking string. Only comparing the labels can.
   */
  it("keeps every stream in a two-client room distinct", () => {
    const labels = [
      formatDevLogLabel("GM", "aa30", "bg"),
      formatDevLogLabel("GM", "aa30", "ui"),
      formatDevLogLabel("PLAYER", "bb71", "bg"),
      formatDevLogLabel("PLAYER", "bb71", "ui"),
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("passes an unrecognised role through rather than calling it a player", () => {
    // Mislabelling something unexpected as the ordinary case is how a surprise stops being
    // visible. If Owlbear ever grows a third role, the log should say so.
    expect(formatDevLogLabel("SPECTATOR", "cc12", "ui")).toBe("SPECTATOR:cc12/ui");
  });

  it("survives an id shorter than it truncates to", () => {
    expect(formatDevLogLabel("GM", "ab", "bg")).toBe("GM:ab/bg");
  });
});

describe("serializeArgs", () => {
  it("passes strings through unchanged", () => {
    expect(serializeArgs(["hello", "world"])).toEqual(["hello", "world"]);
  });

  it("keeps an Error's name, message and stack", () => {
    const [out] = serializeArgs([new TypeError("bad wall")]);
    expect(out).toContain("TypeError: bad wall");
    expect(out).toContain("devlog.test");
  });

  it("survives circular structures", () => {
    // Not exotic here: an SDK item graph and a DOM event both self-reference, and both are
    // exactly the sort of thing that gets logged when something has gone wrong.
    const item: Record<string, unknown> = { id: "wall-1" };
    item.self = item;
    expect(serializeArgs([item])).toEqual(['{"id":"wall-1","self":"[Circular]"}']);
  });

  it("renders primitives that JSON.stringify handles badly", () => {
    expect(serializeArgs([undefined, null, NaN, 10n])).toEqual([
      "undefined",
      "null",
      "NaN",
      "10n",
    ]);
  });

  it("does not throw on values JSON cannot represent", () => {
    expect(() => serializeArgs([() => {}, Symbol("s"), new WeakMap()])).not.toThrow();
  });
});
