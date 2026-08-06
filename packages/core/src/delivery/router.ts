// @autono/pinbox-core/delivery — DeliveryRouter: sticky routing over the deliveries
// ledger. The sticky-routing rules are spelled out on dispatch() below.
//
// WORKERS-SAFETY (build-breaking): this file never statically imports
// resume.ts, openclaw.ts, or anything else touching Bun.spawn — adapters arrive via
// the constructor. The CLI serve path assembles [hooks, openclaw, resume, webhook];
// the Worker assembles [webhook]. No Bun.* API appears here.
//
// The deliveries table is simultaneously the retry schedule (due_at backoff), the
// delivery log, and the replay cursor: EVERY event gets a row (`skipped` when
// unroutable-by-design), so MAX(event_seq) is the consumer cursor and boot
// reconciliation is eventsAfter(deliveries.lastEventSeq()) — the event-log replay
// contract, consumed as designed (the `cursors` table is never read here).
import type { Pin, SessionRef } from "../schema.ts";
import { PinSchema, ThreadMessageSchema } from "../schema.ts";
import type { Session } from "../sessions.ts";
import type { DeliveryRow, PinStore, StoredEvent } from "../store.ts";

export interface DeliveryAdapter {
  readonly name: string; // reserved: "hooks" | "openclaw" | "resume" | "webhook"
  matches(session: Session): boolean | Promise<boolean>; // reachable right now? cheap, no side effects
  deliver(event: StoredEvent, session: Session): Promise<void>; // throw ⇒ retry via deliveries queue (due_at backoff)
}

// Workers-safe re-exports for the ./delivery entry (router + types,
// hooks adapter and context builders — no resume/openclaw import).
export { buildInjectionContext, buildReplyPrompt } from "./context.ts";
export { createHooksAdapter, HOOK_CAPABLE_AGENTS } from "./hooks.ts";

// Pull-based adapters: deliver() has no push side effect — the pending row IS the
// delivery, pulled by `pinbox session inject`. The router leaves their rows pending
// with an escalation due_at instead of marking them delivered.
const PULL_ADAPTERS: ReadonlySet<string> = new Set(["hooks"]);

// Placeholder adapter name for rows no adapter has claimed: skipped-by-design rows
// and pending rows awaiting a session or a reachable adapter.
const NO_ADAPTER = "none";

export const DEFAULT_HOOKS_ESCALATE_MS = 600_000; // 10 min

