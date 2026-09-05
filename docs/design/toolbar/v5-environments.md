# v5: environments — branch previews behind one tunnel URL

The loop we want: an agent lands work on a branch, runs one command, and hands the reviewer a
URL. The reviewer opens it on their phone or laptop, sees that branch running, drops pins on
it, and can flip to another branch from the toolbar without a PR, a deploy, or a `git checkout`
in the working tree the agent is still editing. Pins carry which branch they were dropped on,
so the agent's "fixed on `feat/x`" and the reviewer's "still broken" are about the same build.

Status of the accompanying notes, against `toolbar-v4-dogfood`:

| Note | State |
| --- | --- |
| Second pin type for notes/context only | **Shipped** (v4 item 9: `kind: "comment"`, Ask agent / Note on the draft, NOTES tab, router skips it). |
| Resolve pins; make agent response/progress visible | **Shipped** (v4 items 1–3: THINKING → WAITING → NO RESPONSE, Nudge, drawer Resolve/Unresolve, PR groups, resolution notes). One gap below: a *picked up* state between "sent" and "replied". |
| Pin visibility: show when useful, hide when not, one place for feedback | **Half shipped** (H toggle, anchor-gated markers, drawer lists everything). The environment filter below is the missing half. |
| Pins for general feedback not tied to an element | **CLI only** (`pinbox pin` with no target). The toolbar still requires a placement click. Below. |
| Environment switcher | **New.** The bulk of this document. |

---

## 1. Environments

### Shape

An *environment* is a running preview of one git ref, owned by the local hub:

```ts
Environment {
  id: "env_xxxxxxxxxx",
  branch: string,            // "feat/onboarding"
  commit: string,            // HEAD of the worktree when last probed
  worktree: string,          // .pinbox/worktrees/<slug>
  port: number,              // the dev server's local port
  status: "starting" | "ready" | "failed" | "stopped",
  lastError?: string,
  createdAt, updatedAt: string,
}
```

Worktrees, never `git checkout`: the agent's working tree is untouched, several branches run
side by side, and switching is a proxy decision, not a filesystem one. `.pinbox/worktrees/` is
gitignored by `pinbox init`.

### Where it lives

- **core** — `environments` table (derived, like `sessions`; no event-log replay needed),
  `EnvironmentStore` on `PinStore` with both implementations, routes `GET/POST /environments`,
  `PATCH/DELETE /environments/:id`, one additive event type `env.updated` on the existing log so
  the toolbar hears state changes over the socket it already holds. `PinInput.environment?:
  string` (additive): when present, the hub stamps `env.branch`/`env.commit` from the
  environment record instead of `gitEnv(projectDir)`, which today reports the agent's checkout,
  not the build the reviewer is looking at.
- **cli** — `pinbox env add <branch>`, `pinbox env ls`, `pinbox env rm <id|branch>`,
  `pinbox env logs <id>`; `pinbox preview` (tunnel + router, §2). The daemon (`serve.ts`) owns
  the child processes so they outlive the CLI invocation and die with the hub's idle exit.
- **toolbar** — the switcher (§3).
- **skill** — the agent's happy path (§5).

### `pinbox env add <branch>`

1. `git worktree add .pinbox/worktrees/<slug> <branch>` (fetch first if the ref is remote-only;
   `--json` error `E_INVALID_INPUT` with the git message when the ref does not exist).
2. Dependencies: symlink `node_modules` from the project root when the lockfile is byte-identical
   (the common case for a small branch); otherwise run the detected package manager's install in
   the worktree. `detectRepo` already knows the manager.
3. Dev server: the detected framework's dev command with `PORT`/`--port` set to a free port
   (Vite, Next, Nuxt, SvelteKit, Astro all accept one; a `pinbox.json` `dev` field overrides,
   and is the answer for everything else). `Bun.spawn` under the daemon, stdout/stderr to
   `.pinbox/logs/<env>.log`.
4. Probe `http://127.0.0.1:<port>/` until it answers → `ready`; a non-zero exit before that →
   `failed` with the last 20 log lines in `lastError`.
5. Print the environment (`--json`: the record plus `url`, §2). Idempotent: an existing env for
   the branch is reused and re-probed, not duplicated.

