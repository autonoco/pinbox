import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { Pin, ThreadMessage } from "./schema.ts";
import type { StoredEvent } from "./store.ts";
import { ConflictError, MIGRATIONS, NotFoundError, openStore } from "./store.ts";

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

describe("createPin / getPin", () => {
  test("roundtrips a pin with assigned id, open status, and merged env", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), { branch: "main", commit: "abc1234" });
    expect(pin.id).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(pin.status).toBe("open");
    expect(pin.schemaVersion).toBe(1);
    expect(Date.parse(pin.createdAt)).not.toBeNaN();
    expect(pin.env?.branch).toBe("main");
    expect(pin.env?.commit).toBe("abc1234");
    expect(pin.env?.browser).toBe("Chrome 130");
    const got = s.getPin(pin.id);
    expect(got).toEqual(pin);
    s.close();
  });

  test("empty env merge leaves branch/commit unset", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    expect(pin.env?.branch).toBeUndefined();
    expect(pin.env?.commit).toBeUndefined();
    s.close();
  });

  test("attachments round-trip through storage", () => {
    const s = openStore(":memory:");
    const withShot = {
      ...structuredClone(input),
      attachments: [
        {
          id: "att_1",
          kind: "screenshot" as const,
          path: "/tmp/pinbox/att_1.png",
          contentType: "image/png",
        },
      ],
    };
    const pin = s.createPin(withShot, {});
    expect(s.getPin(pin.id)?.attachments?.[0]?.path).toBe("/tmp/pinbox/att_1.png");
    s.close();
  });

  test("invalid input is rejected before touching storage", () => {
    const s = openStore(":memory:");
    expect(() => s.createPin({ ...structuredClone(input), text: "" }, {})).toThrow();
    expect(s.eventsAfter(0)).toEqual([]);
    s.close();
  });

  test("getPin returns null for unknown id", () => {
    const s = openStore(":memory:");
    expect(s.getPin("pin_zzzzzzzzzz")).toBeNull();
    s.close();
  });
});

describe("listPins", () => {
  test("orders newest first and filters by status", () => {
    const s = openStore(":memory:");
    const a = s.createPin(structuredClone(input), {});
    const b = s.createPin({ ...structuredClone(input), text: "second pin" }, {});
    expect(s.listPins().map((p) => p.id)).toEqual([b.id, a.id]);
    s.resolvePin(a.id, "human");
    expect(s.listPins({ status: "open" }).map((p) => p.id)).toEqual([b.id]);
    expect(s.listPins({ status: "resolved" }).map((p) => p.id)).toEqual([a.id]);
    s.close();
  });
});

describe("resolvePin", () => {
  test("resolve is once-only and event-logged", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), { branch: "main", commit: "abc1234" });
    const resolved = s.resolvePin(pin.id, "agent", "fixed padding");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.by).toBe("agent");
    expect(resolved.resolution?.note).toBe("fixed padding");
    expect(Date.parse(resolved.resolution?.at ?? "")).not.toBeNaN();
    expect(() => s.resolvePin(pin.id, "agent")).toThrow(ConflictError);
    expect(s.eventsAfter(0).map((e) => e.type)).toEqual(["pin.created", "pin.resolved"]);
    s.close();
  });

  test("unknown id throws NotFoundError", () => {
    const s = openStore(":memory:");
    expect(() => s.resolvePin("pin_zzzzzzzzzz", "human")).toThrow(NotFoundError);
    s.close();
  });
});

describe("thread messages", () => {
  test("add/get preserves insertion order and shapes messages", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const m1 = s.addThreadMessage(pin.id, "human", "can you fix this?");
    const m2 = s.addThreadMessage(pin.id, "agent", "on it");
    expect(m1.id).toMatch(/^msg_[a-z0-9]{10}$/);
    expect(m1.pinId).toBe(pin.id);
    expect(m1.role).toBe("human");
    const thread = s.getThread(pin.id);
    expect(thread.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(thread.map((m) => m.text)).toEqual(["can you fix this?", "on it"]);
    s.close();
  });

  test("unknown pin throws NotFoundError; empty thread is []", () => {
    const s = openStore(":memory:");
    expect(() => s.addThreadMessage("pin_zzzzzzzzzz", "human", "hi")).toThrow(NotFoundError);
    const pin = s.createPin(structuredClone(input), {});
    expect(s.getThread(pin.id)).toEqual([]);
    s.close();
  });
});

