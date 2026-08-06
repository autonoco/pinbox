// @autono/pinbox-core/ws-protocol — hello → catch-up → events with cursor replay,
// versioned with a min-protocol handshake. The
// toolbar client and Bun server speak exactly this; the DO server reuses it
// unchanged. Auth happens at upgrade only — no credential ever appears inside protocol
// messages. Keepalive is transport-level (Bun sendPings / DO setWebSocketAutoResponse);
// no ping message exists at protocol 1.
import { z } from "zod";
import type { StoredEvent } from "./store.ts";

export const WS_PATH = "/ws";
export const WS_PROTOCOL_VERSION = 1;
export const WS_MIN_PROTOCOL = 1;
export const WS_TOKEN_SUBPROTOCOL_PREFIX = "pinbox.token.";
export const WS_CLOSE_PROTOCOL = 4400; // hello invalid or protocol < WS_MIN_PROTOCOL
export const WS_CLOSE_UNAUTHORIZED = 4401; // bad/missing token at upgrade; 1013 = backpressure close
// client → server: exactly one hello, within 5s of connect, before anything else.
export const ClientHelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int().positive(), // version the client speaks
  consumerId: z.string().min(1), // stable per toolbar install (localStorage)
  lastSeq: z.number().int().nonnegative(), // replay cursor; 0 = full replay
});
// server → client, in order: one catch-up, then live event frames as they append.
export const WsEventSchema = z.object({
  type: z.literal("event"),
  seq: z.number().int().positive(),
  eventType: z.enum([
    "pin.created",
    "pin.resolved",
    "thread.message",
    "pin.verified",
    "pin.linked",
  ]),
  at: z.string(),
  payload: z.unknown(), // StoredEvent.payload verbatim
});
export const ServerCatchUpSchema = z.object({
  type: z.literal("catch-up"),
  protocol: z.literal(WS_PROTOCOL_VERSION),
  minProtocol: z.literal(WS_MIN_PROTOCOL),
  lastSeq: z.number().int().nonnegative(), // server's latest seq at accept
  events: z.array(WsEventSchema), // everything with seq > hello.lastSeq
});
export const ServerErrorSchema = z.object({
  type: z.literal("error"),
  code: z.enum(["E_WS_PROTOCOL", "E_INVALID_INPUT"]),
  message: z.string(),
});
export type WsClientMessage = z.infer<typeof ClientHelloSchema>;
export type WsServerMessage = z.infer<
  typeof ServerCatchUpSchema | typeof WsEventSchema | typeof ServerErrorSchema
>;

/** One WsEvent frame, JSON. */
export function encodeWsEvent(event: StoredEvent): string {
  return JSON.stringify({
    type: "event",
    seq: event.seq,
    eventType: event.type,
    at: event.at,
    payload: event.payload,
  });
}
