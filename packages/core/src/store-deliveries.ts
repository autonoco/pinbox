// @autono/pinbox-core/store-deliveries — sqlite DeliveryStore over the migration-2
// `deliveries` ledger. The table is simultaneously the retry schedule (due_at backoff),
// the delivery log (attempts / last_error / updated_at), and the delivery router's
// replay cursor (MAX(event_seq) — `skipped` rows keep it complete). Constructed by
// openStore, exposed as the readonly `deliveries` member of PinStore.
import type { Database } from "bun:sqlite";
import type { DeliveryRow, DeliveryStore } from "./store.ts";

class Row {
  id!: number;
  event_seq!: number;
  session_id!: string | null;
  adapter!: string;
  status!: string;
  attempts!: number;
  due_at!: string | null;
  last_error!: string | null;
  updated_at!: string;
}

class MaxSeqRow {
  last_event_seq!: number;
}

function toDeliveryRow(row: Row): DeliveryRow {
  return {
    id: row.id,
    eventSeq: row.event_seq,
    sessionId: row.session_id,
    adapter: row.adapter,
    status: row.status as DeliveryRow["status"],
    attempts: row.attempts,
    dueAt: row.due_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, event_seq, session_id, adapter, status, attempts, due_at, last_error, updated_at";

export class SqliteDeliveryStore implements DeliveryStore {
  private readonly insert;
  private readonly selectById;
  private readonly selectDue;
  private readonly selectForSession;
  private readonly selectUnassigned;
  private readonly updateAssign;
  private readonly updateDelivered;
  private readonly updateFailed;
  private readonly selectMaxSeq;

  constructor(db: Database) {
    this.insert = db.query(
      `INSERT INTO deliveries (event_seq, session_id, adapter, status, attempts, due_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`,
    );
    this.selectById = db.query(`SELECT ${COLUMNS} FROM deliveries WHERE id = ?`).as(Row);
    this.selectDue = db
      .query(
        `SELECT ${COLUMNS} FROM deliveries
         WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?) ORDER BY id ASC`,
      )
      .as(Row);
    this.selectForSession = db
      .query(
        `SELECT ${COLUMNS} FROM deliveries
         WHERE status = 'pending' AND session_id = ? ORDER BY id ASC`,
      )
      .as(Row);
    this.selectUnassigned = db
      .query(
        `SELECT ${COLUMNS} FROM deliveries
         WHERE status = 'pending' AND session_id IS NULL ORDER BY id ASC`,
      )
      .as(Row);
    this.updateAssign = db.query(
      "UPDATE deliveries SET session_id = ?, updated_at = ? WHERE id = ?",
    );
    this.updateDelivered = db.query(
      "UPDATE deliveries SET status = 'delivered', updated_at = ? WHERE id = ?",
    );
    this.updateFailed = db.query(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, due_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.selectMaxSeq = db
      .query("SELECT COALESCE(MAX(event_seq), 0) AS last_event_seq FROM deliveries")
      .as(MaxSeqRow);
  }

  enqueue(row: {
    eventSeq: number;
    sessionId: string | null;
    adapter: string;
    dueAt: string | null;
    status?: "pending" | "skipped";
  }): DeliveryRow {
    const result = this.insert.run(
      row.eventSeq,
      row.sessionId,
      row.adapter,
      row.status ?? "pending",
      row.dueAt,
      new Date().toISOString(),
    );
    return this.mustGet(Number(result.lastInsertRowid));
  }

  due(now: string): DeliveryRow[] {
    return this.selectDue.all(now).map(toDeliveryRow);
  }

  pendingForSession(sessionId: string): DeliveryRow[] {
    return this.selectForSession.all(sessionId).map(toDeliveryRow);
  }

  unassigned(): DeliveryRow[] {
    return this.selectUnassigned.all().map(toDeliveryRow);
  }

  assign(id: number, sessionId: string): void {
    this.updateAssign.run(sessionId, new Date().toISOString(), id);
  }

  markDelivered(id: number): void {
    this.updateDelivered.run(new Date().toISOString(), id);
  }

  markFailed(id: number, error: string, retryAt: string | null): void {
    // null retryAt ⇒ terminal 'failed'; otherwise re-scheduled pending. Both bump attempts.
    this.updateFailed.run(
      retryAt === null ? "failed" : "pending",
      retryAt,
      error,
      new Date().toISOString(),
      id,
    );
  }

  lastEventSeq(): number {
    return this.selectMaxSeq.get()?.last_event_seq ?? 0;
  }

  private mustGet(id: number): DeliveryRow {
    const row = this.selectById.get(id);
    if (!row) throw new Error(`delivery row not found after insert: ${id}`);
    return toDeliveryRow(row);
  }
}