Budget: one env is one dev server. Default cap 4; `pinbox env add` past the cap evicts the
oldest `stopped`/`failed` one or fails with a hint to `rm`.

---

## 2. One URL: the preview router and the tunnel

The reviewer gets exactly one URL, and it does not change when the branch does.

### Preview router

A `Bun.serve` reverse proxy the daemon runs beside the hub, bound `127.0.0.1`, ephemeral port,
recorded in `.pinbox/server.json` as `previewPort`:

- **`/__pinbox/env/<id>`** — sets the `pb_env` cookie to `<id>`, 302 back to `?back=` (the
  page you were on, path + search preserved). This is what the toolbar's switcher hits.
- **`/__pinbox/hub/*`** — proxies to the hub. The toolbar's `hub` becomes same-origin
  (`/__pinbox/hub`), which is what makes the tunnel work at all: a remote browser cannot reach
  `127.0.0.1:<hubport>`.
- **everything else** — proxies to the dev server of the env named by `pb_env` (default: the
  most recently `ready` env, else the project root's own dev server if one is registered).
  Streams bodies both ways; upgrades WebSockets (HMR, and the hub's own `/ws` under
  `/__pinbox/hub/ws`) by opening a client `WebSocket` to the upstream and piping frames.
- **HTML responses** get one tag before `</head>`: `<meta name="pinbox-env" content="<id>">`
  plus the toolbar bootstrap snippet pointed at `/__pinbox/hub`, so the toolbar is present even
  when the app's dev plugin is not installed on that branch. The dev plugin, when present,
  detects the meta and skips its own injection.

The hub's `Bun.serve({ fetch })` handler is unchanged; the router is a second handler in the
same process.

### Tunnel

`pinbox preview` starts the router if needed, then `cloudflared tunnel --url
http://127.0.0.1:<previewPort>` (`Bun.which("cloudflared")`; a clear `E_CONNECTOR`-style error
with the install hint when absent). The quick-tunnel URL is parsed from cloudflared's stderr and
stored in hub state; `pinbox env add --json` and `pinbox preview --json` both return
`url: "https://<random>.trycloudflare.com/__pinbox/env/<id>"`. A named tunnel
(`PINBOX_TUNNEL_NAME`, credentials already on the machine) is used when configured, for a
stable hostname.

### The token problem, stated plainly

Today the hub bearer token is baked into the dev bundle, defensible because the hub binds
`127.0.0.1`. Behind a tunnel that is no longer true: whoever has the URL has the token, and the
token can create, resolve and delete anything. Two rules:

1. **The router never forwards the project bearer token to remote clients.** The bootstrap it
   injects carries a **viewer token**: a JWT the router mints (HS256, secret generated per hub,
   `aud: "pinbox-viewer"`, 12 h expiry) and the hub verifies through the `verify` hook it already
   has for cloud auth. Viewer identity can create pins, reply, resolve, verify. It cannot hit
   `/sessions/*`, `/environments` writes, or `/attachments` deletes.
2. **Quick tunnels are unlisted, not private.** Documented as such. For a stable hostname the
   docs show Cloudflare Access in front of the named tunnel, which is the actual auth layer.

---

## 3. The switcher in the toolbar

- **Branch chip** in the bar's ident area: the current env's branch (from the `pinbox-env` meta;
  "local" when there is none). Click → a popover listing environments with status dots
  (`ready` green, `starting` pulsing, `failed` amber) and the commit's short SHA; picking one
  navigates to `/__pinbox/env/<id>?back=<path+search>`. Keyboard `B`. Fan gets it too.
- **Pins carry their environment.** New pins send `environment` from the meta. Markers render
  only for pins of the env you are viewing plus pins with no environment (CLI pins, pre-v5
  pins). The drawer's OPEN tab groups the other envs' pins under collapsed branch headers —
  everything stays in one place, nothing irrelevant sits on the page. This is the "show when
  useful, hide when not" half that v4 did not have.
- **Status in the switcher, not just the chip.** `failed` shows the last log lines inline;
  `starting` shows a spinner and the switcher refuses to navigate to it until `ready`.
- `env.updated` events keep the list live without polling.

---

## 4. The two smaller notes

### General pins from the toolbar

A pin about the whole page, or a question, with no element behind it.

- Bar/fan action **General** (`G`, glyph: a speech bubble) opens the draft card docked
  mid-viewport (the v4 fallback position) with no target. The composer keeps Ask agent / Note.
- `PinInput` already allows a missing `target`; the toolbar stops requiring one. `env` is still
  sent (viewport, browser, URL), and `environment` when known.
- Rendering: no marker (there is nowhere to point). Drawer shows them under a GENERAL header
  above the anchored pins; the card's label reads "PAGE".
- Nothing new on the hub or the CLI: `pinbox pin` has produced exactly these pins since v1.

### "Picked up": progress between sent and replied

Today the reviewer sees THINKING until the agent's first reply lands, however long the agent
actually works. The router already knows the moment a delivery is handed to a session.

- One additive event, `pin.delivered`, logged by the router when a delivery row is marked
  delivered (hooks pull, webhook 2xx, openclaw enqueue). Payload is the pin plus
  `deliveredTo: { agent, key }`.
- Toolbar `pendingKind` gains `"working"`: after `pin.delivered` and before any agent message,
  the row reads `<agent> IS ON IT` (the session's agent name, as the reply label already does).
  Chip: PICKED UP. The stale timer still runs from the human's last message, so a picked-up pin
  that never replies still ages into NO RESPONSE.

---

## 5. The agent's path

Generated into the skill from the command tree, plus one prose rule:

```
git push -u origin feat/onboarding
pinbox env add feat/onboarding --json     # → { id, status, url }
# wait for status "ready" (poll `pinbox env ls --json`, ~10–40 s)
pinbox reply <pinId> "Fixed on feat/onboarding — preview: <url>"
```

> **Hand over a preview URL, not a branch name.** After landing work for a pin on a branch, run
> `pinbox env add <branch> --json` and put the returned `url` in your reply. The reviewer's pins
> on that URL carry the branch; check `env.branch` before you assume a report is about `main`.

`pinbox summary --json` gains `environments: { ready, starting, failed }` so a session's Stop
hook can mention a preview that died.

---

## 6. Ship order

| PR | Scope | Notes |
| --- | --- | --- |
| 1 | core: `Environment` schema, store, routes, `env.updated`, `PinInput.environment` stamping | Pure hub work; both store implementations. |
| 2 | cli: `pinbox env add/ls/rm/logs` with worktrees and the daemon-owned dev servers | No tunnel yet: `url` is `http://127.0.0.1:<port>`. Usable locally on day one. |
| 3 | cli: preview router (proxy, cookie, `/__pinbox/hub`, HTML injection, WS upgrade) | Local only; verify HMR survives the proxy for Vite and Next. |
| 4 | core+cli: viewer JWT minting and the `verify` hook wiring for preview mode | Before any tunnel exists. |
| 5 | cli: `pinbox preview` — cloudflared quick + named tunnels, URL in state and `--json` | Docs: quick tunnels are unlisted, Access for stable hosts. |
| 6 | toolbar: branch chip + switcher, env filter in markers and drawer, `environment` on new pins | Depends on 1 and 3. |
| 7 | toolbar: General pins (`G`) | Independent; can land any time. |
| 8 | core+toolbar: `pin.delivered` and the PICKED UP stage | Independent; small. |
| 9 | skill prose + `summary` environments | Last; the skill regenerates from the tree. |

Open questions worth a decision before PR 2:

- **Dependency install policy.** Symlinked `node_modules` is fast and wrong the moment a branch
  changes the lockfile. Default to symlink-when-identical, install otherwise, or always install?
  Recommendation: symlink-when-identical; it covers most agent branches and the fallback is safe.
- **Who starts the app's dev server for `main`?** Register the root checkout as an implicit
  environment (`env_root`) so the switcher can always go "back", or leave `main` to the existing
  dev-plugin flow? Recommendation: implicit root env, probed not spawned — the developer already
  runs it.
- **Databases and env vars.** Branch previews share the developer's `.env` and any local DB. That
  is the right default for a preview and the wrong one for a migration branch. Document; do not
  solve in v5.
