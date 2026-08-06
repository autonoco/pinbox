// @autono/pinbox-toolbar — transport tests.
// Fixtures (fake socket, Map storage, manual scheduler, envelope fetch) live in
// ./transport/test-harness.ts, shared with the offline/reconcile/backoff suites.
import { describe, expect, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import {
  catchUp,
  evt,
  harness,
  KEY,
  makeFetch,
  makeInput,
  makeStorage,
  serverPin,
} from "./transport/test-harness.ts";
import { HubError } from "./transport.ts";

describe("hello handshake", () => {
  test("hello carries the persisted cursor and the token subprotocol", () => {
    const storage = makeStorage();
    storage.setItem(KEY("cursor"), "7");
    const h = harness({}, storage);
    h.transport.connect();
    const socket = h.sockets[0];
    if (!socket) throw new Error("no socket created");
    expect(socket.url).toBe("ws://127.0.0.1:4310/ws");
    expect(socket.protocols).toContain("pinbox.token.tok");
    socket.open();
    expect(socket.sent).toHaveLength(1);
    const hello = JSON.parse(socket.sent[0] ?? "");
    expect(hello).toEqual({
      type: "hello",
      protocol: 1,
      consumerId: h.transport.consumerId,
      lastSeq: 7,
    });
    expect(h.states).toEqual(["connecting"]);
  });

  test("consumerId is generated once and persisted", () => {
    const storage = makeStorage();
    const first = harness({}, storage).transport.consumerId;
    expect(first).toMatch(/^[a-z0-9]{10}$/);
    expect(storage.getItem(KEY("consumer"))).toBe(first);
    expect(harness({}, storage).transport.consumerId).toBe(first);
  });
});

describe("catch-up and live frames", () => {
  test("catch-up events apply in order and advance the cursor", () => {
    const storage = makeStorage();
    storage.setItem(KEY("cursor"), "7");
    const h = harness({}, storage);
    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(9, [evt(8), evt(9)]));
    expect(h.events.map((e) => e.seq)).toEqual([8, 9]);
    expect(storage.getItem(KEY("cursor"))).toBe("9");
    expect(h.states).toEqual(["connecting", "live"]);
  });

  test("a live frame arriving before catch-up is buffered and applied exactly once after it", () => {
    const h = harness();
    h.transport.connect();
    const socket = h.sockets[0];
    socket?.open();
    socket?.frame(evt(10)); // accept→catch-up window race
    expect(h.events).toHaveLength(0);
    socket?.frame(catchUp(9, [evt(8), evt(9)]));
    expect(h.events.map((e) => e.seq)).toEqual([8, 9, 10]);
    socket?.frame(evt(10)); // replayed duplicate
    expect(h.events.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(h.storage.getItem(KEY("cursor"))).toBe("10");
  });

  test("a duplicate seq at or below the cursor is dropped", () => {
    const h = harness();
    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(9, [evt(8), evt(9)]));
    h.sockets[0]?.frame(evt(9));
    expect(h.events.map((e) => e.seq)).toEqual([8, 9]);
    h.sockets[0]?.frame(evt(11));
    expect(h.events.map((e) => e.seq)).toEqual([8, 9, 11]);
  });
});

