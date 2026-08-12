// @autono/pinbox-core/do-store — the DO SQLite PinStore: second (and final) PinStore
// implementation, on Durable Object SQLite. Internal module, consumed by do.ts.
// workerd-clean: NO Bun globals, NO node: imports, NO bun:sqlite anywhere in this file's
// import graph beyond store.ts's aliased specifier; types come module-form from
// @cloudflare/workers-types (never ambient — they clash with @types/bun).
//
// Same JSON-column layout as the local store (pins.json, thread_messages.json —
// rebuildable from the append-only events log); replays the SAME `MIGRATIONS` list
// that openStore runs locally.
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import {
  DoCursorStore,
  DoDeliveryStore,
  DoLinkStore,
  DoSessionStore,
} from "./do-store-registries.ts";
import { newId } from "./id.ts";
import type {
  AppliedEdit,
  Attachment,
  Link,
  Pin,
  PinInput,
  SessionRef,
  ThreadMessage,
} from "./schema.ts";
import { PinInputSchema, PinSchema, SessionRefSchema, ThreadMessageSchema } from "./schema.ts";
import type { SessionStore } from "./sessions.ts";
import {
  ConflictError,
  type CursorStore,
  type DeliveryStore,
  type LinkStore,
  MIGRATIONS,
  NotFoundError,
  type PinStore,
  type StoredEvent,
} from "./store.ts";

// The complete PinStore surface. Declared here
// because it must stay identical to store.ts's — as member blocks land in
// `interface PinStore` in store.ts, this extension collapses into plain `PinStore`.
export interface DoPinStore extends PinStore {
  // Pinned — with the additive opts param (attachments, origin):
  addThreadMessage(
    pinId: string,
    role: "human" | "agent" | "mirror",
    text: string,
    opts?: { origin?: string; attachments?: Attachment[]; edit?: AppliedEdit },
  ): ThreadMessage;
  /** @throws NotFoundError @throws ConflictError — trailing commit param is additive */
  resolvePin(id: string, by: "human" | "agent", note?: string, commit?: string): Pin;

  // Fires once per appended event, post-commit, in seq order, on the mutating
  // call's stack. Listeners must not throw (wrap internally); returns unsubscribe.
  subscribe(listener: (event: StoredEvent) => void): () => void;
  readonly sessions: SessionStore;
  readonly deliveries: DeliveryStore;
  /** Persists the routing binding into pin.agentSession. No event. @throws NotFoundError */
  bindSession(pinId: string, ref: SessionRef): Pin;

  // accepted: status stays resolved; reopened: status flips back to "open",
  // resolution kept as history. @throws NotFoundError; ConflictError unless resolved.
  verifyPin(id: string, outcome: "accepted" | "reopened"): Pin;
  searchPins(query: string): Pin[]; // FTS5 MATCH over pin text + thread; newest first
  readonly cursors: CursorStore;

  // Appends pin.linked, updates pin json + links table in one transaction.
  // @throws NotFoundError; ConflictError on duplicate (connector, ref) for the pin.
  addLink(pinId: string, link: Link): Pin;
  readonly links: LinkStore;
}

type VersionCursor = { get(): number; set(version: number): void };

// DO SQLite may refuse PRAGMA user_version writes. Probe once per instance; on refusal
// keep the migration cursor in the storage KV key "pinbox:user_version" (same numbers,
// same list, same order).
const VERSION_KEY = "pinbox:user_version";

function versionCursor(sql: SqlStorage, storage: DurableObjectStorage): VersionCursor {
  try {
    const read = () =>
      Number(sql.exec<{ user_version: number }>("PRAGMA user_version").one().user_version);
    const current = read();
    sql.exec(`PRAGMA user_version = ${current}`); // probe writability
    if (read() !== current) throw new Error("PRAGMA user_version write did not persist");
    return { get: read, set: (version) => void sql.exec(`PRAGMA user_version = ${version}`) };
  } catch {
    return {
      get: () => storage.kv.get<number>(VERSION_KEY) ?? 0,
      set: (version) => storage.kv.put(VERSION_KEY, version),
    };
  }
}

function migrate(sql: SqlStorage, storage: DurableObjectStorage): void {
  const cursor = versionCursor(sql, storage);
  for (const migration of MIGRATIONS) {
    if (migration.version <= cursor.get()) continue;
    storage.transactionSync(() => {
      sql.exec(migration.ddl);
      cursor.set(migration.version);
    });
  }
}

function parsePin(json: string): Pin {
  return PinSchema.parse(JSON.parse(json)); // corruption fails loudly
}

export function openDoStore(sql: SqlStorage, storage: DurableObjectStorage): DoPinStore {
  migrate(sql, storage);
  return new DoSqlitePinStore(sql, storage);
}

class DoSqlitePinStore implements DoPinStore {
  readonly sessions: SessionStore;
  readonly deliveries: DeliveryStore;
  readonly cursors: CursorStore;
  readonly links: LinkStore;

