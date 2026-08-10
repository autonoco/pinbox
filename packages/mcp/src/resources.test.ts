// Which resource an event touches. Get this wrong and a client is told the wrong thing changed —
// or nothing is, which is worse, because it looks exactly like a quiet system.
import { describe, expect, test } from "bun:test";
import { eventPinId, pinUri } from "./resources.ts";

const event = (payload: unknown) => ({ seq: 1, eventType: "thread.message" as const, payload });

describe("event → resource", () => {
  test("a thread message names its pin through pinId", () => {
    expect(eventPinId(event({ pinId: "pin_abc", text: "hi" }))).toBe("pin_abc");
  });

  test("a pin event names itself through id", () => {
    expect(eventPinId(event({ id: "pin_xyz" }))).toBe("pin_xyz");
  });

  test("pinId wins when a payload carries both — id is the message's own", () => {
    expect(eventPinId(event({ id: "msg_1", pinId: "pin_abc" }))).toBe("pin_abc");
  });

  test("a payload naming no pin yields null rather than a bogus uri", () => {
    expect(eventPinId(event({ note: "nothing here" }))).toBeNull();
    expect(eventPinId(event(null))).toBeNull();
    expect(eventPinId(event({ pinId: 42 }))).toBeNull();
  });
});

test("pin uris are stable and per-pin", () => {
  expect(pinUri("pin_abc")).toBe("pinbox://pins/pin_abc");
  expect(pinUri("pin_abc")).not.toBe(pinUri("pin_def"));
});
