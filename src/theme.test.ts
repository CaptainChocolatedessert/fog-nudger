import { describe, expect, it } from "vitest";

import { themeVariables } from "./theme";

/** The shape Owlbear actually sends, trimmed to the fields this reads. */
const OWLBEAR_DARK = {
  mode: "DARK",
  primary: { main: "#bb99ff" },
  background: { default: "#1e1e2a", paper: "#222639" },
  text: { primary: "#ffffff", secondary: "rgba(255, 255, 255, 0.7)" },
};

describe("themeVariables", () => {
  it("maps a full theme onto the properties the stylesheet reads", () => {
    expect(themeVariables(OWLBEAR_DARK)).toEqual({
      "--bg": "#222639",
      "--text": "#ffffff",
      "--dim": "rgba(255, 255, 255, 0.7)",
      "--accent": "#bb99ff",
      "--danger": "#ff8a80",
    });
  });

  /**
   * Owlbear's theme has no error colour, so this one is chosen here — and the two modes need
   * different reds, because the one legible on the dark surface washes out on the light one.
   *
   * Asserting the two are different is the part that matters. Checking either alone cannot
   * distinguish a mode-aware choice from a constant.
   */
  it("picks an error colour per mode rather than one for both", () => {
    const dark = themeVariables({ mode: "DARK" })["--danger"];
    const light = themeVariables({ mode: "LIGHT" })["--danger"];
    expect(dark).toBeTruthy();
    expect(light).toBeTruthy();
    expect(dark).not.toBe(light);
  });

  it("leaves the error colour to the stylesheet when the mode is unrecognised", () => {
    expect(themeVariables({ mode: "SEPIA" })["--danger"]).toBeUndefined();
    expect(themeVariables({})["--danger"]).toBeUndefined();
  });

  it("prefers the raised surface but accepts the page behind it", () => {
    const noPaper = { ...OWLBEAR_DARK, background: { default: "#1e1e2a" } };
    expect(themeVariables(noPaper)["--bg"]).toBe("#1e1e2a");
  });

  /**
   * The point of the whole function.
   *
   * The stylesheet holds a complete readable palette and this only supplies overrides, so a field
   * that is absent must leave the default standing. Emitting the key with an empty value does not
   * fall back — it blanks the default, which is the original bug wearing a different hat.
   */
  it("omits a property it cannot fill rather than emptying it", () => {
    expect(themeVariables({ text: { primary: "#fff" } })).toEqual({ "--text": "#fff" });
    expect(themeVariables({ background: {} })).toEqual({});
    expect(themeVariables({ background: { paper: "" }, text: { primary: "   " } })).toEqual({});
  });

  it("fills what it can from a theme that is only half there", () => {
    // The realistic partial case, and the one the stylesheet's defaults exist for: a payload that
    // is neither complete nor obviously broken.
    expect(themeVariables({ mode: "LIGHT", text: { primary: "#111" } })).toEqual({
      "--text": "#111",
      "--danger": "#b3261e",
    });
  });

  it("ignores values that are not colours", () => {
    expect(
      themeVariables({
        background: { paper: 0x222639 },
        text: { primary: null, secondary: ["#fff"] },
        primary: { main: { main: "#bb99ff" } },
      }),
    ).toEqual({});
  });

  it("survives a payload of the wrong shape entirely", () => {
    // It crosses a frame boundary as a structured clone, so nothing here built it and the failure
    // would land inside the code that paints the page.
    for (const junk of [undefined, null, "DARK", 42, [], { background: "paper" }]) {
      expect(() => themeVariables(junk)).not.toThrow();
      expect(themeVariables(junk)).toEqual({});
    }
  });
});
