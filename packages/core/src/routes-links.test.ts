// routes-links mounted in the ROUTES array: POST/GET /pins/:id/links,
// 502 E_CONNECTOR when no connector can serve, ThreadPostSchema.origin forwarding (§2).
import { describe, expect, test } from "bun:test";
import { POLL_OPEN_MS } from "./connectors/poll.ts";
import type { Connector, ConnectorEvents } from "./connectors/types.ts";
import { createHubHandler } from "./hub.ts";
import type { Link, Pin, ThreadMessage } from "./schema.ts";
import { openStore } from "./store.ts";

const TOKEN = "t1";

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

class FakeConnector implements Connector {
  readonly name = "github";
  readonly created: Pin[] = [];
  failCreate = false;

  async createItem(pin: Pin, _thread: ThreadMessage[]): Promise<Link> {
    if (this.failCreate) throw new Error("gh exploded");
    this.created.push(pin);
    return {
      connector: this.name,
      ref: "123",
      url: "https://github.com/acme/app/issues/123",
    };
  }

  async postComment(_link: Link, _message: ThreadMessage): Promise<void> {}
  async sync(_link: Link, _events: ConnectorEvents): Promise<void> {}
  async setRemoteStatus(_link: Link, _status: "open" | "closed"): Promise<void> {}
}

function makeHandler(connectors?: Connector[]) {
  const store = openStore(":memory:");
  const handler = createHubHandler({
    store,
    token: TOKEN,
    ...(connectors === undefined ? {} : { connectors }),
  });
  return { handler, store };
}

function get(path: string): Request {
  return new Request(`http://hub${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createPin(handler: (req: Request) => Promise<Response>): Promise<Pin> {
  const res = await handler(post("/pins", validInput));
  const body = (await res.json()) as { data: Pin };
  return body.data;
}

describe("POST /pins/:id/links", () => {
  test("201 full Pin with the link appended and due_at armed at the open cadence", async () => {
    const connector = new FakeConnector();
    const { handler, store } = makeHandler([connector]);
    const pin = await createPin(handler);

    const res = await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(pin.id);
    expect(body.data.links).toEqual([
      { connector: "github", ref: "123", url: "https://github.com/acme/app/issues/123" },
    ]);
    expect(connector.created).toHaveLength(1);

    const due = store.pinsDueBefore(new Date(Date.now() + POLL_OPEN_MS + 1_000).toISOString());
    expect(due.map((p) => p.id)).toContain(pin.id);
  });

  test("unknown connector name → 502 E_CONNECTOR with a hint naming pinbox doctor", async () => {
    const { handler } = makeHandler([new FakeConnector()]);
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/links`, { connector: "slack" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_CONNECTOR");
    expect(body.error.hint).toContain("pinbox doctor");
  });

  test("no connectors injected at all → 502 E_CONNECTOR", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("E_CONNECTOR");
  });

  test("createItem throwing → 502 E_CONNECTOR with the cause's message", async () => {
    const connector = new FakeConnector();
    connector.failCreate = true;
    const { handler } = makeHandler([connector]);
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("E_CONNECTOR");
    expect(body.error.message).toBe("gh exploded");
  });

  test("duplicate link → 409 E_CONFLICT", async () => {
    const { handler } = makeHandler([new FakeConnector()]);
    const pin = await createPin(handler);
    await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    const res = await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("E_CONFLICT");
  });

  test("unknown pin → 404 E_NOT_FOUND", async () => {
    const { handler } = makeHandler([new FakeConnector()]);
    const res = await handler(post("/pins/pin_0000000000/links", { connector: "github" }));
    expect(res.status).toBe(404);
  });
});

describe("GET /pins/:id/links", () => {
  test("returns the Link array", async () => {
    const { handler } = makeHandler([new FakeConnector()]);
    const pin = await createPin(handler);
    await handler(post(`/pins/${pin.id}/links`, { connector: "github" }));
    const res = await handler(get(`/pins/${pin.id}/links`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { connector: "github", ref: "123", url: "https://github.com/acme/app/issues/123" },
    ]);
  });

  test("unknown pin → 404", async () => {
    const { handler } = makeHandler([new FakeConnector()]);
    const res = await handler(get("/pins/pin_0000000000/links"));
    expect(res.status).toBe(404);
  });
});

describe("ThreadPostSchema.origin (§2)", () => {
  test("POST /pins/:id/thread forwards origin to the stored message", async () => {
    const { handler, store } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(
      post(`/pins/${pin.id}/thread`, { role: "mirror", text: "from gh", origin: "github:benji" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.origin).toBe("github:benji");
    expect(store.getThread(pin.id)[0]?.origin).toBe("github:benji");
  });

  test("origin stays optional", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/thread`, { role: "human", text: "plain" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.origin).toBeUndefined();
  });
});
