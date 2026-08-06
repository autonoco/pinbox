// Shared WebSocket helpers for the workerd suites: upgrade, frame collection, and the
// protocol-1 hello → catch-up exchange. Both hub-do (DO stubs) and loop-parity (SELF
// against the template) drive the same wire protocol — one set of helpers keeps the
// two suites byte-comparable.
import { expect } from "vitest";

// Fetch-shaped upgrade source: a DO stub's fetch or SELF.fetch. workers-types' Request/
// Response nominally differ from the lib globals; they are the same objects at runtime.
export type UpgradeFetch = (url: string, init?: unknown) => Promise<unknown>;

export type WsEventFrame = {
  type: string;
  seq: number;
  eventType: string;
  at: string;
  payload: unknown;
};

export type CatchUpFrame = {
  type: string;
  protocol: number;
  minProtocol: number;
  lastSeq: number;
  events: WsEventFrame[];
};

export async function openWs(fetchImpl: UpgradeFetch, url: string): Promise<WebSocket> {
  const res = (await fetchImpl(url, { headers: { upgrade: "websocket" } })) as {
    status: number;
    webSocket: (WebSocket & { accept(): void }) | null;
  };
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on 101 response");
  ws.accept();
  return ws;
}

export function collect(ws: WebSocket) {
  const queue: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  ws.addEventListener("message", (event) => {
    const frame = String(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  return {
    next(timeoutMs = 2000): Promise<string> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

export type FrameCollector = ReturnType<typeof collect>;

export function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

// A protocol violation always follows the same script: exactly one
// E_WS_PROTOCOL error frame, then close 4400.
export async function expectProtocolViolation(ws: WebSocket, payload: string): Promise<void> {
  const frames = collect(ws);
  const closed = closeCode(ws);
  ws.send(payload);
  const frame = JSON.parse(await frames.next()) as { type: string; code: string };
  expect(frame.type).toBe("error");
  expect(frame.code).toBe("E_WS_PROTOCOL");
  expect(await closed).toBe(4400);
}

export async function helloCatchUp(
  ws: WebSocket,
  frames: FrameCollector,
  consumerId: string,
  lastSeq = 0,
): Promise<CatchUpFrame> {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, consumerId, lastSeq }));
  const catchUp = JSON.parse(await frames.next()) as CatchUpFrame;
  expect(catchUp.type).toBe("catch-up");
  return catchUp;
}
