/**
 * The GitHub Pages project subpath, written once.
 *
 * Project Pages serve from `/<repo>/`, so every absolute path the extension publishes has to carry
 * this prefix or it resolves against the origin root and 404s. It appears in more places than is
 * comfortable: Vite's `base`, four fields in each of the two manifests under `public/`, and the dev
 * URL registered by hand in Owlbear. Vite rewrites its own copies into the built HTML and does not
 * touch `public/`, which is copied verbatim — so the manifests must be changed by hand.
 *
 * **What this constant removes is the copy that was hiding in the test.** `manifest.test.ts` checks
 * that every manifest path starts with the subpath, and it used to check them against a string
 * declared in the test file. That is a check against a duplicate of the thing being checked: rename
 * the repository, update `vite.config.ts`, and the manifests and the test agree on a stale value
 * while every path in the published site 404s and the suite stays green. Now the test and the build
 * read the same constant, so the manifests are compared against the value that is actually used.
 *
 * **Not runtime code.** Nothing in the browser bundle imports this — code that needs the base at
 * runtime reads `import.meta.env.BASE_URL`, which Vite substitutes. Its two readers are
 * `vite.config.ts` and `manifest.test.ts`, and the first is invisible to a grep for production
 * callers, so this will look test-only to any sweep for unreferenced exports. It is not.
 */
export const PAGES_BASE = "/fog-nudger/";
