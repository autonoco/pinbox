import { describe, expect, test } from "bun:test";
// gitEnv is deliberately imported from hub-server: the published surface (the
// "./hub-server" subpath) must re-export it for Task 7's CLI consumption.
import { gitEnv, startHubServer } from "./hub-server.ts";
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

function start(idleMs?: number) {
  const store = openStore(":memory:");
  return startHubServer({
    store,
    token: TOKEN,
    port: 0,
    ...(idleMs === undefined ? {} : { idleMs }),
  });
}

describe("startHubServer", () => {
  test("binds loopback on an ephemeral port and serves /health tokenless", async () => {
    const server = await start();
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(new URL(server.url).hostname).toBe("127.0.0.1");
      const res = await fetch(new URL("/health", server.url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: { schemaVersion: number } };
      expect(body.ok).toBe(true);
      expect(body.data.schemaVersion).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("authorized POST/GET roundtrip over real HTTP", async () => {
    const server = await start();
    try {
      const created = await fetch(new URL("/pins", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(validInput),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { ok: boolean; data: { id: string } };
      expect(createdBody.ok).toBe(true);
      expect(createdBody.data.id).toMatch(/^pin_[a-z0-9]{10}$/);

      const listed = await fetch(new URL("/pins", server.url), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { ok: boolean; data: { id: string }[] };
      expect(listedBody.data.map((p) => p.id)).toEqual([createdBody.data.id]);
    } finally {
      await server.close();
    }
  });

  test("stops itself after idleMs with no requests", async () => {
    const server = await start(200);
    const healthUrl = new URL("/health", server.url);
    expect((await fetch(healthUrl)).status).toBe(200);
    await Bun.sleep(350);
    expect(fetch(healthUrl)).rejects.toThrow();
    await server.close();
  });
});

describe("CORS (realtime host)", () => {
  function startRealtime() {
    const store = openStore(":memory:");
    return startHubServer({ store, token: TOKEN, port: 0, realtime: { projectId: "p1" } });
  }

  test("OPTIONS preflight from a loopback origin is answered host-level", async () => {
    const server = await startRealtime();
    try {
      const res = await fetch(new URL("/pins", server.url), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      expect(allowHeaders).toContain("authorization");
      expect(allowHeaders).toContain("content-type");
    } finally {
      await server.close();
    }
  });

  test("handler responses to loopback origins carry access-control-allow-origin", async () => {
    const server = await startRealtime();
    try {
      const res = await fetch(new URL("/pins", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        body: JSON.stringify(validInput),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    } finally {
      await server.close();
    }
  });

  test("non-loopback origins are refused 403 with no CORS headers", async () => {
    const server = await startRealtime();
    try {
      const res = await fetch(new URL("/pins", server.url), {
        headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("gitEnv", () => {
  test("inside a repo returns branch and commit", () => {
    const env = gitEnv(import.meta.dir);
    expect(env.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof env.branch).toBe("string");
    expect(env.branch?.length).toBeGreaterThan(0);
  });

  test("outside a repo returns {}", () => {
    expect(gitEnv("/tmp")).toEqual({});
  });
});
