# @autono/pinbox-toolbar

The embeddable feedback toolbar: a vanilla web component (Shadow DOM isolation, zero runtime deps).

Two build artifacts from one `src/`, both emitted by **tsdown** — there is no Vite build here. `tsdown.config.ts` exports an **array of two configs**, not one config with two formats: with `fixedExtension: false` an iife output would also be named `.js` and collide with the ESM entries, and a multi-entry iife build cannot share chunks.

- `dist/toolbar.iife.js` — script-tag embed for any stack; served from a **versioned** CDN path (never latest-only). The entry point is `Pinbox.init({ endpoint })`, same as every other install path.
- ESM build for bundlers — one entry per `exports` subpath.

```html
<script src="https://cdn.example.com/@autono/pinbox-toolbar@0.0.0/toolbar.iife.js"></script>
<script>
  Pinbox.init({ endpoint: "http://127.0.0.1:4319" });
</script>
```

**The iife entry is `src/iife.ts`, not `src/index.ts`, and that is load-bearing.** An iife bundle assigns the entry module's *namespace* to `globalName`, so an entry exporting a `Pinbox` object yields `Pinbox.Pinbox.init(…)` on the host page. `src/iife.ts` re-exports the intended surface flat and exists for this bundle alone — it is absent from the ESM entry list and from `exports`, whose shapes are separate published contracts. `src/build.test.ts` evaluates the built bundle in a happy-dom realm and asserts both that `Pinbox.init` is callable and that `Pinbox.Pinbox` does not exist, because after the first publish this is a breaking change to a public API.

Chunking is part of the published contract: because the wrappers share `src/index.ts`, rolldown hoists the custom-element registration into a shared chunk and `dist/index.js` becomes a re-export shim. `sideEffects` must therefore stay the glob `./dist/*.js` — naming only the shim would let bundlers tree-shake the dev plugins' bare `import "@autono/pinbox-toolbar"` away, silently. `src/build.test.ts` bundles that bare import with Vite and fails if the shape changes.

The `./vite` and `./next` subpath exports are dev-server *plugins for the consumer's* bundler. Vite is therefore an **optional peerDependency** with a deliberately wide range — it is their Vite, not ours, and pinning it would break installs. Pinbox itself has no Vite dependency.

Subpath exports (split into a separate package only if one ever needs independent versioning):

- `./react`, `./vue`, `./svelte` — thin wrappers; frameworks are **optional peerDependencies** and stay external, so nothing framework-shaped is bundled into `dist/index.js`.
- `./vite`, `./next` — dev-server plugins that auto-inject the toolbar in dev and ensure the hub is running. Dev-only; excluded from prod builds.

`./next` is a **separate plugin, not a re-export of `./vite`**, and Vite's own docs are the reason: `transformIndexHtml` "won't be called if you are using a framework that has custom handling of entry files (for example SvelteKit)." Next has no equivalent public hook for injecting a script tag into every dev page from `next.config`, so `withPinbox()` does only the half it can do honestly — keeping the hub daemon alive during `next dev`. The client-side mount is spelled out as a TODO in `src/plugins/next.ts` rather than faked.

Both plugin files are **guest-rule code** (`AGENTS.md`): they are evaluated inside the consumer's toolchain, and both the `vite` and `next` bins carry a `#!/usr/bin/env node` shebang, so they land on Node even when launched with Bun. They use the Node/Bun shared subset (`node:*`) deliberately — do not "fix" them.

## Realtime, offline, attachments

- **Realtime** — `src/transport.ts` speaks the frozen WS protocol (`hello → catch-up → events`) against `GET /ws`, authenticating at upgrade only via the `pinbox.token.<token>` subprotocol, because a browser cannot set headers on an upgrade. It reconnects with jittered 1s→30s backoff and replays from its persisted cursor, so a dropped socket costs no events. Either side of an excluding protocol window closes `4400` with a clear upgrade message; a bad token closes `4401`.
- **Offline mirror** — `src/transport/mirror.ts` keeps the cursor, the last-known pin list, and an outbox of pins drawn while offline in `localStorage`, namespaced per endpoint. Reconnect reconciles on one rule: **the hub wins on status, the client wins on new pins**. Storage writes never throw upward — private mode or a full quota degrades the mirror, never the toolbar.
- **Attachments** — screenshots are cropped and webp-encoded **in the browser** (`createImageBitmap` → `OffscreenCanvas` → `convertToBlob`), POSTed to `/attachments`, and the pin then carries the returned **path — never bytes**. Capture is best-effort by design: with no `html2canvas`-class dependency allowed, `src/screenshot.ts` resolves `null` wherever the environment cannot capture, and the pin ships with structured capture alone.

The toolbar's copies of the `ws-protocol.ts` wire constants are mirrored, not imported (core is a **type-only** dependency here — that is what keeps the runtime zero-dependency, and fallow's `allowTypeOnly` enforces it). `e2e/toolbar.test.ts` drives this transport against a real `pinbox serve`, so drift between the two copies fails the build.

`demo/` is the manual harness: `bun run demo` starts a hub plus a fixture page and prints the URL. Its README carries the checklist the automated tests cannot cover (real canvas pixels, a real browser).

**This package deliberately declares no `engines` field, and must not gain one.** It is the sole exception to the repo-wide `"engines": { "bun": ">=1.3.0" }` rule. The toolbar is browser code: Bun builds it here, but consumers install it into their own toolchain — a Vite/React app on npm under Node, most often. Declaring a Bun engine would make those installs warn, and refuse outright under `engine-strict`, for a package that never executes on a server runtime at all.

Key behaviors (see spec): targeting adapters (`dom` hit-testing | `anchor` attributes for sandboxed-iframe hosts), move pins with before/after rects, live status badges over WS with the accept/reopen verification step, localStorage offline mirror with reconnect reconciliation, copy-as-markdown fallback, `Pinbox.init({ getToken })` auth passthrough — the toolbar never renders a login.
