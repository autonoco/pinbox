// DO SQLite PinStore — the second and final PinStore implementation, exercised on
// workerd (the runtime it ships to). Ports the store.test.ts cases and adds the
// member groups that complete the PinStore interface.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { type DoPinStore, openDoStore } from "../../packages/core/src/do-store.ts";
import { ConflictError, NotFoundError } from "../../packages/core/src/store.ts";
import { pinInput } from "./fixtures/pin-fixtures.ts";
import type { StoreDo } from "./fixtures/store-do.ts";

async function withStore<T>(
  fn: (store: DoPinStore, instance: StoreDo) => T | Promise<T>,
): Promise<T> {
  const stub = env.STORE_DO.get(env.STORE_DO.idFromName(crypto.randomUUID()));
  return await runInDurableObject(stub, async (instance: StoreDo) => fn(instance.store, instance));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createPin / getPin", () => {
  test("roundtrips a pin with assigned id, open status, and merged env", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), { branch: "main", commit: "abc1234" });
      expect(pin.id).toMatch(/^pin_[a-z0-9]{10}$/);
      expect(pin.status).toBe("open");
      expect(pin.schemaVersion).toBe(1);
      expect(Date.parse(pin.createdAt)).not.toBeNaN();
      expect(pin.env?.branch).toBe("main");
      expect(pin.env?.commit).toBe("abc1234");
      expect(pin.env?.browser).toBe("Chrome 130");
      expect(s.getPin(pin.id)).toEqual(pin);
    });
  });

  test("empty env merge leaves branch/commit unset; unknown id is null", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      expect(pin.env?.branch).toBeUndefined();
      expect(pin.env?.commit).toBeUndefined();
      expect(s.getPin("pin_zzzzzzzzzz")).toBeNull();
    });
  });

  test("invalid input is rejected before touching storage", async () => {
    await withStore((s) => {
      expect(() => s.createPin(pinInput(""), {})).toThrow();
      expect(s.eventsAfter(0)).toEqual([]);
    });
  });
});

describe("listPins", () => {
  test("orders newest first and filters by status", async () => {
    await withStore((s) => {
      const a = s.createPin(pinInput(), {});
      const b = s.createPin(pinInput("second pin"), {});
      expect(s.listPins().map((p) => p.id)).toEqual([b.id, a.id]);
      s.resolvePin(a.id, "human");
      expect(s.listPins({ status: "open" }).map((p) => p.id)).toEqual([b.id]);
      expect(s.listPins({ status: "resolved" }).map((p) => p.id)).toEqual([a.id]);
    });
  });
});

describe("resolvePin", () => {
  test("resolve is once-only and event-logged", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const resolved = s.resolvePin(pin.id, "agent", "fixed padding");
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolution?.by).toBe("agent");
      expect(resolved.resolution?.note).toBe("fixed padding");
      expect(() => s.resolvePin(pin.id, "agent")).toThrow(ConflictError);
      expect(s.eventsAfter(0).map((e) => e.type)).toEqual(["pin.created", "pin.resolved"]);
      expect(() => s.resolvePin("pin_zzzzzzzzzz", "human")).toThrow(NotFoundError);
    });
  });

  test("trailing commit param lands in resolution.commit", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const resolved = s.resolvePin(pin.id, "agent", "done", "abc1234");
      expect(resolved.resolution?.commit).toBe("abc1234");
    });
  });
});

describe("thread messages", () => {
  test("add/get preserves insertion order and shapes messages", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const m1 = s.addThreadMessage(pin.id, "human", "can you fix this?");
      const m2 = s.addThreadMessage(pin.id, "agent", "on it");
      expect(m1.id).toMatch(/^msg_[a-z0-9]{10}$/);
      expect(m1.pinId).toBe(pin.id);
      const thread = s.getThread(pin.id);
      expect(thread.map((m) => m.id)).toEqual([m1.id, m2.id]);
      expect(thread.map((m) => m.text)).toEqual(["can you fix this?", "on it"]);
      expect(() => s.addThreadMessage("pin_zzzzzzzzzz", "human", "hi")).toThrow(NotFoundError);
    });
  });

  test("additive opts param carries origin and attachments", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const m = s.addThreadMessage(pin.id, "mirror", "mirrored from slack", {
        origin: "slack:U123",
        attachments: [{ id: "att_1", kind: "file", url: "https://media.example/att_1" }],
      });
      expect(m.origin).toBe("slack:U123");
      const stored = s.getThread(pin.id)[0];
      expect(stored?.origin).toBe("slack:U123");
      expect(stored?.attachments?.[0]?.url).toBe("https://media.example/att_1");
    });
  });
});

