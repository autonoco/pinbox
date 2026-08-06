// e2e — the toolbar against a real hub, over a real WebSocket.
// Drives the REAL stack from source: `pinbox serve` spawned as its own process
// (`bun packages/cli/src/main.ts serve --project <tmp>`, XDG_STATE_HOME redirected,
// PINBOX_IDLE_MS raised — the loop.test.ts pattern) and the REAL
// `HubTransport` from packages/toolbar/src/transport.ts. The transport is browser
// code by construction — WebSocket, fetch, Storage — so Bun runs it unmodified; the
// only injected seams are the ones the transport already declares for tests
// (`storage`, `scheduler`, `webSocket`), never a reimplementation of its logic.
// What this file is uniquely positioned to prove: the toolbar's mirrored §5 wire
// constants still match the core server's, the originator receives its own event
// (the `server.publish` rule), and the offline outbox reconciles against a hub that
// moved on without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { uploadAttachment } from "../packages/toolbar/src/screenshot.ts";
import { memoryStorage, type StorageLike } from "../packages/toolbar/src/transport/mirror.ts";
import {
  type ConnectionState,
  type HubEvent,
  HubTransport,
  type WebSocketLike,
} from "../packages/toolbar/src/transport.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const CLI = `${repoRoot}packages/cli/src/main.ts`;
// Wire-protocol literals, spelled out rather than imported: e2e is the one place
// that must fail if core and the toolbar ever drift from the pinned strings.
const WS_TOKEN_SUBPROTOCOL_PREFIX = "pinbox.token.";

type Envelope<T> = { ok: boolean; data: T; error?: { code: string; message: string } };
type HubStateFile = { pid: number; port: number; token: string };

let tmp = "";
let projectDir = "";
let stateHome = "";
let env: Record<string, string | undefined> = {};
let serve: Bun.Subprocess | undefined;
let hub: HubStateFile;
/** No trailing slash: the mirror namespaces its localStorage keys by this exact string. */
let endpoint = "";

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  projectDir = `${tmp}/project`;
  stateHome = `${tmp}/state`;
  env = {
    ...process.env,
    HOME: `${tmp}/home`,
    XDG_STATE_HOME: stateHome,
    PINBOX_IDLE_MS: "60000",
  };
  await Bun.$`mkdir -p ${projectDir} ${`${tmp}/home`}`.quiet();
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir, env });

  serve = Bun.spawn([process.execPath, CLI, "serve", "--project", projectDir], {
    cwd: projectDir,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  hub = await poll(readHubState, "the hub state file written by `pinbox serve`", 20_000);
  endpoint = `http://127.0.0.1:${hub.port}`;
  const healthy = await waitFor(async () => (await fetch(`${endpoint}/health`)).ok, 10_000);
  expect(healthy, "hub never answered /health").toBe(true);
});

afterAll(async () => {
  if (serve !== undefined) {
    serve.kill("SIGTERM");
    await serve.exited;
  }
  if (tmp !== "") await Bun.$`rm -rf ${tmp}`.quiet();
});

test("round trip: create → own event, CLI resolve → pin.resolved, verify → pin.verified", async () => {
  const tb = new Toolbar();
  try {
    await tb.live();

    const pin = await tb.transport.createPin(pinInput("the CTA overflows on mobile"));
    expect(pin.id).toMatch(/^pin_[a-z0-9]{10}$/);
    // The originator receives its own event: the host publishes with server.publish,
    // never ws.publish (which would exclude the sender and stall its cursor).
    const created = await tb.event("pin.created", (p) => idOf(p) === pin.id);
    expect(created.seq).toBeGreaterThan(0);

    const resolved = await cli(["resolve", pin.id, "--note", "shipped a fix", "--json"]);
    expect(resolved.code, resolved.stderr).toBe(0);
    const resolveEnvelope = JSON.parse(resolved.stdout) as Envelope<{
      status: string;
      resolution?: { note?: string };
    }>;
    expect(resolveEnvelope.data.status).toBe("resolved");
    await tb.event("pin.resolved", (p) => idOf(p) === pin.id);

    const verified = await tb.transport.verify(pin.id, "accepted");
    expect(verified.verification?.outcome).toBe("accepted");
    await tb.event("pin.verified", (p) => idOf(p) === pin.id);

    const fetched = await hubGet<{ status: string; verification?: { outcome: string } }>(
      `/pins/${pin.id}`,
    );
    expect(fetched.verification?.outcome).toBe("accepted");
    expect(fetched.status).toBe("resolved"); // accepted keeps it resolved; reopened flips it
  } finally {
    tb.transport.close();
  }
}, 60_000);

