# pinbox (CLI)

The primary surface, running on Bun. Verbs: `init`, `summary`, `list`, `show`, `reply`, `resolve`, `link`, `export`, `doctor` (`serve` exists but auto-spawns — users never run it).

What lives here:

- **Command surface** — clig.dev-compliant; every command supports `--json`, non-TTY auto-switches to JSON, responses are `{ok, data}` / `{ok: false, error: {code, message, hint}}` with a fixed error-code enum.
- **Daemon lifecycle** — detached self-spawn of the hub (`Bun.serve`), health-probed registration, version-mismatch respawn, SIGTERM→SIGKILL with PID-reuse guard. Subprocesses use `Bun.spawn` with `detached: true` + `process.kill(-pid)` so grandchildren don't orphan, and await `close` (not `exit`) or output is truncated. Secrets (pid, token) in XDG state (0600); project `.pinbox/server.json` carries the port only.
- **`init`** — Layer 1: deterministic setup (marker-managed `PINBOX:START/END` blocks in agent files, git/agent hooks, gitignore). Layer 2: detect installed agents with `Bun.which` (claude/codex/hermes) and hand off the integration brief; the PR is the review boundary.
- **`doctor`** — a capability probe, not a version comparison.
- **`serve --proxy`** — zero-touch toolbar injection locally via a stream scanner that injects before `</head>`. (`HTMLRewriter` is used only in the Worker template.)
- **Human/agent detection** — explicit flags > env fingerprints (`CLAUDECODE=1`, CI) > TTY check. Prompts only on TTY.
- `templates/worker/` — the deployable CF Worker+DO template, shipped inside this package's published `files` so init works offline.
- An embedded copy of the skill (source of truth: root `skills/pinbox/`), copied in at build.

**This package is source, not a published artifact.** It is compiled by `bun build --compile` into one self-contained binary per platform; it never ships as JavaScript.

Distribution is the esbuild platform-package pattern, assembled by `tools/release/`:

- `@autono/pinbox` — a generated ~5 KB launcher (`bin/pinbox.js`) whose `optionalDependencies` name all four platform packages at an **exact** version.
- `@autono/pinbox-{darwin,linux}-{arm64,x64}` — a generated manifest with `os`/`cpu` plus one binary (~23 MB gzipped). Package managers install only the match and silently skip the rest.

So `npx @autono/pinbox` works with no runtime prerequisite — the binary embeds Bun. Neither generated manifest carries an `engines` field, which would defeat the point; the `engines` here applies to this workspace source. Publish platforms first and the launcher last, or the first install after a release 404s. The same binaries also go to GitHub Releases behind a `curl | sh` installer.

The installed *command* is `pinbox` regardless, since the bin name is independent of the package name. Everything ships under the existing `@autono` scope, matching `@autono/buttons`. The unscoped `pinbox` name is held by an abandoned 2020 placeholder; it is not on the critical path, and nothing waits on it.
