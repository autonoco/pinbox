// DeliveryRouter tests — real openStore(":memory:") plus fake adapters (recording
// deliver calls, controllable matches/throws). The deliveries ledger is the
// observable surface: every event gets a row, MAX(event_seq) is the cursor.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { Session } from "../sessions.ts";
import type { DeliveryStore, PinStore, StoredEvent } from "../store.ts";
import { openStore } from "../store.ts";
import {
  DEFAULT_HOOKS_ESCALATE_MS,
  type DeliveryAdapter,
  DeliveryRouter,
  hooksEscalateMs,
} from "./router.ts";

const FUTURE = "2027-01-01T00:00:00.000Z";

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

function lastEvent(store: PinStore): StoredEvent {
  const event = store.eventsAfter(0).at(-1);
  if (event === undefined) throw new Error("no events in log");
  return event;
}

type FakeAdapter = DeliveryAdapter & { calls: { event: StoredEvent; session: Session }[] };

function fakeAdapter(
  name: string,
  opts: { matches?: (session: Session) => boolean; error?: () => Error | null } = {},
): FakeAdapter {
  const calls: FakeAdapter["calls"] = [];
  return {
    name,
    calls,
    matches: (session) => opts.matches?.(session) ?? true,
    deliver(event, session) {
      calls.push({ event, session });
      const error = opts.error?.() ?? null;
      return error === null ? Promise.resolve() : Promise.reject(error);
    },
  };
}

function claudeRef(key = "k1"): { agent: string; key: string; cwd: string } {
  return { agent: "claude", key, cwd: "/tmp/proj" };
}

const tmpDbPath = () =>
  `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-router-${crypto.randomUUID()}.db`;

describe("rule 1 — pin.created binding", () => {
  test("agentSession binds to that session, registering it when unknown", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    store.createPin({ ...structuredClone(input), agentSession: claudeRef() }, {});
    const event = lastEvent(store);
    await router.dispatch(event);
    expect(push.calls).toHaveLength(1);
    expect(push.calls.at(0)?.session.key).toBe("k1");
    const registered = store.sessions.findByRef({ agent: "claude", key: "k1" });
    expect(registered).not.toBeNull();
    expect(push.calls.at(0)?.session.id).toBe(registered?.id ?? "");
    expect(store.deliveries.lastEventSeq()).toBe(event.seq);
    expect(store.deliveries.due(FUTURE)).toEqual([]); // delivered, nothing pending
    store.close();
  });

  test("agentSession reuses an already-registered session", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    const existing = store.sessions.register(claudeRef());
    store.createPin({ ...structuredClone(input), agentSession: claudeRef() }, {});
    await router.dispatch(lastEvent(store));
    expect(push.calls.at(0)?.session.id).toBe(existing.id);
    store.close();
  });

  test("without agentSession binds to the active session and persists the binding", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    const active = store.sessions.register(claudeRef());
    const pin = store.createPin(structuredClone(input), {});
    await router.dispatch(lastEvent(store));
    expect(push.calls.at(0)?.session.id).toBe(active.id);
    expect(store.getPin(pin.id)?.agentSession).toEqual(claudeRef());
    store.close();
  });

  test("no session at all queues the event unassigned, no adapter call", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    store.createPin(structuredClone(input), {});
    const event = lastEvent(store);
    await router.dispatch(event);
    expect(push.calls).toHaveLength(0);
    const rows = store.deliveries.unassigned();
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.eventSeq).toBe(event.seq);
    expect(rows.at(0)?.status).toBe("pending");
    store.close();
  });

  test("drainDue assigns unassigned rows to the next registered session and binds the pin", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    const pin = store.createPin(structuredClone(input), {});
    await router.dispatch(lastEvent(store));
    expect(store.deliveries.unassigned()).toHaveLength(1);
    const late = store.sessions.register(claudeRef("late-key"));
    await router.drainDue(FUTURE);
    expect(push.calls).toHaveLength(1);
    expect(push.calls.at(0)?.session.id).toBe(late.id);
    expect(store.deliveries.unassigned()).toEqual([]);
    expect(store.deliveries.due(FUTURE)).toEqual([]); // delivered
    expect(store.getPin(pin.id)?.agentSession).toEqual(claudeRef("late-key"));
    store.close();
  });
});

