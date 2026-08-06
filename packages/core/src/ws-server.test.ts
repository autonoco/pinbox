// Real-socket coverage for the WS host in hub-server.ts: upgrade intercept,
// hello → catch-up → live events, cursor replay, auth close codes, protocol errors,
// the /summary connectedToolbars merge, and the pendingWebSockets idle gate.
// Replay tests come first — cursor replay ships before backpressure disconnects
// are enabled.
import { describe, expect, test } from "bun:test";
import { startHubServer } from "./hub-server.ts";
import { openStore } from "./store.ts";
import { WS_TOKEN_SUBPROTOCOL_PREFIX } from "./ws-protocol.ts";

const TOKEN = "sekret";
const TOKEN_PROTOCOLS = [`${WS_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`];

const validInput = {
  text: "button is cut off",
  kind: "note",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
  },
  env: {
    viewport: { w: 1440, h: 900, dpr: 2 },
    browser: "Chrome 130",
    os: "macOS",
    colorScheme: "light",
  },
  author: { userId: "bobak" },
};

type EventFrame = { type: string; seq: number; eventType: string; at: string; payload: unknown };
type CatchUpFrame = {
  type: string;
  protocol: number;
  minProtocol: number;
  lastSeq: number;
  events: EventFrame[];
};
type ErrorFrame = { type: string; code: string; message: string };

/** Frame-by-frame WebSocket client: queues incoming JSON frames, resolves close codes. */
class TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<number>;
  private readonly queue: unknown[] = [];
  private waiter: {
    resolve: (frame: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(url: string, protocols?: string[]) {
    this.ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    this.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String((event as MessageEvent).data)) as unknown;
      if (this.waiter !== null) {
        clearTimeout(this.waiter.timer);
        this.waiter.resolve(frame);
        this.waiter = null;
      } else {
        this.queue.push(frame);
      }
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", (event) => resolve((event as CloseEvent).code));
    });
  }

  opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("socket error before open")));
    });
  }

  hello(consumerId: string, lastSeq: number): void {
    this.send({ type: "hello", protocol: 1, consumerId, lastSeq });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  next<T>(timeoutMs = 2000): Promise<T> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      this.waiter = { resolve: (frame) => resolve(frame as T), timer };
    });
  }

  close(): void {
    this.ws.close();
  }
}

function start(o: { idleMs?: number; helloTimeoutMs?: number } = {}) {
  const store = openStore(":memory:");
  return startHubServer({
    store,
    token: TOKEN,
    port: 0,
    realtime: {
      projectId: "p1",
      ...(o.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: o.helloTimeoutMs }),
    },
    ...(o.idleMs === undefined ? {} : { idleMs: o.idleMs }),
  }).then((server) => ({ store, server }));
}

function wsUrl(base: string, query = ""): string {
  const url = new URL(`/ws${query}`, base);
  url.protocol = "ws:";
  return url.href;
}

