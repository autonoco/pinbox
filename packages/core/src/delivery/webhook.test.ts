// Webhook adapter tests — an in-process Bun.serve receiver captures headers and body;
// the HMAC is recomputed independently over `${timestamp}.${body}` with WebCrypto and
// must verify (and must NOT verify when tampered). The router integration proves the
// deliveries ledger is the retry schedule AND the delivery log.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { Session } from "../sessions.ts";
import type { StoredEvent } from "../store.ts";
import { openStore } from "../store.ts";
import { DeliveryRouter } from "./router.ts";
import { createWebhookAdapter } from "./webhook.ts";

const NOW = "2026-08-04T12:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const SECRET = "s3cret-hmac-key";

const input = {
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
} as const;

type Received = { headers: Record<string, string>; body: string };

type Receiver = {
  url: string;
  received: Received[];
  setStatus(status: number): void;
  stop(): void;
};

const receivers: Receiver[] = [];

function makeReceiver(initialStatus = 200): Receiver {
  const received: Received[] = [];
  let status = initialStatus;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      received.push({
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      return new Response(status >= 200 && status < 300 ? "ok" : "boom", { status });
    },
  });
  const receiver: Receiver = {
    url: `http://127.0.0.1:${server.port}/pinbox-hook`,
    received,
    setStatus(next: number) {
      status = next;
    },
    stop() {
      server.stop(true);
    },
  };
  receivers.push(receiver);
  return receiver;
}

afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.stop();
});

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeSession(over: Partial<Session> = {}): Session {
  const base: Session = {
    id: "ses_aaaaaaaaaa",
    agent: "custom-bot",
    key: "hook-key-1",
    cwd: "/tmp/proj",
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  return { ...base, ...over };
}

function makeEvent(over: Partial<StoredEvent> = {}): StoredEvent {
  return { seq: 1, type: "pin.created", at: NOW, payload: { id: "pin_aaaaaaaaaa" }, ...over };
}

describe("deliver", () => {
  test("POSTs the signed envelope: header set, verifiable HMAC over `<timestamp>.<body>`", async () => {
    const receiver = makeReceiver();
    const adapter = createWebhookAdapter({ url: receiver.url, secret: SECRET });
    const event = makeEvent();
    await adapter.deliver(event, makeSession());

    expect(receiver.received).toHaveLength(1);
    const { headers, body } = receiver.received.at(0) ?? { headers: {}, body: "" };
    const timestamp = headers["x-pinbox-timestamp"] ?? "";
    expect(Number.isFinite(Date.parse(timestamp))).toBe(true);
    expect(headers["x-pinbox-event"]).toBe("pin.created");
    expect(headers["content-type"]).toBe("application/json");

    // Recompute the signature independently — it must verify, and only untampered.
    const signature = headers["x-pinbox-signature"] ?? "";
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(signature).toBe(`sha256=${await hmacHex(SECRET, `${timestamp}.${body}`)}`);
    expect(signature).not.toBe(`sha256=${await hmacHex(SECRET, `${timestamp}.${body}x`)}`); // tamper
    expect(signature).not.toBe(`sha256=${await hmacHex("wrong-secret", `${timestamp}.${body}`)}`);

    // Body shape: the full StoredEvent plus the session identity triple, nothing more.
    const parsed = JSON.parse(body) as { event: StoredEvent; session: Record<string, string> };
    expect(parsed.event).toEqual(event);
    expect(parsed.session).toEqual({
      id: "ses_aaaaaaaaaa",
      agent: "custom-bot",
      key: "hook-key-1",
    });
  });

  test("non-2xx response rejects (the queue retries with backoff)", async () => {
    const receiver = makeReceiver(500);
    const adapter = createWebhookAdapter({ url: receiver.url, secret: SECRET });
    await expect(adapter.deliver(makeEvent(), makeSession())).rejects.toThrow(/500/);
  });

  test("network error rejects", async () => {
    const dead = makeReceiver();
    dead.stop(); // port is now closed — connection refused
    const adapter = createWebhookAdapter({ url: dead.url, secret: SECRET });
    await expect(adapter.deliver(makeEvent(), makeSession())).rejects.toThrow();
  });
});

describe("matches", () => {
  test("always true — the catch-all for agents nothing else reaches", () => {
    const adapter = createWebhookAdapter({ url: "http://127.0.0.1:1/x", secret: SECRET });
    expect(adapter.name).toBe("webhook");
    expect(adapter.matches(makeSession())).toBe(true);
    expect(adapter.matches(makeSession({ agent: "claude", endedAt: NOW }))).toBe(true);
  });
});

describe("through a real DeliveryRouter", () => {
  test("first attempt 500 → pending with backoff; drain past due_at retries to delivered, attempts 1", async () => {
    const path = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-webhook-${crypto.randomUUID()}.db`;
    const receiver = makeReceiver(500);
    const store = openStore(path);
    const adapter = createWebhookAdapter({ url: receiver.url, secret: SECRET });
    const router = new DeliveryRouter({ store, adapters: [adapter] });
    const ref = { agent: "custom-bot", key: "hook-key-1" };
    const session = store.sessions.register(ref);
    store.createPin({ ...structuredClone(input), agentSession: ref }, {});
    const event = store.eventsAfter(0).at(0);
    if (event === undefined) throw new Error("no events");

    const before = Date.now();
    await router.dispatch(event);
    const after = Date.now();
    expect(receiver.received).toHaveLength(1);
    const row = store.deliveries.pendingForSession(session.id).at(0);
    expect(row?.adapter).toBe("webhook");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("500");
    const dueAt = Date.parse(row?.dueAt ?? "");
    expect(dueAt).toBeGreaterThanOrEqual(before + 30_000); // 30s·4^0
    expect(dueAt).toBeLessThanOrEqual(after + 30_000);

    receiver.setStatus(200);
    await router.drainDue(FUTURE);
    expect(receiver.received).toHaveLength(2);
    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);

    // The ledger IS the delivery log: delivered, one failed attempt recorded.
    class LedgerRow {
      status!: string;
      attempts!: number;
    }
    const check = new Database(path);
    const ledger = check
      .query("SELECT status, attempts FROM deliveries ORDER BY id LIMIT 1")
      .as(LedgerRow)
      .get();
    expect(ledger?.status).toBe("delivered");
    expect(ledger?.attempts).toBe(1);
    check.close();
    store.close();
    await $`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  });
});
