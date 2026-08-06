// @autono/pinbox-core/store — event-sourced SQLite store (bun:sqlite).
// Append-only `events` log + derived `pins`/`thread_messages`/`sessions`/`deliveries`/
// `pins_fts` tables. `PinStore` is the seam between the two storage implementations:
// this one (local) and the Durable Object SQLite adapter — no bun:sqlite type
// leaks through the interface. The MIGRATIONS list below is shared verbatim with that
// adapter (ctx.storage.sql.exec); the sqlite impls of the sub-stores live in
// sessions.ts and store-deliveries.ts so this file keeps interfaces + wiring only.
import { Database } from "bun:sqlite";
import { newId } from "./id.ts";
import type { Attachment, Link, Pin, PinInput, SessionRef, ThreadMessage } from "./schema.ts";
import {
  LinkSchema,
  PinInputSchema,
  PinSchema,
  SessionRefSchema,
  ThreadMessageSchema,
} from "./schema.ts";
import type { SessionStore } from "./sessions.ts";
import { SqliteSessionStore } from "./sessions.ts";
import { SqliteDeliveryStore } from "./store-deliveries.ts";
import { ConflictError, NotFoundError } from "./store-errors.ts";

export type StoredEvent = {
  seq: number;
  type: "pin.created" | "pin.resolved" | "thread.message" | "pin.verified" | "pin.linked";
  at: string;
  payload: unknown;
};

