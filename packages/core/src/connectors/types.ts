// @autono/pinbox-core/connectors — the connector interface.
// The CLI implements GitHub; the Worker reuses it with an injected transport. The pin thread is
// the source of truth; mirroring is bidirectional and echo-proof: inbound mirrors are
// written role:"mirror" with origin "<connector>:<remoteUser>", and outbound mirroring
// skips any message whose origin starts with "<connector>:" (enforced in core at the
// mirror call sites, never per connector).
import type { Link, Pin, ThreadMessage } from "../schema.ts";

/** Host-injected transport: local = `gh` CLI shell-out (impl in packages/cli, Bun.$); Worker = App token fetch. */
export interface ConnectorTransport {
  request(op: string, params: Record<string, unknown>): Promise<unknown>;
}

export type RemoteComment = { origin: string; text: string; at: string }; // origin "github:benji"
export type RemoteStatus = "open" | "closed";

/** Hub-supplied sinks — the connector reports inbound activity, core writes it. */
export type ConnectorEvents = {
  onRemoteComment(link: Link, comment: RemoteComment): Promise<void>; // writes role:"mirror" + origin; rides normal delivery
  onRemoteStatus(link: Link, status: RemoteStatus): Promise<void>; // closed → resolvePin(by:"agent"); open on a resolved pin → verifyPin(id, "reopened")
};

export interface Connector {
  readonly name: string; // also the Link.connector value and origin-tag prefix; "github", "slack"
  createItem(pin: Pin, thread: ThreadMessage[]): Promise<Link>; // caller stores the Link via store.addLink
  postComment(link: Link, message: ThreadMessage): Promise<void>; // mirror one thread message outward
  /** Inbound: poll (local, scheduled via pins.due_at + drainDue) or webhook-parse (Worker route); reports through the sinks; caller marks links.markSynced. */
  sync(link: Link, events: ConnectorEvents): Promise<void>;
  /** The outbound half of the status rule; the Slack connector implements it too. */
  setRemoteStatus(link: Link, status: RemoteStatus): Promise<void>;
}
