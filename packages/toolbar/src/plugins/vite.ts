// @autono/pinbox-toolbar/vite — Vite dev-server plugin that injects the toolbar
// Exports pinbox(options?) -> Plugin (also the default export).
//
// PORTABILITY — this module is loaded by the CONSUMER's Vite, and Vite runs under Node even on
// Bun-first machines: its bin has a `#!/usr/bin/env node` shebang and Bun honors shebangs, so
// `bunx vite` and `bun run dev` both land on Node (measured — see ./daemon.ts for the table).
// It therefore uses no Bun globals; everything host-facing lives in ./daemon.ts, which
// documents why its `node:` imports are correct. This is the "guest rule" in AGENTS.md.
//
// Behaviour verified by execution against every Vite from 4.5.14 through 8.2.0 — that
// range is the compatibility contract, so re-run it before changing hook shapes.
// Several details below look removable and are not: each carries a comment saying
// what breaks without it.

import type { HtmlTagDescriptor, Plugin } from "vite";
import { ensureHub, type HubStatus, readHubToken } from "./daemon";
import {
  type PinboxPluginOptions,
  RESOLVED_VIRTUAL_ID,
  resolveOptions,
  VIRTUAL_ID,
} from "./options";
import { buildBootstrap } from "./snippet";

const PLUGIN_NAME = "pinbox";

/**
 * Inject the pinbox toolbar into the dev page and make sure the hub daemon is running.
 *
 * Dev only: `apply: "serve"` is the sole production-exclusion mechanism (see below).
 */
export function pinbox(options?: PinboxPluginOptions): Plugin {
  const resolved = resolveOptions(options);

  // Hard off switch: an inert plugin with a name and no hooks. Vite accepts this happily and it
  // keeps `plugins: [pinbox({ disabled: !dev })]` legal without array-hole juggling.
  if (resolved.disabled) {
    return { name: PLUGIN_NAME };
  }

  // Per-invocation state. NOT a cross-restart memo: editing `vite.config.ts` restarts the dev
  // server in the same process and re-evaluates this module, so module-scope flags are wiped.
  // Deduping the daemon is therefore ensureHub's out-of-process health probe, never a flag here.
  let hubPromise: Promise<HubStatus | undefined> | undefined;

  function hub(): Promise<HubStatus | undefined> {
    hubPromise ??= ensureHub(resolved);
    return hubPromise;
  }

  return {
    name: PLUGIN_NAME,

    // The ONLY thing keeping pinbox out of production builds. Measured: with `apply: "serve"`,
    // `vite build` fires zero hooks from this plugin and emits zero pinbox references. Do not add
    // a `command === "serve"` check or a NODE_ENV guard — they are redundant, not defence in depth.
    apply: "serve",

    async configureServer() {
      // Adopt a running hub or start one. Awaiting here means the hub is usually already up by
      // the time `load` runs; if it is not, `load` awaits the same promise.
      await hub();
      // Deliberately NO teardown: no `server.httpServer.on("close", …)`, no `closeBundle`.
      // On a config restart the NEW configureServer runs BEFORE the OLD server's close handlers,
      // so any teardown registered here would kill the hub this invocation just started. The
      // daemon is ADOPTED, never OWNED — it manages its own idle exit.
    },

    // The in-handler `id` guards in resolveId/load are MANDATORY, and this plugin ships NO
    // `filter:` keys on any hook. Vite 6.0–6.2 accept a `filter` and silently ignore it; a
    // filtered-but-unguarded `load` there returned this payload for the consumer's `/main.js`,
    // replacing their application entry with no warning. The guards are what make the
    // `^5 || ^6 || ^7 || ^8` peer range safe.
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      return null;
    },

    async load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;

      const status = await hub();
      if (status === undefined) {
        // The hub never came up — ensureHub already logged one warning. Serve a valid, empty
        // module rather than throwing: a dead hub must degrade the toolbar, not the dev server.
        return "// pinbox: hub unavailable, toolbar not mounted.\nexport {};\n";
      }
      // Token read PER LOAD, not memoized: the daemon may have restarted (new token) since the
      // page was last served; a stale token would 401 every toolbar request until a config edit.
      // Bounded exposure — see the security note in ./snippet.ts.
      return buildBootstrap(status.url, readHubToken(resolved.projectRoot));
    },

    transformIndexHtml: {
      // REQUIRED, and the object form is required to express it. With `order` omitted the served
      // HTML keeps the inline body verbatim — `import "virtual:pinbox-toolbar"` — a bare specifier
      // the browser cannot resolve, which fails with no error and a 200. With `order: "pre"` Vite
      // lifts the script into an html-proxy module and rewrites the specifier itself.
      order: "pre",
      handler(): HtmlTagDescriptor[] {
        // No `ctx.server` guard here on purpose. `apply: "serve"` already means this hook cannot
        // run during a build, so such a check is unreachable — and the comment on `apply` above
        // says redundant guards are redundant, not defence in depth. Keep the two consistent.
        return [
          {
            tag: "script",
            attrs: { type: "module" },
            children: `import ${JSON.stringify(VIRTUAL_ID)};`,
            // `injectTo` — NOT `order` — is what controls placement. `order` above governs when
            // the hook runs relative to Vite's HTML analysis and does nothing for position.
            injectTo: "body",
          },
        ];
      },
    },
  };
}

export default pinbox;
