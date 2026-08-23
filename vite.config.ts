import { defineConfig } from "vite";

/**
 * `base` must match the GitHub Pages project subpath. Project Pages serve from
 * /<repo>/, and assets resolve against the origin root otherwise.
 *
 * The same prefix is hardcoded in both manifests under `public/`, which Vite does not
 * rewrite — `public/` is copied verbatim. That is four fields each (`icon`,
 * `background_url`, `action.icon`, `action.popover`) across `manifest.json` and
 * `manifest.dev.json`, plus the dev URL registered in Owlbear. Change this, change all
 * of them. Drift is loud rather than subtle: a stale path 404s and the extension simply
 * fails to load.
 */
export default defineConfig({
  base: "/fog-nudger/",
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
        overlayProbe: "overlay-probe.html",
        workspaceProbe: "workspace-probe.html",
        workspace: "workspace.html",
      },
    },
  },
});
