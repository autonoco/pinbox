// @autono/pinbox-toolbar — hub transport: WS client speaking the
// wire protocol (hello → catch-up → events, cursor replay, min-protocol
// handshake), REST over fetch + bearer, and the offline mirror with outbox
// reconciliation. Reconciliation rule (spec): hub wins on status; client wins on
// new pins. Browser code: web globals only, core imports are type-only (fallow
// allowTypeOnly), so the §5 wire constants are mirrored below from
// core/src/ws-protocol.ts — pinned text; e2e (Task 10) locks compatibility.
import type { Attachment, Pin, PinInput, ThreadMessage } from "@autono/pinbox-core/schema";
import {
  Mirror,
  memoryStorage,
  type OutboxEntry,
  randomBase36,
  type StorageLike,
} from "./transport/mirror.ts";
import { type FetchLike, HubError, RestClient } from "./transport/rest.ts";

// Mirrored from core/src/ws-protocol.ts — do not drift.
const WS_PATH = "/ws";
const WS_PROTOCOL_VERSION = 1;
const WS_MIN_PROTOCOL = 1;
const WS_TOKEN_SUBPROTOCOL_PREFIX = "pinbox.token.";
const WS_CLOSE_PROTOCOL = 4400;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** How many times a reconcile re-reads the pin list before conceding to live events. */
const SNAPSHOT_ATTEMPTS = 3;

/** The browser WebSocket surface the transport needs — injectable for tests. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface SchedulerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface HubEvent {
  seq: number;
  eventType: string;
  at: string;
  payload: unknown;
}

export type ConnectionState = "connecting" | "live" | "offline" | "incompatible";

export interface TransportOptions {
  endpoint: string;
  token: string;
  /** Default localStorage; injectable for tests. */
  storage?: StorageLike;
  /** Injectable for tests. */
  webSocket?: (url: string, protocols: string[]) => WebSocketLike;
  onEvent(e: HubEvent): void;
  onConnection(state: ConnectionState): void;
  /** Reconciled pin lists: fresh `listPins()` after each reconnect (hub wins on status). */
  onPins?(pins: Pin[]): void;
  /** Queued outbox localIds whenever the set changes — the UI flags them as pending sync. */
  onOutbox?(localIds: string[]): void;
  /** Test seam; default global fetch. */
  fetchFn?: FetchLike;
  /** Test seam standing in for fake timers; default global setTimeout/clearTimeout. */
  scheduler?: SchedulerLike;
}

interface WireFrame {
  type?: string;
  seq?: number;
  eventType?: string;
  at?: string;
  payload?: unknown;
  protocol?: number;
  minProtocol?: number;
  lastSeq?: number;
  events?: WireFrame[];
}

/** `/ws` UNDER the endpoint, not at the origin root: a cloud hub is commonly
 * mounted at a path prefix (`https://hub/tenant/abc`), and resolving "/ws" against
 * it would silently drop the prefix. Query/hash never belong on the socket url. */
function wsUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${WS_PATH}`;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Handshake rule 1: either side of the version window excludes the peer. */
function incompatibleWith(frame: WireFrame): boolean {
  return (frame.minProtocol ?? 1) > WS_PROTOCOL_VERSION || (frame.protocol ?? 1) < WS_MIN_PROTOCOL;
}

/** The optimistic pin a queued outbox entry stands for until the flush replaces it. */
function outboxPin(entry: OutboxEntry): Pin {
  return {
    ...entry.input,
    id: entry.localId,
    schemaVersion: 1,
    status: "open",
    createdAt: entry.at ?? new Date().toISOString(),
  };
}

export class HubTransport {
  /** Stable per install, persisted (`pinbox:<endpoint>:consumer`). */
  readonly consumerId: string;

  readonly #opts: TransportOptions;
  readonly #mirror: Mirror;
  readonly #rest: RestClient;
  readonly #scheduler: SchedulerLike;
  #ws: WebSocketLike | null = null;
  #cursor: number;
  /** Live frames arriving in the accept→catch-up window, drained after catch-up. */
  #buffer: HubEvent[] = [];
  #caughtUp = false;
  #live = false;
  #closed = false;
  #incompatible = false;
  #attempt = 0;
  #timer: unknown = null;
  /** One flush at a time — reconnect and the live write path both drain the outbox. */
  #flushing = false;

  constructor(opts: TransportOptions) {
    this.#opts = opts;
    const storage = opts.storage ?? globalThis.localStorage ?? memoryStorage();
    this.#mirror = new Mirror(storage, opts.endpoint);
    this.#rest = new RestClient(opts.endpoint, opts.token, opts.fetchFn);
    this.#scheduler = opts.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
    };
    this.consumerId = this.#mirror.consumerId();
    this.#cursor = this.#mirror.cursor();
  }

  /** Last-known pin list — the offline read-only render seed. */
  mirrorPins(): Pin[] {
    return this.#mirror.pins();
  }

  /** Optimistic pins for the queued outbox — offline reloads render + flag them. */
  outboxPins(): Pin[] {
    return this.#mirror.outbox().map(outboxPin);
  }

  /** Last-known thread for a pin — the offline read-only thread render seed.
   * Empty for a pin whose thread was never fetched while connected. */
  mirrorThread(pinId: string): ThreadMessage[] {
    return this.#mirror.thread(pinId) ?? [];
  }

  /** hello → buffer live frames → apply catch-up → drain buffer. */
  connect(): void {
    if (this.#closed || this.#incompatible || this.#ws !== null) return;
    this.#opts.onConnection("connecting");
    this.#caughtUp = false;
    this.#buffer = [];
    const factory =
      this.#opts.webSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const ws = factory(wsUrl(this.#opts.endpoint), [
      WS_TOKEN_SUBPROTOCOL_PREFIX + this.#opts.token,
    ]);
    this.#ws = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: WS_PROTOCOL_VERSION,
          consumerId: this.consumerId,
          lastSeq: this.#cursor,
        }),
      );
    ws.onmessage = (ev) => this.#onFrame(ev.data);
    ws.onclose = (ev) => this.#onDown(ws, ev.code);
    ws.onerror = () => this.#onDown(ws);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#live = false;
    ws?.close(1000, "client closed");
  }

  // ── REST (fetch + bearer; every failure surfaces the hub's error envelope) ──

  listPins(): Promise<Pin[]> {
    return this.#rest.listPins();
  }

  /** Offline ⇒ queued in the outbox, optimistic local pin (client wins on new pins). */
  async createPin(input: PinInput): Promise<Pin> {
    if (this.#live) {
      try {
        return await this.#afterWrite(this.#rest.createPin(input));
      } catch (err) {
        if (!(err instanceof HubError) || err.code !== "E_HUB_UNREACHABLE") throw err;
        // the socket has not noticed the drop yet — fall through to the outbox
      }
    }
    const entry: OutboxEntry = {
      localId: `pin_${randomBase36(10)}`,
      input,
      at: new Date().toISOString(),
    };
    this.#mirror.pushOutbox(entry);
    this.#emitOutbox();
    return outboxPin(entry);
  }

  /** Mirrored on every success, served from the mirror when the hub is unreachable —
   * an offline reload renders read-only threads instead of empty ones. Any other
   * hub error (auth, not-found) surfaces: the mirror is a fallback, not a mask. */
  async getThread(pinId: string): Promise<ThreadMessage[]> {
    try {
      const messages = await this.#rest.getThread(pinId);
      this.#mirror.writeThread(pinId, messages);
      return messages;
    } catch (err) {
      if (!(err instanceof HubError) || err.code !== "E_HUB_UNREACHABLE") throw err;
      const mirrored = this.#mirror.thread(pinId);
      if (mirrored === null) throw err;
      return mirrored;
    }
  }

  async reply(pinId: string, text: string, attachments?: Attachment[]): Promise<ThreadMessage> {
    const message = await this.#afterWrite(this.#rest.reply(pinId, text, attachments));
    this.#mirror.appendThread(pinId, message);
    return message;
  }

  resolve(pinId: string, note?: string): Promise<Pin> {
    return this.#afterWrite(this.#rest.resolve(pinId, note));
  }

  verify(pinId: string, outcome: "accepted" | "reopened"): Promise<Pin> {
    return this.#afterWrite(this.#rest.verify(pinId, outcome));
  }

  /** A write the hub accepted proves it is reachable, so anything the socket-still-up
   * failure path queued can go now — `#reconcile` only runs on reconnect, and while
   * the socket stays healthy that reconnect may never come. */
  async #afterWrite<T>(op: Promise<T>): Promise<T> {
    const result = await op;
    await this.#drainOutbox();
    return result;
  }

  async #drainOutbox(): Promise<void> {
    if (this.#mirror.outbox().length === 0) return;
    try {
      const flushed = await this.#flushOutbox();
      if (flushed.length === 0) return;
      const all = [...this.#mirror.pins(), ...flushed];
      this.#opts.onPins?.(all);
      this.#mirror.writePins(all);
    } catch {
      // unreachable again — the queue survives for the next write or reconnect
    }
  }

  // ── WS frames ──

  #onFrame(data: string): void {
    let frame: WireFrame;
    try {
      frame = JSON.parse(data) as WireFrame;
    } catch {
      return; // not ours; the server never sends non-JSON
    }
    if (frame.type === "event") this.#onEventFrame(frame);
    else if (frame.type === "catch-up") this.#onCatchUp(frame);
    // "error" frames precede a server close; #onDown owns recovery
  }

  #toEvent(frame: WireFrame): HubEvent {
    return {
      seq: frame.seq ?? 0,
      eventType: frame.eventType ?? "",
      at: frame.at ?? "",
      payload: frame.payload,
    };
  }

  #onEventFrame(frame: WireFrame): void {
    const event = this.#toEvent(frame);
    if (!this.#caughtUp) {
      this.#buffer.push(event); // accept→catch-up window race
      return;
    }
    this.#apply(event);
  }

  /** Deliver once, monotonically: seq at or below the cursor is already seen. */
  #apply(event: HubEvent): void {
    if (event.seq <= this.#cursor) return;
    this.#opts.onEvent(event);
    this.#cursor = event.seq;
    this.#mirror.writeCursor(this.#cursor);
  }

  /** The client symmetrically closes on an excluding protocol window — a clear
   * upgrade message, never silent misbehavior. */
  #failIncompatible(): void {
    this.#incompatible = true;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close(WS_CLOSE_PROTOCOL, "protocol version incompatible");
    this.#opts.onConnection("incompatible");
  }

  #onCatchUp(frame: WireFrame): void {
    if (incompatibleWith(frame)) {
      this.#failIncompatible();
      return;
    }
    for (const e of frame.events ?? []) this.#apply(this.#toEvent(e));
    if ((frame.lastSeq ?? 0) > this.#cursor) {
      this.#cursor = frame.lastSeq ?? 0;
      this.#mirror.writeCursor(this.#cursor);
    }
    this.#caughtUp = true;
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const e of buffered) this.#apply(e);
    this.#live = true;
    this.#attempt = 0; // healthy connection resets the backoff
    this.#opts.onConnection("live");
    void this.#reconcile();
  }

  #onDown(ws: WebSocketLike, code?: number): void {
    if (this.#ws !== ws) return; // stale socket callback (error+close both fire)
    this.#ws = null;
    this.#live = false;
    this.#caughtUp = false;
    if (this.#closed || this.#incompatible) return;
    if (code === WS_CLOSE_PROTOCOL) {
      // the server refused our hello: it requires a newer client
      this.#incompatible = true;
      this.#opts.onConnection("incompatible");
      return;
    }
    this.#opts.onConnection("offline");
    this.#scheduleReconnect();
  }

  /** Exponential backoff 1s→30s with jitter, resetting on a healthy connection. */
  #scheduleReconnect(): void {
    if (this.#timer !== null) return;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    const delay = Math.min(Math.round(base * (1 + Math.random() * 0.25)), BACKOFF_MAX_MS);
    this.#attempt += 1;
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = null;
      this.connect();
    }, delay);
  }

  // ── Reconciliation (on every reconnect) ──

  /** Refresh listPins (hub wins on status) → flush the outbox (client wins on new pins) → persist the fresh mirror. */
  async #reconcile(): Promise<void> {
    try {
      const pins = await this.#snapshotPins();
      if (pins !== null) this.#opts.onPins?.(pins);
      const flushed = await this.#flushOutbox();
      if (flushed.length === 0) {
        if (pins !== null) this.#mirror.writePins(pins);
        return;
      }
      // re-emit so the UI swaps optimistic local pins for their server replacements
      const all = [...(pins ?? this.#mirror.pins()), ...flushed];
      this.#opts.onPins?.(all);
      this.#mirror.writePins(all);
    } catch {
      // still unreachable — the outbox stays queued; the next reconnect retries
    }
  }

  /** `onPins` is a wholesale replacement, so a snapshot must not be older than the
   * events already applied: a `pin.resolved` landing mid-GET would be overwritten by
   * the staler list, and the advanced cursor would stop it ever reapplying. Re-read
   * at the new cursor instead; if live events keep overtaking it, concede — they are
   * the newer truth, and the UI already has them. */
  async #snapshotPins(): Promise<Pin[] | null> {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const takenAt = this.#cursor;
      const pins = await this.#rest.listPins();
      if (this.#cursor === takenAt) return pins;
    }
    return null;
  }

  async #flushOutbox(): Promise<Pin[]> {
    if (this.#flushing) return [];
    this.#flushing = true;
    const created: Pin[] = [];
    try {
      let remaining = this.#mirror.outbox();
      for (const entry of [...remaining]) {
        created.push(await this.#rest.createPin(entry.input));
        remaining = remaining.filter((e) => e.localId !== entry.localId);
        this.#mirror.writeOutbox(remaining);
        this.#emitOutbox();
      }
    } finally {
      this.#flushing = false;
    }
    return created;
  }

  #emitOutbox(): void {
    this.#opts.onOutbox?.(this.#mirror.outbox().map((e) => e.localId));
  }
}

export type { StorageLike } from "./transport/mirror.ts";
export type { FetchLike } from "./transport/rest.ts";
export { HubError } from "./transport/rest.ts";
