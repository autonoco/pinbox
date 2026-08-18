import { describe, expect, test } from "bun:test";
import { createHubHandler } from "./hub.ts";
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

function makeHandler() {
  const store = openStore(":memory:");
  const handler = createHubHandler({
    store,
    token: TOKEN,
    enrichEnv: () => ({ branch: "main", commit: "abc1234" }),
  });
  return { handler, store };
}

function get(path: string, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://hub${path}`, { headers });
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function del(path: string, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://hub${path}`, { method: "DELETE", headers });
}

async function createPin(handler: (req: Request) => Promise<Response>) {
  const res = await handler(post("/pins", validInput));
  const body = await res.json();
  return body.data;
}

describe("auth", () => {
  test("GET /health needs no token and reports schemaVersion", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/health", null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.schemaVersion).toBe(1);
    expect(typeof body.data.version).toBe("string");
    expect(body.data.wsProtocol).toBe(1);
  });

  test("every other route 401s without a token", async () => {
    const { handler } = makeHandler();
    for (const req of [
      get("/pins", null),
      get("/summary", null),
      post("/pins", validInput, null),
    ]) {
      const res = await handler(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("E_INVALID_INPUT");
    }
  });

  test("wrong token 401s", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/pins", "nope"));
    expect(res.status).toBe(401);
  });
});

describe("verify (cloud auth)", () => {
  test("verify returning null 401s with E_AUTH even on an authorized-header request", async () => {
    const store = openStore(":memory:");
    const handler = createHubHandler({ store, token: TOKEN, verify: async () => null });
    const res = await handler(get("/summary"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_AUTH");
  });

  test("verify returning an identity admits a request with no bearer header", async () => {
    const store = openStore(":memory:");
    const handler = createHubHandler({
      store,
      token: TOKEN,
      verify: async () => ({ userId: "u1" }),
    });
    const res = await handler(get("/summary", null));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("POST /pins", () => {
  test("201 creates a full pin with env enriched", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins", validInput));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(body.data.status).toBe("open");
    expect(body.data.env.branch).toBe("main");
    expect(body.data.env.commit).toBe("abc1234");
  });

  test("pins are numbered at birth — monotonic, never reused after a resolve", async () => {
    const { handler, store } = makeHandler();
    const first = await createPin(handler);
    const second = await createPin(handler);
    expect(first.n).toBe(1);
    expect(second.n).toBe(2);
    store.resolvePin(first.id, "human");
    const third = await createPin(handler);
    expect(third.n).toBe(3); // resolution frees nothing; numbers are issue numbers
    expect(store.getPin(first.id)?.n).toBe(1); // and the resolved pin keeps its own
  });

  test("400 with E_INVALID_INPUT on a bad body", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins", { ...validInput, text: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_INVALID_INPUT");
    expect(typeof body.error.message).toBe("string");
  });

  test("400 on a non-JSON body", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins", "not json {"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("E_INVALID_INPUT");
  });
});

describe("GET /pins", () => {
  test("lists pins and filters by status", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    await handler(post(`/pins/${pin.id}/resolve`, { by: "agent" }));
    await createPin(handler);

    const all = await (await handler(get("/pins"))).json();
    expect(all.data.length).toBe(2);

    const open = await (await handler(get("/pins?status=open"))).json();
    expect(open.data.length).toBe(1);
    expect(open.data[0].status).toBe("open");

    const resolved = await (await handler(get("/pins?status=resolved"))).json();
    expect(resolved.data.map((p: { id: string }) => p.id)).toEqual([pin.id]);
  });

  test("?search returns FTS matches and takes precedence over the status filter", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler); // "button is cut off"
    await handler(post("/pins", { ...validInput, text: "avatar overlaps the nav" }));
    await handler(post(`/pins/${pin.id}/resolve`, { by: "agent" }));

    const found = await (await handler(get("/pins?search=avatar"))).json();
    expect(found.data.map((p: { text: string }) => p.text)).toEqual(["avatar overlaps the nav"]);

    // precedence: the resolved pin still matches even with status=open present
    const both = await (await handler(get("/pins?search=button&status=open"))).json();
    expect(both.data.map((p: { id: string }) => p.id)).toEqual([pin.id]);

    const none = await (await handler(get("/pins?search=zebra"))).json();
    expect(none.data).toEqual([]);
  });

  test("400 on an invalid status filter", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/pins?status=claimed"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("E_INVALID_INPUT");
  });
});

