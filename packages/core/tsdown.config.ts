// Build config for @autono/pinbox-core — ESM-only, d.ts emitted by tsdown.
// dist/schema.json is written post-build by scripts/emit-schema.ts.
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/schema.ts",
    "src/store.ts",
    "src/hub.ts",
    "src/hub-server.ts",
    "src/markdown.ts",
    "src/sessions.ts",
    "src/delivery/router.ts",
    "src/delivery/resume.ts",
    "src/delivery/openclaw.ts",
    "src/delivery/webhook.ts",
    "src/ws.ts",
    "src/ws-protocol.ts",
    "src/connectors/index.ts",
    "src/connectors/github.ts",
    "src/auth/verify.ts",
    "src/do.ts",
  ],
  format: "esm",
  // package is type:module — emit .js/.d.ts, not tsdown's default .mjs/.d.mts
  fixedExtension: false,
  dts: true,
  // The Bun builtins ("bun:sqlite") must be declared external or rolldown warns.
  // @cloudflare/workers-types stays external in the d.ts bundle too: TS 7's declaration
  // emit drops the `type` modifier, and rolldown then fails resolving value-position
  // imports into the types-only package. ./do consumers are on workers and have it.
  deps: { neverBundle: [/^bun(:|$)/, "@cloudflare/workers-types"] },
  // Command string, not an in-process function: the tsdown bin has a node shebang, so
  // a function here runs under Node where `Bun.write` does not exist. The script must
  // run under Bun (Bun APIs only in packages/core), so spawn it explicitly.
  onSuccess: "bun ./scripts/emit-schema.ts",
});
