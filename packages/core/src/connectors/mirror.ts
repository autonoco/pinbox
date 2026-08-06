// @autono/pinbox-core/connectors — the mirror call sites: the origin-tag
// anti-echo rule is enforced HERE, in core, never per connector. Inbound remote activity is
// written role:"mirror" with origin "<connector>:<remoteUser>" and rides delivery via
// the store (§6); outbound mirroring skips anything that came from the same connector.
// No Bun.* here — core is host-agnostic (this file also runs on workerd).
import type { ThreadMessage } from "../schema.ts";
import type { PinStore } from "../store.ts";
import type { ConnectorEvents } from "./types.ts";

export function createConnectorEvents(store: PinStore, pinId: string): ConnectorEvents {
  return {
    async onRemoteComment(_link, comment): Promise<void> {
      store.addThreadMessage(pinId, "mirror", comment.text, { origin: comment.origin });
    },

    async onRemoteStatus(_link, status): Promise<void> {
      const pin = store.getPin(pinId);
      if (pin === null) return; // nothing to reconcile
      if (status === "closed") {
        // §7: closed → resolvePin(by:"agent") — unless already resolved (no-op, keep the
        // original resolution; a status change caused here is never mirrored back out).
        if (pin.status !== "resolved") store.resolvePin(pinId, "agent");
        return;
      }
      // status "open": only a resolved pin has anything to reconcile. verifyPin is a
      // required PinStore member, so no feature detection is needed here — the
      // anti-echo rule applies unconditionally.
      if (pin.status !== "resolved") return;
      store.verifyPin(pinId, "reopened");
    },
  };
}

/**
 * The §7 skip rule, tested exhaustively: messages newer than the cursor that did NOT come
 * from this connector. Human/agent messages flow out; mirrors flow out only cross-connector
 * (a slack-origin mirror is outbound for github); origin-less mirrors (local notices) and
 * anything tagged `<connector>:` never echo back.
 */
export function outboundCandidates(
  thread: ThreadMessage[],
  connector: string,
  since: string | null,
): ThreadMessage[] {
  const prefix = `${connector}:`;
  return thread.filter((message) => {
    if (since !== null && message.at <= since) return false;
    if ((message.origin ?? "").startsWith(prefix)) return false; // non-negotiable anti-echo
    if (message.role === "mirror") return message.origin !== undefined;
    return true; // human | agent
  });
}
