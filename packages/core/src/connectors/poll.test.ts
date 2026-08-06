// drainConnectorPolls: state reconciliation on pins.due_at (the "
// connector polls" clause). Outbound flush → outbound status → inbound sync → markSynced +
// re-arm. Cursor-vs-timestamp comparison makes echo impossible; per-pin failures never throw.
import { describe, expect, test } from "bun:test";
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import { openStore, type PinStore } from "../store.ts";
import { drainConnectorPolls, POLL_OPEN_MS, POLL_RESOLVED_MS } from "./poll.ts";
import type { Connector, ConnectorEvents, RemoteComment, RemoteStatus } from "./types.ts";

const validInput = {
  text: "button is cut off",
  kind: "note",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
  },
  env: {
    viewport: { w: 1440, h: 900, dpr: 2 },
    browser: "Chrome 130",
    os: "macOS",
    colorScheme: "light",
  },
  author: { userId: "bobak" },
};

const base = Date.now();
const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
const PAST = iso(-60_000);
const NOW_1 = iso(5_000);
const NOW_2 = iso(10_000);

class FakeConnector implements Connector {
  readonly name: string = "github";
  readonly posted: { link: Link; message: ThreadMessage }[] = [];
  readonly statusCalls: { link: Link; status: RemoteStatus }[] = [];
  syncCount = 0;
  /** Scripted inbound: called by sync with the events sinks. */
  onSync: ((link: Link, events: ConnectorEvents) => Promise<void>) | null = null;
  throwOnSyncRef: string | null = null;
  /** Scripted outbound failure: postComment throws for a message with this exact text. */
  failPostText: string | null = null;

  async createItem(_pin: Pin, _thread: ThreadMessage[]): Promise<Link> {
    throw new Error("unused");
  }

  async postComment(link: Link, message: ThreadMessage): Promise<void> {
    if (this.failPostText !== null && message.text === this.failPostText) {
      throw new Error(`remote rejected ${message.id}`);
    }
    this.posted.push({ link, message });
  }

  async sync(link: Link, events: ConnectorEvents): Promise<void> {
    this.syncCount += 1;
    if (this.throwOnSyncRef === link.ref) throw new Error("remote unreachable");
    await this.onSync?.(link, events);
  }

  async setRemoteStatus(link: Link, status: RemoteStatus): Promise<void> {
    this.statusCalls.push({ link, status });
  }
}

function setup(ref = "123"): { store: PinStore; pin: Pin; link: Link; connector: FakeConnector } {
  const store = openStore(":memory:");
  const pin = store.createPin(validInput as never, {});
  const link: Link = { connector: "github", ref, url: `https://github.com/a/b/issues/${ref}` };
  store.addLink(pin.id, link);
  store.setDueAt(pin.id, PAST);
  return { store, pin, link, connector: new FakeConnector() };
}

function dueIds(store: PinStore, at: string): string[] {
  return store.pinsDueBefore(at).map((p) => p.id);
}

describe("a due linked open pin", () => {
  test("flushes outbound, syncs inbound, marks synced, re-arms due_at at the open cadence", async () => {
    const { store, pin, connector } = setup();
    const message = store.addThreadMessage(pin.id, "human", "please fix");
    const remote: RemoteComment = { origin: "github:benji", text: "on it", at: iso(1_000) };
    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, remote);
      await events.onRemoteStatus(l, "open");
    };

    await drainConnectorPolls(store, [connector], NOW_1);

    expect(connector.posted.map((p) => p.message.id)).toEqual([message.id]);
    expect(connector.syncCount).toBe(1);
    const mirrors = store.getThread(pin.id).filter((m) => m.role === "mirror");
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]?.origin).toBe("github:benji");
    expect(store.links.all()[0]?.lastSyncedAt).toBe(NOW_1);
    // Re-armed strictly into the future, at the open cadence.
    expect(dueIds(store, iso(6_000))).toEqual([]);
    expect(dueIds(store, new Date(Date.parse(NOW_1) + POLL_OPEN_MS + 1_000).toISOString())).toEqual(
      [pin.id],
    );
    store.close();
  });
});

describe("outbound echo suppression (the cursor)", () => {
  test("a flushed message is never re-posted on the next drain", async () => {
    const { store, pin, connector } = setup();
    store.addThreadMessage(pin.id, "human", "please fix");
    await drainConnectorPolls(store, [connector], NOW_1);
    store.setDueAt(pin.id, PAST); // force due again
    await drainConnectorPolls(store, [connector], NOW_2);
    expect(connector.posted).toHaveLength(1);
    store.close();
  });

  test("local resolve → setRemoteStatus('closed') exactly once across two drains", async () => {
    const { store, pin, link, connector } = setup();
    store.resolvePin(pin.id, "human");
    await drainConnectorPolls(store, [connector], NOW_1);
    store.setDueAt(pin.id, PAST);
    await drainConnectorPolls(store, [connector], NOW_2);
    expect(connector.statusCalls).toEqual([{ link, status: "closed" }]);
    store.close();
  });

  test("a re-viewed remote comment is not re-mirrored (inbound cursor)", async () => {
    const { store, pin, connector } = setup();
    const remote: RemoteComment = { origin: "github:benji", text: "same", at: iso(1_000) };
    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, remote); // remote view always replays all comments
    };
    await drainConnectorPolls(store, [connector], NOW_1);
    store.setDueAt(pin.id, PAST);
    await drainConnectorPolls(store, [connector], NOW_2);
    expect(store.getThread(pin.id).filter((m) => m.role === "mirror")).toHaveLength(1);
    store.close();
  });
});

