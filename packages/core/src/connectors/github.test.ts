// GitHub connector over an injected transport: createItem
// builds title/body/Link exactly, sync maps comments to origin-tagged RemoteComments and
// state to RemoteStatus, setRemoteStatus fires close/reopen ops.
import { describe, expect, test } from "bun:test";
import { pinsToMarkdown } from "../markdown.ts";
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import { openStore, type PinStore } from "../store.ts";
import { createGithubConnector } from "./github.ts";
import type { RemoteComment, RemoteStatus } from "./types.ts";

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

class FakeTransport {
  readonly calls: { op: string; params: Record<string, unknown> }[] = [];

  constructor(private readonly results: Record<string, unknown> = {}) {}

  async request(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ op, params });
    const result = this.results[op];
    if (result instanceof Error) throw result;
    return result;
  }
}

function makePin(store: PinStore, text?: string): Pin {
  return store.createPin({ ...validInput, ...(text === undefined ? {} : { text }) } as never, {});
}

const link: Link = { connector: "github", ref: "123", url: "https://github.com/a/b/issues/123" };

function recordingEvents() {
  const comments: RemoteComment[] = [];
  const statuses: RemoteStatus[] = [];
  return {
    comments,
    statuses,
    events: {
      onRemoteComment: async (_l: Link, c: RemoteComment) => {
        comments.push(c);
      },
      onRemoteStatus: async (_l: Link, s: RemoteStatus) => {
        statuses.push(s);
      },
    },
  };
}

describe("createItem", () => {
  test("issue.create with first-line title, standard markdown body + pin trailer; Link from the result", async () => {
    const store = openStore(":memory:");
    const pin = makePin(store, "button is cut off\nsecond line detail");
    const transport = new FakeTransport({
      "issue.create": { number: 123, url: "https://github.com/a/b/issues/123" },
    });
    const connector = createGithubConnector(transport);

    const created = await connector.createItem(pin, store.getThread(pin.id));

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls.at(0);
    expect(call?.op).toBe("issue.create");
    expect(call?.params["title"]).toBe("button is cut off");
    expect(call?.params["body"]).toBe(
      `${pinsToMarkdown([pin], "standard")}\n\n— pinbox pin ${pin.id}`,
    );
    expect(created).toEqual({
      connector: "github",
      ref: "123",
      url: "https://github.com/a/b/issues/123",
    });
    store.close();
  });

  test("title is capped at 72 chars", async () => {
    const store = openStore(":memory:");
    const pin = makePin(store, `${"x".repeat(100)}\nrest`);
    const transport = new FakeTransport({ "issue.create": { number: 1, url: "u" } });
    await createGithubConnector(transport).createItem(pin, []);
    expect(transport.calls[0]?.params["title"]).toBe("x".repeat(72));
    store.close();
  });
});

describe("postComment", () => {
  test("issue.comment with the issue number and the message text + pinbox trailer", async () => {
    const store = openStore(":memory:");
    const pin = makePin(store);
    const message: ThreadMessage = store.addThreadMessage(pin.id, "agent", "fixed in abc123");
    const transport = new FakeTransport({ "issue.comment": undefined });

    await createGithubConnector(transport).postComment(link, message);

    const call = transport.calls.at(0);
    expect(call?.op).toBe("issue.comment");
    expect(call?.params["number"]).toBe(123);
    expect(call?.params["body"]).toBe(`fixed in abc123\n\n— pinbox ${message.id}`);
    store.close();
  });
});

describe("sync", () => {
  test("one issue.view; comments map to origin-tagged RemoteComments, state to RemoteStatus", async () => {
    const transport = new FakeTransport({
      "issue.view": {
        state: "closed",
        comments: [
          { author: "benji", body: "looks wrong on mobile", createdAt: "2026-08-04T10:00:00Z" },
        ],
      },
    });
    const { comments, statuses, events } = recordingEvents();

    await createGithubConnector(transport).sync(link, events);

    expect(transport.calls).toEqual([{ op: "issue.view", params: { number: 123 } }]);
    expect(comments).toEqual([
      { origin: "github:benji", text: "looks wrong on mobile", at: "2026-08-04T10:00:00Z" },
    ]);
    expect(statuses).toEqual(["closed"]);
  });

  test("comments ending with a pinbox trailer (our own mirrors) are skipped remote-side too", async () => {
    const transport = new FakeTransport({
      "issue.view": {
        state: "open",
        comments: [
          { author: "us", body: "mirrored\n\n— pinbox msg_abcdefghij", createdAt: "t1" },
          { author: "benji", body: "real reply", createdAt: "t2" },
        ],
      },
    });
    const { comments, statuses, events } = recordingEvents();

    await createGithubConnector(transport).sync(link, events);

    expect(comments).toEqual([{ origin: "github:benji", text: "real reply", at: "t2" }]);
    expect(statuses).toEqual(["open"]);
  });
});

describe("setRemoteStatus", () => {
  test("closed → issue.close, open → issue.reopen", async () => {
    const transport = new FakeTransport({ "issue.close": undefined, "issue.reopen": undefined });
    const connector = createGithubConnector(transport);
    await connector.setRemoteStatus(link, "closed");
    await connector.setRemoteStatus(link, "open");
    expect(transport.calls).toEqual([
      { op: "issue.close", params: { number: 123 } },
      { op: "issue.reopen", params: { number: 123 } },
    ]);
  });
});

describe("transport failures propagate", () => {
  test("a throwing transport rejects createItem with the cause", async () => {
    const transport = new FakeTransport({ "issue.create": new Error("gh: not logged in") });
    const store = openStore(":memory:");
    const pin = makePin(store);
    await expect(createGithubConnector(transport).createItem(pin, [])).rejects.toThrow(
      "gh: not logged in",
    );
    store.close();
  });
});
