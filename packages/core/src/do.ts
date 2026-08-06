// @autono/pinbox-core/do — the Durable Object: hub + Broadcaster + cloud attachments.
// The ./do export, consumed by the CLI's templates/worker. Executes on workerd ONLY:
// NO Bun globals, NO node: imports, NO cloudflare:workers import (a plain class with
// fetch/webSocketMessage/webSocketClose/alarm hibernates fine; the RPC base class is
// not needed). Types come module-form from @cloudflare/workers-types — never ambient
// globals (they clash with @types/bun).
import type {
  WebSocketRequestResponsePair as AutoResponsePair,
  WebSocket as DoWebSocket,
  DurableObjectState,
  R2Bucket,
} from "@cloudflare/workers-types";
import { verifyJwt } from "./auth/jwt.ts";
import { verifyNone, verifyToken } from "./auth/verify.ts";
import { type DoPinStore, openDoStore } from "./do-store.ts";
import { createHubHandler, err, type Identity, ok, type VerifyFn } from "./hub.ts";
import { newId } from "./id.ts";
import { presignR2Put } from "./r2.ts";
import { AttachmentSchema } from "./schema.ts";
import type { Broadcaster } from "./ws.ts";
import {
  ClientHelloSchema,
  encodeWsEvent,
  WS_CLOSE_PROTOCOL,
  WS_CLOSE_UNAUTHORIZED,
  WS_MIN_PROTOCOL,
  WS_PATH,
  WS_PROTOCOL_VERSION,
  WS_TOKEN_SUBPROTOCOL_PREFIX,
} from "./ws-protocol.ts";

// workerd globals the module uses at runtime; declared module-locally because ambient
// workers globals are off-limits (see header). Present wherever this module can run.
declare const WebSocketPair: new () => { 0: DoWebSocket; 1: DoWebSocket };
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => AutoResponsePair;

export type PinboxDoEnv = {
  PINBOX_TOKEN?: string; // token strategy secret
  AUTH_STRATEGY?: "none" | "token" | "jwt"; // default "token"; "none" requires ALLOW_UNAUTHENTICATED=1
  ALLOW_UNAUTHENTICATED?: string;
  JWT_ISSUER?: string;
  JWT_JWKS_URL?: string;
  JWT_AUDIENCE?: string;
  MEDIA?: R2Bucket; // attachments bucket binding (GET path)
  R2_ACCOUNT_ID?: string; // presign path (PUT) — S3 API credentials
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function overCap(): Response {
  return err(413, "E_ATTACHMENT", "attachment exceeds the 5 MB cap", {
    hint: "downscale the capture; attachments carry a path or URL, never inline bytes",
  });
}

// Kind validation + the cheap half of the cap for POST /attachments; null means the
// request is admissible so far. A declared content-length over the cap is refused before
// a byte is read — but a *missing* or understated one proves nothing, so this is only
// the fast path. measureBody() below is what actually enforces the limit.
function attachmentInputError(req: Request, url: URL): Response | null {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isFinite(declaredBytes) || declaredBytes > MAX_ATTACHMENT_BYTES) return overCap();
  }
  const kind = url.searchParams.get("kind") ?? "file";
  if (kind !== "screenshot" && kind !== "file") {
    return err(400, "E_INVALID_INPUT", `unknown attachment kind: ${kind}`, {
      hint: "use ?kind=screenshot or ?kind=file",
    });
  }
  return null;
}

