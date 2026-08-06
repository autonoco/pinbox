// Build config for @autono/pinbox-mcp — single ESM bin with a bun shebang.
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  // package is type:module — emit main.js to match the bin path
  fixedExtension: false,
  dts: false,
  banner: { js: "#!/usr/bin/env bun" },
  // deps (@modelcontextprotocol/sdk, zod) are auto-externalized from package.json;
  // the Bun builtins must be declared or rolldown warns.
  deps: { neverBundle: [/^bun(:|$)/] },
});