describe("due_at", () => {
  test("due_at drives the inbound poll queue, oldest deadline first", async () => {
    await withStore((s) => {
      const a = s.createPin(pinInput(), {});
      const b = s.createPin(pinInput("second pin"), {});
      const c = s.createPin(pinInput("third pin"), {});
      expect(s.pinsDueBefore(new Date().toISOString())).toEqual([]);
      s.setDueAt(a.id, new Date(Date.now() - 1000).toISOString());
      s.setDueAt(b.id, new Date(Date.now() - 5000).toISOString());
      s.setDueAt(c.id, new Date(Date.now() + 60_000).toISOString());
      expect(s.pinsDueBefore(new Date().toISOString()).map((p) => p.id)).toEqual([b.id, a.id]);
      s.setDueAt(a.id, null);
      expect(s.pinsDueBefore(new Date().toISOString()).map((p) => p.id)).toEqual([b.id]);
      expect(() => s.setDueAt("pin_zzzzzzzzzz", null)).toThrow(NotFoundError);
    });
  });
});

describe("event log", () => {
  test("eventsAfter cursors through the log in seq order", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      s.addThreadMessage(pin.id, "human", "note");
      s.resolvePin(pin.id, "human");
      const all = s.eventsAfter(0);
      expect(all.map((e) => e.type)).toEqual(["pin.created", "thread.message", "pin.resolved"]);
      const seqs = all.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect((all[0]?.payload as { id?: string } | undefined)?.id).toBe(pin.id);
      expect(s.eventsAfter(seqs.at(-1) ?? 0)).toEqual([]);
      expect(s.eventsAfter(seqs[0] ?? 0).map((e) => e.type)).toEqual([
        "thread.message",
        "pin.resolved",
      ]);
    });
  });
});

describe("summary", () => {
  test("counts open/resolved and reports last event seq", async () => {
    await withStore((s) => {
      expect(s.summary()).toEqual({ open: 0, resolved: 0, lastEventSeq: 0 });
      const a = s.createPin(pinInput(), {});
      s.createPin(pinInput("second pin"), {});
      s.resolvePin(a.id, "human");
      const sum = s.summary();
      expect(sum.open).toBe(1);
      expect(sum.resolved).toBe(1);
      expect(s.eventsAfter(0).at(-1)?.seq).toBe(sum.lastEventSeq);
    });
  });
});

