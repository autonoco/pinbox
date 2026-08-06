// @autono/pinbox-toolbar — bootstrap snippet builder for the dev plugins
// Exports buildBootstrap(hubUrl, token?) -> the ES module SOURCE served as
// `virtual:pinbox-toolbar`. Returns a string of code; it runs in the BROWSER, so it must contain
// no build-time or runtime host APIs. Pure string building — no Bun, no node:.
//
// SECURITY BOUND — the token in served JS. The bearer token is baked into
// this module, which is served only inside the consumer's DEV bundle. The hub binds 127.0.0.1, so
// a LAN peer who reads the token (e.g. `vite --host`) still cannot reach the hub, and a
// same-machine process could already read the 0600 hub.json directly — so this exposure adds
// nothing beyond what local processes already have. Never serve this snippet from a production
// build (`apply: "serve"` in ./vite.ts is the mechanism).

/**
 * Build the module source injected into the dev page.
 *
 * The returned code imports the toolbar element for its side effect (custom element registration),
 * then appends a single `<pinbox-toolbar>` to `document.body` pointed at `hubUrl`. Re-running it
 * after an HMR update is a no-op: the existing element is reused and only its `hub`/`token`
 * attributes are refreshed (a token that disappeared is removed, never left stale).
 *
 * The bare `import "@autono/pinbox-toolbar"` below is a SIDE-EFFECT import — it registers the
 * custom element and binds no name. That is why package.json declares
 * `"sideEffects": ["./dist/*.js"]` rather than `false`: under a blanket `false`, a bundler is
 * entitled to drop this import entirely and `<pinbox-toolbar>` would never be defined, so the
 * toolbar would silently never mount with nothing logged. Do not "simplify" that field back.
 *
 * The glob — not the single `./dist/index.js` it started as — is load-bearing too. Which emitted
 * FILE carries the top-level `defineToolbarElement()` call is decided by tsdown's chunking: once
 * the wrapper entries (react/vue/svelte) joined the ESM build they began sharing code with
 * src/index.ts, so rolldown hoisted that module body into a hash-named chunk and left
 * `dist/index.js` a re-export shim. An allowlist naming only index.js then covered nothing, and
 * this import was dropped for real. `src/build.test.ts` bundles this exact import with Vite and
 * asserts `customElements.define` survives, because statting dist/ cannot see that class of break.
 */
export function buildBootstrap(hubUrl: string, token?: string): string {
  const hub = JSON.stringify(hubUrl);
  const tag = JSON.stringify("pinbox-toolbar");
  // JSON.stringify is the escape hatch that keeps hub/token values from breaking out of the
  // generated source; `null` (not undefined) marks "no token" so the emitted code stays valid JS.
  const tokenLiteral = token === undefined ? "null" : JSON.stringify(token);

  return `// pinbox dev toolbar — injected by @autono/pinbox-toolbar (dev only)
import "@autono/pinbox-toolbar";

const TAG = ${tag};
const HUB = ${hub};
const TOKEN = ${tokenLiteral};

function mount() {
  let el = document.querySelector(TAG);
  if (!el) {
    el = document.createElement(TAG);
    document.body.appendChild(el);
  }
  el.setAttribute("hub", HUB);
  if (TOKEN === null) el.removeAttribute("token");
  else el.setAttribute("token", TOKEN);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
`;
}
