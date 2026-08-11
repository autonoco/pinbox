// The cursor rules, which are the only place this can go quietly wrong. A socket that reconnects
// and replays the wrong slice does not fail loudly — it either spams a client with history or
// swallows pins, and both look like "it works" until someone is waiting on a pin that never came.
import { describe, expect, test } from "bun:test";
import { eventsToDeliver, hubStateFile } from "./hub-events.ts";

const STARTED = "2026-08-10T12:00:00.000Z";

const event = (seq: number, at: string, eventType = "pin.created") => ({
  type: "event",
  seq,
  eventType,
  at,
  payload: { id: `pin_${seq}` },
});

describe("cursor", () => {
  test("first catch-up delivers only what happened since watching began", () => {
    const cursor = { lastSeq: 0, primed: false };
    const delivered = eventsToDeliver(
      {
        type: "catch-up",
        lastSeq: 3,
        events: [
          event(1, "2026-08-10T11:00:00.000Z"), // before we started: history, not news
          event(2, "2026-08-10T11:59:59.000Z"),
          event(3, "2026-08-10T12:00:01.000Z"), // created while the hub was still booting
        ],
      },
      cursor,
      STARTED,
    );
    expect(delivered.map((e) => e.seq)).toEqual([3]);
    expect(cursor).toEqual({ lastSeq: 3, primed: true });
  });

  test("a pin created while the hub was starting is not swallowed", () => {
    // The whole reason the cut is `startedAt` and not "whatever the socket says when it lands":
    // the first tool call launches the hub, so the socket always attaches late.
    const cursor = { lastSeq: 0, primed: false };
    const late = eventsToDeliver(
      { type: "catch-up", lastSeq: 1, events: [event(1, "2026-08-10T12:00:05.000Z")] },
      cursor,
      STARTED,
    );
    expect(late).toHaveLength(1);
  });

  test("after a reconnect the catch-up is the gap, and all of it is delivered", () => {
    const cursor = { lastSeq: 3, primed: true };
    const delivered = eventsToDeliver(
      {
        type: "catch-up",
        lastSeq: 5,
        events: [event(4, "2026-08-10T11:00:00.000Z"), event(5, "2026-08-10T11:00:01.000Z")],
      },
      cursor,
      STARTED,
    );
    // Old timestamps, but missed while disconnected — the `startedAt` cut applies once, not again.
    expect(delivered.map((e) => e.seq)).toEqual([4, 5]);
    expect(cursor.lastSeq).toBe(5);
  });

  test("live frames pass straight through and advance the cursor", () => {
    const cursor = { lastSeq: 5, primed: true };
    expect(eventsToDeliver(event(6, STARTED, "thread.message"), cursor, STARTED)).toHaveLength(1);
    expect(cursor.lastSeq).toBe(6);
  });

  test("anything that is not an event frame is ignored", () => {
    const cursor = { lastSeq: 5, primed: true };
    expect(eventsToDeliver({ type: "error" }, cursor, STARTED)).toEqual([]);
    expect(cursor.lastSeq).toBe(5);
  });
});

test("hub discovery lands in the state dir, keyed per project", () => {
  const previous = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = "/tmp/state-home";
  try {
    const path = hubStateFile("/some/project");
    expect(path).toStartWith("/tmp/state-home/pinbox/");
    expect(path).toEndWith("/hub.json");
    // Two projects must never share a hub file, or one project reads the other's port and token.
    expect(hubStateFile("/other/project")).not.toBe(path);
  } finally {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
  }
});
