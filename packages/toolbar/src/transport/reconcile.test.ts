// @autono/pinbox-toolbar — reconciliation coverage: the REST snapshot must never
// clobber a live WS event that landed while the GET was in flight, and a queued
// outbox must not sit forever just because the socket stayed healthy.
import { describe, expect, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import {
  catchUp,
  type FakeSocket,
  harness,
  KEY,
  makeFetch,
  makeInput,
  serverPin,
} from "./test-harness.ts";

/** Let every pending fetch/await chain inside the transport settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Bun.sleep(0);
}

const resolvedEvent = (seq: number) => ({
  type: "event",
  seq,
  eventType: "pin.resolved",
  at: "2026-08-04T00:00:00.000Z",
  payload: { id: "pin_a000000001" },
});

const notFound = { status: 404, body: { ok: false, error: { code: "E_NOT_FOUND", message: "?" } } };

describe("reconcile fetches agent sessions", () => {
  test("GET /sessions rides each reconcile and reaches onSessions; a hub without it is harmless", async () => {
    const session = {
      id: "ses_aaaaaaaaaa",
      agent: "claude",
      key: "k",
      registeredAt: "2026-08-04T00:00:00.000Z",
      lastSeenAt: "2026-08-04T00:00:00.000Z",
    };
    const { fetchFn, calls } = makeFetch((method, path) => {
      if (method === "GET" && path === "/pins")
        return { status: 200, body: { ok: true, data: [] } };
      if (method === "GET" && path === "/sessions")
        return { status: 200, body: { ok: true, data: [session] } };
      return notFound;
    });
    const seen: unknown[] = [];
    const h = harness({ fetchFn, onSessions: (s) => seen.push(s) });
    h.transport.connect();
    (h.sockets[0] as FakeSocket).open();
    (h.sockets[0] as FakeSocket).frame(catchUp(0));
    await settle();
    expect(seen).toEqual([[session]]);
    expect(calls.some((c) => c.path === "/sessions")).toBe(true);

    // Older hub: 404 on /sessions must not disturb the pin reconcile.
    const old = makeFetch((method, path) =>
      method === "GET" && path === "/pins"
        ? { status: 200, body: { ok: true, data: [] } }
        : notFound,
    );
    const pins: unknown[] = [];
    const seen2: unknown[] = [];
    const h2 = harness({
      fetchFn: old.fetchFn,
      onSessions: (s) => seen2.push(s),
      onPins: (p) => pins.push(p),
    });
    h2.transport.connect();
    (h2.sockets[0] as FakeSocket).open();
    (h2.sockets[0] as FakeSocket).frame(catchUp(0));
    await settle();
    expect(seen2).toEqual([]);
    expect(pins).toEqual([[]]);
  });
});

describe("reconcile race with live events", () => {
  test("an event landing during the snapshot GET wins over the staler snapshot", async () => {
    const open = serverPin("pin_a000000001");
    const resolved: Pin = { ...open, status: "resolved" };
    let gets = 0;
    let duringGet: () => void = () => {};
    const { fetchFn } = makeFetch((method, path) => {
      if (method === "GET" && path === "/pins") {
        gets += 1;
        duringGet();
        return { status: 200, body: { ok: true, data: [gets === 1 ? open : resolved] } };
      }
      return notFound;
    });
    const pinLists: Pin[][] = [];
    const h = harness({ fetchFn, onPins: (pins) => pinLists.push(pins) });

    h.transport.connect();
    const socket = h.sockets[0];
    socket?.open();
    duringGet = () => {
      duringGet = () => {}; // exactly one live event, mid-flight
      socket?.frame(resolvedEvent(5));
    };
    socket?.frame(catchUp(0, []));
    await settle();

    expect(gets).toBe(2); // the snapshot was re-taken at the advanced cursor
    expect(pinLists.map((pins) => pins.map((p) => p.status))).toEqual([["resolved"]]);
    const mirror = JSON.parse(h.storage.getItem(KEY("pins")) ?? "[]") as Pin[];
    expect(mirror.map((p) => p.status)).toEqual(["resolved"]);
  });

  test("a snapshot that never stops being overtaken is dropped, not applied", async () => {
    let gets = 0;
    let seq = 4;
    let socket: FakeSocket | undefined;
    const { fetchFn } = makeFetch((method, path) => {
      if (method === "GET" && path === "/pins") {
        gets += 1;
        seq += 1;
        socket?.frame(resolvedEvent(seq)); // every snapshot is overtaken
        return { status: 200, body: { ok: true, data: [serverPin("pin_a000000001")] } };
      }
      return notFound;
    });
    const pinLists: Pin[][] = [];
    const h = harness({ fetchFn, onPins: (pins) => pinLists.push(pins) });

    h.transport.connect();
    socket = h.sockets[0];
    socket?.open();
    socket?.frame(catchUp(0, []));
    await settle();

    expect(gets).toBeGreaterThan(1); // it retried rather than trusting the stale list
    expect(gets).toBeLessThanOrEqual(4); // …and gave up instead of spinning
    expect(pinLists).toEqual([]); // the live events already carry the newer truth
    expect(h.storage.getItem(KEY("pins"))).toBeNull();
  });
});

describe("outbox flush on the live path", () => {
  test("a pin queued while the socket stayed up flushes on the next successful write", async () => {
    const created = serverPin("pin_srv0000001");
    let postOk = false;
    const { calls, fetchFn } = makeFetch((method, path) => {
      if (method === "GET" && path === "/pins")
        return { status: 200, body: { ok: true, data: [] } };
      if (method === "POST" && path === "/pins") {
        if (!postOk) throw new TypeError("network down");
        return { status: 201, body: { ok: true, data: created } };
      }
      return notFound;
    });
    const outboxUpdates: string[][] = [];
    const pinLists: string[][] = [];
    const h = harness({
      fetchFn,
      onOutbox: (ids) => outboxUpdates.push(ids),
      onPins: (pins) => pinLists.push(pins.map((p) => p.id)),
    });

    h.transport.connect();
    h.sockets[0]?.open();
    h.sockets[0]?.frame(catchUp(0, []));
    await settle();

    // the REST write fails while the socket is still live ⇒ queued, no reconnect coming
    const optimistic = await h.transport.createPin(makeInput());
    expect(outboxUpdates.at(-1)).toEqual([optimistic.id]);

    postOk = true;
    await h.transport.createPin(makeInput());
    await settle();

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3); // failed, live, flushed
    expect(h.storage.getItem(KEY("outbox"))).toBeNull();
    expect(outboxUpdates.at(-1)).toEqual([]);
    expect(pinLists.at(-1)).toContain(created.id);
  });
});
