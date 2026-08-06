// @autono/pinbox-core/connectors — connector state reconciliation on pins.due_at.
// Fills the connector-poll (pinsDueBefore) clause of drainDue. This is a poll,
// not event chasing: each due linked pin flushes outbound (cursor-filtered — echo is
// impossible by construction), pulls inbound through the §7 sinks, marks synced, re-arms.
// Direction rule: local transitions newer than lastSyncedAt push out; otherwise remote
// state pulls in. This module is the ORCHESTRATION only — the two halves live in
// outbound.ts (ordered, resumable flush) and inbound.ts (skew-proof replay filter).
// No Bun.* here — core is host-agnostic (the Worker reuses this on workerd).
import type { Link, Pin } from "../schema.ts";
import type { PinStore } from "../store.ts";
import { inboundEvents } from "./inbound.ts";
import { outboundCandidates } from "./mirror.ts";
import { flushOutbound, type OutboundOp, outboundPlan } from "./outbound.ts";
import type { Connector } from "./types.ts";

export const POLL_OPEN_MS = 60_000;
export const POLL_RESOLVED_MS = 600_000;

/** Per-pin failures are caught + logged to stderr; the drain never throws (§6 dispatch discipline). */
export async function drainConnectorPolls(
  store: PinStore,
  connectors: Connector[],
  now?: string,
): Promise<void> {
  const at = now ?? new Date().toISOString();
  for (const pin of store.pinsDueBefore(at)) {
    try {
      await drainPin(store, connectors, pin, at);
    } catch (cause) {
      console.error(`pinbox: connector poll failed for ${pin.id}:`, cause);
    }
  }
}

/** A row of the links ledger: the link plus its reconciliation cursor. */
type LinkRow = { pinId: string; link: Link; lastSyncedAt: string | null };

async function drainPin(
  store: PinStore,
  connectors: Connector[],
  pin: Pin,
  at: string,
): Promise<void> {
  let drained = 0;
  for (const row of store.links.all().filter((r) => r.pinId === pin.id)) {
    const connector = connectors.find((c) => c.name === row.link.connector);
    if (connector === undefined) continue; // no transport for this link — skip, stay due
    await syncLink(store, connector, pin, row, at);
    drained += 1;
  }
  if (drained === 0) return; // nothing serviceable — leave due_at alone
  rearm(store, pin, at);
}

/** One link: drain it, bank however far it got, then re-raise any failure. Banking BEFORE
 * re-raising is the whole point — a partial flush that already reached the remote must
 * never be replayed, or the user sees duplicate comments on their issue. */
async function syncLink(
  store: PinStore,
  connector: Connector,
  pin: Pin,
  row: LinkRow,
  at: string,
): Promise<void> {
  const result = await drainLink(store, connector, pin, row.link, row.lastSyncedAt, at);
  if (advances(result.syncedAt, row.lastSyncedAt)) {
    store.links.markSynced(pin.id, row.link, result.syncedAt);
  }
  if (result.error !== null) throw result.error; // pin stays due — retried next tick
}

/** Re-arm off the post-sync status (an inbound close moves the pin to the slow cadence). */
function rearm(store: PinStore, pin: Pin, at: string): void {
  const status = store.getPin(pin.id)?.status ?? pin.status;
  const cadence = status === "open" ? POLL_OPEN_MS : POLL_RESOLVED_MS;
  store.setDueAt(pin.id, new Date(Date.parse(at) + cadence).toISOString());
}

/** How far this link got: the cursor to bank, and the failure that stopped it, if any. */
type LinkDrain = { syncedAt: string | null; error: unknown | null };

async function drainLink(
  store: PinStore,
  connector: Connector,
  pin: Pin,
  link: Link,
  lastSyncedAt: string | null,
  at: string,
): Promise<LinkDrain> {
  // 1. Outbound: the §7 skip rule lives in outboundCandidates; the status transition rides
  //    the same ordered plan so one watermark covers both.
  const plan = outboundPlan(store.getThread(pin.id), connector.name, pin, lastSyncedAt);
  const flush = await flushOutbound(connector, link, plan);
  if (flush.error !== null) return { syncedAt: flush.watermark, error: flush.error };

  // 2. Inbound: remote state pulls in — unless we just pushed (a stale remote view the
  //    same cycle must not pull the local transition back).
  const inbound = inboundEvents(store, pin.id, connector.name, flush.statusPushed);
  try {
    await connector.sync(link, inbound.events);
  } catch (error) {
    return { syncedAt: flush.watermark, error };
  }

  // 3. Cross-drain anti-echo (§7: "a status change caused by onRemoteStatus is not mirrored
  //    back out"): a remote-caused transition is stamped with a wall clock LATER than the
  //    drain-start `at` (transport latency), so a cursor left at `at` would make the next
  //    drain's pendingStatus read it as a local transition and push it straight back.
  //    Advance the cursor over the transition it caused — and over nothing else:
  const syncedAt = latest(at, flush.watermark, inbound.transitionedAt()) ?? at;
  // Anything the cursor would swallow (written mid-drain, at ≤ the cursor) is flushed now,
  // before the cursor moves past it.
  const late = lateComments(store, connector, pin, lastSyncedAt, syncedAt, flush.posted);
  const second = await flushOutbound(connector, link, late);
  if (second.error !== null) {
    return { syncedAt: latest(flush.watermark, second.watermark), error: second.error };
  }
  return { syncedAt, error: null };
}

/** Messages the cursor is about to pass that this drain has not posted yet. */
function lateComments(
  store: PinStore,
  connector: Connector,
  pin: Pin,
  lastSyncedAt: string | null,
  syncedAt: string,
  posted: Set<string>,
): OutboundOp[] {
  const thread = outboundCandidates(store.getThread(pin.id), connector.name, lastSyncedAt);
  return thread
    .filter((message) => message.at <= syncedAt && !posted.has(message.id))
    .map((message) => ({ at: message.at, kind: "comment", message }));
}

/** Newest of the given stamps, ignoring nulls. */
function latest(...stamps: (string | null)[]): string | null {
  let newest: string | null = null;
  for (const stamp of stamps) {
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return newest;
}

/** A cursor only ever moves forward — a banked partial watermark must not regress it. */
function advances(next: string | null, current: string | null): next is string {
  if (next === null) return false;
  return current === null || next > current;
}
