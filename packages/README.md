# packages/

The published workspaces. All ESM-only, built with tsdown (ESM + `.d.ts`), versioned independently via changesets, validated by publint + arethetypeswrong on every build. Bun is the runtime: `"engines": { "bun": ">=1.3.0" }`.

| Package | npm name | Purpose |
|---|---|---|
| `core/` | `@autono/pinbox-core` | schema, hub logic, storage adapters |
| `toolbar/` | `@autono/pinbox-toolbar` | embeddable web component + wrappers/plugins |
| `cli/` | `@autono/pinbox` | the CLI, daemon lifecycle, init, worker template — source only; ships as compiled per-platform binaries |
| `mcp/` | `@autono/pinbox-mcp` | standalone MCP server over the core client |

Dependency direction: `cli`/`mcp`/`toolbar` → `core`. Core imports nothing from its siblings. The toolbar's edge is **type-only** — its runtime stays zero-dependency.