export interface PinStore {
  /** Assigns id/status/createdAt, merges env, appends pin.created. */
  createPin(input: PinInput, env: { branch?: string; commit?: string }): Pin;
  getPin(id: string): Pin | null;
  /** Newest first. */
  listPins(filter?: { status?: "open" | "resolved" }): Pin[];
  /** @throws NotFoundError — additive opts param (attachments, origin) */
  addThreadMessage(
    pinId: string,
    role: "human" | "agent" | "mirror",
    text: string,
    opts?: { origin?: string; attachments?: Attachment[] },
  ): ThreadMessage;
  getThread(pinId: string): ThreadMessage[];
  /** @throws NotFoundError @throws ConflictError — the trailing commit param is additive */
  resolvePin(id: string, by: "human" | "agent", note?: string, commit?: string): Pin;
  /** Inbound-poll deadline. @throws NotFoundError */
  setDueAt(id: string, at: string | null): void;
  /** due_at IS NOT NULL AND due_at <= at, oldest deadline first. */
  pinsDueBefore(at: string): Pin[];
  eventsAfter(seq: number): StoredEvent[];
  summary(): { open: number; resolved: number; lastEventSeq: number };
  close(): void;

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

export type DeliveryStatus = "pending" | "delivered" | "failed" | "skipped";
export type DeliveryRow = {
  id: number;
  eventSeq: number;
  sessionId: string | null;
  adapter: string;
  status: DeliveryStatus;
  attempts: number;
  dueAt: string | null;
  lastError: string | null;
  updatedAt: string;
};
export interface DeliveryStore {
  // Lives beside CursorStore/LinkStore, same style
  enqueue(row: {
    eventSeq: number;
    sessionId: string | null;
    adapter: string;
    dueAt: string | null;
    status?: "pending" | "skipped";
  }): DeliveryRow;
  due(now: string): DeliveryRow[]; // status='pending' AND (due_at IS NULL OR due_at <= now)
  pendingForSession(sessionId: string): DeliveryRow[];
  unassigned(): DeliveryRow[]; // status='pending' AND session_id IS NULL
  assign(id: number, sessionId: string): void;
  markDelivered(id: number): void;
  markFailed(id: number, error: string, retryAt: string | null): void; // null retryAt ⇒ terminal 'failed'; bumps attempts
  lastEventSeq(): number; // MAX(event_seq), 0 when empty — the router's boot cursor
}

export interface CursorStore {
  get(consumerId: string): number; // 0 when unknown
  set(consumerId: string, lastSeq: number): void;
}

export interface LinkStore {
  forPin(pinId: string): Link[];
  all(): { pinId: string; link: Link; lastSyncedAt: string | null }[];
  markSynced(pinId: string, link: Pick<Link, "connector" | "ref">, at: string): void;
}

// Defined in a leaf module so `sessions.ts` can import them without closing the
// sessions → store → sessions cycle; re-exported here so `./store` stays source-compatible.
export { ConflictError, NotFoundError };

// Baseline DDL — shared with the DO adapter; keep it plain SQL.
const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  due_at TEXT,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  pin_id TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pins_due_at ON pins(due_at) WHERE due_at IS NOT NULL;
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, key TEXT NOT NULL, cwd TEXT,
  registered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_agent_key ON sessions(agent, key);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_seq INTEGER NOT NULL, session_id TEXT,
  adapter TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  due_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(due_at) WHERE status = 'pending';
`;

// Migration 3 — unicode61 only (trigram/porter not guaranteed on all
// backends); pins_fts is derived — a later migration may DROP + recreate + rebuild.
const DDL_CURSORS_FTS = `
CREATE TABLE IF NOT EXISTS cursors (
  consumer_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pins_fts USING fts5(pin_id UNINDEXED, kind UNINDEXED, body, tokenize='unicode61');
`;

// Migration 4, byte-exact:
const LINKS_DDL = `
CREATE TABLE IF NOT EXISTS links (
  pin_id TEXT NOT NULL, connector TEXT NOT NULL, ref TEXT NOT NULL, url TEXT NOT NULL,
  created_at TEXT NOT NULL, last_synced_at TEXT,
  PRIMARY KEY (pin_id, connector, ref)
);
`;

export type Migration = { version: number; ddl: string };
// Plain SQL only — shared verbatim with the DO adapter (ctx.storage.sql.exec).
// Version numbers are append-only and never reused.
// reserved. Never renumber, never edit a landed migration; each phase appends its own
// entry at its number.
export const MIGRATIONS: Migration[] = [
  { version: 1, ddl: DDL }, // baseline (IF NOT EXISTS — safe over older dbs at user_version 0)
  { version: 2, ddl: MIGRATION_2 }, // sessions + deliveries
  { version: 3, ddl: DDL_CURSORS_FTS }, // cursors + pins_fts
  { version: 4, ddl: LINKS_DDL }, // links table
];

class UserVersionRow {
  user_version!: number;
}

// One immediate transaction over the whole pending list — daemon + stray CLI call is
// the two-writer SQLITE_BUSY case (deep-dive §1.11), so take the write lock up front.
function migrate(db: Database): void {
  db.transaction(() => {
    const current = db.query("PRAGMA user_version").as(UserVersionRow).get()?.user_version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.ddl);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  }).immediate();
}

// pins_fts is derived and may be rebuilt: a pre-migration db arrives with
// pins but an empty index — rebuild it from pins + thread_messages via json_extract.
function backfillFts(db: Database): void {
  const fts = db.query("SELECT COUNT(*) AS n FROM pins_fts").get() as { n: number };
  const pins = db.query("SELECT COUNT(*) AS n FROM pins").get() as { n: number };
  if (fts.n > 0 || pins.n === 0) return;
  db.transaction(() => {
    db.exec(
      "INSERT INTO pins_fts (pin_id, kind, body) SELECT id, 'pin', json_extract(json, '$.text') FROM pins",
    );
    db.exec(
      "INSERT INTO pins_fts (pin_id, kind, body) SELECT pin_id, 'msg', json_extract(json, '$.text') FROM thread_messages",
    );
  })();
}

class JsonRow {
  json!: string;
}

class EventRow {
  seq!: number;
  type!: string;
  at!: string;
  payload!: string;
}

class SummaryRow {
  open!: number;
  resolved!: number;
  lastEventSeq!: number;
}

class CursorRow {
  last_seq!: number;
}

class LinkRow {
  pin_id!: string;
  connector!: string;
  ref!: string;
  url!: string;
  last_synced_at!: string | null;
}

function rowToLink(row: LinkRow): Link {
  return LinkSchema.parse({ connector: row.connector, ref: row.ref, url: row.url });
}

function parsePin(json: string): Pin {
  return PinSchema.parse(JSON.parse(json)); // corruption fails loudly
}

export function openStore(path: string): PinStore {
  const db = new Database(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;");
  migrate(db);
  backfillFts(db);
  return new SqlitePinStore(db);
}

class SqlitePinStore implements PinStore {
  readonly sessions: SessionStore;
  readonly deliveries: DeliveryStore;

  // db.query caches the prepared statement per db — hoisting them here is the whole optimization.
  private readonly insertEvent;
  private readonly insertPin;
  private readonly selectPin;
  private readonly selectAllPins;
  private readonly selectPinsByStatus;
  private readonly updatePin;
  private readonly updateDueAt;
  private readonly selectDuePins;
  private readonly insertMessage;
  private readonly selectThread;
  private readonly selectEventsAfter;
  private readonly selectSummary;
  private readonly insertFts;
  private readonly selectSearch;
  private readonly insertLink;
  private readonly selectLinksForPin;
  private readonly selectAllLinks;
  private readonly updateLinkSynced;

  readonly cursors: CursorStore;
  readonly links: LinkStore;

  private readonly listeners = new Set<(event: StoredEvent) => void>();
  private pendingEvents: StoredEvent[] = [];

  constructor(private readonly db: Database) {
    this.sessions = new SqliteSessionStore(db);
    this.deliveries = new SqliteDeliveryStore(db);
    this.insertEvent = db.query("INSERT INTO events (type, at, payload) VALUES (?, ?, ?)");
    this.insertPin = db.query(
      "INSERT INTO pins (id, status, created_at, json) VALUES (?, ?, ?, ?)",
    );
    this.selectPin = db.query("SELECT json FROM pins WHERE id = ?").as(JsonRow);
    this.selectAllPins = db
      .query("SELECT json FROM pins ORDER BY created_at DESC, rowid DESC")
      .as(JsonRow);
    this.selectPinsByStatus = db
      .query("SELECT json FROM pins WHERE status = ? ORDER BY created_at DESC, rowid DESC")
      .as(JsonRow);
    this.updatePin = db.query("UPDATE pins SET status = ?, json = ? WHERE id = ?");
    this.updateDueAt = db.query("UPDATE pins SET due_at = ? WHERE id = ?");
    this.selectDuePins = db
      .query("SELECT json FROM pins WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC")
      .as(JsonRow);
    this.insertMessage = db.query(
      "INSERT INTO thread_messages (id, pin_id, at, json) VALUES (?, ?, ?, ?)",
    );
    this.selectThread = db
      .query("SELECT json FROM thread_messages WHERE pin_id = ? ORDER BY rowid ASC")
      .as(JsonRow);
    this.selectEventsAfter = db
      .query("SELECT seq, type, at, payload FROM events WHERE seq > ? ORDER BY seq ASC")
      .as(EventRow);
    this.selectSummary = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM pins WHERE status = 'open') AS open,
           (SELECT COUNT(*) FROM pins WHERE status = 'resolved') AS resolved,
           (SELECT COALESCE(MAX(seq), 0) FROM events) AS lastEventSeq`,
      )
      .as(SummaryRow);
    this.insertFts = db.query("INSERT INTO pins_fts (pin_id, kind, body) VALUES (?, ?, ?)");
    this.selectSearch = db
      .query(
        `SELECT json FROM pins
         WHERE id IN (SELECT DISTINCT pin_id FROM pins_fts WHERE pins_fts MATCH ?)
         ORDER BY created_at DESC, rowid DESC`,
      )
      .as(JsonRow);

