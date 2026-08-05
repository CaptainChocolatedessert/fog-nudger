import { defineConfig } from "vite";

/**
 * `base` must match the GitHub Pages project subpath. Project Pages serve from
 * /<repo>/, and assets resolve against the origin root otherwise.
 *
 * The same prefix is hardcoded in public/manifest.json, which Vite does not rewrite —
 * `public/` is copied verbatim. If this changes, change all three fields there too.
 */
export default defineConfig({
  base: "/fog-nudger/",
  server: {
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
      },
    },
  },
});
