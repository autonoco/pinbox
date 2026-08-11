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
import {
  type AgentEnv,
  type HubGet,
  type HubPost,
  handleDelivery,
  registerSession,
} from "./agent.ts";

export { PinboxHubDO };

export type Env = PinboxDoEnv &
  AgentEnv & {
    /** Static assets binding — everything in `public/`. */
    ASSETS: Fetcher;
    PINBOX_HUB: DurableObjectNamespace;
    PINBOX_PROJECT?: string;
  };

const MOUNT = "/_pinbox";
/** Where the hub delivers pins. Same Worker, so the round trip never leaves Cloudflare. */
const AGENT_MOUNT = "/_pinbox-agent";

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
/** Screenshots and other attachments are legitimately far larger than a pin. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

async function tooLarge(req: Request): Promise<Response> {
  // Drain first. Answering while the body is still streaming kills the whole Worker with
  // "Can't read from request stream after response has been sent" — which took the socket, the
  // queued pin, and the dev server with it.
  await req.body?.cancel().catch(() => {});
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

/** What a path is for. Pure, so the routing table is testable without booting a Worker. */
export type Route = "agent" | "hub" | "demo" | "asset";

export function routeFor(pathname: string): Route {
  if (pathname === AGENT_MOUNT) return "agent";
  if (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`)) return "hub";
  if (pathname === "/demo" || pathname === "/demo/") return "demo";
  return "asset";
}

async function serveHub(req: Request, env: Env): Promise<Response> {
  const limit = new URL(req.url).pathname.startsWith(`${MOUNT}/attachments`)
    ? MAX_ATTACHMENT_BYTES
    : MAX_BODY_BYTES;
  if (Number(req.headers.get("content-length") ?? 0) > limit) return tooLarge(req);
  const id = env.PINBOX_HUB.idFromName(env.PINBOX_PROJECT ?? "site-demo");
  // workers-types' Request/Response nominally differ from the global lib types; they are the
  // same objects at runtime.
  return env.PINBOX_HUB.get(id).fetch(stripPrefix(req) as never) as unknown as Promise<Response>;
}

/**
 * A direct line to the hub Durable Object: no network hop and no self-subrequest (a Worker
 * fetching its own hostname can be refused or loop). The bearer token is still required — the hub
 * authenticates every request without exception, including one that never left the isolate.
 */
function hubPost(env: Env, origin: string): HubPost {
  return (path, body) => {
    const request = new Request(`${origin}${MOUNT}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PINBOX_TOKEN ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    return serveHub(request, env);
  };
}

/** The read side of the same direct line. */
function hubGet(env: Env, origin: string): HubGet {
  return (path) =>
    serveHub(
      new Request(`${origin}${MOUNT}${path}`, {
        headers: { authorization: `Bearer ${env.PINBOX_TOKEN ?? ""}` },
      }),
      env,
    );
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname, origin } = new URL(req.url);
    const route = routeFor(pathname);
    if (route === "agent") {
      return handleDelivery(req, env, hubPost(env, origin), hubGet(env, origin));
    }
    if (route === "hub") return serveHub(req, env);
    // Loading the demo registers the agent session, so a pin dropped a moment later has somewhere
    // to be delivered. Upsert by (agent, key), so repeat loads cost nothing; a pin that lands
    // first is held unassigned and picked up by the next drain rather than lost.
    if (route === "demo") ctx.waitUntil(registerSession(hubPost(env, origin)).catch(() => {}));
    return env.ASSETS.fetch(req as never) as unknown as Promise<Response>;
  },
};