describe("GET /pins/:id", () => {
  test("returns the pin", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(get(`/pins/${pin.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(pin.id);
  });

  test("404 with E_NOT_FOUND for an unknown id", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/pins/pin_zzzzzzzzzz"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_NOT_FOUND");
  });
});

describe("thread routes", () => {
  test("POST then GET round-trips a message", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const postRes = await handler(post(`/pins/${pin.id}/thread`, { role: "human", text: "hi" }));
    expect(postRes.status).toBe(201);
    const message = (await postRes.json()).data;
    expect(message.id).toMatch(/^msg_[a-z0-9]{10}$/);
    expect(message.pinId).toBe(pin.id);

    const listRes = await handler(get(`/pins/${pin.id}/thread`));
    expect(listRes.status).toBe(200);
    const thread = (await listRes.json()).data;
    expect(thread.map((m: { text: string }) => m.text)).toEqual(["hi"]);
  });

  test("POST with attachments round-trips them", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const att = {
      id: "att_abcdefghij",
      kind: "screenshot",
      path: "/tmp/pinbox/att_abcdefghij.webp",
      contentType: "image/webp",
    };
    const postRes = await handler(
      post(`/pins/${pin.id}/thread`, { role: "human", text: "shot attached", attachments: [att] }),
    );
    expect(postRes.status).toBe(201);
    const message = (await postRes.json()).data;
    expect(message.attachments[0].id).toBe("att_abcdefghij");

    const thread = (await (await handler(get(`/pins/${pin.id}/thread`))).json()).data;
    expect(thread[0].attachments[0].path).toBe("/tmp/pinbox/att_abcdefghij.webp");
  });

  test("404 posting to an unknown pin", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins/pin_zzzzzzzzzz/thread", { role: "human", text: "hi" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("E_NOT_FOUND");
  });

  test("400 on a bad role", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/thread`, { role: "robot", text: "hi" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });
});

describe("POST /pins/:id/resolve", () => {
  test("resolves once, then 409 with E_CONFLICT", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(post(`/pins/${pin.id}/resolve`, { by: "agent", note: "fixed" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.resolution.note).toBe("fixed");

    const again = await handler(post(`/pins/${pin.id}/resolve`, { by: "agent" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("E_CONFLICT");
  });

  test("404 for an unknown id", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins/pin_zzzzzzzzzz/resolve", { by: "human" }));
    expect(res.status).toBe(404);
  });
});

describe("GET /events", () => {
  test("cursor pages the event log", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    await handler(post(`/pins/${pin.id}/resolve`, { by: "agent" }));

    const all = (await (await handler(get("/events"))).json()).data;
    expect(all.map((e: { type: string }) => e.type)).toEqual(["pin.created", "pin.resolved"]);

    const afterFirst = (await (await handler(get(`/events?after=${all[0].seq}`))).json()).data;
    expect(afterFirst.map((e: { type: string }) => e.type)).toEqual(["pin.resolved"]);

    const afterLast = (await (await handler(get(`/events?after=${all[1].seq}`))).json()).data;
    expect(afterLast).toEqual([]);
  });

  test("400 on a non-numeric cursor", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/events?after=abc"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });
});

describe("GET /summary", () => {
  test("counts pins and reports the last event seq", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    await createPin(handler);
    await handler(post(`/pins/${pin.id}/resolve`, { by: "human" }));

    const body = await (await handler(get("/summary"))).json();
    expect(body.data).toEqual({ open: 1, resolved: 1, lastEventSeq: 3, sessions: 0 });
  });

  test("carries the count of not-ended sessions", async () => {
    const { handler } = makeHandler();
    const s1 = (await (await handler(post("/sessions", { agent: "claude", key: "k1" }))).json())
      .data;
    await handler(post("/sessions", { agent: "claude", key: "k2" }));
    await handler(del(`/sessions/${s1.id}`));
    const body = await (await handler(get("/summary"))).json();
    expect(body.data.sessions).toBe(1);
  });
});

describe("session routes", () => {
  const ref = { agent: "claude", key: "e2e-s1", cwd: "/tmp/proj" };

  test("POST /sessions 201 on first register, 200 on upsert refresh", async () => {
    const { handler } = makeHandler();
    const first = await handler(post("/sessions", ref));
    expect(first.status).toBe(201);
    const created = (await first.json()).data;
    expect(created.id).toMatch(/^ses_[a-z0-9]{10}$/);
    expect(created.agent).toBe("claude");
    expect(created.key).toBe("e2e-s1");

    const again = await handler(post("/sessions", ref));
    expect(again.status).toBe(200);
    expect((await again.json()).data.id).toBe(created.id);
  });

  test("400 E_INVALID_INPUT on an invalid body", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/sessions", { agent: "claude" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });

  test("GET /sessions lists sessions", async () => {
    const { handler } = makeHandler();
    await handler(post("/sessions", { agent: "claude", key: "k1" }));
    await handler(post("/sessions", { agent: "codex", key: "k2" }));
    const res = await handler(get("/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
    expect(body.data.map((s: { agent: string }) => s.agent).sort()).toEqual(["claude", "codex"]);
  });

  test("DELETE /sessions/:id ends the session; repeat DELETE still 200; unknown 404", async () => {
    const { handler } = makeHandler();
    const created = (await (await handler(post("/sessions", ref))).json()).data;
    const res = await handler(del(`/sessions/${created.id}`));
    expect(res.status).toBe(200);
    const ended = (await res.json()).data;
    expect(ended.id).toBe(created.id);
    expect(typeof ended.endedAt).toBe("string");

    const again = await handler(del(`/sessions/${created.id}`));
    expect(again.status).toBe(200);

    const missing = await handler(del("/sessions/ses_zzzzzzzzzz"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("E_NOT_FOUND");
  });
});

describe("session hook-pull routes (A4)", () => {
  const ref = { agent: "claude", key: "pull-1" };

  async function registerSession(handler: (req: Request) => Promise<Response>) {
    return (await (await handler(post("/sessions", ref))).json()).data;
  }

  test("POST /sessions/:id/inject delivers pending rows and claims unassigned ones", async () => {
    const { handler, store } = makeHandler();
    const pin = await createPin(handler);
    const session = await registerSession(handler);
    store.deliveries.enqueue({ eventSeq: 1, sessionId: session.id, adapter: "hooks", dueAt: null });
    store.deliveries.enqueue({ eventSeq: 1, sessionId: null, adapter: "hooks", dueAt: null });

    const res = await handler(post(`/sessions/${session.id}/inject`, undefined));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.delivered).toBe(2);
    expect(data.pins.map((p: { id: string }) => p.id)).toEqual([pin.id]);
    expect(data.context).toContain("1 open pin(s)");
    expect(data.context).toContain(pin.text);
    expect(data.context).toContain(pin.id);

    expect(store.deliveries.pendingForSession(session.id)).toEqual([]);
    expect(store.deliveries.unassigned()).toEqual([]);
  });

  test("second inject returns delivered: 0 but still the full context (re-injection)", async () => {
    const { handler, store } = makeHandler();
    const pin = await createPin(handler);
    const session = await registerSession(handler);
    store.deliveries.enqueue({ eventSeq: 1, sessionId: session.id, adapter: "hooks", dueAt: null });

    await handler(post(`/sessions/${session.id}/inject`, undefined));
    const again = await handler(post(`/sessions/${session.id}/inject`, undefined));
    const data = (await again.json()).data;
    expect(data.delivered).toBe(0);
    expect(data.context).toContain(pin.text);
    expect(data.pins.map((p: { id: string }) => p.id)).toEqual([pin.id]);
  });

  test("inject 404s for an unknown session", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/sessions/ses_zzzzzzzzzz/inject", undefined));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("E_NOT_FOUND");
  });

  test("GET /sessions/:id/pending is read-only and reports open pins from pending rows", async () => {
    const { handler, store } = makeHandler();
    const pin = await createPin(handler);
    const session = await registerSession(handler);
    store.deliveries.enqueue({ eventSeq: 1, sessionId: session.id, adapter: "hooks", dueAt: null });

    const res = await handler(get(`/sessions/${session.id}/pending`));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.count).toBe(1);
    expect(data.pins.map((p: { id: string }) => p.id)).toEqual([pin.id]);

    // Read-only: the row is still pending after the gate check.
    expect(store.deliveries.pendingForSession(session.id).length).toBe(1);
  });

  test("pending resolves the pin id from a thread.message row and drops resolved pins", async () => {
    const { handler, store } = makeHandler();
    const pin = await createPin(handler);
    await handler(post(`/pins/${pin.id}/thread`, { role: "human", text: "still broken?" }));
    const session = await registerSession(handler);
    // seq 2 is the thread.message event; its payload carries pinId, not id.
    store.deliveries.enqueue({ eventSeq: 2, sessionId: session.id, adapter: "hooks", dueAt: null });

    const before = (await (await handler(get(`/sessions/${session.id}/pending`))).json()).data;
    expect(before.count).toBe(1);
    expect(before.pins.map((p: { id: string }) => p.id)).toEqual([pin.id]);

    // The Stop gate releases once the pin is resolved, even with the row still pending.
    await handler(post(`/pins/${pin.id}/resolve`, { by: "agent" }));
    const after = (await (await handler(get(`/sessions/${session.id}/pending`))).json()).data;
    expect(after).toEqual({ count: 0, pins: [] });
  });

  test("pending 404s for an unknown session", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/sessions/ses_zzzzzzzzzz/pending"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("E_NOT_FOUND");
  });
});

describe("POST /pins/:id/resolve with commit", () => {
  test("returns the commit in resolution", async () => {
    const { handler } = makeHandler();
    const pin = await createPin(handler);
    const res = await handler(
      post(`/pins/${pin.id}/resolve`, { by: "agent", note: "fixed", commit: "abc1234" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolution.commit).toBe("abc1234");
  });
});

describe("unknown routes", () => {
  test("404 with the contract error shape", async () => {
    const { handler } = makeHandler();
    const res = await handler(get("/nope"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_NOT_FOUND");
  });

  test("wrong method on a known path 404s", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/summary", {}));
    expect(res.status).toBe(404);
  });
});