describe("rule 2 — replies stick to the bound session", () => {
  test("human reply routes to the bound session even when another is more recently active", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    const bound = store.sessions.register(claudeRef());
    const pin = store.createPin({ ...structuredClone(input), agentSession: claudeRef() }, {});
    await router.dispatch(lastEvent(store));
    const other = store.sessions.register(claudeRef("k2")); // now the most recently seen
    expect(store.sessions.active()?.id).toBe(other.id);
    store.addThreadMessage(pin.id, "human", "also fix hover");
    await router.dispatch(lastEvent(store));
    expect(push.calls).toHaveLength(2);
    expect(push.calls.at(1)?.session.id).toBe(bound.id);
    store.close();
  });

  test("mirror replies ride the same path", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    const bound = store.sessions.register(claudeRef());
    const pin = store.createPin({ ...structuredClone(input), agentSession: claudeRef() }, {});
    await router.dispatch(lastEvent(store));
    store.addThreadMessage(pin.id, "mirror", "from github", { origin: "github:benji" });
    await router.dispatch(lastEvent(store));
    expect(push.calls.at(1)?.session.id).toBe(bound.id);
    store.close();
  });
});

describe("rule 3 — agent-authored events are skipped, ledger stays complete", () => {
  test("agent reply and pin.resolved write skipped rows and never reach adapters", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    store.sessions.register(claudeRef());
    store.subscribe((e) => void router.dispatch(e));
    const pin = store.createPin(structuredClone(input), {});
    store.addThreadMessage(pin.id, "agent", "on it");
    store.resolvePin(pin.id, "agent", "done");
    await router.drainDue(); // flush the serialized dispatch chain
    expect(push.calls).toHaveLength(1); // pin.created only
    expect(store.deliveries.lastEventSeq()).toBe(store.summary().lastEventSeq);
    expect(store.deliveries.due(FUTURE)).toEqual([]);
    expect(store.deliveries.unassigned()).toEqual([]);
    store.close();
  });
});

describe("adapter preference order", () => {
  test("first matching adapter wins; later adapters never see the event", async () => {
    const store = openStore(":memory:");
    const first = fakeAdapter("first");
    const second = fakeAdapter("second");
    const router = new DeliveryRouter({ store, adapters: [first, second] });
    store.sessions.register(claudeRef());
    store.createPin(structuredClone(input), {});
    await router.dispatch(lastEvent(store));
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
    store.close();
  });

  test("non-matching adapters are passed over", async () => {
    const store = openStore(":memory:");
    const first = fakeAdapter("first", { matches: () => false });
    const second = fakeAdapter("second");
    const router = new DeliveryRouter({ store, adapters: [first, second] });
    store.sessions.register(claudeRef());
    store.createPin(structuredClone(input), {});
    await router.dispatch(lastEvent(store));
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
    store.close();
  });
});

