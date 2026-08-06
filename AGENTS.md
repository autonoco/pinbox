# Agent guide

Pinbox is a Bun-workspaces TypeScript monorepo. **Bun is the runtime** — the CLI,
the daemon, and the local hub all execute under Bun. The shipped code is the source
of truth for architecture decisions; `docs/concepts/architecture.mdx` describes the
system as built, and `docs/contributing.mdx` covers the workflow. Read both before
proposing structural changes.

## Map

- `packages/core` — `@autono/pinbox-core`: pin schema, hub logic, storage adapters. No CLI or toolbar imports.
- `packages/toolbar` — `@autono/pinbox-toolbar`: vanilla web component; framework wrappers and dev plugins are subpath exports (split out only if one needs independent versioning).
- `packages/cli` — `pinbox` bin: command surface, daemon lifecycle, `init`. Ships `templates/worker/` and an embedded copy of the skill.
- `packages/mcp` — `@autono/pinbox-mcp`: thin stdio MCP server over the core client.
- `skills/pinbox` — published agent skill. `SKILL.md` is **generated** from the CLI command tree; never hand-edit it.
- `apps/web`, `examples/`, `e2e/`, `tools/` — see each directory's README.

## File size budget (modular decomposition)

- **Hard cap: no source file exceeds 1,000 lines.** Ever.
- **Soft threshold: before adding code to a file, check its line count.** At **500 lines or more, stop — do not append.** Do the preparatory refactoring first: design the split, break the file into focused modules/components with clear interfaces (create new files/folders as needed), then land the new code in the right unit. "Make the change easy, then make the easy change."
- Split along responsibility boundaries, never arbitrary halves — each resulting file has one clear purpose, is understandable on its own, and is imported/referenced by the original site.
- Enforced mechanically: a PreToolUse hook (`tools/hooks/file-size-guard.sh`, wired in `.claude/settings.json`) warns at 500 lines and blocks edits at 1,000.

## Code review (`agent:review`)

Line count is a *proxy* for modular decomposition; the hook above is preventive and blunt. **Fallow** measures the thing the proxy stands in for, and covers what a line count cannot see.

- `bun run agent:review` — full scan, grouped by package.
- `bun run agent:review:changed` — `fallow audit --base main`, reporting only findings **new** relative to `main`. This is the one to run on a branch; it stops accumulated scaffold debt from drowning the signal.

**Run `agent:review` before finishing any non-trivial TypeScript change.** Findings are *guidance, not automatic blockers* — but if you ignore one deliberately, say so and why in your final response. It is not wired into CI, and that is intentional: a review you must read beats a gate you learn to route around.

What it catches that the line-count hook cannot: unused files, exports and dependencies; import cycles; duplication; oversized *functions* (`maxUnitSize`, default 60 lines) and cyclomatic/cognitive complexity — all per-function, where our cap is per-file.

**Architecture boundaries are enforced here, not by convention.** `.fallowrc.json` encodes the dependency direction this file asserts: `core` may import from no sibling; `cli` and `mcp` may import `core`; `toolbar` may reach `core` **type-only** (`allowTypeOnly`), which is what keeps its runtime zero-dependency. Verified live — a runtime `core` import added to a toolbar file is reported as a boundary violation.

Two caveats worth knowing before you trust a clean run:

1. **Boundaries only apply to files reachable from an entry point.** A violation inside a file nothing imports is silently not checked. Most of the scaffold is currently unreachable, so coverage grows as phases land. Entry points are listed in `.fallowrc.json`; keep them accurate or dead-code and boundary analysis both degrade.
2. **The scaffold reports a large baseline of dead code by design** — stub files that are `export {}` are genuinely unreachable. Use `agent:review:changed` to see only what *you* added.

## Conventions

- **Bun is the runtime.** Workspace packages declare `"engines": { "bun": ">=1.3.0" }` and source bin shebangs are `#!/usr/bin/env bun`. Reach for Bun APIs directly — `Bun.serve`, `bun:sqlite`, `Bun.spawn`, `Bun.$`, `Bun.which`, `Bun.S3Client` — not their `node:` equivalents.
- **The guest rule — the only exception, and it is not negotiable either way.** Bun APIs in processes *we* launch: the CLI, the daemon, the hub, tests, builds. The Node/Bun **shared subset** (`node:fs`, `node:path`, `node:child_process` — all fully implemented by Bun) *only* where our code is loaded into a runtime we do not control. That is exactly two places: `packages/toolbar/src/plugins/*` (runs inside the consumer's Vite/Next) and the generated npm launcher shim. Both say so in a header comment with the measurement behind it.

  This is **not** "some users are on Node." Measured on a Bun-first machine: `bunx vite build` and `bun run dev` both execute plugin code under **Node 24**, because Vite's bin has a `#!/usr/bin/env node` shebang and Bun honors shebangs. Only `bun --bun` or `bunfig.toml` `[run] bun = true` gets Bun. So a Bun API in a dev plugin throws for nearly everyone, *including* Bun users. Don't "fix" `node:` imports in those two locations, and don't widen the exception to anything else.
- Local storage is `bun:sqlite` (`db.query` caches statements, `db.transaction(fn)` wraps, `.as(Class)` maps rows; FTS5 is available and powers `pinbox list --search`). Cloud storage is Durable Object SQLite. `PinStore` is the interface with exactly those two implementations.
- The hub is a `(Request) => Response` handler. `Bun.serve({ fetch })` consumes it locally; the same handler is the Cloudflare Worker entry. Bun's `idleTimeout` is a total request deadline — streaming routes must call `server.timeout(req, 0)`.
- ESM only. Strict `tsconfig.base.json` at root; each package extends it. Typecheck with `tsc --noEmit`; tsdown owns emit (ESM + `.d.ts`).
- Ship with `bun build --compile` for standalone binaries; `bun build` alone does not emit types, so tsdown stays for library builds.
- **Distribution is the esbuild platform-package pattern.** `tools/release/` generates a ~5 KB `@autono/pinbox` launcher plus `@autono/pinbox-<os>-<cpu>` packages holding one compiled binary each, wired by exact-pinned `optionalDependencies`. Those generated manifests are the one place the rules above invert: the launcher shim is plain JS with a **node** shebang (packaging glue, not pinbox), and neither generated manifest declares `engines` — the binary embeds Bun, so requiring it would block the very machines the binary serves.
- Biome for lint/format (root `biome.json`, no nested configs). 2-space indent, width 100, double quotes.
- `bun test` is the test runner (`bun:test`: `test`, `describe`, `expect`, `mock`, `spyOn`, `setSystemTime`, …). Unit tests colocated as `*.test.ts` next to source. Cross-package flows go in `e2e/`, never per-package.
- Internal deps use `workspace:*`; shared tool versions live in the root catalog. Build order comes from topological `bun run --filter`, never a hardcoded `&&` chain.
- Machine output (`--json`, published schemas) is a versioned contract — change it deliberately.
