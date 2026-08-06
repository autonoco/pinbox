// @autono/pinbox-toolbar — connection coverage: the WS URL a prefixed cloud
// endpoint produces, and the reconnect backoff curve (growth, 30s cap, reset).
import { describe, expect, test } from "bun:test";
import { catchUp, type Harness, harness } from "./test-harness.ts";

function socketUrl(endpoint: string): string {
  const h = harness({ endpoint });
  h.transport.connect();
  const url = h.sockets[0]?.url;
  if (url === undefined) throw new Error("no socket created");
  return url;
}

/** Bring the newest socket up through catch-up: a healthy connection. */
function goLive(h: Harness): void {
  const socket = h.sockets.at(-1);
  socket?.open();
  socket?.frame(catchUp(0, []));
}

/** Fail the newest socket, fire its reconnect timer, return the delay used. */
function dropAndReconnect(h: Harness): number {
  h.sockets.at(-1)?.fail();
  const timer = h.timers.at(-1);
  if (!timer) throw new Error("no reconnect timer scheduled");
  timer.fn();
  return timer.ms;
}

/** The jitter window the implementation is allowed to pick from for `attempt`. */
function window(attempt: number): [number, number] {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return [base, Math.min(Math.round(base * 1.25), 30_000)];
}

describe("ws url", () => {
  test("a prefixed cloud endpoint keeps its path prefix", () => {
    expect(socketUrl("https://hub.example.com/tenant/abc")).toBe(
      "wss://hub.example.com/tenant/abc/ws",
    );
  });

  test("a trailing slash does not double up", () => {
    expect(socketUrl("https://hub.example.com/tenant/abc/")).toBe(
      "wss://hub.example.com/tenant/abc/ws",
    );
  });

  test("query and hash on the endpoint are dropped, not smuggled into the socket", () => {
    expect(socketUrl("https://hub.example.com/base?x=1#y")).toBe("wss://hub.example.com/base/ws");
  });

  test("a bare local endpoint is unchanged", () => {
    expect(socketUrl("http://127.0.0.1:4310")).toBe("ws://127.0.0.1:4310/ws");
  });
});

describe("reconnect backoff", () => {
  test("delays grow exponentially from 1s, each inside its jitter window", () => {
    const h = harness();
    h.transport.connect();
    goLive(h);
    const delays = [0, 1, 2, 3, 4].map(() => dropAndReconnect(h));
    delays.forEach((ms, attempt) => {
      const [lo, hi] = window(attempt);
      expect(ms).toBeGreaterThanOrEqual(lo);
      expect(ms).toBeLessThanOrEqual(hi);
    });
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
  });

  test("the delay caps at 30s and stays there", () => {
    const h = harness();
    h.transport.connect();
    goLive(h);
    const delays = Array.from({ length: 9 }, () => dropAndReconnect(h));
    expect(delays.slice(5)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  test("a healthy connection resets the backoff to the 1s step", () => {
    const h = harness();
    h.transport.connect();
    goLive(h);
    const grown = [0, 1, 2, 3].map(() => dropAndReconnect(h)).at(-1) ?? 0;
    expect(grown).toBeGreaterThanOrEqual(8_000);

    goLive(h); // catch-up completed ⇒ attempt counter back to zero
    const [lo, hi] = window(0);
    const afterReset = dropAndReconnect(h);
    expect(afterReset).toBeGreaterThanOrEqual(lo);
    expect(afterReset).toBeLessThanOrEqual(hi);
  });
});