    const selectCursor = db
      .query("SELECT last_seq FROM cursors WHERE consumer_id = ?")
      .as(CursorRow);
    const upsertCursor = db.query(
      `INSERT INTO cursors (consumer_id, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(consumer_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
    );
    this.cursors = {
      get: (consumerId) => selectCursor.get(consumerId)?.last_seq ?? 0,
      set: (consumerId, lastSeq) => {
        upsertCursor.run(consumerId, lastSeq, new Date().toISOString());
      },
    };

    this.insertLink = db.query(
      "INSERT INTO links (pin_id, connector, ref, url, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectLinksForPin = db
      .query(
        "SELECT pin_id, connector, ref, url, last_synced_at FROM links WHERE pin_id = ? ORDER BY rowid ASC",
      )
      .as(LinkRow);
    this.selectAllLinks = db
      .query("SELECT pin_id, connector, ref, url, last_synced_at FROM links ORDER BY rowid ASC")
      .as(LinkRow);
    this.updateLinkSynced = db.query(
      "UPDATE links SET last_synced_at = ? WHERE pin_id = ? AND connector = ? AND ref = ?",
    );
    this.links = {
      forPin: (pinId) => this.selectLinksForPin.all(pinId).map(rowToLink),
      all: () =>
        this.selectAllLinks.all().map((row) => ({
          pinId: row.pin_id,
          link: rowToLink(row),
          lastSyncedAt: row.last_synced_at,
        })),
      markSynced: (pinId, link, at) => {
        this.updateLinkSynced.run(at, pinId, link.connector, link.ref);
      },
    };
  }

  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
    this.mutate(() => {
      this.insertPin.run(pin.id, pin.status, pin.createdAt, JSON.stringify(pin));
      this.insertFts.run(pin.id, "pin", pin.text);
      this.logEvent("pin.created", pin.createdAt, pin);
    });
    return pin;
  }

  getPin(id: string): Pin | null {
    const row = this.selectPin.get(id);
    return row ? parsePin(row.json) : null;
  }

  listPins(filter?: { status?: "open" | "resolved" }): Pin[] {
    const rows = filter?.status
      ? this.selectPinsByStatus.all(filter.status)
      : this.selectAllPins.all();
    return rows.map((r) => parsePin(r.json));
  }

  addThreadMessage(
    pinId: string,
    role: "human" | "agent" | "mirror",
    text: string,
    opts?: { origin?: string; attachments?: Attachment[] },
  ): ThreadMessage {
    const message = ThreadMessageSchema.parse({
      id: newId("msg"),
      pinId,
      role,
      ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
      text,
      ...(opts?.attachments !== undefined ? { attachments: opts.attachments } : {}),
      at: new Date().toISOString(),
    });
    this.mutate(() => {
      this.mustGetPin(pinId);
      this.insertMessage.run(message.id, message.pinId, message.at, JSON.stringify(message));
      this.insertFts.run(message.pinId, "msg", message.text);
      this.logEvent("thread.message", message.at, message);
    });
    return message;
  }

  getThread(pinId: string): ThreadMessage[] {
    return this.selectThread.all(pinId).map((r) => ThreadMessageSchema.parse(JSON.parse(r.json)));
  }

  resolvePin(id: string, by: "human" | "agent", note?: string, commit?: string): Pin {
    let resolved!: Pin;
    this.mutate(() => {
      const pin = this.mustGetPin(id); // re-read inside the transaction to enforce the conflict
      if (pin.status === "resolved") throw new ConflictError(`pin already resolved: ${id}`);
      const at = new Date().toISOString();
      resolved = PinSchema.parse({
        ...pin,
        status: "resolved",
        resolution: {
          by,
          ...(note !== undefined ? { note } : {}),
          ...(commit !== undefined ? { commit } : {}),
          at,
        },
      });
      this.updatePin.run(resolved.status, JSON.stringify(resolved), id);
      this.logEvent("pin.resolved", at, resolved);
    });
    return resolved;
  }

  bindSession(pinId: string, ref: SessionRef): Pin {
    const parsedRef = SessionRefSchema.parse(ref);
    let bound!: Pin;
    this.mutate(() => {
      const pin = this.mustGetPin(pinId);
      bound = PinSchema.parse({ ...pin, agentSession: parsedRef });
      this.updatePin.run(bound.status, JSON.stringify(bound), pinId);
      // no event: derived-table mutation, same class as sessions.touch
    });
    return bound;
  }

  verifyPin(id: string, outcome: "accepted" | "reopened"): Pin {
    let verified!: Pin;
    this.mutate(() => {
      const pin = this.mustGetPin(id);
      if (pin.status !== "resolved") throw new ConflictError(`pin not resolved: ${id}`);
      const at = new Date().toISOString();
      verified = PinSchema.parse({
        ...pin,
        status: outcome === "reopened" ? "open" : "resolved",
        verification: { outcome, at },
      });
      this.updatePin.run(verified.status, JSON.stringify(verified), id);
      this.logEvent("pin.verified", at, verified);
    });
    return verified;
  }

  searchPins(query: string): Pin[] {
    // The raw query is quoted as one FTS phrase (embedded quotes doubled) so user
    // input can never hit the MATCH syntax parser.
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return this.selectSearch.all(phrase).map((r) => parsePin(r.json));
  }

  addLink(pinId: string, link: Link): Pin {
    const parsed = LinkSchema.parse(link);
    let updated!: Pin;
    // mutate() uses an immediate transaction (daemon + stray CLI call is the
    // two-writer SQLITE_BUSY case, §3) and its post-commit subscriber flush. logEvent, not a
    // bare insertEvent: pin.linked must reach store.subscribe listeners (delivery router §6,
    // WS broadcaster §4).
    this.mutate(() => {
      const pin = this.mustGetPin(pinId);
      const existing = pin.links ?? [];
      if (existing.some((l) => l.connector === parsed.connector && l.ref === parsed.ref)) {
        throw new ConflictError(`pin already linked: ${pinId} → ${parsed.connector}#${parsed.ref}`);
      }
      const at = new Date().toISOString();
      updated = PinSchema.parse({ ...pin, links: [...existing, parsed] });
      this.insertLink.run(pinId, parsed.connector, parsed.ref, parsed.url, at);
      // Rewrite the pin's json column too, so getPin needs no join.
      this.updatePin.run(updated.status, JSON.stringify(updated), pinId);
      this.logEvent("pin.linked", at, updated);
    });
    return updated;
  }

  setDueAt(id: string, at: string | null): void {
    const result = this.updateDueAt.run(at, id);
    if (result.changes === 0) throw new NotFoundError(`pin not found: ${id}`);
  }

  pinsDueBefore(at: string): Pin[] {
    return this.selectDuePins.all(at).map((r) => parsePin(r.json));
  }

  eventsAfter(seq: number): StoredEvent[] {
    return this.selectEventsAfter.all(seq).map((row) => ({
      seq: row.seq,
      type: row.type as StoredEvent["type"],
      at: row.at,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  summary(): { open: number; resolved: number; lastEventSeq: number } {
    const row = this.selectSummary.get();
    return {
      open: row?.open ?? 0,
      resolved: row?.resolved ?? 0,
      lastEventSeq: row?.lastEventSeq ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs a mutation inside one immediate transaction (two-writer SQLITE_BUSY case:
   * daemon + stray CLI call, deep-dive §1.11), then flushes events collected by
   * logEvent to subscribers — post-commit, in seq order, on the mutating call's stack.
   */
  private mutate<T>(mutation: () => T): T {
    let result: T;
    try {
      result = this.db.transaction(mutation).immediate();
    } catch (cause) {
      this.pendingEvents = [];
      throw cause;
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // listeners must not break the mutation or each other; they wrap internally
        }
      }
    }
    return result;
  }

  private logEvent(type: StoredEvent["type"], at: string, payload: unknown): void {
    const result = this.insertEvent.run(type, at, JSON.stringify(payload));
    this.pendingEvents.push({ seq: Number(result.lastInsertRowid), type, at, payload });
  }

  private mustGetPin(id: string): Pin {
    const pin = this.getPin(id);
    if (!pin) throw new NotFoundError(`pin not found: ${id}`);
    return pin;
  }
}
