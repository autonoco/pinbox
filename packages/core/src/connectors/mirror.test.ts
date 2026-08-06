// The mirror call sites: the anti-echo rule, enforced in core.
// Sinks write role:"mirror"+origin; remote-closed resolves by:"agent"; remote-open on a
// resolved pin calls verifyPin(id,"reopened"); outboundCandidates is the skip table.
import { describe, expect, test } from "bun:test";
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import { openStore, type PinStore } from "../store.ts";
import { createConnectorEvents, outboundCandidates } from "./mirror.ts";

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

const link: Link = { connector: "github", ref: "123", url: "https://github.com/a/b/issues/123" };

function setup(): { store: PinStore; pin: Pin } {
  const store = openStore(":memory:");
  const pin = store.createPin(validInput as never, {});
  return { store, pin };
}

/** Spies on verifyPin while leaving the rest of the store real. */
function withVerifyPin(
  store: PinStore,
  fn: (id: string, outcome: "accepted" | "reopened") => Pin,
): PinStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "verifyPin") return fn;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("onRemoteComment", () => {
  test("writes role:mirror with the origin tag", async () => {
    const { store, pin } = setup();
    await createConnectorEvents(store, pin.id).onRemoteComment(link, {
      origin: "github:benji",
      text: "looks wrong on mobile",
      at: "2026-08-04T10:00:00Z",
    });
    const thread = store.getThread(pin.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.role).toBe("mirror");
    expect(thread[0]?.origin).toBe("github:benji");
    expect(thread[0]?.text).toBe("looks wrong on mobile");
    store.close();
  });
});

describe("onRemoteStatus closed", () => {
  test("resolves an open pin by:agent", async () => {
    const { store, pin } = setup();
    await createConnectorEvents(store, pin.id).onRemoteStatus(link, "closed");
    const updated = store.getPin(pin.id);
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution?.by).toBe("agent");
    store.close();
  });

  test("no-ops on an already-resolved pin (keeps the original resolution)", async () => {
    const { store, pin } = setup();
    store.resolvePin(pin.id, "human", "done");
    await createConnectorEvents(store, pin.id).onRemoteStatus(link, "closed");
    const updated = store.getPin(pin.id);
    expect(updated?.resolution?.by).toBe("human");
    expect(updated?.resolution?.note).toBe("done");
    store.close();
  });
});

describe("onRemoteStatus open", () => {
  test("no-ops on an open pin", async () => {
    const { store, pin } = setup();
    await createConnectorEvents(store, pin.id).onRemoteStatus(link, "open");
    expect(store.getPin(pin.id)?.status).toBe("open");
    expect(store.getThread(pin.id)).toHaveLength(0);
    store.close();
  });

  test("resolved pin + verifyPin present → verifyPin(id, 'reopened'), no notice", async () => {
    const { store, pin } = setup();
    store.resolvePin(pin.id, "human");
    const calls: [string, string][] = [];
    const verifying = withVerifyPin(store, (id, outcome) => {
      calls.push([id, outcome]);
      const current = store.getPin(id);
      if (current === null) throw new Error("pin vanished");
      return current;
    });
    await createConnectorEvents(verifying, pin.id).onRemoteStatus(link, "open");
    expect(calls).toEqual([[pin.id, "reopened"]]);
    expect(store.getThread(pin.id)).toHaveLength(0);
    store.close();
  });

  test("resolved pin → verifyPin reopens it; no mirror notice is written", async () => {
    const { store, pin } = setup();
    store.resolvePin(pin.id, "human");
    const events = createConnectorEvents(store, pin.id);
    await events.onRemoteStatus(link, "open");
    expect(store.getPin(pin.id)?.status).toBe("open");
    expect(store.getPin(pin.id)?.verification?.outcome).toBe("reopened");
    expect(store.getThread(pin.id)).toHaveLength(0);
    store.close();
  });
});

describe("outboundCandidates — the anti-echo table", () => {
  const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({
    id: "msg_0000000000",
    pinId: "pin_0000000000",
    role: "human",
    text: "t",
    at: "2026-08-04T10:00:00Z",
    ...over,
  });

  test("human msg → out; agent msg → out", () => {
    const thread = [msg({ role: "human" }), msg({ role: "agent" })];
    expect(outboundCandidates(thread, "github", null)).toEqual(thread);
  });

  test("origin github:benji → never (for github)", () => {
    const thread = [msg({ role: "mirror", origin: "github:benji" })];
    expect(outboundCandidates(thread, "github", null)).toEqual([]);
  });

  test("origin slack:z → out for github, never for slack", () => {
    const thread = [msg({ role: "mirror", origin: "slack:z" })];
    expect(outboundCandidates(thread, "github", null)).toEqual(thread);
    expect(outboundCandidates(thread, "slack", null)).toEqual([]);
  });

  test("origin-less mirror (local notice) stays home", () => {
    const thread = [msg({ role: "mirror" })];
    expect(outboundCandidates(thread, "github", null)).toEqual([]);
  });

  test("cursor: everything ≤ since is dropped; null since means everything", () => {
    const older = msg({ id: "msg_0000000001", at: "2026-08-04T09:00:00Z" });
    const atCursor = msg({ id: "msg_0000000002", at: "2026-08-04T10:00:00Z" });
    const newer = msg({ id: "msg_0000000003", at: "2026-08-04T11:00:00Z" });
    const thread = [older, atCursor, newer];
    expect(outboundCandidates(thread, "github", "2026-08-04T10:00:00Z")).toEqual([newer]);
    expect(outboundCandidates(thread, "github", null)).toEqual(thread);
  });
});
