// @autono/pinbox-core/connectors — the inbound half of a link drain: §7's mirror sinks
// wrapped with the replay filter that keeps a re-viewed remote comment from being mirrored
// twice (every connector's `sync` replays the remote's whole comment list each poll).
//
// The filter is REMOTE-AUTHORITATIVE by construction — it compares nothing against a
// clock. The previous filter compared the remote's `createdAt` against our locally-stamped
// lastSyncedAt: a remote whose clock runs behind ours produces a genuinely new comment
// carrying a createdAt at or below our cursor, and it was dropped on that poll and every
// poll after — the mirror lost it permanently, silently. Skew cannot lose a comment here:
// the durable pin thread IS the record of what has been mirrored, and each inbound comment
// is matched against it by identity (origin + text), counted, so a remote author repeating
// themselves verbatim still mirrors once per occurrence.
// No Bun.* here — core is host-agnostic (this file also runs on workerd).
import type { Pin, ThreadMessage } from "../schema.ts";
import type { PinStore } from "../store.ts";
import { createConnectorEvents } from "./mirror.ts";
import type { ConnectorEvents } from "./types.ts";

export type InboundSync = {
  events: ConnectorEvents;
  /** Timestamp of a local status transition the sinks performed, or null if none. */
  transitionedAt: () => string | null;
};

/** The §7 sinks plus the replay filter and the transition probe the cursor needs. */
export function inboundEvents(
  store: PinStore,
  pinId: string,
  connector: string,
  statusPushed: boolean,
): InboundSync {
  const sinks = createConnectorEvents(store, pinId);
  // Snapshot of what this connector has already mirrored into the thread, as a multiset:
  // each incoming comment consumes one match, so occurrence N+1 of an identical comment
  // is mirrored the poll it first appears.
  const unmatched = mirroredCounts(store.getThread(pinId), connector);
  // Exactly the value pendingStatus compares to the cursor, so the caller can advance the
  // cursor past it and keep the transition from echoing back out on the next drain.
  let transitionedAt: string | null = null;
  const events: ConnectorEvents = {
    async onRemoteComment(link, comment): Promise<void> {
      const key = mirrorKey(comment.origin, comment.text);
      const already = unmatched.get(key) ?? 0;
      if (already > 0) {
        unmatched.set(key, already - 1); // mirrored on an earlier poll
        return;
      }
      await sinks.onRemoteComment(link, comment);
    },
    async onRemoteStatus(link, status): Promise<void> {
      if (statusPushed) return; // this cycle the local transition wins
      const before = store.getPin(pinId)?.status;
      await sinks.onRemoteStatus(link, status);
      transitionedAt = transitionStamp(before, store.getPin(pinId)) ?? transitionedAt;
    },
  };
  return { events, transitionedAt: () => transitionedAt };
}

/** How many times each (origin, text) already sits in the thread as this connector's mirror. */
function mirroredCounts(thread: ThreadMessage[], connector: string): Map<string, number> {
  const prefix = `${connector}:`;
  const counts = new Map<string, number>();
  for (const message of thread) {
    const origin = message.origin;
    if (message.role !== "mirror" || origin === undefined || !origin.startsWith(prefix)) continue;
    const key = mirrorKey(origin, message.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** NUL separator: it cannot occur in an origin tag, so the two fields never blur. */
function mirrorKey(origin: string, text: string): string {
  return `${origin}\u0000${text}`;
}

/** The timestamp the sinks stamped a status transition with, or null if none happened. */
function transitionStamp(before: Pin["status"] | undefined, after: Pin | null): string | null {
  if (before === undefined || after === null || after.status === before) return null;
  const at = after.status === "resolved" ? after.resolution?.at : after.verification?.at;
  return at ?? new Date().toISOString();
}