describe("direction rule", () => {
  test("a local resolve pushes out; stale remote 'open' the same cycle does not pull back", async () => {
    const { store, pin, connector } = setup();
    store.resolvePin(pin.id, "human");
    connector.onSync = async (l, events) => {
      await events.onRemoteStatus(l, "open"); // remote hasn't seen the close yet
    };
    await drainConnectorPolls(store, [connector], NOW_1);
    expect(connector.statusCalls.map((c) => c.status)).toEqual(["closed"]);
    expect(store.getPin(pin.id)?.status).toBe("resolved");
    expect(store.getThread(pin.id)).toHaveLength(0); // no "reopened" notice fight
    store.close();
  });

  test("remote closed pulls in: pin resolves by:agent and re-arms at the resolved cadence", async () => {
    const { store, pin, connector } = setup();
    connector.onSync = async (l, events) => {
      await events.onRemoteStatus(l, "closed");
    };
    await drainConnectorPolls(store, [connector], NOW_1);
    const updated = store.getPin(pin.id);
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution?.by).toBe("agent");
    const openHorizon = new Date(Date.parse(NOW_1) + POLL_OPEN_MS + 1_000).toISOString();
    const resolvedHorizon = new Date(Date.parse(NOW_1) + POLL_RESOLVED_MS + 1_000).toISOString();
    expect(dueIds(store, openHorizon)).toEqual([]);
    expect(dueIds(store, resolvedHorizon)).toEqual([pin.id]);
    store.close();
  });
});

describe("cross-drain echo (remote-caused transitions)", () => {
  // The anti-echo rule: "a status change caused by onRemoteStatus is not mirrored back out."
  // Real-clock path: resolvePin stamps a wall clock AFTER drain-start `at` (transport
  // latency), so a drain-start cursor would read it as a local transition next drain.
  test("a remote-caused close is not pushed back out on the next drain (real clock)", async () => {
    const { store, pin, connector } = setup();
    connector.onSync = async (l, events) => {
      await new Promise((r) => setTimeout(r, 5)); // transport round-trip
      await events.onRemoteStatus(l, "closed");
    };
    await drainConnectorPolls(store, [connector]); // production path: no injected now
    expect(store.getPin(pin.id)?.status).toBe("resolved");
    expect(connector.statusCalls).toEqual([]);

    connector.onSync = null;
    store.setDueAt(pin.id, new Date(Date.now() - 60_000).toISOString());
    await drainConnectorPolls(store, [connector]);
    expect(connector.statusCalls).toEqual([]); // no echo of the remote's own close
    store.close();
  });

  test("the cursor advance does not swallow a human message written mid-drain", async () => {
    const { store, pin, connector } = setup();
    connector.onSync = async (l, events) => {
      await events.onRemoteStatus(l, "closed");
      store.addThreadMessage(pin.id, "human", "wait, checking one thing"); // lands mid-drain
    };
    await drainConnectorPolls(store, [connector]);

    connector.onSync = null;
    store.setDueAt(pin.id, new Date(Date.now() - 60_000).toISOString());
    await drainConnectorPolls(store, [connector]);
    // Flushed exactly once across both drains — neither dropped nor duplicated.
    expect(connector.posted.map((p) => p.message.text)).toEqual(["wait, checking one thing"]);
    expect(connector.statusCalls).toEqual([]);
    store.close();
  });
});