describe("sessions", () => {
  test("register upserts by (agent, key): keeps id, refreshes lastSeenAt, clears endedAt", async () => {
    await withStore(async (s) => {
      const first = s.sessions.register({ agent: "claude", key: "k1", cwd: "/repo" });
      expect(first.id).toMatch(/^ses_[a-z0-9]{10}$/);
      expect(first.lastSeenAt).toBe(first.registeredAt);
      s.sessions.end(first.id);
      expect(s.sessions.get(first.id)?.endedAt).toBeDefined();
      await sleep(10);
      const again = s.sessions.register({ agent: "claude", key: "k1", cwd: "/repo2" });
      expect(again.id).toBe(first.id);
      expect(again.registeredAt).toBe(first.registeredAt);
      expect(Date.parse(again.lastSeenAt)).toBeGreaterThan(Date.parse(first.lastSeenAt));
      expect(again.endedAt).toBeUndefined();
      expect(again.cwd).toBe("/repo2");
      const other = s.sessions.register({ agent: "claude", key: "k2" });
      expect(other.id).not.toBe(first.id);
    });
  });

  test("findByRef / active / touch / list / end", async () => {
    await withStore(async (s) => {
      expect(s.sessions.active()).toBeNull();
      const a = s.sessions.register({ agent: "claude", key: "a" });
      await sleep(10);
      const b = s.sessions.register({ agent: "codex", key: "b" });
      expect(s.sessions.findByRef({ agent: "claude", key: "a" })?.id).toBe(a.id);
      expect(s.sessions.findByRef({ agent: "claude", key: "nope" })).toBeNull();
      expect(s.sessions.active()?.id).toBe(b.id);
      await sleep(10);
      s.sessions.touch(a.id);
      expect(s.sessions.active()?.id).toBe(a.id);
      expect(
        s.sessions
          .list()
          .map((x) => x.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      s.sessions.end(a.id);
      expect(s.sessions.active()?.id).toBe(b.id);
      expect(() => s.sessions.touch("ses_zzzzzzzzzz")).toThrow(NotFoundError);
      expect(() => s.sessions.end("ses_zzzzzzzzzz")).toThrow(NotFoundError);
    });
  });
});

describe("deliveries + bindSession", () => {
  test("enqueue/due/assign/mark round-trip and lastEventSeq boot cursor", async () => {
    await withStore((s) => {
      expect(s.deliveries.lastEventSeq()).toBe(0);
      const now = new Date().toISOString();
      const row = s.deliveries.enqueue({
        eventSeq: 1,
        sessionId: null,
        adapter: "webhook",
        dueAt: null,
      });
      expect(row.status).toBe("pending");
      expect(s.deliveries.unassigned().map((r) => r.id)).toEqual([row.id]);
      expect(s.deliveries.due(now).map((r) => r.id)).toEqual([row.id]);
      s.deliveries.assign(row.id, "ses_aaaaaaaaaa");
      expect(s.deliveries.unassigned()).toEqual([]);
      expect(s.deliveries.pendingForSession("ses_aaaaaaaaaa").map((r) => r.id)).toEqual([row.id]);
      s.deliveries.markFailed(row.id, "boom", new Date(Date.now() + 60_000).toISOString());
      const retried = s.deliveries.pendingForSession("ses_aaaaaaaaaa")[0];
      expect(retried?.attempts).toBe(1);
      expect(retried?.lastError).toBe("boom");
      expect(s.deliveries.due(now)).toEqual([]); // future retry not due yet
      s.deliveries.markDelivered(row.id);
      expect(s.deliveries.pendingForSession("ses_aaaaaaaaaa")).toEqual([]);
      const terminal = s.deliveries.enqueue({
        eventSeq: 7,
        sessionId: null,
        adapter: "webhook",
        dueAt: null,
      });
      s.deliveries.markFailed(terminal.id, "gone", null);
      expect(s.deliveries.due(new Date().toISOString())).toEqual([]);
      expect(s.deliveries.lastEventSeq()).toBe(7);
    });
  });

  test("bindSession persists pin.agentSession without appending an event", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const before = s.eventsAfter(0).length;
      const bound = s.bindSession(pin.id, { agent: "claude", key: "k1" });
      expect(bound.agentSession).toEqual({ agent: "claude", key: "k1" });
      expect(s.getPin(pin.id)?.agentSession?.key).toBe("k1");
      expect(s.eventsAfter(0).length).toBe(before);
      expect(() => s.bindSession("pin_zzzzzzzzzz", { agent: "claude", key: "x" })).toThrow(
        NotFoundError,
      );
    });
  });
});

describe("verifyPin", () => {
  test("accepted keeps status resolved; conflict unless currently resolved", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      expect(() => s.verifyPin(pin.id, "accepted")).toThrow(ConflictError); // open, not resolved
      s.resolvePin(pin.id, "agent");
      const verified = s.verifyPin(pin.id, "accepted");
      expect(verified.status).toBe("resolved");
      expect(verified.verification?.outcome).toBe("accepted");
      expect(s.eventsAfter(0).map((e) => e.type)).toEqual([
        "pin.created",
        "pin.resolved",
        "pin.verified",
      ]);
      expect(() => s.verifyPin("pin_zzzzzzzzzz", "accepted")).toThrow(NotFoundError);
    });
  });

  test("reopened flips status back to open and keeps resolution as history", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      s.resolvePin(pin.id, "agent", "hopefully fixed");
      const reopened = s.verifyPin(pin.id, "reopened");
      expect(reopened.status).toBe("open");
      expect(reopened.resolution?.note).toBe("hopefully fixed");
      expect(reopened.verification?.outcome).toBe("reopened");
      expect(() => s.verifyPin(pin.id, "accepted")).toThrow(ConflictError); // no longer resolved
      const payload = s.eventsAfter(0).at(-1)?.payload as { status?: string } | undefined;
      expect(payload?.status).toBe("open");
    });
  });
});