// Count the request body as it streams, aborting the read the moment the running total
// crosses the cap; null means "over". Nothing is buffered — the chunks are measured and
// dropped — so a hostile 5 GB upload costs the DO a few kilobytes of window, not memory.
// This is the half that survives a chunked request carrying no content-length at all.
async function measureBody(req: Request, cap: number): Promise<number | null> {
  const body = req.body;
  if (body === null) return 0;
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel("attachment exceeds the 5 MB cap");
        return null;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// The presign path needs the S3 API credentials — the MEDIA binding cannot presign.
function r2Credentials(
  env: PinboxDoEnv,
): Pick<
  Parameters<typeof presignR2Put>[0],
  "accountId" | "bucket" | "accessKeyId" | "secretAccessKey"
> | null {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

// Auth strategy assembly from env (default token). Misconfiguration is a loud 500 on
// every request — "no unauthenticated writes in any configuration" (template README rule).
type AuthStrategy = { verify: VerifyFn } | { error: string; hint: string };

function buildStrategy(env: PinboxDoEnv): AuthStrategy {
  const strategy = env.AUTH_STRATEGY ?? "token";
  if (strategy === "none") {
    if (env.ALLOW_UNAUTHENTICATED !== "1") {
      return {
        error: 'AUTH_STRATEGY "none" refused',
        hint: "set ALLOW_UNAUTHENTICATED=1 to explicitly run an unauthenticated hub (loopback/dev only)",
      };
    }
    return { verify: verifyNone() };
  }
  if (strategy === "jwt") {
    const { JWT_ISSUER, JWT_JWKS_URL, JWT_AUDIENCE } = env;
    if (!JWT_ISSUER || !JWT_JWKS_URL || !JWT_AUDIENCE) {
      return {
        error: 'AUTH_STRATEGY "jwt" is missing configuration',
        hint: "set JWT_ISSUER, JWT_JWKS_URL, and JWT_AUDIENCE",
      };
    }
    return {
      verify: verifyJwt({ issuer: JWT_ISSUER, jwksUrl: JWT_JWKS_URL, audience: JWT_AUDIENCE }),
    };
  }
  if (!env.PINBOX_TOKEN) {
    return {
      error: 'AUTH_STRATEGY "token" has no PINBOX_TOKEN',
      hint: "set the PINBOX_TOKEN secret (wrangler secret put PINBOX_TOKEN)",
    };
  }
  return { verify: verifyToken(env.PINBOX_TOKEN) };
}

// A misconfigured strategy refuses everything — "no unauthenticated writes in any
// configuration" — but the refusal has to stay legible. GET /health is the one tokenless
// route and the only thing a monitor can reach here, so it answers 503 with
// the actual reason: a live-but-misconfigured DO is a different problem from a dead one,
// and a blanket 500 on every route made the two indistinguishable. Every other route
// keeps the loud 500 — the refusal itself does not soften.
function refuse(req: Request, url: URL, strategy: { error: string; hint: string }): Response {
  if (req.method === "GET" && url.pathname === "/health") {
    return err(503, "E_INTERNAL", `hub is unhealthy: ${strategy.error}`, { hint: strategy.hint });
  }
  return err(500, "E_INTERNAL", strategy.error, { hint: strategy.hint });
}

// DO impl: enumerate sockets by tag, send to every one — always the full
// topic including the originating socket (the cursor-echo rule; sender-exclusion is
// deliberately inexpressible). Per-connection state rides serializeAttachment, never a
// memory map — hibernation evicts memory.
export class DoBroadcaster implements Broadcaster {
  constructor(private readonly state: DurableObjectState) {}

  publish(topic: string, data: string): void {
    for (const ws of this.state.getWebSockets(topic)) {
      try {
        ws.send(data);
      } catch {
        // a socket torn down mid-iteration must not break the fan-out
      }
    }
  }

  subscriberCount(topic: string): number {
    return this.state.getWebSockets(topic).length; // feeds `connectedToolbars` — sockets, not humans
  }
}

export class PinboxHubDO {
  readonly store: DoPinStore;
  readonly broadcaster: DoBroadcaster;
  readonly topic: string;

  private readonly ctx: DurableObjectState;
  private readonly env: PinboxDoEnv;
  private readonly strategy: AuthStrategy;
  private readonly handler: (req: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: PinboxDoEnv) {
    this.ctx = ctx;
    this.env = env;
    this.store = openDoStore(ctx.storage.sql, ctx.storage);
    this.topic = `project:${ctx.id.name ?? ctx.id.toString()}`;
    this.broadcaster = new DoBroadcaster(ctx);
    this.strategy = buildStrategy(env);
    this.handler = createHubHandler({
      store: this.store,
      token: env.PINBOX_TOKEN ?? "",
      ...("verify" in this.strategy ? { verify: this.strategy.verify } : {}),
    });
    // Wiring rule: exactly one store.subscribe listener feeds the Broadcaster;
    // the hub handler never touches it. (The second listener — router.dispatch — awaits
    // a cloud adapter set, not the router itself; see alarm() below.)
    this.store.subscribe((event) => this.broadcaster.publish(this.topic, encodeWsEvent(event)));
    // Keepalive is transport-level: no ping message exists at
    // protocol 1; hibernated sockets answer without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // /ws upgrade + /attachments + /media/:key intercepts, else the shared hub handler.
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if ("error" in this.strategy) return refuse(req, url, this.strategy);
    const verify = this.strategy.verify;
    if (url.pathname === WS_PATH) return this.upgrade(req, url, verify);
    return (await this.intercept(req, url, verify)) ?? this.handler(req);
  }

  // Host-level intercepts, exactly like /ws: HubOptions is
  // frozen and routes-toolbar.ts is shared, so the cloud attachment surface mounts
  // here, behind the same auth gate the handler applies. Null falls through to the hub.
  private async intercept(req: Request, url: URL, verify: VerifyFn): Promise<Response | null> {
    if (req.method === "POST" && url.pathname === "/attachments") {
      return (await this.unauthorized(verify, req)) ?? this.createAttachment(req, url);
    }
    const mediaKey = /^\/media\/([^/]+)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && mediaKey !== undefined) {
      return (await this.unauthorized(verify, req)) ?? this.serveMedia(mediaKey);
    }
    return null;
  }

  // hello → catch-up (ws-protocol.ts, reused unchanged). Pinned-sync signature.
  webSocketMessage(ws: DoWebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      this.protocolError(ws, "binary frames are not part of protocol 1");
      return;
    }
    if (ws.deserializeAttachment() !== null) {
      this.protocolError(ws, "protocol 1 has exactly one client message: hello");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.protocolError(ws, "hello frame is not valid JSON");
      return;
    }
    const hello = ClientHelloSchema.safeParse(raw);
    if (!hello.success) {
      this.protocolError(ws, "malformed hello frame");
      return;
    }
    if (hello.data.protocol < WS_MIN_PROTOCOL) {
      this.protocolError(
        ws,
        `protocol ${hello.data.protocol} is below the minimum ${WS_MIN_PROTOCOL} — upgrade the client`,
      );
      return;
    }
    ws.serializeAttachment({ consumerId: hello.data.consumerId }); // 16 KB cap; hibernation-safe
    this.store.cursors.set(hello.data.consumerId, hello.data.lastSeq); // diagnostics snapshot (§12.2)
    ws.send(
      JSON.stringify({
        type: "catch-up",
        protocol: WS_PROTOCOL_VERSION,
        minProtocol: WS_MIN_PROTOCOL,
        lastSeq: this.store.summary().lastEventSeq,
        events: this.store.eventsAfter(hello.data.lastSeq).map((event) => ({
          type: "event",
          seq: event.seq,
          eventType: event.type,
          at: event.at,
          payload: event.payload,
        })),
      }),
    );
  }

  webSocketClose(_ws: DoWebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Nothing to clean up: per-connection state rides the socket's attachment and the
    // runtime forgets closed sockets; cursors are durable diagnostics, not liveness.
  }

  async alarm(): Promise<void> {
    // Still a no-op, and no longer for the reason originally written here: the
    // DeliveryRouter HAS merged (delivery/router.ts, workers-safe by construction).
    // What is missing is the cloud adapter set — [webhook] needs its
    // endpoint/secret configuration surfaced through PinboxDoEnv, which is a contract
    // decision, not wiring. Until an adapter exists no dispatch listener is registered,
    // so no delivery row is ever enqueued and there is nothing to drain. When one does:
    // `await router.drainDue()` here + reschedule via ctx.storage.setAlarm while pending
    // rows remain (deep-dive §1.14 — DO alarms, never cron).
  }

  private async upgrade(req: Request, url: URL, verify: VerifyFn): Promise<Response> {
    // Token from `Sec-WebSocket-Protocol: pinbox.token.<token>` or `?token=`
    // — browsers cannot set headers on an upgrade. Auth happens at upgrade only (§5
    // rule 5); the accepted subprotocol is echoed so browser clients complete the
    // handshake.
    let token = url.searchParams.get("token");
    let acceptedProtocol: string | undefined;
    for (const entry of (req.headers.get("sec-websocket-protocol") ?? "").split(",")) {
      const candidate = entry.trim();
      if (candidate.startsWith(WS_TOKEN_SUBPROTOCOL_PREFIX)) {
        token = candidate.slice(WS_TOKEN_SUBPROTOCOL_PREFIX.length);
        acceptedProtocol = candidate;
      }
    }
    // Always let the configured strategy decide — a tokenless upgrade must pass under
    // verifyNone (strategy parity with REST); verifyToken/verifyJwt reject it themselves.
    const identity = await verify(
      new Request(
        url.origin,
        token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
      ),
    );
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (identity === null) {
      // The 101 must complete for the close code to reach the client — accept the
      // server end outside hibernation and close it 4401.
      server.accept();
      server.close(WS_CLOSE_UNAUTHORIZED, "missing or invalid token");
    } else {
      this.ctx.acceptWebSocket(server, [this.topic]); // topics fixed at accept: project:<id>
    }
    const headers =
      acceptedProtocol === undefined ? {} : { "sec-websocket-protocol": acceptedProtocol };
    return new Response(null, {
      status: 101,
      headers,
      webSocket: client,
    } as unknown as ResponseInit);
  }

  private protocolError(ws: DoWebSocket, message: string): void {
    ws.send(JSON.stringify({ type: "error", code: "E_WS_PROTOCOL", message }));
    ws.close(WS_CLOSE_PROTOCOL, message.slice(0, 123)); // close reasons cap at 123 bytes
  }

  private async unauthorized(verify: VerifyFn, req: Request): Promise<Response | null> {
    const identity: Identity | null = await verify(req);
    if (identity !== null) return null;
    return err(401, "E_AUTH", "request rejected by the configured verifier", {
      hint: "send a credential the hub's verify strategy accepts",
    });
  }

  // POST /attachments — cloud form: enforce the 5 MB cap, mint
  // the att id, and hand the browser a presigned R2 PUT; the bytes are never *stored* by
  // the DO. The cap is enforced by two mechanisms because one leg each is invisible to
  // the other:
  //   1. the request body is counted as it streams and the read aborted past the cap —
  //      this is what a chunked POST declaring no content-length can no longer dodge;
  //   2. the measured length is signed into the presigned PUT (`content-length` joins
  //      SignedHeaders), so R2 itself rejects an upload of any other size — including a
  //      chunked one — on the leg the DO never observes.
  // What neither covers: a client may PUT *different* 2 MB to the key it was granted,
  // and may replay that PUT until the URL expires. The cap is a size bound, not an
  // integrity or a rate bound; content addressing and per-project quotas are separate.
  private async createAttachment(req: Request, url: URL): Promise<Response> {
    const rejected = attachmentInputError(req, url);
    if (rejected !== null) return rejected;
    const creds = r2Credentials(this.env);
    if (creds === null) {
      return err(500, "E_INTERNAL", "R2 S3 credentials are not configured", {
        hint: "set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY — the R2 binding cannot presign",
      });
    }
    const contentLength = await measureBody(req, MAX_ATTACHMENT_BYTES);
    if (contentLength === null) return overCap();
    const id = newId("att");
    const kind = url.searchParams.get("kind") ?? "file";
    const contentType = req.headers.get("content-type") ?? "application/octet-stream";
    const uploadUrl = await presignR2Put({ ...creds, key: id, contentType, contentLength });
    const attachment = AttachmentSchema.parse({ id, kind, url: `/media/${id}`, contentType });
    return ok(201, { attachment, uploadUrl });
  }

  // GET /media/:key — reads stream from the MEDIA binding; no presign needed.
  private async serveMedia(key: string): Promise<Response> {
    const media = this.env.MEDIA;
    if (!media) {
      return err(500, "E_INTERNAL", "no MEDIA bucket binding", {
        hint: "bind an R2 bucket named MEDIA in wrangler.jsonc",
      });
    }
    const object = await media.get(key);
    if (object === null) return err(404, "E_NOT_FOUND", `media not found: ${key}`);
    return new Response(object.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      },
    });
  }
}
