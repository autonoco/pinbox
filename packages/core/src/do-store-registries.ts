// @autono/pinbox-core/do-store-registries — the keyed sub-stores of the DO SQLite
// PinStore sub-stores: sessions, cursors, links, deliveries. Split from
// do-store.ts along the PinStore interface boundaries. workerd-clean: no Bun
// globals, no node: imports, types via module-form @cloudflare/workers-types.
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import { newId } from "./id.ts";
import type { Link, SessionRef } from "./schema.ts";
import { type Session, SessionSchema, type SessionStore } from "./sessions.ts";
import {
  type CursorStore,
  type DeliveryRow,
  type DeliveryStatus,
  type DeliveryStore,
  type LinkStore,
  NotFoundError,
} from "./store.ts";

function parseSession(json: string): Session {
  return SessionSchema.parse(JSON.parse(json)); // corruption fails loudly
}

export class DoSessionStore implements SessionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
  ) {}

  register(ref: SessionRef): Session {
    return this.storage.transactionSync(() => {
      const now = new Date().toISOString();
      const existing = this.findByRef(ref);
      // Upsert by (agent, key): keeps id/registeredAt, refreshes lastSeenAt/cwd,
      // clears endedAt.
      const session = SessionSchema.parse({
        id: existing?.id ?? newId("ses"),
        agent: ref.agent,
        key: ref.key,
        ...(ref.cwd !== undefined ? { cwd: ref.cwd } : {}),
        registeredAt: existing?.registeredAt ?? now,
        lastSeenAt: now,
      });
      this.sql.exec(
        `INSERT INTO sessions (id, agent, key, cwd, registered_at, last_seen_at, ended_at, json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd, last_seen_at = excluded.last_seen_at,
           ended_at = NULL, json = excluded.json`,
        session.id,
        session.agent,
        session.key,
        session.cwd ?? null,
        session.registeredAt,
        session.lastSeenAt,
        JSON.stringify(session),
      );
      return session;
    });
  }

  get(id: string): Session | null {
    const row = this.sql
      .exec<{ json: string }>("SELECT json FROM sessions WHERE id = ?", id)
      .toArray()[0];
    return row ? parseSession(row.json) : null;
  }

  findByRef(ref: Pick<SessionRef, "agent" | "key">): Session | null {
    const row = this.sql
      .exec<{ json: string }>(
        "SELECT json FROM sessions WHERE agent = ? AND key = ?",
        ref.agent,
        ref.key,
      )
      .toArray()[0];
    return row ? parseSession(row.json) : null;
  }

  active(): Session | null {
    const row = this.sql
      .exec<{ json: string }>(
        "SELECT json FROM sessions WHERE ended_at IS NULL ORDER BY last_seen_at DESC, rowid DESC LIMIT 1",
      )
      .toArray()[0];
    return row ? parseSession(row.json) : null;
  }

  list(): Session[] {
    return this.sql
      .exec<{ json: string }>("SELECT json FROM sessions ORDER BY last_seen_at DESC, rowid DESC")
      .toArray()
      .map((row) => parseSession(row.json));
  }

  touch(id: string): void {
    this.refresh(id, (session, now) => ({ ...session, lastSeenAt: now }));
  }

  end(id: string): void {
    this.refresh(id, (session, now) => ({ ...session, endedAt: now }));
  }

  private refresh(id: string, update: (session: Session, now: string) => Session): void {
    this.storage.transactionSync(() => {
      const existing = this.get(id);
      if (!existing) throw new NotFoundError(`session not found: ${id}`);
      const session = SessionSchema.parse(update(existing, new Date().toISOString()));
      this.sql.exec(
        "UPDATE sessions SET last_seen_at = ?, ended_at = ?, json = ? WHERE id = ?",
        session.lastSeenAt,
        session.endedAt ?? null,
        JSON.stringify(session),
        id,
      );
    });
  }
}

export class DoCursorStore implements CursorStore {
  constructor(private readonly sql: SqlStorage) {}

  get(consumerId: string): number {
    const row = this.sql
      .exec<{ last_seq: number }>("SELECT last_seq FROM cursors WHERE consumer_id = ?", consumerId)
      .toArray()[0];
    return row?.last_seq ?? 0;
  }

