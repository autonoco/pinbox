// @autono/pinbox-toolbar — offline mirror: the transport's localStorage-backed
// persistence, namespaced per endpoint. Keys:
//   pinbox:<endpoint>:consumer  random 10-base36 id, stable per install
//   pinbox:<endpoint>:cursor    max seq applied (WS replay cursor)
//   pinbox:<endpoint>:pins      last-known pin list (offline read-only render)
//   pinbox:<endpoint>:threads   last-known thread per pin id (same, for threads)
//   pinbox:<endpoint>:outbox    PinInputs created offline, flushed on reconnect
// Browser code: storage writes never throw upward (private mode / quota — the
// mirror degrades, the toolbar keeps working).
import type { Pin, PinInput, ThreadMessage } from "@autono/pinbox-core/schema";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OutboxEntry {
  /** Client-assigned optimistic pin id; correlates the queued input with its local pin. */
  localId: string;
  input: PinInput;
  /** Queue time — the optimistic pin's createdAt survives an offline reload. */
  at?: string;
}

export function randomBase36(length: number): string {
  let out = "";
  while (out.length < length) out += Math.random().toString(36).slice(2);
  return out.slice(0, length);
}

/** In-memory fallback when no Web Storage exists (SSR import, tests). */
export function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export class Mirror {
  readonly #storage: StorageLike;
  readonly #prefix: string;

  constructor(storage: StorageLike, endpoint: string) {
    this.#storage = storage;
    this.#prefix = `pinbox:${endpoint.replace(/\/+$/, "")}`;
  }

  #key(name: string): string {
    return `${this.#prefix}:${name}`;
  }

  #readRaw(name: string): string | null {
    try {
      return this.#storage.getItem(this.#key(name));
    } catch {
      return null;
    }
  }

  #read<T>(name: string, fallback: T): T {
    try {
      const raw = this.#readRaw(name);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  }

  #write(name: string, value: string): void {
    try {
      this.#storage.setItem(this.#key(name), value);
    } catch {
      // quota / private mode — persistence degrades, nothing else does
    }
  }

  consumerId(): string {
    const id = this.#readRaw("consumer");
    if (id !== null && id !== "") return id;
    const fresh = randomBase36(10);
    this.#write("consumer", fresh);
    return fresh;
  }

  cursor(): number {
    const n = Number(this.#readRaw("cursor"));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  writeCursor(seq: number): void {
    this.#write("cursor", String(seq));
  }

  pins(): Pin[] {
    return this.#read<Pin[]>("pins", []);
  }

  writePins(pins: Pin[]): void {
    this.#write("pins", JSON.stringify(pins));
  }

  /** Threads keyed by pin id — the offline read-only thread render (plan: "mirror
   * renders read-only threads"). Only pins whose thread was fetched appear. */
  threads(): Record<string, ThreadMessage[]> {
    return this.#read<Record<string, ThreadMessage[]>>("threads", {});
  }

  /** `null` distinguishes "never mirrored" from "mirrored and empty". */
  thread(pinId: string): ThreadMessage[] | null {
    return this.threads()[pinId] ?? null;
  }

  writeThread(pinId: string, messages: ThreadMessage[]): void {
    this.#write("threads", JSON.stringify({ ...this.threads(), [pinId]: messages }));
  }

  /** No-op for an unmirrored pin: a lone reply is not a thread. */
  appendThread(pinId: string, message: ThreadMessage): void {
    const existing = this.thread(pinId);
    if (existing === null) return;
    this.writeThread(pinId, [...existing, message]);
  }

  outbox(): OutboxEntry[] {
    return this.#read<OutboxEntry[]>("outbox", []);
  }

  writeOutbox(entries: OutboxEntry[]): void {
    if (entries.length === 0) {
      try {
        this.#storage.removeItem(this.#key("outbox"));
      } catch {
        // ignore — an unremovable empty outbox re-reads as []
      }
      return;
    }
    this.#write("outbox", JSON.stringify(entries));
  }

  pushOutbox(entry: OutboxEntry): void {
    this.writeOutbox([...this.outbox(), entry]);
  }
}
