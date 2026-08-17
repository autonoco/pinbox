# pinbox worker template

The deployable Cloudflare Worker + Durable Object hub. **Copied, never imported** — the
CLI materializes this directory into your project; it is not a published package. The DO
runs the exact `(Request) => Response` handler the local `pinbox serve` runs, on DO
SQLite storage, with hibernating WebSockets and R2-backed attachments.

## Provisioning

1. `bun install` (or npm/pnpm) — pulls `@autono/pinbox-core` and wrangler.
2. Create the media bucket and put its name in `wrangler.jsonc`:
   `wrangler r2 bucket create <your-bucket>` → `r2_buckets[0].bucket_name`.
   The shipped `pinbox-media-placeholder-provision-me` name fails loudly at deploy, by design.
3. Set the hub secret: `wrangler secret put PINBOX_TOKEN`.
4. (Optional, attachments) Create an R2 API token and set the S3 credentials as secrets:
   `wrangler secret put R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY`. The `MEDIA` binding serves reads; presigned PUTs need these.
5. (Cross-origin hosts) If your app mounts the toolbar itself rather than being injected
   via `ORIGIN_URL`, set `CORS_ORIGINS` in `wrangler.jsonc` to your app origin(s) — and
   give the R2 bucket CORS too (`wrangler r2 bucket cors set <bucket> --file cors.json`,
   allowing `PUT`/`GET` from the same origins), or text pins will work while screenshot
   uploads fail. Without `CORS_ORIGINS` the websocket still connects (CORS-exempt), so
   the toolbar reads "live" while every REST write quietly queues offline.
6. `bun run deploy` — runs the locally installed wrangler (pinned `^4.118.0` in
   `package.json`; wrangler < 3.91 silently ignores `wrangler.jsonc`, so don't reach for a
   global). Local loop: copy `.dev.vars.example` to `.dev.vars`, `bun run dev`.

The hub mounts under `/_pinbox` (health: `GET /_pinbox/health`, tokenless). **Point
consumers at `https://<worker-host>/_pinbox`** — mount path included; the origin root
deliberately 404s. One Durable Object exists per `PINBOX_PROJECT` name.

## Auth — no unauthenticated writes in any configuration

The template inherits the host's auth strategy via `AUTH_STRATEGY`:

| strategy | config | behavior |
| --- | --- | --- |
| `token` (default) | `PINBOX_TOKEN` secret | constant-time bearer compare |
| `jwt` | `JWT_ISSUER`, `JWT_JWKS_URL`, `JWT_AUDIENCE` | jose JWKS, EdDSA + RS256 only |
| `none` | refused unless `ALLOW_UNAUTHENTICATED=1` | loopback/dev only |

Misconfiguration (e.g. `token` with no secret, `none` without the explicit opt-in) is a
loud 500 on every request — the hub never falls open.

## Zero-touch staging injection

Set `ORIGIN_URL` to your staging origin and every non-`/_pinbox` request is proxied with
the toolbar `<script>` injected into HTML responses by HTMLRewriter (streaming; no build
change on the app side). The snippet stamps the hub mount and the proxied origin — never
a token. Pages that already mount a pinbox script are left alone.

### Authenticated staging behind Cloudflare Access

Access sets a `CF_Authorization` cookie (a JWT) on every request. To let the hub accept
it, wrap the jwt strategy to read the cookie — a template-local three-liner in
`src/index.ts`, passed instead of the env-built verifier:

```ts
const verifyAccess = (verify: VerifyFn): VerifyFn => async (req) => {
  const jwt = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return verify(new Request(req.url, { headers: { authorization: `Bearer ${jwt ?? ""}` } }));
};
```

Point `JWT_ISSUER`/`JWT_JWKS_URL`/`JWT_AUDIENCE` at your Access team domain
(`https://<team>.cloudflareaccess.com`, `…/cdn-cgi/access/certs`, your Access app AUD).

## Layout

- `src/index.ts` — routing only: `/_pinbox/pinbox.js` (toolbar script), `/_pinbox/*` →
  the DO, everything else → injection (when `ORIGIN_URL` is set).
- `src/inject.ts` — the HTMLRewriter proxy. Worker-only; the local equivalent is the
  CLI's stream scanner.
- `src/pinbox.iife.js` — the toolbar bundle slot, served as text.
- `src/shims/bun-sqlite.ts` — build shim; see THE LOAD-BEARING LINE in `wrangler.jsonc`.

A byte-identical copy lives at `examples/worker` in the pinbox repo and is deploy-checked
in CI (`tools/validate/template-drift.ts`), so template drift is caught before release.
