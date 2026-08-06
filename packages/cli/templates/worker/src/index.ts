// Worker entry: one DO per project, hub mounted under /_pinbox — same-origin with the
// injected page, so no CORS and cookies ride along for jwt-cookie setups. The DO runs
// the same (Request) => Response hub handler the local `pinbox serve` runs; this file
// only routes. Inherits the host's auth strategy — no unauthenticated writes in any
// configuration (AUTH_STRATEGY=none is refused without ALLOW_UNAUTHENTICATED=1).
import type { PinboxDoEnv } from "@autono/pinbox-core/do";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { injectToolbar } from "./inject.ts";
// Text module (wrangler.jsonc `rules`): the toolbar IIFE served at /_pinbox/pinbox.js.
import toolbarIife from "./pinbox.iife.js";

export { PinboxHubDO } from "@autono/pinbox-core/do";

export type Env = PinboxDoEnv & {
  PINBOX_HUB: DurableObjectNamespace;
  PINBOX_PROJECT?: string;
  ORIGIN_URL?: string;
};

const MOUNT = "/_pinbox";

// The DO sees hub-root paths: /_pinbox/pins → /pins. Method/headers/body carry over,
// including WebSocket upgrade headers for /_pinbox/ws.
function stripPrefix(req: Request): Request {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice(MOUNT.length) || "/";
  return new Request(url.toString(), req);
}

function toolbarScript(): Response {
  return new Response(toolbarIife, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}

// Machine-output envelope (frozen contract) — same shape the hub itself speaks.
function notFoundHint(): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: "E_NOT_FOUND",
        message: "nothing mounted at this path",
        hint: "set ORIGIN_URL for zero-touch staging injection, or call the hub under /_pinbox",
      },
    },
    { status: 404 },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === `${MOUNT}/pinbox.js`) return toolbarScript();
    if (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`)) {
      const id = env.PINBOX_HUB.idFromName(env.PINBOX_PROJECT ?? "default");
      const stub = env.PINBOX_HUB.get(id);
      // workers-types' Request/Response nominally differ from the global lib types;
      // they are the same objects at runtime.
      return stub.fetch(stripPrefix(req) as never) as unknown as Promise<Response>;
    }
    if (env.ORIGIN_URL) return injectToolbar(req, env); // zero-touch staging injection
    return notFoundHint();
  },
};
