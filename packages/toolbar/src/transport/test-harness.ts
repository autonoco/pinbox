// @autono/pinbox-toolbar — shared fixtures for the transport tests.
// Not part of any published entry: it is imported only from `*.test.ts`, which is
// why it lives beside the transport rather than in `src/` proper. A fake
// WebSocketLike driven frame-by-frame, Map-backed storage, a manual scheduler
// standing in for fake timers, and an envelope-speaking fetch stub.
import type { Pin, PinInput } from "@autono/pinbox-core/schema";
import {
  type ConnectionState,
  type HubEvent,
  HubTransport,
  type TransportOptions,
  type WebSocketLike,
} from "../transport.ts";
import { memoryStorage, type StorageLike } from "./mirror.ts";
import type { FetchLike } from "./rest.ts";

const ENDPOINT = "http://127.0.0.1:4310";
export const KEY = (name: string) => `pinbox:${ENDPOINT}:${name}`;

export class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  // test drivers
  open(): void {
    this.onopen?.();
  }
  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  fail(): void {
    this.onerror?.();
    this.onclose?.({ code: 1006 });
  }
}

/** The transport's own in-memory StorageLike is exactly the fixture a test wants —
 * re-exported rather than re-implemented. */
export { memoryStorage as makeStorage };

export interface Harness {
  transport: HubTransport;
  sockets: FakeSocket[];
  events: HubEvent[];
  states: ConnectionState[];
  timers: { fn: () => void; ms: number }[];
  storage: StorageLike;
}

export function harness(
  overrides: Partial<TransportOptions> = {},
  storage: StorageLike = memoryStorage(),
): Harness {
  const sockets: FakeSocket[] = [];
  const events: HubEvent[] = [];
  const states: ConnectionState[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const transport = new HubTransport({
    endpoint: ENDPOINT,
    token: "tok",
    storage,
    webSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    scheduler: {
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: () => {},
    },
    fetchFn: async () => {
      throw new TypeError("network down");
    },
    onEvent: (e) => events.push(e),
    onConnection: (s) => states.push(s),
    ...overrides,
  });
  return { transport, sockets, events, states, timers, storage };
}

export const catchUp = (lastSeq: number, events: unknown[] = [], extra: object = {}) => ({
  type: "catch-up",
  protocol: 1,
  minProtocol: 1,
  lastSeq,
  events,
  ...extra,
});

export const evt = (seq: number) => ({
  type: "event",
  seq,
  eventType: "pin.created",
  at: "2026-08-04T00:00:00.000Z",
  payload: { id: `pin_${seq}` },
});

export function makeInput(): PinInput {
  return {
    text: "Break the headline onto two lines.",
    kind: "note",
    target: {
      url: "http://localhost:5173/",
      selector: "#hero > h1",
      tag: "h1",
      rect: { x: 40, y: 120, width: 600, height: 80 },
      fixed: false,
    },
    env: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      browser: "test",
      os: "test",
      colorScheme: "dark",
    },
    author: { userId: "u1" },
  };
}

export interface FetchCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Envelope-speaking fetch stub that records calls. */
export function makeFetch(
  respond: (method: string, path: string) => { status: number; body: unknown },
): {
  calls: FetchCall[];
  fetchFn: FetchLike;
} {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, headers, body });
    const { status, body: resBody } = respond(method, url.pathname);
    return new Response(JSON.stringify(resBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

export function serverPin(id: string): Pin {
  return {
    ...makeInput(),
    id,
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T01:00:00.000Z",
  };
}
