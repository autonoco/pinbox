# pinbox

Drop a pin on a live app, and the coding agent already working on it picks the pin up, fixes the code, replies on the thread, and resolves it.

[![validate](https://img.shields.io/github/actions/workflow/status/autonoco/pinbox/validate.yml?branch=main&label=validate)](https://github.com/autonoco/pinbox/actions/workflows/validate.yml)
[![npm](https://img.shields.io/npm/v/@autono/pinbox?label=npm)](https://www.npmjs.com/package/@autono/pinbox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

One self-contained binary, macOS and Linux, on `arm64` and `x64`. Bun is compiled into it, so there is no runtime to install first.

**Install script** — no JavaScript runtime required:

```sh
curl -fsSL https://github.com/autonoco/pinbox/releases/latest/download/install.sh | sh
```

**npm** — or `bun add -g`, `pnpm add -g`, `yarn global add`:

```sh
npm install -g @autono/pinbox
```

**No install at all** — run it once against a project:

```sh
npx @autono/pinbox init
```

Then check it resolves:

```sh
pinbox --version
```

<details>
<summary>Build from source</summary>

You need [Bun](https://bun.sh) 1.3 or newer.

```sh
git clone https://github.com/autonoco/pinbox.git
cd pinbox
bun install
bun run build
export PATH="$PWD/packages/cli/dist:$PATH"
```

</details>

Every route, and how to verify each one: [`docs/installation.mdx`](docs/installation.mdx).

## Quickstart

**Set up the project you want feedback on.** This creates `.pinbox/`, adds it to `.gitignore`, installs the pinbox skill for each coding agent it finds on your machine, and installs a `post-commit` hook. It asks before it touches anything; add `--yes` to skip the prompt in a script.

```sh
pinbox init
```

**Pin what is wrong.** Anchor it to a web surface with `--url` and `--selector`, or to a source location with `--file`:

```sh
pinbox pin "Pay button is cut off on mobile" \
  --url http://localhost:5173/checkout --selector "button.pay"
```

```
pin_lxpe3bflp3
pinned to http://localhost:5173/checkout
```

You did not start a server. The first command that needs the hub starts it, and it exits when idle.

**See what is open:**

```sh
pinbox list
```

```
pin_lxpe3bflp3  open  just now  button.pay  Pay button is cut off on mobile
1 pin (1 open)
```

**Read one pin with everything captured alongside it:**

```sh
pinbox show pin_lxpe3bflp3
```

```
pin_lxpe3bflp3  open  note
text      Pay button is cut off on mobile
target    button.pay
url       http://localhost:5173/checkout
git       main @ fad63e3
author    ada@example.com
created   2026-08-08T01:09:16.037Z (just now)
```

The branch and commit were recorded for you. That is the point of a pin over a sentence in chat: the agent never has to ask where you were.

**Reply on the thread.** Replying adds a message and never changes the status, so an agent can report progress or ask a question without closing anything:

```sh
pinbox reply pin_lxpe3bflp3 "Bumped the min-width — re-check at 320px?" --as agent
```

**Resolve it,** with a note saying what changed — or why it will not:

```sh
pinbox resolve pin_lxpe3bflp3 --note "min-width: 8rem on .pay" --as agent
```

```
pin_lxpe3bflp3 resolved
by agent — min-width: 8rem on .pay
```

Or name the pin in a commit message and the `post-commit` hook resolves it for you, with the commit attached. `Fixes`, `Resolves`, and `Closes` all work:

```sh
git commit -m "Widen the pay button

Fixes pin_lxpe3bflp3"
```

The whole loop in one sitting, with the agent side included: [Quickstart](docs/quickstart.mdx).

## Commands

| | |
|---|---|
| `pinbox init` | set up pinbox in this project |
| `pinbox pin <text>` | create a pin from the terminal |
| `pinbox list` | list pins, newest first |
| `pinbox show <id>` | one pin with its full thread |
| `pinbox reply <id> <text>` | add a message to a pin's thread |
| `pinbox resolve <id>` | mark a pin resolved |
| `pinbox summary` | counts and the event cursor, in one call |
| `pinbox link <id>` | link a pin to an external tracker |
| `pinbox export` | write pins to stdout as markdown or JSON |
| `pinbox doctor` | probe this machine's capabilities |

Every flag, exit code, and JSON shape: [CLI reference](docs/cli/commands/overview.mdx).

## Why a pin

You are clicking through your app and something is wrong. Now you have to describe it somewhere else: which page, which element, which branch you were on, what you expected. By the time an agent has enough to work with, you have retyped everything you were already looking at, and the answer comes back somewhere the report is not.

Pinbox closes that round trip. A pin captures your words plus the context — URL, selector, file and line, branch and commit — and it stays a conversation until someone resolves it.

## How it works

Pins live in a SQLite file in your project (`.pinbox/pinbox.db`), served by a local hub daemon bound to `127.0.0.1`. Nothing leaves your machine unless you link a pin to a tracker.

Every verb is a command with a `--json` mode and a documented exit code, and that is the whole API. Pipe any command to another program and you get JSON instead of text, so an agent drives pinbox by running exactly what you just ran — and `pinbox init` hands it the skill, so it knows these verbs without being told.

## Documentation

Docs live in [`docs/`](docs/index.mdx) and are built with Mintlify.

- [Quickstart](docs/quickstart.mdx) — the whole loop in one terminal session
- [Installation](docs/installation.mdx) — every route, and how to verify it
- [CLI reference](docs/cli/commands/overview.mdx) — every command, flag, exit code, JSON shape
- [Concepts](docs/concepts/pins.mdx) — pins, threads, sessions, the hub, where data lives
- [Toolbar](docs/integrations/toolbar.mdx) — drop pins from the browser instead

## Layout

```
packages/core       @autono/pinbox-core — schema, hub handler, stores, connectors
packages/toolbar    @autono/pinbox-toolbar — zero-dependency web component + wrappers
packages/cli        the `pinbox` binary — commands, daemon lifecycle, init
packages/mcp        @autono/pinbox-mcp — stdio MCP server over the core client
skills/pinbox       the agent skill (generated from the CLI command tree)
plugins/            agent-host plugin packages (generated)
integrations/       agent-host integrations (generated)
examples/           script-tag, vite-react, and a deployable Cloudflare Worker
e2e/                cross-package tests, plus the Workers suite on real workerd
tools/              release pipeline, generators, validation scripts
docs/               this documentation site
```

## Contributing

Issues and pull requests are welcome. [Bun](https://bun.sh) 1.3+ is the runtime, the test runner, and the script runner; read [`docs/contributing.mdx`](docs/contributing.mdx) before you open a PR.

```sh
bun install
bun test
bun run ci:validate
```

## License

MIT © Autono Holdings Inc. See [LICENSE](LICENSE).