  private readonly listeners = new Set<(event: StoredEvent) => void>();
  private readonly pendingEvents: StoredEvent[] = [];

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
  ) {
    this.sessions = new DoSessionStore(sql, storage);
    this.deliveries = new DoDeliveryStore(sql);
    this.cursors = new DoCursorStore(sql);
    this.links = new DoLinkStore(sql);
  }

  createPin(input: PinInput, env: { branch?: string; commit?: string }): Pin {
    const parsed = PinInputSchema.parse(input);
    const mergedEnv = { ...parsed.env };
    if (env.branch !== undefined) mergedEnv.branch = env.branch;
    if (env.commit !== undefined) mergedEnv.commit = env.commit;
    const pin = PinSchema.parse({
      ...parsed,
      env: mergedEnv,
      id: newId("pin"),
      schemaVersion: 1,
      status: "open",
      createdAt: new Date().toISOString(),
    });
    return this.mutate(() => {
      this.sql.exec(
        "INSERT INTO pins (id, status, created_at, json) VALUES (?, ?, ?, ?)",
        pin.id,
        pin.status,
        pin.createdAt,
        JSON.stringify(pin),
      );
      this.sql.exec(
        "INSERT INTO pins_fts (pin_id, kind, body) VALUES (?, ?, ?)",
        pin.id,
        "pin",
        pin.text,
      );
      this.appendEvent("pin.created", pin.createdAt, pin);
      return pin;
    });
  }

  getPin(id: string): Pin | null {
    const row = this.sql
      .exec<{ json: string }>("SELECT json FROM pins WHERE id = ?", id)
      .toArray()[0];
    return row ? parsePin(row.json) : null;
  }

  listPins(filter?: { status?: "open" | "resolved" }): Pin[] {
    const rows = filter?.status
      ? this.sql.exec<{ json: string }>(
          "SELECT json FROM pins WHERE status = ? ORDER BY created_at DESC, rowid DESC",
          filter.status,
        )
      : this.sql.exec<{ json: string }>(
          "SELECT json FROM pins ORDER BY created_at DESC, rowid DESC",
        );
    return rows.toArray().map((row) => parsePin(row.json));
  }

  addThreadMessage(
    pinId: string,
    role: "human" | "agent" | "mirror",
    text: string,
    opts?: { origin?: string; attachments?: Attachment[]; edit?: AppliedEdit },
  ): ThreadMessage {
    const message = ThreadMessageSchema.parse({
      id: newId("msg"),
      pinId,
      role,
      text,
      ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts?.attachments !== undefined ? { attachments: opts.attachments } : {}),
      ...(opts?.edit !== undefined ? { edit: opts.edit } : {}),
      at: new Date().toISOString(),
    });
    return this.mutate(() => {
      this.mustGetPin(pinId);
      this.sql.exec(
        "INSERT INTO thread_messages (id, pin_id, at, json) VALUES (?, ?, ?, ?)",
        message.id,
        message.pinId,
        message.at,
        JSON.stringify(message),
      );
      this.sql.exec(
        "INSERT INTO pins_fts (pin_id, kind, body) VALUES (?, ?, ?)",
        pinId,
        "thread",
        message.text,
      );
      this.appendEvent("thread.message", message.at, message);
      return message;
    });
  }

  getThread(pinId: string): ThreadMessage[] {
    return this.sql
      .exec<{ json: string }>(
        "SELECT json FROM thread_messages WHERE pin_id = ? ORDER BY rowid ASC",
        pinId,
      )
      .toArray()
      .map((row) => ThreadMessageSchema.parse(JSON.parse(row.json)));
  }

  resolvePin(id: string, by: "human" | "agent", note?: string, commit?: string): Pin {
    return this.mutate(() => {
      const pin = this.mustGetPin(id); // re-read inside the transaction to enforce the conflict
      if (pin.status === "resolved") throw new ConflictError(`pin already resolved: ${id}`);
      const at = new Date().toISOString();
      const resolved = PinSchema.parse({
        ...pin,
        status: "resolved",
        resolution: {
          by,
          at,
          ...(note !== undefined ? { note } : {}),
          ...(commit !== undefined ? { commit } : {}),
        },
      });
      this.updatePinRow(resolved);
      this.appendEvent("pin.resolved", at, resolved);
      return resolved;
    });
  }

  verifyPin(id: string, outcome: "accepted" | "reopened"): Pin {
    return this.mutate(() => {
      const pin = this.mustGetPin(id);
      if (pin.status !== "resolved") {
        throw new ConflictError(`pin is not resolved, cannot verify: ${id}`);
      }
      const at = new Date().toISOString();
      const verified = PinSchema.parse({
        ...pin, // resolution kept as history in both outcomes
        status: outcome === "reopened" ? "open" : "resolved",
        verification: { outcome, at },
      });
      this.updatePinRow(verified);
      this.appendEvent("pin.verified", at, verified);
      return verified;
    });
  }

  searchPins(query: string): Pin[] {
    // Quote each token as an FTS5 phrase so user input is never parsed as MATCH syntax.
    const match = query
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" ");
    if (match === "") return [];
    return this.sql
      .exec<{ json: string }>(
        `SELECT json FROM pins
         WHERE id IN (SELECT pin_id FROM pins_fts WHERE pins_fts MATCH ?)
         ORDER BY created_at DESC, rowid DESC`,
        match,
      )
      .toArray()
      .map((row) => parsePin(row.json));
  }

  addLink(pinId: string, link: Link): Pin {
    return this.mutate(() => {
      const pin = this.mustGetPin(pinId);
      const duplicate = this.sql
        .exec<{ ref: string }>(
          "SELECT ref FROM links WHERE pin_id = ? AND connector = ? AND ref = ?",
          pinId,
          link.connector,
          link.ref,
        )
        .toArray()[0];
      if (duplicate) {
        throw new ConflictError(`link already exists: ${link.connector}:${link.ref} on ${pinId}`);
      }
      const at = new Date().toISOString();
      this.sql.exec(
        "INSERT INTO links (pin_id, connector, ref, url, created_at, last_synced_at) VALUES (?, ?, ?, ?, ?, NULL)",
        pinId,
        link.connector,
        link.ref,
        link.url,
        at,
      );
      const updated = PinSchema.parse({ ...pin, links: [...(pin.links ?? []), link] });
      this.updatePinRow(updated);
      this.appendEvent("pin.linked", at, updated);
      return updated;
    });
  }

  bindSession(pinId: string, ref: SessionRef): Pin {
    return this.mutate(() => {
      const pin = this.mustGetPin(pinId);
      const bound = PinSchema.parse({ ...pin, agentSession: SessionRefSchema.parse(ref) });
      this.updatePinRow(bound); // derived-table mutation, no event
      return bound;
    });
  }

  setDueAt(id: string, at: string | null): void {
    this.mutate(() => {
      this.mustGetPin(id);
      this.sql.exec("UPDATE pins SET due_at = ? WHERE id = ?", at, id);
    });
  }

  pinsDueBefore(at: string): Pin[] {
    return this.sql
      .exec<{ json: string }>(
        "SELECT json FROM pins WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC",
        at,
      )
      .toArray()
      .map((row) => parsePin(row.json));
  }

  eventsAfter(seq: number): StoredEvent[] {
    return this.sql
      .exec<{ seq: number; type: string; at: string; payload: string }>(
        "SELECT seq, type, at, payload FROM events WHERE seq > ? ORDER BY seq ASC",
        seq,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        type: row.type as StoredEvent["type"],
        at: row.at,
        payload: JSON.parse(row.payload) as unknown,
      }));
  }

  summary(): { open: number; resolved: number; lastEventSeq: number } {
    const row = this.sql
      .exec<{ open: number; resolved: number; lastEventSeq: number }>(
        `SELECT
           (SELECT COUNT(*) FROM pins WHERE status = 'open') AS open,
           (SELECT COUNT(*) FROM pins WHERE status = 'resolved') AS resolved,
           (SELECT COALESCE(MAX(seq), 0) FROM events) AS lastEventSeq`,
      )
      .one();
    return { open: row.open, resolved: row.resolved, lastEventSeq: row.lastEventSeq };
  }

  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  close(): void {
    // DO SQLite has no close: the runtime owns the database lifecycle. Kept for
    // PinStore parity so callers can treat both implementations uniformly.
  }

  /** Runs fn in transactionSync, then flushes appended events post-commit in seq order. */
  private mutate<T>(fn: () => T): T {
    let result: T;
    try {
      result = this.storage.transactionSync(fn);
    } catch (error) {
      this.pendingEvents.length = 0; // rolled back — nothing to publish
      throw error;
    }
    const events = this.pendingEvents.splice(0);
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // listeners must not throw — a bad listener never breaks a mutation
        }
      }
    }
    return result;
  }

  private appendEvent(type: StoredEvent["type"], at: string, payload: unknown): void {
    const row = this.sql
      .exec<{ seq: number }>(
        "INSERT INTO events (type, at, payload) VALUES (?, ?, ?) RETURNING seq",
        type,
        at,
        JSON.stringify(payload),
      )
      .one();
    this.pendingEvents.push({ seq: row.seq, type, at, payload });
  }

  private updatePinRow(pin: Pin): void {
    this.sql.exec(
      "UPDATE pins SET status = ?, json = ? WHERE id = ?",
      pin.status,
      JSON.stringify(pin),
      pin.id,
    );
  }

  private mustGetPin(id: string): Pin {
    const pin = this.getPin(id);
    if (!pin) throw new NotFoundError(`pin not found: ${id}`);
    return pin;
  }
}
