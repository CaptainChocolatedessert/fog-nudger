import { configDefaults, defineConfig } from "vitest/config";

import { PAGES_BASE } from "./src/pagesBase";

/**
 * `base` must match the GitHub Pages project subpath, and it is declared in `src/pagesBase.ts`
 * so that the test which checks the manifests against it cannot hold its own stale copy.
 *
 * The same prefix is still hardcoded in both manifests under `public/`, which Vite does not
 * rewrite — `public/` is copied verbatim. That is four fields each (`icon`, `background_url`,
 * `action.icon`, `action.popover`) across `manifest.json` and `manifest.dev.json`, plus the dev
 * URL registered in Owlbear. Change the constant, change all of them; `manifest.test.ts` is what
 * catches you forgetting. Drift is loud rather than subtle: a stale path 404s and the extension
 * simply fails to load.
 *
 * `defineConfig` comes from `vitest/config` rather than `vite` — it re-exports Vite's own, and
 * taking it from there is what makes the `test` section below type-check.
 */
export default defineConfig({
  base: PAGES_BASE,
  server: {
    /**
     * Claimed in `../project setup notes.md`, which is where ports are registered across every
     * project in this folder. That file is the authority; read it before changing this, and
     * claim there before configuring anything new.
     *
     * **Deliberately not 5173, and not because someone else holds it.** Nobody does — it is kept
     * empty on purpose. It is the port every *unconfigured* project takes: a scratch repo, a
     * tutorial, a one-off clone, anything run before ports were thought about. Sitting on it means
     * colliding with whatever gets started next by accident, so it is left free for exactly those.
     *
     * **`strictPort` is the half that matters more than the number.** Vite's default on a taken
     * port is to quietly move to the next free one, which leaves the URL registered as a custom
     * extension in Owlbear pointing at whichever project *did* get the port — a working page
     * serving someone else's extension, with nothing anywhere reporting a problem. That has
     * already happened once between two of these projects and a run of measurements was taken
     * against a stale build before anyone noticed. Failing to start is the readable outcome and
     * costs seconds.
     */
    port: 5273,
    strictPort: true,
    /**
     * Owlbear fetches the manifest from its own HTTPS origin, so loading the extension
     * from this dev server is a cross-origin request. Vite's default is to refuse those
     * — a deliberate hardening, since otherwise any page visited while developing could
     * read the dev server's responses.
     *
     * Allow Owlbear specifically rather than setting `cors: true`, which would restore
     * exactly the hole the default is there to close. Dev server only; has no effect on
     * the built output.
     *
     * Firefox reports every cross-origin refusal as the same generic `NetworkError`, so
     * diagnose failures here with `curl -D - -H "Origin: <origin>" <url>` and look for
     * `Access-Control-Allow-Origin`. A 200 with no ACAO header is a refusal, not a pass.
     */
    cors: {
      origin: [/^https:\/\/([a-z0-9-]+\.)*owlbear\.rodeo$/],
    },
  },
  build: {
    rollupOptions: {
      // Relative to project root. A page absent from this list is silently absent from
      // `dist/` — it will not fail the build, it will just 404 in a room.
      input: {
        // Landing page — what a human sees at the Pages URL.
        main: "index.html",
        // Headless entry point, loaded by Owlbear via manifest `background_url`.
        background: "background.html",
        // Loaded by Owlbear via the manifest action's `popover`.
        panel: "panel.html",
        // Opened as full-screen modals by the panel, not by the manifest — so nothing declares
        // them anywhere else and forgetting these lines is the only way they can go missing.
        //
        // `overlay-probe.html` is DELIBERATELY absent, and this comment is here because the line
        // above makes an omission look like exactly that mistake. The click-through design it
        // measured is closed and the panel no longer wires a button to it (`panel.ts:34`), so
        // building it published ~7KB of page and module that nothing can open — and which would do
        // nothing if opened, since the SDK is inert outside a room. The page and its module stay in
        // the repository as the record of how those platform answers were got; re-adding this line
        // is the third step of re-wiring it, after the import and the markup.
        workspaceProbe: "workspace-probe.html",
        workspace: "workspace.html",
      },
    },
  },
  test: {
    /*
      `reference/` is a shallow clone of somebody else's repository, refreshed with `git pull`, and
      vitest's default `exclude` in v4 is only `node_modules` and `.git` — narrower than it looks.
      It is gitignored, so CI never checks it out; without this line, a test file appearing upstream
      would run locally and not in CI, and the two disagreeing would look like a local breakage.
      That is the worse direction, since local is what gets looked at before a push.

      Spreading the defaults rather than replacing them: `exclude` overwrites, it does not extend.
    */
    exclude: [...configDefaults.exclude, "reference/**"],
  },
});