test("offline reconcile: catch-up delivers the missed message, the outbox flushes", async () => {
  const tb = new Toolbar();
  try {
    await tb.live();
    const anchor = await tb.transport.createPin(pinInput("anchor pin for the offline window"));
    await tb.event("pin.created", (p) => idOf(p) === anchor.id);
    const cursorBefore = tb.cursor();
    expect(cursorBefore).toBeGreaterThan(0);
    const countBefore = (await tb.transport.listPins()).length;

    // Drop the socket without closing the transport: this is a network failure, not
    // a shutdown, so the transport schedules a reconnect (held by ManualScheduler).
    tb.dropSocket();
    const offline = await waitFor(() => tb.states.at(-1) === "offline", 10_000);
    expect(offline, `transport never went offline: ${tb.states.join(",")}`).toBe(true);

    // The hub moves on while the toolbar is away.
    const missed = await hubPost<{ id: string }>(`/pins/${anchor.id}/thread`, {
      role: "human",
      text: "posted while the toolbar was offline",
    });
    expect(missed.id).toMatch(/^msg_/);

    // A pin created offline queues in the outbox as an optimistic local pin.
    const queued = await tb.transport.createPin(pinInput("drawn while offline"));
    expect(tb.transport.outboxPins().map((p) => p.id)).toEqual([queued.id]);
    expect(tb.outbox.at(-1)).toEqual([queued.id]);

    tb.scheduler.runPending(); // the backoff timer fires: reconnect
    await waitFor(() => tb.states.at(-1) === "live", 10_000);

    // Catch-up replays exactly what was missed…
    const replayed = await tb.event("thread.message", (p) => pinIdOf(p) === anchor.id);
    expect((replayed.payload as { text: string }).text).toBe(
      "posted while the toolbar was offline",
    );
    // …and reconciliation flushes the outbox to the hub (client wins on new pins).
    const flushed = await waitFor(() => tb.transport.outboxPins().length === 0, 10_000);
    expect(flushed, "outbox never flushed after reconnect").toBe(true);
    expect(tb.outbox.at(-1)).toEqual([]);

    const pins = await tb.transport.listPins();
    expect(pins.length).toBe(countBefore + 1);
    expect(pins.some((p) => p.text === "drawn while offline")).toBe(true);
    expect(tb.cursor()).toBeGreaterThan(cursorBefore);
  } finally {
    tb.transport.close();
  }
}, 60_000);

test("min-protocol: hello below the floor errors then closes 4400; a bad token closes 4401", async () => {
  const socket = raw([`${WS_TOKEN_SUBPROTOCOL_PREFIX}${hub.token}`]);
  await socket.opened;
  socket.ws.send(JSON.stringify({ type: "hello", protocol: 0, consumerId: "e2e", lastSeq: 0 }));
  const frame = await poll(
    () => socket.frames.shift() as { type: string; code: string } | undefined,
    "the E_WS_PROTOCOL error frame",
  );
  expect(frame.type).toBe("error");
  expect(frame.code).toBe("E_WS_PROTOCOL");
  expect(await socket.closed).toBe(4400);

  const unauthorized = raw([`${WS_TOKEN_SUBPROTOCOL_PREFIX}not-the-token`]);
  expect(await unauthorized.closed).toBe(4401);
}, 30_000);

