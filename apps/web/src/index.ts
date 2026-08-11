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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`)) {
      const id = env.PINBOX_HUB.idFromName(env.PINBOX_PROJECT ?? "site-demo");
      // workers-types' Request/Response nominally differ from the global lib types; they are the
      // same objects at runtime.
      return env.PINBOX_HUB.get(id).fetch(
        stripPrefix(req) as never,
      ) as unknown as Promise<Response>;
    }
    return env.ASSETS.fetch(req as never) as unknown as Promise<Response>;
  },
};
