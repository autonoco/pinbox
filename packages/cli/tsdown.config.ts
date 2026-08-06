// Build config for the pinbox CLI — single ESM bin with shebang.
// The embedded skill and templates/ are shipped via package.json "files", not bundled.
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  // package is type:module — emit main.js to match the bin path
  fixedExtension: false,
  dts: false,
  banner: { js: "#!/usr/bin/env bun" },
  // deps (@autono/pinbox-core, commander) are auto-externalized from package.json;
  // the Bun builtins ("bun", "bun:sqlite") must be declared or rolldown warns.
  deps: { neverBundle: [/^bun(:|$)/] },
});
