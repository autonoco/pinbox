# apps/web

The pinbox.sh marketing site. A sibling app — deliberately **not** nested inside a package, which
would produce stray lockfiles and couple the site's build to a library's.

```sh
bun run --filter '@autono/pinbox-site' dev      # wrangler dev
bun run --filter '@autono/pinbox-site' deploy   # wrangler deploy
```

## Deploying

Merging to `main` deploys it. `.github/workflows/deploy-site.yml` revalidates, builds, and runs
`wrangler deploy` on any change to `apps/web`, `packages/core`, or `packages/toolbar` — core and
toolbar included because this Worker bundles both, so a hub fix that skipped the deploy would
leave the live site running the old one. The command above is the same deploy, by hand.

Three things live outside the repo and are set once:

| What | Where | Why |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub → the `site - prod` environment | What lets CI deploy. Scoped to that environment, not the whole repo, and to the one job that needs them — the test suite runs in a separate job that cannot see them. |
| `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET` | `wrangler secret put <NAME>` | The demo agent's key, and the HMAC that proves a delivery came from the hub. Worker secrets survive deploys, so CI never needs to see them. |
| `pinbox.sh` as a zone | The same Cloudflare account as the token | `wrangler.jsonc` claims the apex as a custom domain. If the zone is not on that account the deploy fails rather than silently serving from a `workers.dev` URL. |

Without the two Worker secrets the site and hub still run; the agent answers `503` and pins go
unanswered. That is the intended degradation — the demo says nothing rather than pretending.

## No build step

`public/` **is** the site. Cloudflare serves it byte for byte, so what you see on `wrangler dev`
is what deploys — no bundler, no framework, no hydration, and nothing to go stale between the
source and the artifact.

The cost is that nothing resolves paths for you: rename a font and the page still loads, quietly
substituting a system face. `bun tools/validate/site-assets.ts` (wired into `ci:validate`) walks
every `href`, `src`, and `url()` in `public/` and fails if one does not resolve.

## Where the design came from

Ported from the "Pinbox site" design in Claude Design. That tool emits inline styles plus a
`style-hover` attribute it resolves with a React runtime at page load; none of that ships here.
Inline styles became classes in `styles/site.css`, `style-hover` became real `:hover` rules, and
the 70 KB runtime is gone — the page needs no JavaScript at all.

`styles/tokens.css` is a **subset** of the Autono design system's `colors_and_type.css`, not a
fork. Add a token when a page needs one; never redefine a value that exists upstream.

## Fonts

Self-hosted, no third-party requests.

- **DM Sans**, **JetBrains Mono** — open licences, subset `woff2` from Google Fonts.
- **PP Monument Extended** — **commercial** (Pangram Pangram). Only Light 300 ships, because that
  is the only weight the site sets. Confirm the webfont licence covers pinbox.sh before this goes
  public, and add a weight only alongside its file.

## `/demo` — the real thing

`/demo/` is a stand-in app ("Meridian") with **the shipped toolbar** on it, talking to a **real
hub**. Nothing on that page draws a pin, a thread, or an inbox: all of it comes from
`packages/toolbar`'s bundle, and every pin is a row in a Durable Object.

- The bundle is a copy, so `tools/validate/site-toolbar.ts` asserts it matches what this repo
  builds. `bun run --filter '@autono/pinbox-site' sync:toolbar` refreshes it, and `predeploy`
  runs that for you.
- The hub is the same `(Request) => Response` handler `pinbox serve` runs locally, mounted at
  `/_pinbox` in this same Worker — same origin, so no CORS.

**The demo hub is public and writable by anyone who loads the page.** That is what a live demo is.
It is isolated to its own project namespace (`site-demo`), and the token in `wrangler.jsonc` is
published to every visitor — it is not a secret and must never be reused anywhere real. Wiping the
demo is deleting one Durable Object.

The Worker caps request bodies at 64 KB, which stops one request writing a megabyte of pin text.
That is not a rate limit and does not pretend to be one — **there is still no request-rate
limit**. Add one before this gets real traffic.

`endpoint` must be **absolute**. The transport builds its WebSocket URL with `new URL(endpoint)`,
which throws on a bare path — a relative endpoint leaves the toolbar mounted and permanently
disconnected, which looks like it is working.

## Not built yet

The README this file replaced also claimed the site would host documentation, the skill discovery
surface (`/.well-known/agent-skills/index.json` with SHA256 integrity), `llms.txt`, the versioned
script-tag bundle, and the toolbar running on itself. None of that exists yet — this is the
marketing page only.
