// @autono/pinbox-core/connectors — the outbound half of a link drain: the thread messages
// to mirror out plus the local status transition, ordered by timestamp and executed behind
// a RESUMABLE watermark.
//
// Why a watermark and not "post everything, then mark synced": the links cursor is
// per-link, so a postComment throw partway through a flush skipped markSynced entirely and
// the next drain re-posted every message that had already landed — duplicate comments on
// the user's issue, once per retry, forever. The cursor now advances only over work that
// COMPLETED, in timestamp order, which makes the flush resumable without re-posting.
// No Bun.* here — core is host-agnostic (this file also runs on workerd).
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import { outboundCandidates } from "./mirror.ts";
import type { Connector, RemoteStatus } from "./types.ts";

/** One remote write, carrying the timestamp the cursor advances to once it lands. */
export type OutboundOp =
  | { at: string; kind: "comment"; message: ThreadMessage }
  | { at: string; kind: "status"; status: RemoteStatus };

export type OutboundFlush = {
  posted: Set<string>; // ids of the messages this flush actually mirrored out
  statusPushed: boolean; // the planned status transition reached the remote
  /** Highest timestamp the cursor may take without skipping unfinished work; null = hold. */
  watermark: string | null;
  error: unknown | null; // the throw that stopped the flush, if any
};

/**
 * Everything owed to the remote for this link, oldest first. The status transition is an
 * op like any other precisely so the watermark stays a single ordered cursor: if it were
 * flushed out of band, a watermark past its timestamp would drop it on the next drain.
 * Sort is stable, so a transition stamped in the same millisecond as a comment still goes
 * out after it (comments, then the close).
 */
export function outboundPlan(
  thread: ThreadMessage[],
  connector: string,
  pin: Pin,
  since: string | null,
): OutboundOp[] {
  const ops: OutboundOp[] = outboundCandidates(thread, connector, since).map((message) => ({
    at: message.at,
    kind: "comment",
    message,
  }));
  const status = pendingStatus(pin, since);
  if (status !== null) ops.push({ at: status.at, kind: "status", status: status.status });
  return ops.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The local status transition newer than the cursor, or null — §7's outbound half (A2). */
function pendingStatus(
  pin: Pin,
  since: string | null,
): { status: RemoteStatus; at: string } | null {
  const newerThanCursor = (at: string): boolean => since === null || at > since;
  const resolution = pin.resolution;
  if (pin.status === "resolved" && resolution !== undefined && newerThanCursor(resolution.at)) {
    return { status: "closed", at: resolution.at };
  }
  const verification = pin.verification;
  if (
    pin.status === "open" &&
    verification?.outcome === "reopened" &&
    newerThanCursor(verification.at)
  ) {
    return { status: "open", at: verification.at };
  }
  return null;
}

/** Execute the plan in order, stopping at the first throw. Never rejects — the caller
 * banks the watermark before it re-raises, so progress is never lost to an exception. */
export async function flushOutbound(
  connector: Connector,
  link: Link,
  ops: OutboundOp[],
): Promise<OutboundFlush> {
  const posted = new Set<string>();
  let statusPushed = false;
  let done = 0;
  for (const op of ops) {
    try {
      if (op.kind === "comment") {
        await connector.postComment(link, op.message);
        posted.add(op.message.id);
      } else {
        await connector.setRemoteStatus(link, op.status);
        statusPushed = true;
      }
    } catch (error) {
      return { posted, statusPushed, watermark: resumeWatermark(ops, done), error };
    }
    done += 1;
  }
  return { posted, statusPushed, watermark: ops.at(-1)?.at ?? null, error: null };
}

/**
 * How far a partial flush may move the cursor: strictly below the first unfinished op's
 * stamp. Ops sharing a millisecond cannot be split by a timestamp cursor, so a tie group
 * containing unfinished work holds the cursor below the whole group — the landed members
 * are re-sent on the next drain (one duplicate) rather than the unfinished ones being
 * silently dropped. Distinct stamps, the ordinary case, resume exactly.
 */
function resumeWatermark(ops: OutboundOp[], done: number): string | null {
  const pending = ops[done]?.at;
  if (pending === undefined) return ops.at(-1)?.at ?? null;
  for (let i = done - 1; i >= 0; i -= 1) {
    const at = ops[i]?.at;
    if (at !== undefined && at < pending) return at;
  }
  return null;
}
