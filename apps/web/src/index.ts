// pinbox.sh — one Worker: the static marketing site, plus a live hub for the demo section.
//
// The hub is the same `(Request) => Response` handler `pinbox serve` runs locally, in a Durable
// Object, mounted at /_pinbox — same origin as the page, so there is no CORS and the toolbar on
// /demo/ is the real shipped component talking to a real hub. Routing is all this file does.
//
// The demo hub is PUBLIC and writable by anyone who loads the page. That is what a live demo is.
// It is deliberately isolated: its own DO namespace, nothing else in the project touches it, and
// wiping it is deleting one Durable Object. Do not point anything real at it.
import { type PinboxDoEnv, PinboxHubDO } from "@autono/pinbox-core/do";
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export { PinboxHubDO };

export type Env = PinboxDoEnv & {
  /** Static assets binding — everything in `public/`. */
  ASSETS: Fetcher;
  PINBOX_HUB: DurableObjectNamespace;
  PINBOX_PROJECT?: string;
};

const MOUNT = "/_pinbox";

/** The DO expects hub-root paths: /_pinbox/pins becomes /pins, upgrade headers and all. */
function stripPrefix(req: Request): Request {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice(MOUNT.length) || "/";
  return new Request(url.toString(), req);
}

/**
 * The demo hub is unauthenticated in practice — the token is printed in the page — so the only
 * thing standing between it and a filled Durable Object is this. A body cap is not a rate limit
 * and does not pretend to be one; it is the cheap half, and it is the half that stops one request
 * from writing a megabyte of pin text.
 */
const MAX_BODY_BYTES = 64 * 1024;

function tooLarge(): Response {
  // The hub's own machine-output envelope, so a client parses one error shape either way.
  return Response.json(
    {
      ok: false,
      error: {
        code: "E_INVALID_INPUT",
        message: `request body exceeds the demo hub's ${MAX_BODY_BYTES} byte limit`,
        hint: "this is the public demo; run your own hub for real payloads",
      },
    },
    { status: 413 },
  );
}

function isHubPath(pathname: string): boolean {
  return pathname === MOUNT || pathname.startsWith(`${MOUNT}/`);
}

function serveHub(req: Request, env: Env): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Promise.resolve(tooLarge());
  }
  const id = env.PINBOX_HUB.idFromName(env.PINBOX_PROJECT ?? "site-demo");
  // workers-types' Request/Response nominally differ from the global lib types; they are the
  // same objects at runtime.
  return env.PINBOX_HUB.get(id).fetch(stripPrefix(req) as never) as unknown as Promise<Response>;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return isHubPath(new URL(req.url).pathname)
      ? serveHub(req, env)
      : (env.ASSETS.fetch(req as never) as unknown as Promise<Response>);
  },
};