describe("searchPins + cursors", () => {
  test("FTS5 MATCH over pin text and thread bodies, newest first", async () => {
    await withStore((s) => {
      const a = s.createPin(pinInput("the header wobbles on scroll"), {});
      const b = s.createPin(pinInput("footer link is dead"), {});
      const c = s.createPin(pinInput("header color is wrong"), {});
      s.addThreadMessage(b.id, "human", "actually the header too");
      expect(s.searchPins("header").map((p) => p.id)).toEqual([c.id, b.id, a.id]);
      expect(s.searchPins("wobbles").map((p) => p.id)).toEqual([a.id]);
      expect(s.searchPins("zebra")).toEqual([]);
      expect(s.searchPins("   ")).toEqual([]);
    });
  });

  test("cursors get/set: 0 when unknown, upsert on set", async () => {
    await withStore((s) => {
      expect(s.cursors.get("toolbar-1")).toBe(0);
      s.cursors.set("toolbar-1", 5);
      expect(s.cursors.get("toolbar-1")).toBe(5);
      s.cursors.set("toolbar-1", 9);
      expect(s.cursors.get("toolbar-1")).toBe(9);
      expect(s.cursors.get("toolbar-2")).toBe(0);
    });
  });
});

describe("links", () => {
  const link = {
    connector: "github",
    ref: "owner/repo#1",
    url: "https://github.com/owner/repo/issues/1",
  };

  test("addLink appends pin.linked, updates pin json and links table in one transaction", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      const updated = s.addLink(pin.id, link);
      expect(updated.links).toEqual([link]);
      expect(s.getPin(pin.id)?.links).toEqual([link]);
      expect(s.links.forPin(pin.id)).toEqual([link]);
      expect(s.eventsAfter(0).map((e) => e.type)).toEqual(["pin.created", "pin.linked"]);
      expect(() => s.addLink("pin_zzzzzzzzzz", link)).toThrow(NotFoundError);
    });
  });

  test("duplicate (connector, ref) for the pin throws ConflictError", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      s.addLink(pin.id, link);
      expect(() => s.addLink(pin.id, { ...link })).toThrow(ConflictError);
      s.addLink(pin.id, { ...link, ref: "owner/repo#2" }); // different ref is fine
      expect(s.links.forPin(pin.id)).toHaveLength(2);
    });
  });

  test("links.all + markSynced expose the sync ledger", async () => {
    await withStore((s) => {
      const pin = s.createPin(pinInput(), {});
      s.addLink(pin.id, link);
      expect(s.links.all()).toEqual([{ pinId: pin.id, link, lastSyncedAt: null }]);
      const at = new Date().toISOString();
      s.links.markSynced(pin.id, { connector: link.connector, ref: link.ref }, at);
      expect(s.links.all()[0]?.lastSyncedAt).toBe(at);
    });
  });
});

describe("migrations on DO SQLite", () => {
  test("idempotent across two openDoStore calls on the same storage", async () => {
    await withStore((_s, instance) => {
      const first = openDoStore(instance.ctx.storage.sql, instance.ctx.storage);
      const pin = first.createPin(pinInput(), {});
      const second = openDoStore(instance.ctx.storage.sql, instance.ctx.storage);
      expect(second.getPin(pin.id)?.id).toBe(pin.id); // replay was a no-op, data intact
      const third = second.createPin(pinInput("second pin"), {});
      expect(first.getPin(third.id)?.id).toBe(third.id);
    });
  });
});

describe("subscribe", () => {
  test("fires post-commit, in seq order, and survives throwing listeners", async () => {
    await withStore((s) => {
      const seen: number[] = [];
      const alsoSeen: string[] = [];
      const unsubThrowing = s.subscribe(() => {
        throw new Error("listener bug — must not break the mutating call");
      });
      s.subscribe((e) => {
        // post-commit: the mutation is already readable from the store
        const id =
          (e.payload as { id?: string; pinId?: string }).pinId ?? (e.payload as { id?: string }).id;
        if (e.type === "pin.created") expect(s.getPin(id ?? "")).not.toBeNull();
        seen.push(e.seq);
      });
      const unsub = s.subscribe((e) => {
        alsoSeen.push(e.type);
      });
      const pin = s.createPin(pinInput(), {});
      s.addThreadMessage(pin.id, "human", "note");
      unsub();
      unsubThrowing();
      s.resolvePin(pin.id, "human");
      expect(seen).toEqual(s.eventsAfter(0).map((e) => e.seq));
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(alsoSeen).toEqual(["pin.created", "thread.message"]); // unsubscribed before resolve
    });
  });

  test("no events fire for a failed mutation", async () => {
    await withStore((s) => {
      const seen: string[] = [];
      s.subscribe((e) => seen.push(e.type));
      const pin = s.createPin(pinInput(), {});
      s.resolvePin(pin.id, "human");
      expect(() => s.resolvePin(pin.id, "human")).toThrow(ConflictError);
      expect(seen).toEqual(["pin.created", "pin.resolved"]);
    });
  });
});