describe("due_at", () => {
  test("due_at drives the inbound poll queue", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    expect(s.pinsDueBefore(new Date().toISOString())).toEqual([]);
    s.setDueAt(pin.id, new Date(Date.now() - 1000).toISOString());
    expect(s.pinsDueBefore(new Date().toISOString()).map((p) => p.id)).toEqual([pin.id]);
    s.setDueAt(pin.id, null);
    expect(s.pinsDueBefore(new Date().toISOString())).toEqual([]);
    s.close();
  });

  test("future deadlines are not returned; oldest deadline first", () => {
    const s = openStore(":memory:");
    const a = s.createPin(structuredClone(input), {});
    const b = s.createPin({ ...structuredClone(input), text: "second pin" }, {});
    const c = s.createPin({ ...structuredClone(input), text: "third pin" }, {});
    s.setDueAt(a.id, new Date(Date.now() - 1000).toISOString());
    s.setDueAt(b.id, new Date(Date.now() - 5000).toISOString());
    s.setDueAt(c.id, new Date(Date.now() + 60_000).toISOString());
    expect(s.pinsDueBefore(new Date().toISOString()).map((p) => p.id)).toEqual([b.id, a.id]);
    s.close();
  });

  test("unknown id throws NotFoundError", () => {
    const s = openStore(":memory:");
    expect(() => s.setDueAt("pin_zzzzzzzzzz", null)).toThrow(NotFoundError);
    s.close();
  });
});

describe("event log", () => {
  test("eventsAfter cursors through pin.created, thread.message, pin.resolved", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    s.addThreadMessage(pin.id, "human", "note");
    s.resolvePin(pin.id, "human");
    const all = s.eventsAfter(0);
    expect(all.map((e) => e.type)).toEqual(["pin.created", "thread.message", "pin.resolved"]);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const e of all) expect(Date.parse(e.at)).not.toBeNaN();
    const last = seqs.at(-1);
    expect(s.eventsAfter(last ?? 0)).toEqual([]);
    const tail = s.eventsAfter(seqs[0] ?? 0);
    expect(tail.map((e) => e.type)).toEqual(["thread.message", "pin.resolved"]);
    s.close();
  });

  test("pin.created payload carries the full pin", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const [created] = s.eventsAfter(0);
    expect((created?.payload as { id?: string } | undefined)?.id).toBe(pin.id);
    s.close();
  });
});

