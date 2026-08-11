// @autono/pinbox-mcp — live pin events, straight from the hub's WebSocket.
//
// Every other path in this package shells out to the CLI, because every other thing this server
// does is a request/response the CLI already answers. A live feed is not: the CLI answers once and
// exits, so there is no command to keep open. The hub already broadcasts every store change to
// attached sockets — this connects to that.
//
// Discovery duplicates the CLI's state-path rule rather than importing it: `mcp` may depend on
// `core` and not on `cli`. `e2e/` covers the pair against a real hub, which is where drift would
// actually show up.
import {
  WS_PATH,
  WS_PROTOCOL_VERSION,
  WS_TOKEN_SUBPROTOCOL_PREFIX,
} from "@autono/pinbox-core/ws-protocol";

export type HubEvent = {
  seq: number;
  eventType: "pin.created" | "pin.resolved" | "thread.message" | "pin.verified" | "pin.linked";
  payload: unknown;
};

type HubState = { port: number; token: string };

/** Symlink-free path, so `/tmp` and `/private/tmp` resolve to the same project. */
function physicalPath(dir: string): string {
  try {
    const result = Bun.spawnSync(["pwd", "-P"], { cwd: dir });
    if (!result.success) return dir;
    return result.stdout.toString().trim() || dir;
  } catch {
    return dir;
  }
}

function stateHome(): string | null {
  return process.env["XDG_STATE_HOME"] || process.env["HOME"]?.concat("/.local/state") || null;
}

/** Where `pinbox serve` writes the port and bearer token for this project. */
export function hubStateFile(projectDir: string): string | null {
  const home = stateHome();
  if (home === null) return null;
  const id = new Bun.CryptoHasher("sha256")
    .update(physicalPath(projectDir))
    .digest("hex")
    .slice(0, 12);
  return `${home}/pinbox/${id}/hub.json`;
}

/** null whenever the hub is not running, or its state file is unreadable or malformed. */
async function readHubState(projectDir: string): Promise<HubState | null> {
  const file = hubStateFile(projectDir);
  if (file === null) return null;
  try {
    const raw: unknown = await Bun.file(file).json();
    if (typeof raw !== "object" || raw === null) return null;
    const { port, token } = raw as Record<string, unknown>;
    if (typeof port !== "number" || typeof token !== "string") return null;
    return { port, token };
  } catch {
    return null;
  }
}

type Frame = { type?: string; seq?: number; lastSeq?: number; at?: string; events?: unknown[] };

/** Mutable position: the cursor we replay from, and whether the first catch-up has been handled. */
type Cursor = { lastSeq: number; primed: boolean };

function isEvent(value: unknown): value is HubEvent & { type: string; at?: string } {
  const frame = value as Frame;
  return frame?.type === "event" && typeof frame.seq === "number";
}

/**
 * The events a frame should deliver, advancing `cursor`.
 *
 * The first catch-up is the whole history, because our cursor starts at zero. Delivering it would
 * announce every pin ever created; skipping it wholesale would swallow pins created while the hub
 * was still starting up — which is the common case, since the first tool call is what launches it.
 * So the cut is `startedAt`: what happened since watching began, and nothing older.
 */
export function eventsToDeliver(frame: Frame, cursor: Cursor, startedAt: string): HubEvent[] {
  const catchUp = frame.type === "catch-up";
  if (catchUp && typeof frame.lastSeq === "number") cursor.lastSeq = frame.lastSeq;

  const candidates = (catchUp ? (frame.events ?? []) : [frame]).filter(isEvent);
  const fresh =
    catchUp && !cursor.primed
      ? candidates.filter((event) => (event.at ?? "") >= startedAt)
      : candidates;
  if (catchUp) cursor.primed = true;

  for (const event of fresh) cursor.lastSeq = Math.max(cursor.lastSeq, event.seq);
  return fresh;
}

/**
 * Hold a socket to the hub and call `onEvent` for each change, reconnecting for as long as the
 * server lives. Nothing here throws into the caller: a hub that is down must not take the MCP
 * server with it, because every tool still works without this.
 */
export function watchHub(opts: {
  projectDir: string;
  onEvent: (event: HubEvent) => void;
  onError?: (error: Error) => void;
}): { close: () => void } {
  const cursor: Cursor = { lastSeq: 0, primed: false };
  const startedAt = new Date().toISOString();
  const consumerId = `pinbox-mcp-${Bun.randomUUIDv7()}`;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let backoffMs = 250;

  const reconnect = (): void => {
    if (closed) return;
    retry = setTimeout(connect, backoffMs);
    retry.unref?.();
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };

  const attach = (state: HubState): void => {
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}${WS_PATH}`, [
      `${WS_TOKEN_SUBPROTOCOL_PREFIX}${state.token}`,
    ]);
    socket = ws;
    ws.addEventListener("open", () => {
      backoffMs = 250;
      const hello = {
        type: "hello",
        protocol: WS_PROTOCOL_VERSION,
        consumerId,
        lastSeq: cursor.lastSeq,
      };
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener("message", (message) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(message.data)) as Frame;
      } catch {
        return;
      }
      for (const event of eventsToDeliver(frame, cursor, startedAt)) opts.onEvent(event);
    });
    ws.addEventListener("error", () => opts.onError?.(new Error("pinbox hub socket error")));
    ws.addEventListener("close", reconnect);
  };

  function connect(): void {
    if (closed) return;
    void readHubState(opts.projectDir).then((state) => {
      if (closed) return;
      // No hub yet is the normal case at startup — the first tool call starts one.
      if (state === null) return reconnect();
      attach(state);
    });
  }

  connect();
  return {
    close: () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    },
  };
}
