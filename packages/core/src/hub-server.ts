// @autono/pinbox-core — local hub server.
// Thin Bun.serve wrapper around the fetch-style handler (hub.ts): loopback bind only,
// ephemeral port by default, and an idle timer that stops the server after idleMs with
// no requests and no attached sockets. Exit is the caller's choice: startHubServer
// resolves close(); the `serve` CLI entry calls process.exit after close. With the
// server stopped and the timer unref'd, a standalone process drains its event loop and
// exits 0 on its own.
//
// The realtime host layer is enabled by `realtime` (absent ⇒ plain request/response
// behavior). GET /ws is intercepted BEFORE the pure handler: the handler
// keeps its one-argument invariant and its bearer gate untouched — browsers cannot set
// headers on an upgrade, so the token rides `Sec-WebSocket-Protocol: pinbox.token.<t>`
// or `?token=`. The host also owns the loopback-origin CORS layer and the /summary
// `connectedToolbars` merge (host-level because HubOptions is pinned final; the DO
// host mirrors this in do.ts).
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { createHubHandler, type HubOptions } from "./hub.ts";
import type { PinStore } from "./store.ts";
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

// Re-exported for the CLI serve path: sink registration must ride an existing subpath
// because the package export map is final and has no "./attachments" entry.
export { registerAttachmentSink } from "./attachments.ts";
// localDirSink is Bun-only (Bun.write) and lives apart so the DO bundle never sees it.
export { localDirSink } from "./attachments-local.ts";
// Re-exported so gitEnv ships on the "./hub-server" subpath (the CLI's `serve`
// entry consumes both from here) and stays inside fallow's entry-reachable set.
export { gitEnv } from "./git-env.ts";

const DEFAULT_IDLE_MS = 30 * 60_000;
// Exactly one hello, within 5s of connect, before anything else.
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
// ws.send return <= 0 means undelivered; close 1013 and let the client
// replay from its cursor. Enabled only because cursor replay ships first.
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

type WsData = {
  authorized: boolean;
  helloDone: boolean;
  helloTimer: ReturnType<typeof setTimeout> | undefined;
};

// `server.pendingWebSockets` would be the obvious idle-exit gate, but Bun
// 1.3.14 never decrements that counter after a SERVER-initiated ws.close (measured:
// scratchpad repro — close cb fires, client sees the code, counter stays 1 forever and
// server.stop(true)'s promise never resolves). One 4401 would wedge idle-exit for the
// daemon's lifetime, so the host keeps its own balanced open/close count instead.
type SocketCounter = { count: number };

export type RealtimeOptions = {
  projectId: string; // topic is fixed at connect, always `project:<id>`
  /** Test override for the 5s hello deadline. */
  helloTimeoutMs?: number;
};

export function startHubServer(
  opts: HubOptions & { port?: number; idleMs?: number; realtime?: RealtimeOptions },
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const handler = createHubHandler(opts);
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const { realtime } = opts;
  const topic = `project:${realtime?.projectId ?? ""}`;

  const sockets: SocketCounter = { count: 0 };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touchIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Never idle-exit while sockets are attached (own counter
      // instead of the leaking server.pendingWebSockets — see SocketCounter above).
      if (sockets.count > 0) {
        touchIdleTimer();
        return;
      }
      void close();
    }, idleMs);
    // unref: the idle timer must never by itself keep the process alive.
    idleTimer.unref();
  };

  // Bun's `idleTimeout` is a TOTAL request deadline, not an idle one. Small JSON bodies
  // never approach it; the long-lived WS upgrade calls `server.timeout(req, 0)`.
  const server = Bun.serve({
    hostname: "127.0.0.1", // loopback only — the hub is never exposed on external interfaces
    port: opts.port ?? 0,
    fetch: (req, srv) => {
      touchIdleTimer();
      if (!realtime) return handler(req);
      return realtimeFetch(req, srv, handler, opts.token, topic);
    },
    websocket: wsHandlers(
      opts.store,
      topic,
      realtime?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
      sockets,
    ),
  });

  // The ONE host-registered listener: events reach sockets only
  // through store.subscribe → Broadcaster.publish; the hub handler never touches it.
  // Always server.publish, never ws.publish — ws.publish excludes the sender, stalling
  // the originating toolbar's cursor so it replays its own actions on reconnect.
  const broadcaster: Broadcaster = {
    publish: (t, d) => void server.publish(t, d),
    subscriberCount: (t) => server.subscriberCount(t),
  };
  const unsubscribe = realtime
    ? opts.store.subscribe((event) => broadcaster.publish(topic, encodeWsEvent(event)))
    : undefined;

  const close = async () => {
    clearTimeout(idleTimer);
    unsubscribe?.();
    // stop(true) closes the listener synchronously and tears down active sockets, but
    // its promise never resolves once a server-initiated ws.close leaked the internal
    // connection count (same Bun 1.3.14 bug as SocketCounter) — don't hang on it.
    await Promise.race([server.stop(true), Bun.sleep(50)]);
  };

  const { port } = server;
  // `server.port` is undefined only for unix-socket binds, which this server never uses.
  if (port === undefined) throw new Error("hub server bound without a TCP port");

  touchIdleTimer();
  return Promise.resolve({ port, url: server.url.href, close });
}

