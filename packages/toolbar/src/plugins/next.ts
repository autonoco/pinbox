// @autono/pinbox-toolbar — Next.js integration, exposed at the `./next` subpath
// Exports NextConfigLike and withPinbox() — a `next.config` wrapper, NOT a Vite-plugin port.
//
// PORTABILITY — this module is evaluated inside the CONSUMER's Next toolchain. Like Vite, the
// `next` bin carries a `#!/usr/bin/env node` shebang, so it lands on Node even when launched with
// Bun (`bunx next`, `bun run dev`) — see the measured table in ./daemon.ts. It must therefore
// never touch Bun-only globals. It uses no host APIs of its own beyond `process.env`; all
// filesystem/process work lives in ./daemon.ts, whose `node:` imports are deliberate and correct
// for the same reason. This is the "guest rule" in AGENTS.md — do not "fix" it.
//
// SCOPE — read this before assuming parity with ./vite.ts. Next has no `transformIndexHtml` and no
// documented public hook for injecting a script tag into every dev page from `next.config`. So this
// wrapper does exactly ONE half of the job: it makes sure the hub daemon is running during `next
// dev`. The client-side half — actually mounting `<pinbox-toolbar>` — is unsolved here and is
// spelled out in the TODO block below rather than faked.

// Extensionless specifiers: the root tsconfig does NOT set `allowImportingTsExtensions`, so a
// value import written `./daemon.ts` is a TS5097 error. `moduleResolution: "Bundler"` resolves
// these, and tsdown/rolldown emits the correct `.js` specifiers.
import { ensureHub } from "./daemon";
import { type PinboxPluginOptions, resolveOptions } from "./options";

/**
 * Structural stand-in for Next's `NextConfig`.
 *
 * We deliberately do NOT depend on `next` — it is an enormous dependency to pull in just for a
 * type, and pinning it would constrain which Next versions consumers may use. An index signature
 * is enough: we return the caller's object unchanged, so its own type `T` is what survives.
 */
export interface NextConfigLike {
  [key: string]: unknown;
}

/** `next dev` / `next build` set NODE_ENV themselves; bracket access is required by house tsconfig. */
function isDevelopment(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

/**
 * Wrap a `next.config` object so the pinbox hub is running during development.
 *
 *     // next.config.ts
 *     import { withPinbox } from "@autono/pinbox-toolbar/next";
 *     export default withPinbox({ reactStrictMode: true });
 *
 * Returns the SAME config value it was given (never a clone), so it composes with other `withX`
 * wrappers in any order. The only effect is the side effect below.
 *
 * The hub check is fire-and-forget: `next.config` is evaluated synchronously here and `ensureHub`
 * can take up to ~10s when it has to spawn the daemon. Blocking on it would stall every `next dev`
 * start, and `ensureHub` never throws or rejects, so nothing can escape into the consumer's build.
 * A future phase may instead export an async config function so the resolved hub URL can be
 * threaded into `env` at config time — see the TODO.
 */
export function withPinbox<T extends NextConfigLike>(config?: T, options?: PinboxPluginOptions): T {
  const resolved = resolveOptions(options);
  const nextConfig = config ?? ({} as T);

  if (resolved.disabled || !isDevelopment()) return nextConfig;

  // Not awaited: see the doc comment. `ensureHub` swallows its own failures and logs one warning.
  void ensureHub(resolved);

  return nextConfig;
}

// ---------------------------------------------------------------------------------------------
// TODO: client-side injection. NOT IMPLEMENTED — this wrapper only starts the daemon.
//
// Vite lets us inject an inline module into every served page via `transformIndexHtml`. Next has no
// equivalent that a `next.config` wrapper can reach, and under the App Router the page shell is a
// React Server Component, so there is no client-side entry point we can extend from config alone.
// The three candidate approaches, with their real costs:
//
//   1. Consumer edits `app/layout.tsx` to render a `<PinboxToolbar />` client component we ship.
//      Honest and version-proof, works in both routers, and is the only option that composes with
//      streaming/RSC. Cost: it is not zero-config — the consumer must add one line, so `withPinbox`
//      alone would remain insufficient. Currently the most likely choice.
//
//   2. Pages Router only: a custom `pages/_document.tsx`. Cannot be applied from `next.config`
//      either (the consumer still owns that file), and it does nothing for App Router users, so it
//      solves a shrinking fraction of the ecosystem.
//
//   3. Rewrite the client entry via the `webpack`/Turbopack config hooks to prepend our bootstrap
//      module. This is the only genuinely zero-config route, but it reaches into build internals
//      that are not a stable public contract; Turbopack in particular exposes a much narrower
//      surface than webpack, and I am not confident enough in the current names/shapes of those
//      hooks to write them here. Guessing an API would be worse than leaving this open — verify
//      against the Next version matrix we intend to support before attempting it.
//
// Whichever wins, the mounted component's job is the same as ./snippet.ts's `buildBootstrap`:
// import the toolbar element for its side effect, create one `<pinbox-toolbar>`, and set its
// `hub` AND `token` attributes. The hub URL and token must be discovered on the CLIENT (or passed
// through `env` at config time via an async config function) — the browser can read neither
// `.pinbox/server.json` nor the XDG state dir. The token half already exists server-side:
// `readHubToken(projectRoot)` in ./daemon.ts is the same function ./vite.ts bakes into its dev
// bundle (see the security bound in ./snippet.ts) — the missing piece here is only the delivery
// vehicle into the page, not the token plumbing.
// ---------------------------------------------------------------------------------------------