describe("partial outbound failure is resumable", () => {
  // The cursor advances per successfully-posted message: a postComment throw mid-flush
  // must not make the next drain re-post the ones that already landed (duplicate
  // comments on the user's issue).
  test("messages that landed before the throw are never re-posted", async () => {
    const { store, pin, connector } = setup();
    store.addThreadMessage(pin.id, "human", "one");
    await Bun.sleep(2); // distinct ISO-millisecond stamps — the cursor is a timestamp
    store.addThreadMessage(pin.id, "human", "two");
    await Bun.sleep(2);
    store.addThreadMessage(pin.id, "human", "three");
    connector.failPostText = "two";

    await drainConnectorPolls(store, [connector], NOW_1); // logged, never rejects
    expect(connector.posted.map((p) => p.message.text)).toEqual(["one"]);
    expect(dueIds(store, NOW_1)).toEqual([pin.id]); // failed link stays due

    connector.failPostText = null;
    await drainConnectorPolls(store, [connector], NOW_2);
    expect(connector.posted.map((p) => p.message.text)).toEqual(["one", "two", "three"]);
    store.close();
  });

  test("same-millisecond messages are re-posted, never dropped, when the flush fails", async () => {
    const { store, pin, connector } = setup();
    store.addThreadMessage(pin.id, "human", "a"); // same tick ⇒ identical `at`
    store.addThreadMessage(pin.id, "human", "b");
    connector.failPostText = "b";

    await drainConnectorPolls(store, [connector], NOW_1);
    connector.failPostText = null;
    await drainConnectorPolls(store, [connector], NOW_2);

    // The tie group cannot be split by a timestamp cursor: prefer a duplicate over a
    // silent drop — every message reaches the remote at least once.
    expect(connector.posted.map((p) => p.message.text)).toContain("b");
    expect(connector.posted.filter((p) => p.message.text === "a").length).toBeGreaterThan(0);
    store.close();
  });

  test("a throw on the first message leaves the cursor untouched", async () => {
    const { store, pin, connector } = setup();
    store.addThreadMessage(pin.id, "human", "only");
    connector.failPostText = "only";
    await drainConnectorPolls(store, [connector], NOW_1);
    expect(store.links.all()[0]?.lastSyncedAt).toBeNull();
    store.close();
  });
});

describe("inbound is remote-authoritative (clock skew)", () => {
  // The remote stamps createdAt with ITS clock; our cursor is stamped with ours. A remote
  // running behind produces a genuinely new comment whose createdAt sits at or below the
  // cursor — a timestamp comparison drops it forever.
  test("a new remote comment stamped before our cursor is still mirrored", async () => {
    const { store, pin, connector } = setup();
    const first: RemoteComment = { origin: "github:benji", text: "on it", at: iso(1_000) };
    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, first);
    };
    await drainConnectorPolls(store, [connector], NOW_1);

    // Remote clock is a minute behind ours; this comment was written after the drain above.
    const skewed: RemoteComment = { origin: "github:benji", text: "it is the padding", at: PAST };
    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, first); // the remote view always replays everything
      await events.onRemoteComment(l, skewed);
    };
    store.setDueAt(pin.id, PAST);
    await drainConnectorPolls(store, [connector], NOW_2);

    const mirrors = store.getThread(pin.id).filter((m) => m.role === "mirror");
    expect(mirrors.map((m) => m.text)).toEqual(["on it", "it is the padding"]);
    store.close();
  });

  test("a repeated identical remote comment mirrors twice, once each poll", async () => {
    const { store, pin, connector } = setup();
    const bump: RemoteComment = { origin: "github:benji", text: "bump", at: iso(1_000) };
    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, bump);
    };
    await drainConnectorPolls(store, [connector], NOW_1);

    connector.onSync = async (l, events) => {
      await events.onRemoteComment(l, bump);
      await events.onRemoteComment(l, { ...bump, at: iso(2_000) }); // the author said it again
    };
    store.setDueAt(pin.id, PAST);
    await drainConnectorPolls(store, [connector], NOW_2);

    expect(store.getThread(pin.id).filter((m) => m.role === "mirror")).toHaveLength(2);
    store.close();
  });
});

describe("scope and resilience", () => {
  test("a non-due pin is untouched", async () => {
    const { store, pin, connector } = setup();
    store.setDueAt(pin.id, iso(3_600_000));
    await drainConnectorPolls(store, [connector], NOW_1);
    expect(connector.syncCount).toBe(0);
    expect(connector.posted).toHaveLength(0);
    store.close();
  });

  test("a link with no known connector is skipped and due_at left alone", async () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput as never, {});
    store.addLink(pin.id, { connector: "jira", ref: "9", url: "https://jira/9" });
    store.setDueAt(pin.id, PAST);
    const connector = new FakeConnector();
    await drainConnectorPolls(store, [connector], NOW_1);
    expect(connector.syncCount).toBe(0);
    expect(dueIds(store, NOW_1)).toEqual([pin.id]); // untouched — still due
    store.close();
  });

  test("a sync throw on one pin leaves other pins drained and never rejects", async () => {
    const store = openStore(":memory:");
    const pinA = store.createPin(validInput as never, {});
    const pinB = store.createPin(validInput as never, {});
    store.addLink(pinA.id, { connector: "github", ref: "1", url: "https://github/1" });
    store.addLink(pinB.id, { connector: "github", ref: "2", url: "https://github/2" });
    store.setDueAt(pinA.id, PAST);
    store.setDueAt(pinB.id, PAST);
    const connector = new FakeConnector();
    connector.throwOnSyncRef = "1";

    await drainConnectorPolls(store, [connector], NOW_1);

    const rows = store.links.all();
    expect(rows.find((r) => r.pinId === pinA.id)?.lastSyncedAt).toBeNull();
    expect(rows.find((r) => r.pinId === pinB.id)?.lastSyncedAt).toBe(NOW_1);
    expect(dueIds(store, NOW_1)).toEqual([pinA.id]); // A still due, B re-armed
    store.close();
  });
});