describe("migrations", () => {
  const tmpDbPath = () =>
    `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-store-${crypto.randomUUID()}.db`;
  const cleanup = async (path: string) => {
    await $`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  };

  test("fresh db lands at user_version 4 with sessions, deliveries, cursors, fts, links", async () => {
    const path = tmpDbPath();
    const s = openStore(path);
    s.close();
    const db = new Database(path);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(4);
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toContain("sessions");
    expect(tables).toContain("deliveries");
    expect(tables).toContain("cursors");
    expect(tables).toContain("pins_fts");
    expect(tables).toContain("links");
    db.close();
    await cleanup(path);
  });

  test("a pre-migration db at user_version 0 migrates cleanly and keeps its rows", async () => {
    const path = tmpDbPath();
    const db = new Database(path);
    db.exec(MIGRATIONS[0]?.ddl ?? "");
    const pin = {
      ...structuredClone(input),
      id: "pin_aaaaaaaaaa",
      schemaVersion: 1,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    db.query("INSERT INTO pins (id, status, created_at, json) VALUES (?, ?, ?, ?)").run(
      pin.id,
      pin.status,
      pin.createdAt,
      JSON.stringify(pin),
    );
    db.close();
    const s = openStore(path);
    expect(s.getPin("pin_aaaaaaaaaa")?.text).toBe(input.text);
    s.sessions.register({ agent: "claude", key: "k1" }); // migration 2 tables are live
    s.close();
    const check = new Database(path);
    const version = check.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(4);
    check.close();
    await cleanup(path);
  });

  // Version 5 is reserved and must stay unused: the cloud adapter adds no table of its own.
  test("versions are strictly increasing and 5 stays reserved-unused", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.length).toBeGreaterThan(0);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i] as number).toBeGreaterThan(versions[i - 1] as number);
    }
    expect(versions).not.toContain(5);
  });

  // Migration 3: pins_fts is derived, so an older db must be backfilled, not just migrated.
  test("a pre-freeze db at user_version 0 backfills FTS from pins and thread_messages", async () => {
    const path = tmpDbPath();
    const raw = new Database(path);
    raw.exec(MIGRATIONS[0]?.ddl ?? "");
    const at = new Date().toISOString();
    const legacyPin = {
      ...structuredClone(input),
      id: "pin_legacy0000",
      schemaVersion: 1,
      status: "open",
      createdAt: at,
      text: "legacy searchable pin",
    };
    raw
      .query("INSERT INTO pins (id, status, created_at, json) VALUES (?, ?, ?, ?)")
      .run(legacyPin.id, "open", at, JSON.stringify(legacyPin));
    raw
      .query("INSERT INTO events (type, at, payload) VALUES (?, ?, ?)")
      .run("pin.created", at, JSON.stringify(legacyPin));
    const legacyMessage = {
      id: "msg_legacy0000",
      pinId: legacyPin.id,
      role: "agent",
      text: "grid template mismatch",
      at,
    };
    raw
      .query("INSERT INTO thread_messages (id, pin_id, at, json) VALUES (?, ?, ?, ?)")
      .run(legacyMessage.id, legacyPin.id, at, JSON.stringify(legacyMessage));
    raw.close();

    const s = openStore(path);
    expect(s.getPin(legacyPin.id)?.text).toBe("legacy searchable pin");
    expect(s.searchPins("legacy").map((p) => p.id)).toEqual([legacyPin.id]);
    expect(s.searchPins("grid").map((p) => p.id)).toEqual([legacyPin.id]);
    s.close();
    await cleanup(path);
  });
});

describe("verifyPin", () => {
  test("accepted keeps status resolved and records verification; appends pin.verified", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    s.resolvePin(pin.id, "agent", "fixed");
    const verified = s.verifyPin(pin.id, "accepted");
    expect(verified.status).toBe("resolved");
    expect(verified.verification?.outcome).toBe("accepted");
    expect(Date.parse(verified.verification?.at ?? "")).not.toBeNaN();
    expect(s.getPin(pin.id)).toEqual(verified);
    const last = s.eventsAfter(0).at(-1);
    expect(last?.type).toBe("pin.verified");
    expect(last?.payload).toEqual(verified);
    s.close();
  });

  test("reopened flips status to open and keeps resolution as history", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    s.resolvePin(pin.id, "agent", "fixed padding");
    const reopened = s.verifyPin(pin.id, "reopened");
    expect(reopened.status).toBe("open");
    expect(reopened.resolution?.note).toBe("fixed padding");
    expect(reopened.verification?.outcome).toBe("reopened");
    expect(s.getPin(pin.id)?.status).toBe("open");
    s.close();
  });

  test("ConflictError on an open pin; NotFoundError on an unknown id", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    expect(() => s.verifyPin(pin.id, "accepted")).toThrow(ConflictError);
    expect(() => s.verifyPin("pin_zzzzzzzzzz", "accepted")).toThrow(NotFoundError);
    s.close();
  });
});

describe("searchPins", () => {
  test("matches pin text and thread-message text, newest first", () => {
    const s = openStore(":memory:");
    const a = s.createPin({ ...structuredClone(input), text: "avatar is cut off" }, {});
    const b = s.createPin({ ...structuredClone(input), text: "header is cut off" }, {});
    s.addThreadMessage(a.id, "agent", "the flexbox gap was wrong");
    expect(s.searchPins("avatar").map((p) => p.id)).toEqual([a.id]);
    // matched only via the reply text
    expect(s.searchPins("flexbox").map((p) => p.id)).toEqual([a.id]);
    // both match; newest first
    expect(s.searchPins("cut").map((p) => p.id)).toEqual([b.id, a.id]);
    s.close();
  });

  test("no match returns []; quotes and question marks do not throw", () => {
    const s = openStore(":memory:");
    s.createPin(structuredClone(input), {});
    expect(s.searchPins("zebra")).toEqual([]);
    expect(() => s.searchPins('weird"quote')).not.toThrow();
    expect(() => s.searchPins("what?")).not.toThrow();
    s.close();
  });
});

describe("cursors", () => {
  test("get unknown is 0; set round-trips and overwrites", () => {
    const s = openStore(":memory:");
    expect(s.cursors.get("c1")).toBe(0);
    s.cursors.set("c1", 5);
    expect(s.cursors.get("c1")).toBe(5);
    s.cursors.set("c1", 9);
    expect(s.cursors.get("c1")).toBe(9);
    s.close();
  });
});

describe("subscribe", () => {
  test("fires post-commit in seq order for create → reply → resolve; unsubscribe stops delivery", () => {
    const s = openStore(":memory:");
    const seen: { type: string; seq: number }[] = [];
    const unsubscribe = s.subscribe((e) => seen.push({ type: e.type, seq: e.seq }));
    const pin = s.createPin(structuredClone(input), {});
    s.addThreadMessage(pin.id, "human", "note");
    s.resolvePin(pin.id, "human");
    expect(seen.map((e) => e.type)).toEqual(["pin.created", "thread.message", "pin.resolved"]);
    expect(seen.map((e) => e.seq)).toEqual(s.eventsAfter(0).map((e) => e.seq));
    unsubscribe();
    s.createPin(structuredClone(input), {});
    expect(seen.length).toBe(3);
    s.close();
  });

  test("a throwing listener breaks neither the mutation nor later listeners", () => {
    const s = openStore(":memory:");
    const seen: string[] = [];
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe((e) => seen.push(e.type));
    const pin = s.createPin(structuredClone(input), {});
    expect(s.getPin(pin.id)).not.toBeNull();
    expect(seen).toEqual(["pin.created"]);
    s.close();
  });

  test("listeners observe committed state, not mid-transaction state", () => {
    const s = openStore(":memory:");
    const observed: (Pin | null)[] = [];
    s.subscribe((e) => {
      if (e.type === "pin.created") observed.push(s.getPin((e.payload as Pin).id));
    });
    const pin = s.createPin(structuredClone(input), {});
    expect(observed[0]?.id).toBe(pin.id);
    s.close();
  });
});

describe("addThreadMessage attachments", () => {
  test("opts.attachments round-trip and ride the thread.message event payload", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const att = {
      id: "att_abcdefghij",
      kind: "screenshot" as const,
      path: "/tmp/pinbox/att_abcdefghij.webp",
      contentType: "image/webp",
    };
    const message = s.addThreadMessage(pin.id, "human", "see the shot", { attachments: [att] });
    expect(message.attachments?.[0]?.path).toBe("/tmp/pinbox/att_abcdefghij.webp");
    expect(s.getThread(pin.id)[0]?.attachments?.[0]?.id).toBe("att_abcdefghij");
    const last = s.eventsAfter(0).at(-1) as StoredEvent;
    expect(last.type).toBe("thread.message");
    expect((last.payload as ThreadMessage).attachments?.[0]?.contentType).toBe("image/webp");
    s.close();
  });
});

describe("bindSession", () => {
  test("persists agentSession without appending an event", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const ref = { agent: "claude", key: "e2e-s1", cwd: "/tmp/proj" };
    const bound = s.bindSession(pin.id, ref);
    expect(bound.agentSession).toEqual(ref);
    expect(s.getPin(pin.id)?.agentSession).toEqual(ref);
    expect(s.eventsAfter(0).map((e) => e.type)).toEqual(["pin.created"]);
    s.close();
  });

  test("unknown pin throws NotFoundError", () => {
    const s = openStore(":memory:");
    expect(() => s.bindSession("pin_zzzzzzzzzz", { agent: "claude", key: "k" })).toThrow(
      NotFoundError,
    );
    s.close();
  });
});

describe("resolvePin with commit", () => {
  test("sets resolution.commit", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const resolved = s.resolvePin(pin.id, "agent", "note", "abc1234");
    expect(resolved.resolution?.commit).toBe("abc1234");
    expect(resolved.resolution?.note).toBe("note");
    expect(s.getPin(pin.id)?.resolution?.commit).toBe("abc1234");
    s.close();
  });
});

describe("addThreadMessage opts", () => {
  test("stores origin on mirror messages", () => {
    const s = openStore(":memory:");
    const pin = s.createPin(structuredClone(input), {});
    const m = s.addThreadMessage(pin.id, "mirror", "hi", { origin: "github:benji" });
    expect(m.origin).toBe("github:benji");
    expect(s.getThread(pin.id)[0]?.origin).toBe("github:benji");
    s.close();
  });
});

describe("summary", () => {
  test("counts open/resolved and reports last event seq", () => {
    const s = openStore(":memory:");
    expect(s.summary()).toEqual({ open: 0, resolved: 0, lastEventSeq: 0 });
    const a = s.createPin(structuredClone(input), {});
    s.createPin({ ...structuredClone(input), text: "second pin" }, {});
    s.resolvePin(a.id, "human");
    const sum = s.summary();
    expect(sum.open).toBe(1);
    expect(sum.resolved).toBe(1);
    expect(s.eventsAfter(0).at(-1)?.seq).toBe(sum.lastEventSeq);
    s.close();
  });
});
