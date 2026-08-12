// @autono/pinbox-core/hub — fetch-style hub handler.
// A pure (Request) => Promise<Response> with no server coupling: Bun.serve({ fetch })
// consumes it locally and the Cloudflare Worker exports it as `default` —
// one implementation, two hosts, zero adapters. Bearer auth on every route except
// GET /health; every body follows the machine output contract. Routing is a
// route-module array: one file per route group, first non-null Response wins.
import { z } from "zod";
import type { Connector } from "./connectors/types.ts";
import { routeLinks } from "./routes-links.ts";
import { routeSessions } from "./routes-sessions.ts";
import { routeToolbar } from "./routes-toolbar.ts";
import { AppliedEditSchema, AttachmentSchema, PinInputSchema, SCHEMA_VERSION } from "./schema.ts";
import type { PinStore } from "./store.ts";
import { ConflictError, NotFoundError } from "./store.ts";

// Cloud auth types — declared here alongside the rest of the hub surface;
// auth/verify.ts re-exports them with the implementations.
export type Identity = { userId: string; tenantId?: string; name?: string; email?: string };
export type VerifyFn = (req: Request) => Promise<Identity | null>;

export type HubOptions = {
  store: PinStore;
  token: string;
  enrichEnv?: () => { branch?: string; commit?: string };
  verify?: VerifyFn; // cloud auth; absent = shipped bearer compare; null result ⇒ 401 E_AUTH
  connectors?: Connector[]; // host-injected (gh CLI locally, App token on the Worker); absent ⇒ link routes 502 E_CONNECTOR
};
export type RouteModule = (req: Request, url: URL, opts: HubOptions) => Promise<Response | null>;

// Keep in step with packages/core/package.json — surfaced by GET /health so the CLI
// daemon can detect a stale hub and restart it.
const HUB_VERSION = "0.1.0";

// Final §9 union minus E_HUB_UNREACHABLE (client-only).
type HubErrorCode =
  | "E_INTERNAL"
  | "E_INVALID_INPUT"
  | "E_NOT_FOUND"
  | "E_CONFLICT"
  | "E_SESSION_GONE"
  | "E_DELIVERY"
  | "E_WS_PROTOCOL"
  | "E_ATTACHMENT"
  | "E_CONNECTOR"
  | "E_AUTH";

const StatusFilterSchema = z.enum(["open", "resolved"]);
const AfterSchema = z.coerce.number().int().nonnegative();
const ThreadPostSchema = z.object({
  role: z.enum(["human", "agent", "mirror"]),
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  origin: z.string().optional(), // mirror attribution "github:user"
  edit: AppliedEditSchema.optional(), // a change the agent applied to a live page
});
const ResolvePostSchema = z.object({
  by: z.enum(["human", "agent"]),
  note: z.string().optional(),
  commit: z.string().optional(), // commit-trailer resolution attaches the SHA
});

// Order is pinned: routeToolbar and routeLinks append at their slots.
const ROUTES: RouteModule[] = [
  routeCollections,
  routePinItem, // signature is (req, url, opts), same as the rest
  routeSessions, // packages/core/src/routes-sessions.ts
  routeToolbar, // packages/core/src/routes-toolbar.ts
  routeLinks, // packages/core/src/routes-links.ts
];

export function createHubHandler(opts: HubOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return ok(200, { version: HUB_VERSION, schemaVersion: SCHEMA_VERSION, wsProtocol: 1 });
    }
    if (opts.verify) {
      const identity = await opts.verify(req);
      if (identity === null) {
        return err(401, "E_AUTH", "request rejected by the configured verifier", {
          hint: "send a credential the hub's verify strategy accepts",
        });
      }
    } else if (req.headers.get("authorization") !== `Bearer ${opts.token}`) {
      return err(401, "E_INVALID_INPUT", "missing or invalid bearer token", {
        hint: "send Authorization: Bearer <token>; the token lives in the XDG state file",
      });
    }
    try {
      return await route(req, url, opts);
    } catch (cause) {
      return mapError(cause);
    }
  };
}

// First non-null response from ROUTES in order, else NotFoundError.
async function route(req: Request, url: URL, opts: HubOptions): Promise<Response> {
  for (const routeModule of ROUTES) {
    const response = await routeModule(req, url, opts);
    if (response) return response;
  }
  throw new NotFoundError(`no route: ${req.method} ${url.pathname}`);
}

