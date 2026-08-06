import { describe, expect, test } from "bun:test";
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import { createSlackConnector, createSlackTransport } from "./slack.ts";
import type { ConnectorEvents, ConnectorTransport, RemoteComment } from "./types.ts";

const pin: Pin = {
  id: "pin_abcdefghij",
  schemaVersion: 1,
  status: "open",
  createdAt: "2026-08-04T10:00:00.000Z",
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

const link: Link = {
  connector: "slack",
  ref: "C123/1722600000.000100",
  url: "https://acme.slack.com/archives/C123/p1722600000000100",
};

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "msg_0000000001",
    pinId: pin.id,
    role: "human",
    text: "please fix on mobile too",
    at: "2026-08-04T10:05:00.000Z",
    ...overrides,
  };
}

type Call = { op: string; params: Record<string, unknown> };

function mockTransport(respond: (op: string, params: Record<string, unknown>) => unknown): {
  calls: Call[];
  transport: ConnectorTransport;
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      async request(op, params) {
        calls.push({ op, params });
        return respond(op, params);
      },
    },
  };
}

function collectEvents(): { comments: RemoteComment[]; events: ConnectorEvents } {
  const comments: RemoteComment[] = [];
  return {
    comments,
    events: {
      async onRemoteComment(_link, comment) {
        comments.push(comment);
      },
      async onRemoteStatus() {
        throw new Error("onRemoteStatus must never be called for slack (no status vocabulary)");
      },
    },
  };
}

describe("createSlackTransport", () => {
  test("POSTs JSON to https://slack.com/api/<op> with the bot token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const t = createSlackTransport({ botToken: "xoxb-secret", fetchImpl });
    const data = (await t.request("chat.postMessage", { channel: "C123", text: "hi" })) as {
      ok: boolean;
    };
    expect(data.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(seen[0]?.init.method).toBe("POST");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer xoxb-secret");
    expect(headers["content-type"]).toContain("application/json");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ channel: "C123", text: "hi" });
  });

  test("Slack {ok:false,error} rejects with the Slack error string in the message", async () => {
    const fetchImpl = (async () =>
      Response.json({ ok: false, error: "channel_not_found" })) as unknown as typeof fetch;
    const t = createSlackTransport({ botToken: "xoxb-secret", fetchImpl });
    expect(t.request("chat.postMessage", { channel: "nope" })).rejects.toThrow(/channel_not_found/);
  });

  test("non-2xx HTTP rejects", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const t = createSlackTransport({ botToken: "xoxb-secret", fetchImpl });
    expect(t.request("chat.postMessage", {})).rejects.toThrow(/503/);
  });
});

describe("createItem", () => {
  test("posts the pin at standard detail and returns a slack Link with ref + permalink", async () => {
    const { calls, transport } = mockTransport((op) => {
      if (op === "chat.postMessage") return { ok: true, channel: "C123", ts: "1722600000.000100" };
      if (op === "chat.getPermalink")
        return { ok: true, permalink: "https://acme.slack.com/archives/C123/p1722600000000100" };
      throw new Error(`unexpected op ${op}`);
    });
    const connector = createSlackConnector(transport, { channel: "C123" });
    expect(connector.name).toBe("slack");
    const created = await connector.createItem(pin, []);
    expect(created).toEqual({
      connector: "slack",
      ref: "C123/1722600000.000100",
      url: "https://acme.slack.com/archives/C123/p1722600000000100",
    });
    expect(calls[0]?.op).toBe("chat.postMessage");
    expect(calls[0]?.params["channel"]).toBe("C123");
    expect(String(calls[0]?.params["text"])).toContain("button is cut off");
    expect(String(calls[0]?.params["text"])).toContain("url: http://localhost:3000/");
    expect(calls[1]?.op).toBe("chat.getPermalink");
    expect(calls[1]?.params).toEqual({ channel: "C123", message_ts: "1722600000.000100" });
  });

  test("transport failure rejects (route layer maps to 502 E_CONNECTOR)", async () => {
    const { transport } = mockTransport(() => {
      throw new Error("slack chat.postMessage failed: invalid_auth");
    });
    const connector = createSlackConnector(transport, { channel: "C123" });
    expect(connector.createItem(pin, [])).rejects.toThrow(/invalid_auth/);
  });
});