async function createPinHttp(base: string): Promise<{ id: string }> {
  const res = await fetch(new URL("/pins", base), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(validInput),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data;
}

async function summaryData(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/summary", base), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

describe("ws host", () => {
  test("hello replays prior events in catch-up; live frames reach every socket", async () => {
    const { server } = await start();
    try {
      await createPinHttp(server.url);

      const a = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await a.opened();
      a.hello("a", 0);
      const cuA = await a.next<CatchUpFrame>();
      expect(cuA.type).toBe("catch-up");
      expect(cuA.protocol).toBe(1);
      expect(cuA.minProtocol).toBe(1);
      expect(cuA.lastSeq).toBe(1);
      expect(cuA.events.map((e) => e.eventType)).toEqual(["pin.created"]);

      const b = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await b.opened();
      b.hello("b", cuA.lastSeq);
      const cuB = await b.next<CatchUpFrame>();
      expect(cuB.events).toEqual([]);

      // server.publish rule: EVERY subscribed socket receives the live frame,
      // including one whose own HTTP call caused the mutation.
      await createPinHttp(server.url);
      const liveA = await a.next<EventFrame>();
      const liveB = await b.next<EventFrame>();
      expect(liveA.type).toBe("event");
      expect(liveA.eventType).toBe("pin.created");
      expect(liveA.seq).toBe(cuA.lastSeq + 1);
      expect(liveB.seq).toBe(liveA.seq);
      a.close();
      b.close();
    } finally {
      await server.close();
    }
  });

  test("cursor replay: reconnect with lastSeq gets exactly the missed events; hello snapshots cursors", async () => {
    const { store, server } = await start();
    try {
      await createPinHttp(server.url);
      const first = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await first.opened();
      first.hello("c1", 0);
      const cu = await first.next<CatchUpFrame>();
      first.close();
      await first.closed;

      await createPinHttp(server.url);
      await createPinHttp(server.url);

      const second = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await second.opened();
      second.hello("c1", cu.lastSeq);
      const replay = await second.next<CatchUpFrame>();
      expect(replay.events.map((e) => e.seq)).toEqual([cu.lastSeq + 1, cu.lastSeq + 2]);
      expect(store.cursors.get("c1")).toBe(cu.lastSeq);
      second.close();
    } finally {
      await server.close();
    }
  });

  test("bad token closes 4401; missing token closes 4401", async () => {
    const { server } = await start();
    try {
      expect(await new TestSocket(wsUrl(server.url, "?token=wrong")).closed).toBe(4401);
      expect(await new TestSocket(wsUrl(server.url)).closed).toBe(4401);
    } finally {
      await server.close();
    }
  });

  test("hello below min protocol gets an E_WS_PROTOCOL error frame then close 4400", async () => {
    const { server } = await start();
    try {
      const s = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await s.opened();
      s.send({ type: "hello", protocol: 0, consumerId: "c1", lastSeq: 0 });
      const frame = await s.next<ErrorFrame>();
      expect(frame.type).toBe("error");
      expect(frame.code).toBe("E_WS_PROTOCOL");
      expect(await s.closed).toBe(4400);
    } finally {
      await server.close();
    }
  });

  test("malformed JSON hello gets an error frame then close 4400", async () => {
    const { server } = await start();
    try {
      const s = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await s.opened();
      s.ws.send("this is not json");
      const frame = await s.next<ErrorFrame>();
      expect(frame.code).toBe("E_WS_PROTOCOL");
      expect(await s.closed).toBe(4400);
    } finally {
      await server.close();
    }
  });

  test("no hello within the deadline closes 4400", async () => {
    const { server } = await start({ helloTimeoutMs: 100 });
    try {
      const s = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await s.opened();
      expect(await s.closed).toBe(4400);
    } finally {
      await server.close();
    }
  });

  test("GET /summary data includes connectedToolbars", async () => {
    const { server } = await start();
    try {
      expect((await summaryData(server.url))["connectedToolbars"]).toBe(0);
      const s = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
      await s.opened();
      s.hello("c1", 0);
      await s.next<CatchUpFrame>();
      expect((await summaryData(server.url))["connectedToolbars"]).toBe(1);
      s.close();
      await s.closed;
      await Bun.sleep(50);
      expect((await summaryData(server.url))["connectedToolbars"]).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("idle exit is gated on attached sockets", async () => {
    const { server } = await start({ idleMs: 200 });
    const health = new URL("/health", server.url);
    const s = new TestSocket(wsUrl(server.url), TOKEN_PROTOCOLS);
    await s.opened();
    s.hello("c1", 0);
    await s.next<CatchUpFrame>();
    await Bun.sleep(500);
    // Without the pendingWebSockets gate the server would have idled out by now.
    expect((await fetch(health)).status).toBe(200);
    s.close();
    await s.closed;
    await Bun.sleep(500);
    await expect(fetch(health)).rejects.toThrow();
    await server.close();
  });
});
