# pinbox

CLI-first feedback for agent collaboration. Users drop **pins** on a live app; coding agents receive them in-session, fix, and resolve; status round-trips to the user's screen. Pins are multi-turn conversations, not one-shot tickets.

Pinbox runs on **Bun**. The CLI, the daemon, and the local hub all execute under Bun; local pin storage is `bun:sqlite`, and the hub is a `(Request) => Response` handler served by `Bun.serve` locally and by a Cloudflare Worker in the cloud.

**Documentation:** [`docs/`](docs/index.mdx) — start with [`docs/quickstart.mdx`](docs/quickstart.mdx)
for the whole loop in one terminal session, or [`docs/cli/commands.mdx`](docs/cli/commands.mdx)
for the command reference.

## Install

> **Nothing is published yet.** There is no npm package and no GitHub Release for
> pinbox today, so building from source is the only route that works right now.
> The other two are the shipped installers, described so you know what to expect.

Build from source — needs [Bun](https://bun.sh) 1.3+, but only to build:

```sh
git clone https://github.com/autonoco/pinbox.git
cd pinbox && bun install && bun run build
export PATH="$PWD/packages/cli/dist:$PATH"   # the binary is packages/cli/dist/pinbox
```

Once released, via npm:

```sh
npx @autono/pinbox init      # or: bunx / pnpm dlx / yarn dlx
```

`@autono/pinbox` is a small launcher whose `optionalDependencies` carry one
compiled binary per platform; your package manager installs only the one matching
your `os`/`cpu` and skips the rest. The binary is self-contained — Bun is compiled
in, so nothing needs to be installed first.

Or without npm at all:

```sh
curl -fsSL https://github.com/autonoco/pinbox/releases/latest/download/install.sh | sh
```

Same artifacts, straight from GitHub Releases. Either way the command is
`pinbox`. The libraries ship under the same scope: `@autono/pinbox-core`,
`@autono/pinbox-toolbar`, `@autono/pinbox-mcp`.

## Layout

```
packages/core       @autono/pinbox-core — schema, hub logic, storage adapters
packages/toolbar    @autono/pinbox-toolbar — embeddable web component + wrappers/plugins
packages/cli        the CLI (daemon lifecycle, init) + worker template
packages/mcp        standalone MCP server (fallback for shell-less environments)
skills/pinbox       published agent skill (generated from the CLI command tree)
docs/               the public documentation site (Mintlify)
examples/           copy-paste-trivial example apps, CI smoke targets
e2e/                single cross-package end-to-end test workspace
tools/              release/CI scripts (Bun.$ in TS; YAML wires credentials)
```

Each directory has a README describing what belongs inside.

## Develop

```sh
bun install
bun test
bun run --filter '*' build
```
