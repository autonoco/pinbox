// @autono/pinbox-core/sessions — agent session registry.
// Sessions are a DERIVED table: no session events exist — the event log stays
// pin-centric. SqliteSessionStore is constructed by openStore and exposed as the
// readonly `sessions` member of PinStore; the DO adapter implements the
// same SessionStore interface over Durable Object SQLite.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { newId } from "./id.ts";
import type { SessionRef } from "./schema.ts";
// From the leaf module, NOT ./store.ts — store.ts imports SqliteSessionStore from this file,
// so importing errors from there would close a runtime import cycle (fallow flags it).
import { NotFoundError } from "./store-errors.ts";

// The CLI's `pinbox session trailer` consumes the parser through this subpath: the
// the package export table is final and carries no `./trailer` entry, and this verb
// family is where it is used (trailer.ts itself stays a pure, I/O-free module).
export { parseTrailers } from "./trailer.ts";

export const SessionSchema = z.object({
  id: z.string().regex(/^ses_[a-z0-9]{10}$/),
  agent: z.string(),
  key: z.string(),
  cwd: z.string().optional(),
  registeredAt: z.string(),
  lastSeenAt: z.string(),
  endedAt: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;
export interface SessionStore {
  register(ref: SessionRef): Session; // upsert by (agent, key): refreshes lastSeenAt/cwd, keeps id, clears endedAt
  get(id: string): Session | null;
  findByRef(ref: Pick<SessionRef, "agent" | "key">): Session | null;
  active(): Session | null; // most recently seen, not ended; null when none
  list(): Session[];
  touch(id: string): void; // bumps lastSeenAt; @throws NotFoundError
  end(id: string): void; // sets endedAt; @throws NotFoundError
}

class JsonRow {
  json!: string;
}

function parseSession(json: string): Session {
  return SessionSchema.parse(JSON.parse(json)); // corruption fails loudly
}

export class SqliteSessionStore implements SessionStore {
  private readonly insert;
  private readonly update;
  private readonly selectById;
  private readonly selectByRef;
  private readonly selectActive;
  private readonly selectAll;

  constructor(db: Database) {
    this.insert = db.query(
      `INSERT INTO sessions (id, agent, key, cwd, registered_at, last_seen_at, ended_at, json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    this.update = db.query(
      "UPDATE sessions SET cwd = ?, last_seen_at = ?, ended_at = ?, json = ? WHERE id = ?",
    );
    this.selectById = db.query("SELECT json FROM sessions WHERE id = ?").as(JsonRow);
    this.selectByRef = db
      .query("SELECT json FROM sessions WHERE agent = ? AND key = ?")
      .as(JsonRow);
    this.selectActive = db
      .query(
        `SELECT json FROM sessions WHERE ended_at IS NULL
         ORDER BY last_seen_at DESC, rowid DESC LIMIT 1`,
      )
      .as(JsonRow);
    this.selectAll = db
      .query("SELECT json FROM sessions ORDER BY last_seen_at DESC, rowid DESC")
      .as(JsonRow);
  }

  register(ref: SessionRef): Session {
    const now = new Date().toISOString();
    const existing = this.findByRef(ref);
    if (existing) {
      const cwd = ref.cwd ?? existing.cwd;
      const session = SessionSchema.parse({
        id: existing.id,
        agent: existing.agent,
        key: existing.key,
        ...(cwd !== undefined ? { cwd } : {}),
        registeredAt: existing.registeredAt,
        lastSeenAt: now,
        // endedAt cleared: the same (agent, key) coming back IS the session resuming
      });
      this.write(session);
      return session;
    }
    const session = SessionSchema.parse({
      id: newId("ses"),
      agent: ref.agent,
      key: ref.key,
      ...(ref.cwd !== undefined ? { cwd: ref.cwd } : {}),
      registeredAt: now,
      lastSeenAt: now,
    });
    this.insert.run(
      session.id,
      session.agent,
      session.key,
      session.cwd ?? null,
      session.registeredAt,
      session.lastSeenAt,
      JSON.stringify(session),
    );
    return session;
  }

  get(id: string): Session | null {
    const row = this.selectById.get(id);
    return row ? parseSession(row.json) : null;
  }

  findByRef(ref: Pick<SessionRef, "agent" | "key">): Session | null {
    const row = this.selectByRef.get(ref.agent, ref.key);
    return row ? parseSession(row.json) : null;
  }

  active(): Session | null {
    const row = this.selectActive.get();
    return row ? parseSession(row.json) : null;
  }

  list(): Session[] {
    return this.selectAll.all().map((r) => parseSession(r.json));
  }

  touch(id: string): void {
    const session = this.mustGet(id);
    this.write({ ...session, lastSeenAt: new Date().toISOString() });
  }

  end(id: string): void {
    const session = this.mustGet(id);
    this.write({ ...session, endedAt: new Date().toISOString() });
  }

  private write(session: Session): void {
    this.update.run(
      session.cwd ?? null,
      session.lastSeenAt,
      session.endedAt ?? null,
      JSON.stringify(session),
      session.id,
    );
  }

  private mustGet(id: string): Session {
    const session = this.get(id);
    if (!session) throw new NotFoundError(`session not found: ${id}`);
    return session;
  }
}