describe("failure, backoff, terminal", () => {
  test("failures back off 30s·4^attempts capped 15 min; 5th failure is terminal E_DELIVERY:", async () => {
    const path = tmpDbPath();
    const store = openStore(path);
    const boom = fakeAdapter("push", { error: () => new Error("boom") });
    const router = new DeliveryRouter({ store, adapters: [boom] });
    const session = store.sessions.register(claudeRef());
    store.createPin(structuredClone(input), {});
    const before = Date.now();
    await router.dispatch(lastEvent(store));
    const after = Date.now();

    const first = store.deliveries.pendingForSession(session.id).at(0);
    expect(first?.attempts).toBe(1);
    expect(first?.lastError).toBe("boom");
    const firstDue = Date.parse(first?.dueAt ?? "");
    expect(firstDue).toBeGreaterThanOrEqual(before + 30_000);
    expect(firstDue).toBeLessThanOrEqual(after + 30_000);

    // Each drain retries once the backoff passed; retryAt is exactly drain-now + backoff.
    const expectRetry = async (drainNow: string, attempts: number, backoffMs: number) => {
      await router.drainDue(drainNow);
      const row = store.deliveries.pendingForSession(session.id).at(0);
      expect(row?.attempts).toBe(attempts);
      expect(row?.dueAt).toBe(new Date(Date.parse(drainNow) + backoffMs).toISOString());
    };
    await expectRetry("2026-09-01T00:00:00.000Z", 2, 120_000); // 30s·4^1
    await expectRetry("2026-09-02T00:00:00.000Z", 3, 480_000); // 30s·4^2
    await expectRetry("2026-09-03T00:00:00.000Z", 4, 900_000); // 30s·4^3 = 32 min, capped 15 min

    await router.drainDue("2026-09-04T00:00:00.000Z"); // 5th attempt — terminal
    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);
    expect(store.deliveries.due(FUTURE)).toEqual([]);
    expect(boom.calls).toHaveLength(5);

    class LedgerRow {
      status!: string;
      attempts!: number;
      last_error!: string | null;
    }
    const check = new Database(path);
    const row = check
      .query("SELECT status, attempts, last_error FROM deliveries ORDER BY id LIMIT 1")
      .as(LedgerRow)
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(5);
    expect(row?.last_error).toBe("E_DELIVERY: boom");
    check.close();
    store.close();
    await $`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  });

  test("an E_SESSION_GONE-tagged failure is immediately terminal (rule 2's terminal case)", async () => {
    const store = openStore(":memory:");
    const gone = fakeAdapter("resume", {
      error: () => new Error("E_SESSION_GONE: resume refused for key k1"),
    });
    const router = new DeliveryRouter({ store, adapters: [gone] });
    const session = store.sessions.register(claudeRef());
    store.createPin({ ...structuredClone(input), agentSession: claudeRef() }, {});
    await router.dispatch(lastEvent(store));
    expect(gone.calls).toHaveLength(1);
    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);
    expect(store.deliveries.due(FUTURE)).toEqual([]); // failed terminally, not re-scheduled
    store.close();
  });
});

describe("escalation — pull rows re-select after the recorded adapter", () => {
  test("hooks row left pending past its escalation due_at escalates to the next adapter", async () => {
    const store = openStore(":memory:");
    const hooks = fakeAdapter("hooks");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [hooks, push] });
    const session = store.sessions.register(claudeRef());
    store.createPin(structuredClone(input), {});
    const before = Date.now();
    await router.dispatch(lastEvent(store));
    const after = Date.now();

    // Pull-based: the row IS the delivery — pending with an escalation due_at.
    const row = store.deliveries.pendingForSession(session.id).at(0);
    expect(row?.adapter).toBe("hooks");
    expect(row?.attempts).toBe(0);
    const dueAt = Date.parse(row?.dueAt ?? "");
    expect(dueAt).toBeGreaterThanOrEqual(before + DEFAULT_HOOKS_ESCALATE_MS);
    expect(dueAt).toBeLessThanOrEqual(after + DEFAULT_HOOKS_ESCALATE_MS);
    expect(push.calls).toHaveLength(0);

    // The pull never came: drain past due_at picks the adapter AFTER hooks.
    await router.drainDue(FUTURE);
    expect(push.calls).toHaveLength(1);
    expect(push.calls.at(0)?.session.id).toBe(session.id);
    expect(store.deliveries.pendingForSession(session.id)).toEqual([]); // delivered
    store.close();
  });
});

describe("boot reconciliation", () => {
  test("drainDue dispatches events appended while no router was subscribed", async () => {
    const store = openStore(":memory:");
    store.sessions.register(claudeRef());
    const pin = store.createPin(structuredClone(input), {});
    store.addThreadMessage(pin.id, "human", "still broken");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    await router.drainDue(FUTURE);
    expect(push.calls).toHaveLength(2);
    expect(store.deliveries.lastEventSeq()).toBe(store.summary().lastEventSeq);
    store.close();
  });

  test("dispatching an event at or below the cursor is a no-op (no duplicate rows)", async () => {
    const store = openStore(":memory:");
    const push = fakeAdapter("push");
    const router = new DeliveryRouter({ store, adapters: [push] });
    store.createPin(structuredClone(input), {});
    const event = lastEvent(store);
    await router.dispatch(event);
    await router.dispatch(event);
    expect(store.deliveries.unassigned()).toHaveLength(1);
    store.close();
  });
});

describe("dispatch never rejects", () => {
  test("resolves even when the store throws", async () => {
    const store = openStore(":memory:");
    const throwing = {
      lastEventSeq(): number {
        throw new Error("database is locked");
      },
    } as unknown as DeliveryStore;
    const broken = Object.create(store, { deliveries: { value: throwing } }) as PinStore;
    const router = new DeliveryRouter({ store: broken, adapters: [fakeAdapter("push")] });
    store.createPin(structuredClone(input), {});
    await expect(router.dispatch(lastEvent(store))).resolves.toBeUndefined();
    await expect(router.drainDue()).resolves.toBeUndefined();
    store.close();
  });
});

describe("hooksEscalateMs", () => {
  test("defaults to 10 min and honors PINBOX_HOOKS_ESCALATE_MS", () => {
    expect(hooksEscalateMs()).toBe(DEFAULT_HOOKS_ESCALATE_MS);
    process.env["PINBOX_HOOKS_ESCALATE_MS"] = "5000";
    expect(hooksEscalateMs()).toBe(5000);
    process.env["PINBOX_HOOKS_ESCALATE_MS"] = "not-a-number";
    expect(hooksEscalateMs()).toBe(DEFAULT_HOOKS_ESCALATE_MS);
    delete process.env["PINBOX_HOOKS_ESCALATE_MS"];
  });
});