// /summary, /events, /pins — routes not addressing a single pin.
async function routeCollections(
  req: Request,
  url: URL,
  opts: HubOptions,
): Promise<Response | null> {
  const { store } = opts;
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case "GET /summary": {
      // Additive `sessions` field: count of not-ended sessions. store.summary() stays frozen.
      const sessions = store.sessions.list().filter((s) => s.endedAt === undefined).length;
      return ok(200, { ...store.summary(), sessions });
    }
    case "GET /events": {
      const after = url.searchParams.get("after");
      return ok(200, store.eventsAfter(after === null ? 0 : AfterSchema.parse(after)));
    }
    case "POST /pins": {
      const input = PinInputSchema.parse(await readJson(req));
      return ok(201, store.createPin(input, opts.enrichEnv?.() ?? {}));
    }
    case "GET /pins": {
      const search = url.searchParams.get("search");
      if (search !== null) return ok(200, store.searchPins(search));
      const status = url.searchParams.get("status");
      const filter = status === null ? undefined : { status: StatusFilterSchema.parse(status) };
      return ok(200, store.listPins(filter));
    }
    default:
      return null;
  }
}

// /pins/:id and its sub-resources.
async function routePinItem(req: Request, url: URL, opts: HubOptions): Promise<Response | null> {
  const { store } = opts;
  const { method } = req;
  const path = url.pathname;

  const pinId = match(path, /^\/pins\/([a-z0-9_]+)$/);
  if (pinId !== null && method === "GET") return ok(200, mustGetPin(store, pinId));

  const threadPinId = match(path, /^\/pins\/([a-z0-9_]+)\/thread$/);
  if (threadPinId !== null && method === "GET") {
    mustGetPin(store, threadPinId);
    return ok(200, store.getThread(threadPinId));
  }
  if (threadPinId !== null && method === "POST") {
    const body = ThreadPostSchema.parse(await readJson(req));
    const messageOpts = {
      ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
      ...(body.origin === undefined ? {} : { origin: body.origin }),
      ...(body.edit === undefined ? {} : { edit: body.edit }),
    };
    const hasOpts = Object.keys(messageOpts).length > 0;
    return ok(
      201,
      store.addThreadMessage(threadPinId, body.role, body.text, hasOpts ? messageOpts : undefined),
    );
  }

  const resolvePinId = match(path, /^\/pins\/([a-z0-9_]+)\/resolve$/);
  if (resolvePinId !== null && method === "POST") {
    const body = ResolvePostSchema.parse(await readJson(req));
    return ok(200, store.resolvePin(resolvePinId, body.by, body.note, body.commit));
  }

  return null;
}

function match(path: string, pattern: RegExp): string | null {
  return pattern.exec(path)?.[1] ?? null;
}

function mustGetPin(store: PinStore, id: string) {
  const pin = store.getPin(id);
  if (!pin) throw new NotFoundError(`pin not found: ${id}`);
  return pin;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BodyNotJsonError();
  }
}

class BodyNotJsonError extends Error {}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ok(status: number, data: unknown): Response {
  return json(status, { ok: true, data });
}

function err(
  status: number,
  code: HubErrorCode,
  message: string,
  extra?: { hint?: string },
): Response {
  const hint = extra?.hint;
  return json(status, {
    ok: false,
    error: hint === undefined ? { code, message } : { code, message, hint },
  });
}

function mapError(cause: unknown): Response {
  if (cause instanceof NotFoundError) return err(404, "E_NOT_FOUND", cause.message);
  if (cause instanceof ConflictError) return err(409, "E_CONFLICT", cause.message);
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    const message = issue
      ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`
      : "invalid input";
    return err(400, "E_INVALID_INPUT", message);
  }
  if (cause instanceof BodyNotJsonError) {
    return err(400, "E_INVALID_INPUT", "request body is not valid JSON", {
      hint: "send a JSON body with content-type: application/json",
    });
  }
  return err(500, "E_INTERNAL", cause instanceof Error ? cause.message : "unexpected error");
}

export type { HubErrorCode }; // renamed from file-local ErrorCode; final §9 union minus E_HUB_UNREACHABLE
// Response kit for route modules.
export { BodyNotJsonError, err, match, mustGetPin, ok, readJson };