describe("protocol compatibility", () => {
  test("catch-up minProtocol above the client version ⇒ incompatible, no reconnect timer", () => {
    const h = harness();
    h.transport.connect();
    const socket = h.sockets[0];
    socket?.open();
    socket?.frame(catchUp(0, [], { protocol: 2, minProtocol: 2 }));
    expect(h.states).toEqual(["connecting", "incompatible"]);
    expect(socket?.closed).not.toBeNull();
    expect(h.timers).toHaveLength(0);
    // and the socket's own close callback must not resurrect a reconnect
    socket?.onclose?.({ code: 4400 });
    expect(h.timers).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("reconnect backoff", () => {
  test("socket failure ⇒ offline, then a jittered backoff reconnect attempt", () => {
    const h = harness();
    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(3, [evt(1), evt(2), evt(3)]));
    h.sockets[0]?.fail();
    expect(h.states).toEqual(["connecting", "live", "offline"]);
    expect(h.timers).toHaveLength(1);
    const timer = h.timers[0];
    if (!timer) throw new Error("no reconnect timer");
    expect(timer.ms).toBeGreaterThanOrEqual(1000);
    expect(timer.ms).toBeLessThanOrEqual(30000);
    timer.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.open();
    const hello = JSON.parse(h.sockets[1]?.sent[0] ?? "");
    expect(hello.lastSeq).toBe(3); // cursor survived the drop
  });

  test("close() stops the transport: no reconnect after an explicit close", () => {
    const h = harness();
    h.transport.connect();
    h.sockets[0]?.open();
    h.transport.close();
    h.sockets[0]?.fail();
    expect(h.timers).toHaveLength(0);
  });
});

describe("offline outbox and reconciliation", () => {
  test("createPin while offline enqueues and returns an optimistic pin; reconnect flushes and clears", async () => {
    let respond: (method: string, path: string) => { status: number; body: unknown } = () => {
      throw new TypeError("network down");
    };
    const { calls, fetchFn } = makeFetch((m, p) => respond(m, p));
    const h = harness({ fetchFn });

    const input = makeInput();
    const optimistic = await h.transport.createPin(input);
    expect(optimistic.id).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(optimistic.status).toBe("open");
    expect(optimistic.text).toBe(input.text);
    expect(calls).toHaveLength(0); // never hit the network offline
    const outbox = JSON.parse(h.storage.getItem(KEY("outbox")) ?? "[]");
    expect(outbox).toHaveLength(1);

    // reconnect: hub wins on status (listPins), client wins on new pins (outbox POST)
    const created = serverPin("pin_srv0000001");
    respond = (method, path) => {
      if (method === "GET" && path === "/pins")
        return { status: 200, body: { ok: true, data: [] } };
      if (method === "POST" && path === "/pins")
        return { status: 201, body: { ok: true, data: created } };
      return { status: 404, body: { ok: false, error: { code: "E_NOT_FOUND", message: "?" } } };
    };
    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(0, []));
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /pins", "POST /pins"]);
    expect(calls[1]?.headers["authorization"]).toBe("Bearer tok");
    expect(calls[1]?.body).toEqual(input);
    expect(h.storage.getItem(KEY("outbox"))).toBeNull(); // cleared after the flush
    const mirror = JSON.parse(h.storage.getItem(KEY("pins")) ?? "[]") as Pin[];
    expect(mirror.map((p) => p.id)).toEqual(["pin_srv0000001"]);
  });

  test("mirrorPins returns the persisted last-known pin list", () => {
    const storage = makeStorage();
    storage.setItem(KEY("pins"), JSON.stringify([serverPin("pin_mirror0001")]));
    const h = harness({}, storage);
    expect(h.transport.mirrorPins().map((p) => p.id)).toEqual(["pin_mirror0001"]);
  });

  test("onOutbox reports the queued localId; the flush empties it and re-emits pins", async () => {
    let respond: (method: string, path: string) => { status: number; body: unknown } = () => {
      throw new TypeError("network down");
    };
    const { fetchFn } = makeFetch((m, p) => respond(m, p));
    const outboxUpdates: string[][] = [];
    const pinLists: string[][] = [];
    const h = harness({
      fetchFn,
      onOutbox: (ids) => outboxUpdates.push(ids),
      onPins: (pins) => pinLists.push(pins.map((p) => p.id)),
    });

    const optimistic = await h.transport.createPin(makeInput());
    expect(outboxUpdates).toEqual([[optimistic.id]]);
    expect(h.transport.outboxPins().map((p) => p.id)).toEqual([optimistic.id]);

    const created = serverPin("pin_srv0000001");
    respond = (method, path) => {
      if (method === "GET" && path === "/pins")
        return { status: 200, body: { ok: true, data: [] } };
      if (method === "POST" && path === "/pins")
        return { status: 201, body: { ok: true, data: created } };
      return { status: 404, body: { ok: false, error: { code: "E_NOT_FOUND", message: "?" } } };
    };
    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(0, []));
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(outboxUpdates.at(-1)).toEqual([]); // flushed — nothing queued anymore
    expect(h.transport.outboxPins()).toEqual([]);
    // the flushed server pin reaches onPins so the optimistic local pin gets replaced
    expect(pinLists.at(-1)).toEqual(["pin_srv0000001"]);
  });

  test("outboxPins reconstructs queued optimistic pins across a reload", async () => {
    const storage = makeStorage();
    const first = harness({}, storage);
    const input = makeInput();
    const optimistic = await first.transport.createPin(input); // offline ⇒ queued

    const reloaded = harness({}, storage);
    const queued = reloaded.transport.outboxPins();
    expect(queued.map((p) => p.id)).toEqual([optimistic.id]);
    expect(queued[0]?.text).toBe(input.text);
    expect(queued[0]?.status).toBe("open");
    expect(queued[0]?.createdAt).toBe(optimistic.createdAt);
  });
});

describe("REST surface", () => {
  test("every failure surfaces the hub's error envelope as HubError", async () => {
    const { fetchFn } = makeFetch(() => ({
      status: 404,
      body: { ok: false, error: { code: "E_NOT_FOUND", message: "pin not found: x", hint: "h" } },
    }));
    const h = harness({ fetchFn });
    expect.assertions(3);
    try {
      await h.transport.resolve("pin_x");
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
      expect(err.code).toBe("E_NOT_FOUND");
      expect(err.message).toBe("pin not found: x");
      expect(err.hint).toBe("h");
    }
  });

  test("network failure surfaces as the client-only E_HUB_UNREACHABLE", async () => {
    const h = harness();
    expect.assertions(1);
    try {
      await h.transport.listPins();
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
      expect(err.code).toBe("E_HUB_UNREACHABLE");
    }
  });

  test("reply and verify hit the pinned routes with bearer auth", async () => {
    const msg = {
      id: "msg_1",
      pinId: "pin_a",
      role: "human",
      text: "hi",
      at: "2026-08-04T00:00:00.000Z",
    };
    const { calls, fetchFn } = makeFetch((_method, path) => {
      if (path === "/pins/pin_a/thread") return { status: 201, body: { ok: true, data: msg } };
      if (path === "/pins/pin_a/verify")
        return { status: 200, body: { ok: true, data: serverPin("pin_a000000001") } };
      return { status: 404, body: { ok: false, error: { code: "E_NOT_FOUND", message: "?" } } };
    });
    const h = harness({ fetchFn });
    await h.transport.reply("pin_a", "hi");
    await h.transport.verify("pin_a", "accepted");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /pins/pin_a/thread",
      "POST /pins/pin_a/verify",
    ]);
    expect(calls[0]?.body).toEqual({ role: "human", text: "hi" });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer tok");
    expect(calls[1]?.body).toEqual({ outcome: "accepted" });
  });
});