/** Escalation window for pull rows: PINBOX_HOOKS_ESCALATE_MS, default 10 min. */
export function hooksEscalateMs(): number {
  // Guarded env read: `process` does not exist on workerd without nodejs_compat.
  const raw = typeof process === "undefined" ? undefined : process.env["PINBOX_HOOKS_ESCALATE_MS"];
  if (raw === undefined) return DEFAULT_HOOKS_ESCALATE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOOKS_ESCALATE_MS;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_FACTOR = 4;
const BACKOFF_CAP_MS = 900_000; // 15 min
const MAX_ATTEMPTS = 5;

type RoutingTarget =
  | { kind: "skip" } // unroutable-by-design: ledger row only
  | { kind: "unassigned" } // rule 1: no session anywhere — queue for the next one
  | { kind: "session"; session: Session };

export class DeliveryRouter {
  private readonly store: PinStore;
  private readonly adapters: DeliveryAdapter[];
  // Dispatches serialize through one promise chain: `subscribe` fires synchronously
  // in seq order and routing must not interleave bindings out of order.
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { store: PinStore; adapters: DeliveryAdapter[] }) {
    this.store = opts.store;
    this.adapters = [...opts.adapters];
  }

  /** THE single entry point; never throws — failures land in the queue. */
  dispatch(event: StoredEvent): Promise<void> {
    return this.enqueueWork(() => this.dispatchOne(event));
  }

  /**
   * Runs on hub wake + a coarse unref'd interval: (a) boot/cursor reconciliation,
   * (b) retry/escalate due pending rows, (c) assign unassigned rows to the active
   * session. Never rejects.
   */
  drainDue(now?: string): Promise<void> {
    return this.enqueueWork(() => this.drainNow(now ?? new Date().toISOString()));
  }

  private enqueueWork(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work).catch(() => {
      // dispatch/drainDue never reject; anything unrecoverable here is retried by
      // the next drain's boot reconciliation (the queue, not the process, is durable)
    });
    this.chain = run;
    return run;
  }

  private async dispatchOne(event: StoredEvent): Promise<void> {
    // Idempotence guard: rows are written in seq order, so any seq at or below the
    // cursor already has its row (a mutation can be seen both by the live
    // subscription and by a concurrent drain's replay).
    if (event.seq <= this.store.deliveries.lastEventSeq()) return;
    let target: RoutingTarget;
    try {
      target = this.route(event);
    } catch {
      target = { kind: "skip" }; // malformed payload / mid-route store error: keep the cursor complete
    }
    if (target.kind === "skip") {
      this.store.deliveries.enqueue({
        eventSeq: event.seq,
        sessionId: null,
        adapter: NO_ADAPTER,
        dueAt: null,
        status: "skipped",
      });
      return;
    }
    if (target.kind === "unassigned") {
      // Rule 1: the next session to register receives all unassigned pins — claimed
      // by drainDue (c) or by the next `pinbox session inject` pull.
      this.store.deliveries.enqueue({
        eventSeq: event.seq,
        sessionId: null,
        adapter: NO_ADAPTER,
        dueAt: null,
      });
      return;
    }
    await this.attemptNew(event, target.session, new Date());
  }

  /**
   * Deliverable events are pin.created and thread.message with role human|mirror
   * (rule 3: agent-authored events are never delivered back). Everything else —
   * pin.resolved, and later event types — is skipped-by-design.
   */
  private route(event: StoredEvent): RoutingTarget {
    if (event.type === "pin.created") {
      const pin = PinSchema.parse(event.payload);
      return this.bindTarget(pin);
    }
    if (event.type === "thread.message") {
      const message = ThreadMessageSchema.parse(event.payload);
      if (message.role === "agent") return { kind: "skip" }; // rule 3
      const pin = this.store.getPin(message.pinId);
      if (pin === null) return { kind: "skip" };
      return this.bindTarget(pin);
    }
    return { kind: "skip" };
  }

  private bindTarget(pin: Pin): RoutingTarget {
    const { sessions } = this.store;
    if (pin.agentSession !== undefined) {
      // Rules 1 & 2: the bound ref wins — registering if unknown, never a fresh key.
      const session = sessions.findByRef(pin.agentSession) ?? sessions.register(pin.agentSession);
      return { kind: "session", session };
    }
    const active = sessions.active();
    if (active === null) return { kind: "unassigned" };
    // Rule-1 persistence: rule 2 reads pin.agentSession directly.
    this.store.bindSession(pin.id, sessionRefOf(active));
    return { kind: "session", session: active };
  }

  private async attemptNew(event: StoredEvent, session: Session, now: Date): Promise<void> {
    const { deliveries } = this.store;
    const adapter = await this.selectAdapter(this.adapters, session);
    if (adapter === null) {
      // Nothing reachable right now: pending, no adapter recorded; drains re-select.
      deliveries.enqueue({
        eventSeq: event.seq,
        sessionId: session.id,
        adapter: NO_ADAPTER,
        dueAt: null,
      });
      return;
    }
    if (PULL_ADAPTERS.has(adapter.name)) {
      // The pending row IS the delivery; due_at is the escalation deadline — a row
      // still pending when it passes re-selects starting after "hooks" at drain.
      const dueAt = new Date(now.getTime() + hooksEscalateMs()).toISOString();
      const row = deliveries.enqueue({
        eventSeq: event.seq,
        sessionId: session.id,
        adapter: adapter.name,
        dueAt,
      });
      try {
        await adapter.deliver(event, session); // side-effect-free for pull adapters
      } catch (cause) {
        this.recordFailure(row, cause, now);
      }
      return;
    }
    const row = deliveries.enqueue({
      eventSeq: event.seq,
      sessionId: session.id,
      adapter: adapter.name,
      dueAt: null,
    });
    try {
      await adapter.deliver(event, session);
      deliveries.markDelivered(row.id);
    } catch (cause) {
      this.recordFailure(row, cause, now);
    }
  }

  private async drainNow(now: string): Promise<void> {
    const { store } = this;
    // (a) Boot/cursor reconciliation — covers a crash between event commit and
    // enqueue, and events appended while no daemon ran.
    for (const event of store.eventsAfter(store.deliveries.lastEventSeq())) {
      await this.dispatchOne(event);
    }
    // (b) Retry / escalate due pending rows.
    for (const row of store.deliveries.due(now)) {
      if (row.sessionId === null) continue; // (c) owns unassigned rows
      try {
        await this.retryRow(row, now);
      } catch {
        // one bad row must not block the drain; the row stays pending for the next one
      }
    }
    // (c) Assign unassigned rows to the active session — rule 1's "the next session
    // to register receives all unassigned pins" (the inject pull satisfies it too).
    const active = store.sessions.active();
    if (active !== null) {
      for (const row of store.deliveries.unassigned()) {
        try {
          await this.claimRow(row, active, now);
        } catch {
          // ditto — stays pending
        }
      }
    }
    // The connector-poll branch — pinsDueBefore(now) — lives in connectors/poll.ts,
    // deliberately not here: this file stays on the delivery path only.
  }

  private async retryRow(row: DeliveryRow, now: string): Promise<void> {
    const { deliveries, sessions } = this.store;
    const event = this.eventOf(row);
    if (event === null) {
      deliveries.markFailed(row.id, `E_DELIVERY: event ${row.eventSeq} missing from log`, null);
      return;
    }
    const session = row.sessionId === null ? null : sessions.get(row.sessionId);
    if (session === null) {
      deliveries.markFailed(row.id, `E_SESSION_GONE: session ${row.sessionId} unknown`, null);
      return;
    }
    // Escalation order: re-select starting AFTER the recorded adapter, wrapping — a
    // live-but-abandoned TUI escalates hooks → resume, while a sole failing adapter
    // wraps around and retries itself.
    const adapter = await this.selectAdapter(this.rotatedAfter(row.adapter), session);
    if (adapter === null) return; // nothing reachable; stays pending for the next drain
    if (PULL_ADAPTERS.has(adapter.name)) return; // already the pull delivery; nothing to push
    try {
      await adapter.deliver(event, session);
      deliveries.markDelivered(row.id);
    } catch (cause) {
      this.recordFailure(row, cause, new Date(Date.parse(now)));
    }
  }

  private async claimRow(row: DeliveryRow, active: Session, now: string): Promise<void> {
    const event = this.eventOf(row);
    if (event === null) {
      this.store.deliveries.markFailed(
        row.id,
        `E_DELIVERY: event ${row.eventSeq} missing from log`,
        null,
      );
      return;
    }
    this.store.deliveries.assign(row.id, active.id);
    const pinId = pinIdOfEvent(event);
    if (pinId !== null) {
      try {
        this.store.bindSession(pinId, sessionRefOf(active)); // rule-1 persistence
      } catch {
        // pin vanished from the derived table; the delivery attempt below still decides the row
      }
    }
    await this.retryRow({ ...row, sessionId: active.id }, now);
  }

  private async selectAdapter(
    candidates: DeliveryAdapter[],
    session: Session,
  ): Promise<DeliveryAdapter | null> {
    for (const adapter of candidates) {
      try {
        if (await adapter.matches(session)) return adapter;
      } catch {
        // a throwing matches() is a non-match, never a crashed dispatch
      }
    }
    return null;
  }

  private rotatedAfter(name: string): DeliveryAdapter[] {
    const index = this.adapters.findIndex((adapter) => adapter.name === name);
    if (index < 0) return [...this.adapters];
    return [...this.adapters.slice(index + 1), ...this.adapters.slice(0, index + 1)];
  }

  private recordFailure(row: DeliveryRow, cause: unknown, now: Date): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Rule 2's terminal case: resume refused/impossible ⇒ E_SESSION_GONE, no retry.
    const sessionGone = message.startsWith("E_SESSION_GONE");
    const attempts = row.attempts; // attempts BEFORE this failure; markFailed bumps it
    if (sessionGone || attempts >= MAX_ATTEMPTS - 1) {
      const lastError = sessionGone ? message : `E_DELIVERY: ${message}`;
      this.store.deliveries.markFailed(row.id, lastError, null);
      return;
    }
    const backoffMs = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempts, BACKOFF_CAP_MS);
    const retryAt = new Date(now.getTime() + backoffMs).toISOString();
    this.store.deliveries.markFailed(row.id, message, retryAt);
  }

  private eventOf(row: DeliveryRow): StoredEvent | null {
    // Re-fetch by seq via the event-log replay contract; seq-checked.
    const event = this.store.eventsAfter(row.eventSeq - 1).at(0);
    return event !== undefined && event.seq === row.eventSeq ? event : null;
  }
}

function sessionRefOf(session: Session): SessionRef {
  return {
    agent: session.agent,
    key: session.key,
    ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
  };
}

/** pin.created payloads are the Pin (`id`); thread.message payloads carry `pinId`. */
function pinIdOfEvent(event: StoredEvent): string | null {
  if (event.type === "pin.created") {
    const parsed = PinSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.id : null;
  }
  if (event.type === "thread.message") {
    const parsed = ThreadMessageSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.pinId : null;
  }
  return null;
}