// Host layer in front of the pure handler: WS upgrade, CORS, /summary merge.
async function realtimeFetch(
  req: Request,
  server: Server<WsData>,
  handler: (req: Request) => Promise<Response>,
  token: string,
  topic: string,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname === WS_PATH) return upgradeWs(req, url, server, token);
  const origin = req.headers.get("origin");
  const gated = corsGate(req, origin);
  if (gated !== null) return gated;
  let res = await handler(req);
  if (req.method === "GET" && url.pathname === "/summary" && res.status === 200) {
    res = await withConnectedToolbars(res, server.subscriberCount(topic));
  }
  return origin === null ? res : withAllowOrigin(res, origin);
}

// Static loopback allowlist; non-loopback origins get 403 with NO CORS headers
// (a static allowlist; learn-and-pin for other origins is deliberately not implemented).
function corsGate(req: Request, origin: string | null): Response | null {
  if (origin === null) return null;
  if (!isLoopbackOrigin(origin)) return new Response(null, { status: 403 });
  if (req.method === "OPTIONS") return preflight(origin);
  return null;
}

function upgradeWs(
  req: Request,
  url: URL,
  server: Server<WsData>,
  token: string,
): Response | undefined {
  const requested = req.headers.get("sec-websocket-protocol");
  const entry = (requested ?? "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith(WS_TOKEN_SUBPROTOCOL_PREFIX));
  const presented =
    entry?.slice(WS_TOKEN_SUBPROTOCOL_PREFIX.length) ?? url.searchParams.get("token");
  const data: WsData = { authorized: presented === token, helloDone: false, helloTimer: undefined };
  // The upgrade is long-lived: idleTimeout is a total request deadline in Bun.
  server.timeout(req, 0);
  // Echo the requested subprotocol (browsers drop the connection when the selected
  // subprotocol is not echoed). Unauthorized sockets are accepted, then closed 4401 in
  // open — a close code needs an accepted socket.
  const upgraded = server.upgrade(req, {
    data,
    ...(entry === undefined ? {} : { headers: { "sec-websocket-protocol": entry } }),
  });
  return upgraded ? undefined : new Response("websocket upgrade failed", { status: 400 });
}

function wsHandlers(
  store: PinStore,
  topic: string,
  helloTimeoutMs: number,
  sockets: SocketCounter,
): WebSocketHandler<WsData> {
  return {
    sendPings: true, // keepalive is transport-level; no ping message exists at protocol 1
    backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
    closeOnBackpressureLimit: true, // close 1013; the client replays from its cursor
    open(ws) {
      sockets.count += 1;
      if (!ws.data.authorized) {
        ws.close(WS_CLOSE_UNAUTHORIZED, "missing or invalid token");
        return;
      }
      ws.subscribe(topic);
      ws.data.helloTimer = setTimeout(() => {
        ws.close(WS_CLOSE_PROTOCOL, "no hello within deadline");
      }, helloTimeoutMs);
    },
    message(ws, raw) {
      onWsMessage(store, ws, raw);
    },
    close(ws) {
      sockets.count -= 1;
      clearTimeout(ws.data.helloTimer);
    },
  };
}

// Protocol 1 has exactly one client message: the hello. Reply catch-up from the
// append-only log, snapshot the cursor (diagnostics only), and treat
// every later client frame as a protocol violation.
function onWsMessage(store: PinStore, ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  if (ws.data.helloDone) {
    ws.send(errorFrame("unexpected client frame: no client messages exist after hello"));
    return;
  }
  const hello = parseHello(raw);
  if (hello === null) {
    ws.send(errorFrame("malformed hello"));
    ws.close(WS_CLOSE_PROTOCOL, "malformed hello");
    return;
  }
  if (hello.protocol < WS_MIN_PROTOCOL) {
    ws.send(errorFrame(`protocol ${hello.protocol} below minimum ${WS_MIN_PROTOCOL}`));
    ws.close(WS_CLOSE_PROTOCOL, "protocol below minimum");
    return;
  }
  clearTimeout(ws.data.helloTimer);
  ws.data.helloDone = true;
  const events = store.eventsAfter(hello.lastSeq).map((event) => ({
    type: "event" as const,
    seq: event.seq,
    eventType: event.type,
    at: event.at,
    payload: event.payload,
  }));
  ws.send(
    JSON.stringify({
      type: "catch-up",
      protocol: WS_PROTOCOL_VERSION,
      minProtocol: WS_MIN_PROTOCOL,
      lastSeq: store.summary().lastEventSeq,
      events,
    }),
  );
  store.cursors.set(hello.consumerId, hello.lastSeq);
}

function parseHello(
  raw: string | Buffer,
): { protocol: number; consumerId: string; lastSeq: number } | null {
  try {
    const parsed = ClientHelloSchema.safeParse(JSON.parse(String(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function errorFrame(message: string): string {
  return JSON.stringify({ type: "error", code: "E_WS_PROTOCOL", message });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      vary: "origin",
    },
  });
}

function withAllowOrigin(res: Response, origin: string): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  return new Response(res.body, { status: res.status, headers });
}

// summary's `connectedToolbars` counts sockets, not humans. Merged
// host-level: HubOptions is pinned final, so the pure handler cannot carry the count.
async function withConnectedToolbars(res: Response, connectedToolbars: number): Promise<Response> {
  const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
  body.data["connectedToolbars"] = connectedToolbars;
  return new Response(JSON.stringify(body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