test("attachments: upload lands bytes under .pinbox/media and the pin carries the path", async () => {
  // A tiny real webp (RIFF header + VP8L payload) — the sink keys its extension off
  // the content type, and the bytes must survive the round trip untouched.
  const bytes = Uint8Array.fromBase64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");
  const attachment = await uploadAttachment(endpoint, hub.token, {
    blob: new Blob([bytes], { type: "image/webp" }),
    width: 16,
    height: 16,
  });
  expect(attachment.kind).toBe("screenshot");
  expect(attachment.id).toMatch(/^att_[a-z0-9]{10}$/);
  const { path } = attachment;
  if (path === undefined) throw new Error("local sink returned an attachment with no path");
  expect(path.startsWith(`${projectDir}/.pinbox/media/`)).toBe(true);
  expect(path.endsWith(".webp")).toBe(true);
  expect(await Bun.file(path).bytes()).toEqual(bytes);

  const tb = new Toolbar();
  try {
    await tb.live();
    const pin = await tb.transport.createPin({
      ...pinInput("the hero image is blurry"),
      attachments: [attachment],
    });
    const shown = await cli(["show", pin.id, "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    const envelope = JSON.parse(shown.stdout) as Envelope<{
      pin: { attachments?: { id: string; path?: string }[] };
    }>;
    expect(envelope.data.pin.attachments?.[0]?.id).toBe(attachment.id);
    expect(envelope.data.pin.attachments?.[0]?.path).toBe(path);
  } finally {
    tb.transport.close();
  }
}, 60_000);

test("summary connectedToolbars counts live sockets, and drops back to 0 on close", async () => {
  const drained = await waitFor(async () => (await connectedToolbars()) === 0, 10_000);
  expect(drained, "sockets from earlier tests never drained").toBe(true);

  const tb = new Toolbar();
  try {
    await tb.live();
    expect(await connectedToolbars()).toBe(1);
  } finally {
    tb.transport.close();
  }
  const back = await waitFor(async () => (await connectedToolbars()) === 0, 10_000);
  expect(back, "connectedToolbars never returned to 0 after close").toBe(true);
}, 30_000);

// ── harness ──

/** Holds the transport's scheduled reconnect so the offline window is deterministic. */
class ManualScheduler {
  readonly #pending = new Map<number, () => void>();
  #next = 1;

  setTimeout(fn: () => void): number {
    const id = this.#next++;
    this.#pending.set(id, fn);
    return id;
  }

  clearTimeout(id: unknown): void {
    this.#pending.delete(id as number);
  }

  runPending(): void {
    const fns = [...this.#pending.values()];
    this.#pending.clear();
    for (const fn of fns) fn();
  }
}

/** One toolbar install: the real transport plus the observations a test asserts on. */
class Toolbar {
  readonly events: HubEvent[] = [];
  readonly states: ConnectionState[] = [];
  readonly outbox: string[][] = [];
  readonly scheduler = new ManualScheduler();
  readonly transport: HubTransport;

  readonly #storage: StorageLike = memoryStorage();
  #socket: WebSocketLike | null = null;

  constructor() {
    this.transport = new HubTransport({
      endpoint,
      token: hub.token,
      storage: this.#storage,
      scheduler: this.scheduler,
      webSocket: (url, protocols) => {
        const ws = new WebSocket(url, protocols) as unknown as WebSocketLike;
        this.#socket = ws;
        return ws;
      },
      onEvent: (e) => void this.events.push(e),
      onConnection: (s) => void this.states.push(s),
      onOutbox: (ids) => void this.outbox.push(ids),
    });
  }

  async live(): Promise<void> {
    this.transport.connect();
    const up = await waitFor(() => this.states.at(-1) === "live", 15_000);
    expect(up, `transport never reached live: ${this.states.join(",")}`).toBe(true);
  }

  /** A network drop, not a shutdown: 4400 is the one code the transport treats specially. */
  dropSocket(): void {
    this.#socket?.close(4000, "e2e: simulated network drop");
  }

  event(eventType: string, match: (payload: unknown) => boolean): Promise<HubEvent> {
    return poll(
      () => this.events.find((e) => e.eventType === eventType && match(e.payload)),
      `a ${eventType} event`,
    );
  }

  /** The mirror's persisted replay cursor, read back out of its own storage. */
  cursor(): number {
    return Number(this.#storage.getItem(`pinbox:${endpoint}:cursor`) ?? "0");
  }
}

// ── helpers ──

function pinInput(text: string) {
  return {
    text,
    kind: "note" as const,
    target: {
      url: "http://localhost:5173/",
      selector: "main > button.cta",
      tag: "button",
      rect: { x: 120, y: 480, width: 200, height: 48 },
      fixed: false,
    },
    env: {
      viewport: { w: 1440, h: 900, dpr: 2 },
      browser: "Chrome 130",
      os: "macOS",
      colorScheme: "light" as const,
    },
    author: { userId: "bobak" },
  };
}

function idOf(payload: unknown): string | undefined {
  return (payload as { id?: string } | null)?.id;
}

function pinIdOf(payload: unknown): string | undefined {
  return (payload as { pinId?: string } | null)?.pinId;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.ok !== true) {
    throw new Error(`hub ${res.status}: ${body.error?.code} ${body.error?.message}`);
  }
  return body.data;
}

function hubGet<T>(path: string): Promise<T> {
  return fetch(`${endpoint}${path}`, {
    headers: { authorization: `Bearer ${hub.token}` },
  }).then(unwrap<T>);
}

function hubPost<T>(path: string, body: unknown): Promise<T> {
  return fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(unwrap<T>);
}

async function connectedToolbars(): Promise<number> {
  return (await hubGet<{ connectedToolbars: number }>("/summary")).connectedToolbars;
}

/** A bare WebSocket for the protocol-level assertions the transport never makes. */
function raw(protocols: string[]): {
  ws: WebSocket;
  frames: unknown[];
  opened: Promise<void>;
  closed: Promise<number>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`, protocols);
  const frames: unknown[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(String((e as MessageEvent).data)));
  });
  const opened = new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (e) => resolve((e as CloseEvent).code));
  });
  return { ws, frames, opened, closed };
}

/** The state file `pinbox serve` writes under XDG_STATE_HOME (project id is hashed). */
async function readHubState(): Promise<HubStateFile | undefined> {
  let matches: string[];
  try {
    matches = [...new Bun.Glob("pinbox/*/hub.json").scanSync({ cwd: stateHome, dot: true })];
  } catch {
    return undefined; // state dir not created yet
  }
  const first = matches[0];
  if (first === undefined) return undefined;
  try {
    return (await Bun.file(`${stateHome}/${first}`).json()) as HubStateFile;
  } catch {
    return undefined; // caught mid-write
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(25);
  }
  return await condition();
}

async function poll<T>(
  pick: () => T | undefined | Promise<T | undefined>,
  what: string,
  deadlineMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await pick();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}
