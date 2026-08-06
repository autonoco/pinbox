import { describe, expect, test } from "bun:test";
import { openStore } from "./store.ts";

const PAST = "2026-08-04T11:00:00.000Z";
const NOW = "2026-08-04T12:00:00.000Z";
const FUTURE = "2026-08-04T13:00:00.000Z";

describe("enqueue", () => {
  test("defaults to a pending row with zero attempts", () => {
    const s = openStore(":memory:");
    const row = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: null,
      adapter: "hooks",
      dueAt: null,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.eventSeq).toBe(1);
    expect(row.sessionId).toBeNull();
    expect(row.adapter).toBe("hooks");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.dueAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(Date.parse(row.updatedAt)).not.toBeNaN();
    s.close();
  });

  test("accepts an explicit skipped status", () => {
    const s = openStore(":memory:");
    const row = s.deliveries.enqueue({
      eventSeq: 2,
      sessionId: null,
      adapter: "none",
      dueAt: null,
      status: "skipped",
    });
    expect(row.status).toBe("skipped");
    s.close();
  });
});

describe("due", () => {
  test("honors due_at IS NULL OR due_at <= now and excludes non-pending rows", () => {
    const s = openStore(":memory:");
    const immediate = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    const past = s.deliveries.enqueue({
      eventSeq: 2,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: PAST,
    });
    s.deliveries.enqueue({ eventSeq: 3, sessionId: "ses_a", adapter: "hooks", dueAt: FUTURE });
    s.deliveries.enqueue({
      eventSeq: 4,
      sessionId: null,
      adapter: "none",
      dueAt: null,
      status: "skipped",
    });
    const delivered = s.deliveries.enqueue({
      eventSeq: 5,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.markDelivered(delivered.id);
    const failed = s.deliveries.enqueue({
      eventSeq: 6,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.markFailed(failed.id, "boom", null);
    expect(s.deliveries.due(NOW).map((r) => r.id)).toEqual([immediate.id, past.id]);
    s.close();
  });
});

describe("pendingForSession / unassigned / assign", () => {
  test("pendingForSession returns only that session's pending rows", () => {
    const s = openStore(":memory:");
    const a = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.enqueue({ eventSeq: 2, sessionId: "ses_b", adapter: "hooks", dueAt: null });
    const done = s.deliveries.enqueue({
      eventSeq: 3,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.markDelivered(done.id);
    expect(s.deliveries.pendingForSession("ses_a").map((r) => r.id)).toEqual([a.id]);
    s.close();
  });

  test("unassigned returns only null-session pending rows; assign claims them", () => {
    const s = openStore(":memory:");
    const orphan = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: null,
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.enqueue({ eventSeq: 2, sessionId: "ses_a", adapter: "hooks", dueAt: null });
    s.deliveries.enqueue({
      eventSeq: 3,
      sessionId: null,
      adapter: "none",
      dueAt: null,
      status: "skipped",
    });
    expect(s.deliveries.unassigned().map((r) => r.id)).toEqual([orphan.id]);
    s.deliveries.assign(orphan.id, "ses_b");
    expect(s.deliveries.unassigned()).toEqual([]);
    expect(s.deliveries.pendingForSession("ses_b").map((r) => r.id)).toEqual([orphan.id]);
    s.close();
  });
});

describe("markDelivered / markFailed", () => {
  test("markDelivered flips the row to delivered", () => {
    const s = openStore(":memory:");
    const row = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: "ses_a",
      adapter: "hooks",
      dueAt: null,
    });
    s.deliveries.markDelivered(row.id);
    expect(s.deliveries.due(NOW)).toEqual([]);
    expect(s.deliveries.pendingForSession("ses_a")).toEqual([]);
    s.close();
  });

  test("markFailed with retryAt re-schedules with attempts+1; null retryAt is terminal", () => {
    const s = openStore(":memory:");
    const row = s.deliveries.enqueue({
      eventSeq: 1,
      sessionId: "ses_a",
      adapter: "resume",
      dueAt: null,
    });
    s.deliveries.markFailed(row.id, "spawn failed", FUTURE);
    expect(s.deliveries.due(NOW)).toEqual([]);
    const [retry] = s.deliveries.due(FUTURE);
    expect(retry?.id).toBe(row.id);
    expect(retry?.status).toBe("pending");
    expect(retry?.attempts).toBe(1);
    expect(retry?.dueAt).toBe(FUTURE);
    expect(retry?.lastError).toBe("spawn failed");
    s.deliveries.markFailed(row.id, "E_DELIVERY: gave up", null);
    expect(s.deliveries.due(FUTURE)).toEqual([]);
    expect(s.deliveries.pendingForSession("ses_a")).toEqual([]);
    const again = s.deliveries.enqueue({
      eventSeq: 2,
      sessionId: "ses_a",
      adapter: "resume",
      dueAt: null,
    });
    expect(again.attempts).toBe(0); // terminal failure did not leak into new rows
    s.close();
  });
});

describe("lastEventSeq", () => {
  test("is MAX(event_seq) including skipped rows, 0 when empty", () => {
    const s = openStore(":memory:");
    expect(s.deliveries.lastEventSeq()).toBe(0);
    s.deliveries.enqueue({ eventSeq: 3, sessionId: "ses_a", adapter: "hooks", dueAt: null });
    s.deliveries.enqueue({
      eventSeq: 7,
      sessionId: null,
      adapter: "none",
      dueAt: null,
      status: "skipped",
    });
    expect(s.deliveries.lastEventSeq()).toBe(7);
    s.close();
  });
});
