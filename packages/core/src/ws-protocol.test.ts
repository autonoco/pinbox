// ws-protocol frame schemas + encodeWsEvent.
import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "./store.ts";
import {
  ClientHelloSchema,
  encodeWsEvent,
  ServerCatchUpSchema,
  ServerErrorSchema,
  WsEventSchema,
} from "./ws-protocol.ts";

describe("encodeWsEvent", () => {
  test("produces a WsEvent frame that round-trips through WsEventSchema", () => {
    const event: StoredEvent = {
      seq: 7,
      type: "pin.created",
      at: "2026-08-04T12:00:00.000Z",
      payload: { id: "pin_abcdefghij", text: "check the header" },
    };
    const frame = JSON.parse(encodeWsEvent(event));
    const parsed = WsEventSchema.parse(frame);
    expect(parsed.type).toBe("event");
    expect(parsed.seq).toBe(7);
    expect(parsed.at).toBe("2026-08-04T12:00:00.000Z");
    expect(parsed.eventType).toBe("pin.created");
    expect(parsed.payload).toEqual({ id: "pin_abcdefghij", text: "check the header" });
  });
});

describe("ClientHelloSchema", () => {
  test("accepts a well-formed hello", () => {
    expect(
      ClientHelloSchema.safeParse({ type: "hello", protocol: 1, consumerId: "c1", lastSeq: 0 })
        .success,
    ).toBe(true);
  });

  test("rejects a missing consumerId", () => {
    expect(ClientHelloSchema.safeParse({ type: "hello", protocol: 1, lastSeq: 0 }).success).toBe(
      false,
    );
  });

  test("rejects a negative lastSeq", () => {
    expect(
      ClientHelloSchema.safeParse({ type: "hello", protocol: 1, consumerId: "c1", lastSeq: -1 })
        .success,
    ).toBe(false);
  });
});

describe("ServerCatchUpSchema", () => {
  test("accepts an empty catch-up at protocol 1", () => {
    expect(
      ServerCatchUpSchema.safeParse({
        type: "catch-up",
        protocol: 1,
        minProtocol: 1,
        lastSeq: 0,
        events: [],
      }).success,
    ).toBe(true);
  });
});

describe("ServerErrorSchema", () => {
  test("accepts both error codes", () => {
    for (const code of ["E_WS_PROTOCOL", "E_INVALID_INPUT"]) {
      expect(ServerErrorSchema.safeParse({ type: "error", code, message: "nope" }).success).toBe(
        true,
      );
    }
  });
});
