# pinbox cloud — one-command Cloudflare hub setup

**Status: planned.** Born from the first real cloud deployment (Lark's staging admin,
2026-08-16/17): getting the shipped worker template from "copied into the repo" to
"toolbar live with screenshots" took a dozen manual steps across wrangler, the
Cloudflare dashboard, and hand-run verification — and hit nine distinct traps, each
of which cost real debugging time. Every one of them is mechanical. `pinbox init`
already installs the agent and wires the toolbar; this adds the missing third leg:
standing up the hub itself.

## What it takes today (the Lark deployment, reconstructed)

1. Copy `templates/worker/` into the host repo; hand-edit `wrangler.jsonc` (name,
   account, project).
2. `wrangler deploy` — fails on multi-account credentials until `account_id` is
   pinned in the config.
3. Generate a bearer token; `wrangler secret put PINBOX_TOKEN`; mirror it into the
   host app's own secret store for its token-distribution endpoint.
4. Enable R2 on the account — dashboard-only, cannot be done by API (error 10042).
5. Create the media bucket, add the `MEDIA` binding, create an R2 S3 API token in
   the dashboard (wrangler cannot mint one), set four more vars/secrets.
6. Discover the toolbar sits at `PINBOX · OFFLINE`: REST needs CORS the template
   does not have (websockets are CORS-exempt, which makes the failure deceptive —
   the connection reads `live` while every pin quietly queues).
7. Add worker CORS + R2 **bucket** CORS (browser PUTs presigned uploads directly).
8. Discover the host app pointed at the bare origin: the hub mounts under
   `/_pinbox`, and the root 404s.
9. Verify by hand: WS `hello` → `catch-up`, REST pin CRUD, presigned PUT
   round-trip (which signs `content-length`, so the probe must PUT the exact
   byte size it presigned).

## The traps, named (each becomes automation or a guarded prompt)

| # | Trap | Symptom | Automation |
|---|---|---|---|
| 1 | Multi-account wrangler | `More than one account available` | `wrangler whoami` → picker → pin `account_id` into the generated config |
| 2 | R2 not enabled | API error 10042 | Print the exact dashboard URL, poll `r2 bucket list` until it succeeds |
| 3 | S3 keys are dashboard-only | presign 401s | Guided step with the exact URL; accept the two keys via hidden prompt straight into `wrangler secret put` (never echoed) |
| 4 | `content-length` is a signed header | mysterious presign 403s | Verification PUTs the exact presigned size |
| 5 | No CORS in the template | `live` connection, pins stuck `QUEUED` | Port the CORS handling (worker `CORS_ORIGINS` + preflight + never wrapping 101s) into `templates/worker`; ask for app origins up front |
| 6 | R2 bucket CORS separate from worker CORS | text pins work, screenshots fail | `r2 bucket cors set` from the same origins list |
| 7 | Endpoint without the `/_pinbox` mount | root 404s, toolbar offline | Every printed snippet and stored config includes the mount; `verify` probes both and calls out the difference |
| 8 | Stale `.wrangler/deploy/config.json` | wrangler deploys the wrong thing | Scaffold adds it to the template `.gitignore`; `up` deletes it before deploying |
| 9 | Old wrangler (< 3.91) ignores JSON config | "No environment found" | Spawn a pinned `bunx wrangler@<tested>` rather than whatever is on PATH |

## Design

Three subcommands, plus an entry in init's existing picker ("Wire a cloud hub —
Cloudflare"):

```
pinbox cloud up       scaffold + configure + deploy + verify; idempotent, resumable
pinbox cloud verify   the full probe suite against an existing hub
pinbox cloud status   what exists and what's missing (worker, secrets, bucket, CORS)
```

`up` walks a checklist where every step is skip-if-done, so a run interrupted at
the R2 dashboard step resumes where it left off:

1. **Preflight** — wrangler auth (`whoami`), account selection, pinned wrangler
   version.
2. **Scaffold** — copy `templates/worker` (or adopt an existing copy), substitute
   name/account/project; prompt for the app origin(s) → `CORS_ORIGINS`.
3. **Token** — generate (`crypto.randomBytes`), `secret put PINBOX_TOKEN`, and
   print ONE machine-readable line (`PINBOX_HUB_TOKEN=<value>`) for the host's
   secret store — the only time it is shown, with a rotation one-liner
   (`pinbox cloud rotate-token`) documented beside it.
4. **Deploy** — clean stale artifacts (trap 8), `wrangler deploy`, capture the
   workers.dev URL.
5. **Media (optional, prompted)** — R2 enablement poll (trap 2), bucket create,
   bucket CORS (trap 6), guided S3-key entry (trap 3), binding + vars, redeploy.
6. **Verify** — the suite from the Lark deployment, automated: WS `hello` →
   `catch-up` (and a bad-token connect must close 4401), REST pin
   create/thread/resolve/delete round-trip, presigned PUT + read-back (trap 4),
   CORS preflight from each declared origin. PASS/FAIL table; any FAIL prints the
   matching trap's remedy.
7. **Handoff** — print the wiring snippet with the mount-inclusive endpoint
   (trap 7) and the `getToken` pattern (token via a host-gated endpoint, never in
   the client bundle), plus what to add to CI if the host builds with a baked
   `VITE_*` endpoint.

### Non-goals

- No Cloudflare account creation, payment enablement, or API-token minting — the
  two dashboard-only steps stay human, but guided (exact URL, poll until done).
- No host-app code generation beyond the printed snippet: token distribution is
  the host's auth domain (Lark gates it behind an operator check; every app will
  differ).
- No other clouds in this pass. The hub is a `(Request) => Response` handler, so
  the verb namespace (`cloud up`) deliberately leaves room.

### Implementation notes

- Lives in `packages/cli/src/cloud/` (new): `up.ts`, `verify.ts`, `status.ts`,
  `wrangler.ts` (spawn wrapper: pinned version, JSON parsing, redacted logging).
  The verify probes reuse `@autono/pinbox-core` schema types; WS probe via Bun's
  `WebSocket`.
- All secrets flow machine-to-machine (generated value → `secret put` stdin);
  nothing is ever echoed except the single deliberate handoff line in step 3.
- State for resumability sits in the scaffolded dir (`.pinbox-cloud.json`:
  account, worker name, completed steps) — committed, secrets never in it.
- TUI follows the existing OpenTUI init picker; every prompt has a flag
  (`--origins`, `--no-media`, `--name`, `--yes`) so agents can run it headless.
- **Prerequisite PR** (small, immediate): port Lark's CORS handling into
  `templates/worker` and gitignore the deploy artifact — the template is broken
  for any cross-origin consumer today, tooling or not.

## Landing sequence

1. Prerequisite template PR (CORS + gitignore) — unblocks anyone copying the
   template by hand.
2. `pinbox cloud` verb + verify suite; `bun test` coverage for the planner
   (step skipping, resume) with the wrangler spawn mocked.
3. Init picker entry; docs page `docs/cli/cloud.mdx`; changeset (minor, CLI).
4. Dogfood: re-run `pinbox cloud verify` against the live Lark hub (should pass
   untouched), then `pinbox cloud up` from scratch in a throwaway account.