  set(consumerId: string, lastSeq: number): void {
    this.sql.exec(
      `INSERT INTO cursors (consumer_id, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(consumer_id) DO UPDATE SET
         last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
      consumerId,
      lastSeq,
      new Date().toISOString(),
    );
  }
}

type LinkRow = {
  pin_id: string;
  connector: string;
  ref: string;
  url: string;
  last_synced_at: string | null;
};

export class DoLinkStore implements LinkStore {
  constructor(private readonly sql: SqlStorage) {}

  forPin(pinId: string): Link[] {
    return this.sql
      .exec<LinkRow>(
        "SELECT pin_id, connector, ref, url, last_synced_at FROM links WHERE pin_id = ? ORDER BY rowid ASC",
        pinId,
      )
      .toArray()
      .map((row) => ({ connector: row.connector, ref: row.ref, url: row.url }));
  }

  all(): { pinId: string; link: Link; lastSyncedAt: string | null }[] {
    return this.sql
      .exec<LinkRow>(
        "SELECT pin_id, connector, ref, url, last_synced_at FROM links ORDER BY rowid ASC",
      )
      .toArray()
      .map((row) => ({
        pinId: row.pin_id,
        link: { connector: row.connector, ref: row.ref, url: row.url },
        lastSyncedAt: row.last_synced_at,
      }));
  }

  markSynced(pinId: string, link: Pick<Link, "connector" | "ref">, at: string): void {
    this.sql.exec(
      "UPDATE links SET last_synced_at = ? WHERE pin_id = ? AND connector = ? AND ref = ?",
      at,
      pinId,
      link.connector,
      link.ref,
    );
  }
}

type DeliveryDbRow = {
  id: number;
  event_seq: number;
  session_id: string | null;
  adapter: string;
  status: string;
  attempts: number;
  due_at: string | null;
  last_error: string | null;
  updated_at: string;
};

const DELIVERY_COLUMNS =
  "id, event_seq, session_id, adapter, status, attempts, due_at, last_error, updated_at";

function mapDelivery(row: DeliveryDbRow): DeliveryRow {
  return {
    id: row.id,
    eventSeq: row.event_seq,
    sessionId: row.session_id,
    adapter: row.adapter,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    dueAt: row.due_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export class DoDeliveryStore implements DeliveryStore {
  constructor(private readonly sql: SqlStorage) {}

  enqueue(row: {
    eventSeq: number;
    sessionId: string | null;
    adapter: string;
    dueAt: string | null;
    status?: "pending" | "skipped";
  }): DeliveryRow {
    const inserted = this.sql
      .exec<DeliveryDbRow>(
        `INSERT INTO deliveries (event_seq, session_id, adapter, status, attempts, due_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING ${DELIVERY_COLUMNS}`,
        row.eventSeq,
        row.sessionId,
        row.adapter,
        row.status ?? "pending",
        row.dueAt,
        new Date().toISOString(),
      )
      .one();
    return mapDelivery(inserted);
  }

  due(now: string): DeliveryRow[] {
    return this.sql
      .exec<DeliveryDbRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries
         WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?) ORDER BY id ASC`,
        now,
      )
      .toArray()
      .map(mapDelivery);
  }

  pendingForSession(sessionId: string): DeliveryRow[] {
    return this.sql
      .exec<DeliveryDbRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries
         WHERE status = 'pending' AND session_id = ? ORDER BY id ASC`,
        sessionId,
      )
      .toArray()
      .map(mapDelivery);
  }

  unassigned(): DeliveryRow[] {
    return this.sql
      .exec<DeliveryDbRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries
         WHERE status = 'pending' AND session_id IS NULL ORDER BY id ASC`,
      )
      .toArray()
      .map(mapDelivery);
  }

  assign(id: number, sessionId: string): void {
    this.sql.exec(
      "UPDATE deliveries SET session_id = ?, updated_at = ? WHERE id = ?",
      sessionId,
      new Date().toISOString(),
      id,
    );
  }

  markDelivered(id: number): void {
    this.sql.exec(
      "UPDATE deliveries SET status = 'delivered', updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      id,
    );
  }

  markFailed(id: number, error: string, retryAt: string | null): void {
    this.sql.exec(
      `UPDATE deliveries SET attempts = attempts + 1, last_error = ?,
         status = ?, due_at = ?, updated_at = ? WHERE id = ?`,
      error,
      retryAt === null ? "failed" : "pending",
      retryAt,
      new Date().toISOString(),
      id,
    );
  }

  lastEventSeq(): number {
    return this.sql
      .exec<{ last: number }>("SELECT COALESCE(MAX(event_seq), 0) AS last FROM deliveries")
      .one().last;
  }
}
