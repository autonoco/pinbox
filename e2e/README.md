# e2e/

The single cross-package end-to-end test workspace. One directory on purpose: every meaningful pinbox flow crosses packages, and per-package e2e leads to each package re-spawning its own hub harness.

Flows that belong here. Landed ones name their file; the rest are slots for the phase that owns them.

- **`loop.test.ts`** — the daemon lifecycle loop: `pinbox serve` spawned from source, port/state files, idle exit.
- **`toolbar.test.ts`** — the real `HubTransport` against a real spawned hub: create → the originator receives its own `pin.created` frame (the `server.publish` rule), CLI `resolve` → `pin.resolved`, `verify` → `pin.verified`; offline reconcile (drop the socket, cursor replay of the missed `thread.message`, outbox flush on reconnect); the min-protocol and bad-token close codes (4400 / 4401); attachment bytes landing under `.pinbox/media/` and the path round-tripping through `pinbox show --json`; `connectedToolbars` tracking live sockets.
- Dev-plugin auto-spawn: a consumer's Vite dev server adopts or starts the hub (`ensureHub`) → toolbar injected → pin created → appears via `pinbox list`. Only the transport half of this is covered today; the plugin half is unit-tested.
- Delivery: pin routed to a registered session (hooks injection / resume-spawn / webhook).
- Commit-trailer resolution (`Fixes pin <id>`) → status round-trips to the toolbar over WS.
- `pinbox init` marker-block idempotency (run twice, diff once).
- Cloud parity: the product loop + realtime on workerd (`workers/loop-parity.worker-test.ts`) — "the same handler, two hosts" proven, not asserted.

## Two runners, and why

| Runner | Files | Runtime | Invocation |
|---|---|---|---|
| `bun test` | `*.test.ts` (this directory) | Bun — the runtime pinbox owns | `bun test ./e2e` |
| vitest + `@cloudflare/vitest-pool-workers` | `workers/*.worker-test.ts` | **workerd** — the runtime the DO ships to | `bun run test:workers` (root) |

The workers suite is the one non-`bun test` suite in the repo, and that is the point: `@cloudflare/vitest-pool-workers` *is* workerd, so the DO SQLite store, the hibernating WS broadcaster, HTMLRewriter injection, and the auth strategies are exercised on the engine they deploy to — Bun cannot host any of that. The two runners stay disjoint by filename convention: `bun test` never discovers `*.worker-test.ts` (only `.test.`/`.spec.` patterns), and the vitest config includes only `workers/**/*.worker-test.ts`, so neither runner ever loads the other's files.

`workers/vitest.config.ts` splits the pool into two projects:

- **`do`** — inline miniflare config driving core's DO classes directly (`STORE_DO`, `HUB_DO`, plus per-strategy subclasses for the auth matrix — wrangler vars are namespace-wide, so each strategy needs its own namespace).
- **`template`** — the real `examples/worker/wrangler.jsonc` (alias, migrations, Text rules included), so the deploy-checked template copy is what the tests exercise, through `SELF`.

Unit tests do NOT belong here — they stay colocated as `*.test.ts` next to source.