describe("postComment", () => {
  test("threads the message on thread_ts parsed from the ref", async () => {
    const { calls, transport } = mockTransport(() => ({ ok: true, ts: "1722600300.000500" }));
    const connector = createSlackConnector(transport, { channel: "C123" });
    await connector.postComment(link, message());
    expect(calls).toEqual([
      {
        op: "chat.postMessage",
        params: {
          channel: "C123",
          thread_ts: "1722600000.000100",
          text: "please fix on mobile too",
        },
      },
    ]);
  });

  test("posts blindly — never second-guesses core's origin-tag anti-echo skip", async () => {
    const { calls, transport } = mockTransport(() => ({ ok: true, ts: "1722600301.000500" }));
    const connector = createSlackConnector(transport, { channel: "C123" });
    await connector.postComment(link, message({ role: "mirror", origin: "slack:U999" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params["text"]).toBe("please fix on mobile too");
  });
});

describe("sync", () => {
  const replies = [
    { ts: "1722600000.000100", user: "UBOT", text: "pin text (thread parent)" },
    { ts: "1722599000.000100", user: "U123", text: "old reply, before the cursor" },
    { ts: "1722603600.000000", user: "U123", text: "reply exactly at the cursor" },
    { ts: "1722607200.000200", user: "U123", text: "first new reply" },
    { ts: "1722607300.000300", user: "U456", text: "second new reply" },
  ];

  // Replay filtering is core's job (inbound.ts), and core does it against the durable pin
  // thread — never against a clock. A connector that filtered on OUR lastSyncedAt would
  // drop a reply whose Slack ts sits below it, which is exactly what a Slack workspace
  // clock running behind ours produces: a genuinely new reply, lost before core ever sees it.
  test("reports every reply except the parent, even under a local-clock cursor", async () => {
    const { calls, transport } = mockTransport(() => ({ ok: true, messages: replies }));
    const { comments, events } = collectEvents();
    const cursor = new Date(1722603600 * 1000).toISOString();
    const connector = createSlackConnector(transport, { channel: "C123" });
    await connector.sync({ ...link, lastSyncedAt: cursor } as Link, events);
    expect(calls[0]?.op).toBe("conversations.replies");
    expect(calls[0]?.params["channel"]).toBe("C123");
    expect(calls[0]?.params["ts"]).toBe("1722600000.000100");
    expect(comments.map((c) => c.text)).toEqual([
      "old reply, before the cursor",
      "reply exactly at the cursor",
      "first new reply",
      "second new reply",
    ]);
    expect(comments.at(-1)).toEqual({
      origin: "slack:U456",
      text: "second new reply",
      at: new Date(1722607300.0003 * 1000).toISOString(),
    });
  });

  test("no cursor: every reply except the thread parent is reported", async () => {
    const { transport } = mockTransport(() => ({ ok: true, messages: replies }));
    const { comments, events } = collectEvents();
    const connector = createSlackConnector(transport, { channel: "C123" });
    await connector.sync(link, events);
    expect(comments).toHaveLength(4);
    expect(comments[0]?.origin).toBe("slack:U123");
  });

  test("transport failure rejects", async () => {
    const { transport } = mockTransport(() => {
      throw new Error("slack conversations.replies failed: channel_not_found");
    });
    const { events } = collectEvents();
    const connector = createSlackConnector(transport, { channel: "C123" });
    expect(connector.sync(link, events)).rejects.toThrow(/channel_not_found/);
  });
});

describe("setRemoteStatus", () => {
  test("is a documented no-op — Slack threads have no open/closed vocabulary", async () => {
    const { calls, transport } = mockTransport(() => {
      throw new Error("transport must not be called");
    });
    const connector = createSlackConnector(transport, { channel: "C123" });
    await connector.setRemoteStatus(link, "closed");
    await connector.setRemoteStatus(link, "open");
    expect(calls).toHaveLength(0);
  });
});
