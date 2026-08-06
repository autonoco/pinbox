// Build config for @autono/pinbox-toolbar — ESM entries for the element, the framework
// wrappers, and the dev-server plugins, plus a standalone script-tag bundle.
// Exports: an array of two tsdown configs.
import { defineConfig } from "tsdown";

/**
 * ESM library build — one entry per `exports` subpath in package.json.
 *
 * The wrapper entries (`react`/`vue`/`svelte`) import their framework at value level, but the
 * frameworks are OPTIONAL peers and therefore stay external: nothing framework-shaped is bundled
 * into `dist/index.js`, and a consumer who never imports a wrapper subpath never resolves
 * `react` at all.
 *
 * CHUNKING IS PART OF THE PUBLISHED CONTRACT. Because the wrappers share `src/index.ts`, rolldown
 * hoists its module body — including the top-level `defineToolbarElement()` that registers the
 * custom element — into a hash-named shared chunk, leaving `dist/index.js` a re-export shim. So
 * package.json's `sideEffects` must be the glob `./dist/*.js`, not `./dist/index.js`: naming only
 * the shim tells bundlers the chunk is inert and the dev plugins' bare
 * `import "@autono/pinbox-toolbar"` gets tree-shaken away, silently. Changing the entry list here
 * changes that shape — `src/build.test.ts` bundles the bare import with Vite and will catch it.
 */
const esm = defineConfig({
  entry: [
    "src/index.ts",
    "src/react.ts",
    "src/vue.ts",
    "src/svelte.ts",
    "src/plugins/vite.ts",
    "src/plugins/next.ts",
  ],
  format: "esm",
  // package is type:module — emit .js/.d.ts, not tsdown's default .mjs/.d.mts
  fixedExtension: false,
  dts: true,
});

/**
 * Script-tag bundle — `<script src="…/toolbar.iife.js"></script>`, then `Pinbox.init(…)`.
 *
 * THE ENTRY IS `src/iife.ts`, NOT `src/index.ts`, AND THAT IS THE WHOLE POINT. An iife bundle
 * assigns the entry module's NAMESPACE to `globalName`, so an entry that exports a `Pinbox`
 * object yields `Pinbox.Pinbox.init(…)` on the host page. `src/iife.ts` re-exports the intended
 * surface flat — it is a shim for this bundle alone and is deliberately absent from the ESM
 * entry list above and from package.json `exports`, whose shapes are their own contracts.
 *
 * This CANNOT share the ESM config object. With `fixedExtension: false` an iife output would also
 * be named `.js` and collide with the ESM entries, and a multi-entry iife build has no way to
 * share chunks — hence the single entry, renamed to `toolbar` so the artifact is
 * `dist/toolbar.iife.js` rather than `dist/iife.iife.js`.
 *
 * `clean: false` is load-bearing: both configs run in sequence against the same `outDir`, so a
 * cleaning second pass would delete everything the first pass just emitted.
 */
const iife = defineConfig({
  entry: { toolbar: "src/iife.ts" },
  format: ["iife"],
  globalName: "Pinbox",
  platform: "browser",
  // tsdown already infixes the format (`toolbar` -> `toolbar.iife`); this pins the extension
  // itself to `.js` so the artifact is `dist/toolbar.iife.js` and not `.iife.iife.js`/`.cjs`.
  outExtensions: () => ({ js: ".js" }),
  dts: false,
  clean: false,
});

export default [esm, iife];
