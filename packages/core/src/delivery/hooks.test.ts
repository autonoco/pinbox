// Hooks adapter tests — matches matrix over the hook-capable agent set, and the
// pull path end to end: dispatch leaves the row pending with an escalation due_at,
// the Task-2 inject route flips it to delivered, and a later drain has nothing to do.
import { describe, expect, test } from "bun:test";
import { routeSessions } from "../routes-sessions.ts";
import type { Session } from "../sessions.ts";
import { openStore } from "../store.ts";
import { createHooksAdapter, HOOK_CAPABLE_AGENTS } from "./hooks.ts";
import { DEFAULT_HOOKS_ESCALATE_MS, DeliveryRouter } from "./router.ts";

const NOW = "2026-08-04T12:00:00.000Z";
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

function makeSession(agent: string, over: Partial<Session> = {}): Session {
  return {
    id: "ses_aaaaaaaaaa",
    agent,
    key: "k1",
    registeredAt: NOW,
    lastSeenAt: NOW,
    ...over,
  };
}

describe("matches", () => {
  const adapter = createHooksAdapter();

  test("live claude, codex, and hermes sessions match", () => {
    for (const agent of ["claude", "codex", "hermes"]) {
      expect(HOOK_CAPABLE_AGENTS.has(agent)).toBe(true);
      expect(adapter.matches(makeSession(agent))).toBe(true);
    }
  });

  test("an ended session never matches", () => {
    expect(adapter.matches(makeSession("claude", { endedAt: NOW }))).toBe(false);
  });

  test("a non-hook-capable agent never matches", () => {
    expect(adapter.matches(makeSession("openclaw"))).toBe(false);
  });
});

describe("deliver — the row IS the delivery", () => {
  test("dispatch leaves the row pending with the escalation due_at and no error", async () => {
    const store = openStore(":memory:");
    const router = new DeliveryRouter({ store, adapters: [createHooksAdapter()] });
    const session = store.sessions.register({ agent: "claude", key: "k1", cwd: "/tmp/proj" });
    store.subscribe((e) => void router.dispatch(e));
    const before = Date.now();
    store.createPin(structuredClone(input), {});
    await router.drainDue(); // flush the serialized dispatch chain
    const after = Date.now();

    const row = store.deliveries.pendingForSession(session.id).at(0);
    expect(row?.adapter).toBe("hooks");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
    const dueAt = Date.parse(row?.dueAt ?? "");
    expect(dueAt).toBeGreaterThanOrEqual(before + DEFAULT_HOOKS_ESCALATE_MS);
    expect(dueAt).toBeLessThanOrEqual(after + DEFAULT_HOOKS_ESCALATE_MS);
    store.close();
  });

  test("the inject pull flips the row to delivered; a later drain has nothing to redeliver", async () => {
    const store = openStore(":memory:");
    const router = new DeliveryRouter({ store, adapters: [createHooksAdapter()] });
    const session = store.sessions.register({ agent: "claude", key: "k1", cwd: "/tmp/proj" });
    store.subscribe((e) => void router.dispatch(e));
    const pin = store.createPin(structuredClone(input), {});
    await router.drainDue();
    expect(store.deliveries.pendingForSession(session.id)).toHaveLength(1);

    const url = new URL(`http://hub.local/sessions/${session.id}/inject`);
    const res = await routeSessions(new Request(url, { method: "POST" }), url, {
      store,
      token: "t",
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      ok: boolean;
      data: { context: string; delivered: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.delivered).toBe(1);
    expect(body.data.context).toContain(pin.text);

    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);
    await router.drainDue(FUTURE); // escalation window passed, but the pull already delivered
    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);
    expect(store.deliveries.due(FUTURE)).toEqual([]);
    store.close();
  });
});
