import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { NotFoundError, openStore } from "./store.ts";

const T0 = new Date("2026-08-04T10:00:00.000Z");
const T1 = new Date("2026-08-04T10:01:00.000Z");
const T2 = new Date("2026-08-04T10:02:00.000Z");

afterEach(() => {
  setSystemTime();
});

describe("register", () => {
  test("assigns a ses_ id and stamps registeredAt/lastSeenAt", () => {
    const s = openStore(":memory:");
    const ses = s.sessions.register({ agent: "claude", key: "k1", cwd: "/tmp/proj" });
    expect(ses.id).toMatch(/^ses_[a-z0-9]{10}$/);
    expect(ses.agent).toBe("claude");
    expect(ses.key).toBe("k1");
    expect(ses.cwd).toBe("/tmp/proj");
    expect(Date.parse(ses.registeredAt)).not.toBeNaN();
    expect(ses.lastSeenAt).toBe(ses.registeredAt);
    expect(ses.endedAt).toBeUndefined();
    s.close();
  });

  test("re-register same (agent, key) keeps id, bumps lastSeenAt, updates cwd, clears endedAt", () => {
    const s = openStore(":memory:");
    setSystemTime(T0);
    const first = s.sessions.register({ agent: "claude", key: "k1", cwd: "/tmp/a" });
    s.sessions.end(first.id);
    setSystemTime(T1);
    const again = s.sessions.register({ agent: "claude", key: "k1", cwd: "/tmp/b" });
    expect(again.id).toBe(first.id);
    expect(again.registeredAt).toBe(T0.toISOString());
    expect(again.lastSeenAt).toBe(T1.toISOString());
    expect(again.cwd).toBe("/tmp/b");
    expect(again.endedAt).toBeUndefined();
    expect(s.sessions.list().length).toBe(1);
    s.close();
  });

  test("different keys are different sessions", () => {
    const s = openStore(":memory:");
    const a = s.sessions.register({ agent: "claude", key: "k1" });
    const b = s.sessions.register({ agent: "claude", key: "k2" });
    expect(a.id).not.toBe(b.id);
    expect(s.sessions.list().length).toBe(2);
    s.close();
  });
});

describe("get / findByRef / list", () => {
  test("roundtrips by id and by (agent, key)", () => {
    const s = openStore(":memory:");
    const ses = s.sessions.register({ agent: "codex", key: "k9", cwd: "/tmp/x" });
    expect(s.sessions.get(ses.id)).toEqual(ses);
    expect(s.sessions.findByRef({ agent: "codex", key: "k9" })).toEqual(ses);
    expect(s.sessions.get("ses_zzzzzzzzzz")).toBeNull();
    expect(s.sessions.findByRef({ agent: "codex", key: "nope" })).toBeNull();
    s.close();
  });

  test("list orders most recently seen first", () => {
    const s = openStore(":memory:");
    setSystemTime(T0);
    const a = s.sessions.register({ agent: "claude", key: "k1" });
    setSystemTime(T1);
    const b = s.sessions.register({ agent: "claude", key: "k2" });
    expect(s.sessions.list().map((x) => x.id)).toEqual([b.id, a.id]);
    setSystemTime(T2);
    s.sessions.touch(a.id);
    expect(s.sessions.list().map((x) => x.id)).toEqual([a.id, b.id]);
    s.close();
  });
});

describe("active", () => {
  test("returns the most recently seen non-ended session, null when all ended", () => {
    const s = openStore(":memory:");
    expect(s.sessions.active()).toBeNull();
    setSystemTime(T0);
    const a = s.sessions.register({ agent: "claude", key: "k1" });
    setSystemTime(T1);
    const b = s.sessions.register({ agent: "claude", key: "k2" });
    expect(s.sessions.active()?.id).toBe(b.id);
    s.sessions.end(b.id);
    expect(s.sessions.active()?.id).toBe(a.id);
    s.sessions.end(a.id);
    expect(s.sessions.active()).toBeNull();
    s.close();
  });
});

describe("touch / end", () => {
  test("touch bumps lastSeenAt", () => {
    const s = openStore(":memory:");
    setSystemTime(T0);
    const ses = s.sessions.register({ agent: "claude", key: "k1" });
    setSystemTime(T2);
    s.sessions.touch(ses.id);
    expect(s.sessions.get(ses.id)?.lastSeenAt).toBe(T2.toISOString());
    s.close();
  });

  test("end sets endedAt", () => {
    const s = openStore(":memory:");
    setSystemTime(T0);
    const ses = s.sessions.register({ agent: "claude", key: "k1" });
    setSystemTime(T1);
    s.sessions.end(ses.id);
    expect(s.sessions.get(ses.id)?.endedAt).toBe(T1.toISOString());
    s.close();
  });

  test("unknown id throws NotFoundError", () => {
    const s = openStore(":memory:");
    expect(() => s.sessions.touch("ses_zzzzzzzzzz")).toThrow(NotFoundError);
    expect(() => s.sessions.end("ses_zzzzzzzzzz")).toThrow(NotFoundError);
    s.close();
  });
});
