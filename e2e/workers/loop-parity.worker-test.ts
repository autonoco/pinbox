// Cloud parity e2e — the product loop + realtime on workerd.
// "The same handler, two hosts" is proven here, not asserted. The file runs under BOTH
// pool projects and each mode skips the other's describes:
//   - template mode: the flow drives the real `examples/worker` wrangler.jsonc through
//     SELF — hub mount, WS upgrade, and the frozen envelope all through the deploy-
//     checked template.
//   - do mode: the auth-matrix rows that need per-namespace env (none/jwt) drive the
//     DO classes directly — wrangler vars are namespace-wide, so the template cannot
//     host three strategies at once (same reasoning as HUB_DO_NONE in vitest.config.ts).
import { env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Envelope, makePost, pinInput } from "./fixtures/pin-fixtures.ts";
import {
  collect,
  expectProtocolViolation,
  helloCatchUp,
  openWs,
  type UpgradeFetch,
  type WsEventFrame,
} from "./fixtures/ws-helpers.ts";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const post = makePost(AUTH);

// Which pool project is running the file: the template project binds PINBOX_HUB (from
// examples/worker/wrangler.jsonc); the do project binds the DO namespaces directly.
const templateMode = (env as unknown as Record<string, unknown>)["PINBOX_HUB"] !== undefined;

const MOUNT = "https://staging.example/_pinbox";
const selfFetch: UpgradeFetch = (url, init) => SELF.fetch(url, init as never);

async function hub(path: string, init?: RequestInit): Promise<{ status: number; body: Envelope }> {
  const res = await SELF.fetch(`${MOUNT}${path}`, init as never);
  return { status: res.status, body: (await res.json()) as Envelope };
}

describe.skipIf(!templateMode)("product loop through the template mount (SELF)", () => {
  test("create is 201 and cloud env is un-enriched — no git on workerd", async () => {
    const created = await hub(...post("/pins", pinInput()));
    expect(created.status).toBe(201);
    const pinEnv = created.body.data?.["env"] as Record<string, unknown>;
    // Locally enrichEnv() stamps branch/commit from git; the DO passes no enrichEnv —
    // the cloud pin carries exactly what the client reported, nothing synthesized.
    expect("branch" in pinEnv).toBe(false);
    expect("commit" in pinEnv).toBe(false);
    expect(pinEnv["browser"]).toBe("Chrome 130");
  });

  test("double resolve is 409 with the frozen E_CONFLICT envelope shape", async () => {
    const created = await hub(...post("/pins", pinInput()));
    const id = created.body.data?.id as string;
    const first = await hub(...post(`/pins/${id}/resolve`, { by: "human" }));
    expect(first.status).toBe(200);

    const second = await hub(...post(`/pins/${id}/resolve`, { by: "agent" }));
    expect(second.status).toBe(409);
    // Envelope byte-shape: exactly {ok,error} and exactly {code,message} — no extras,
    // no hint on this route, key order as frozen.
    expect(Object.keys(second.body)).toEqual(["ok", "error"]);
    expect(second.body.ok).toBe(false);
    expect(Object.keys(second.body.error as object)).toEqual(["code", "message"]);
    expect(second.body.error?.code).toBe("E_CONFLICT");
  });

  test("GET /events?after=N equals the WS catch-up for the same lastSeq (continuity)", async () => {
    // Template mode shares one DO across the file (idFromName(PINBOX_PROJECT)), so the
    // cursor is anchored to the live lastEventSeq, never to absolute seq numbers.
    const before = await hub("/summary", { headers: AUTH });
    const base = before.body.data?.["lastEventSeq"] as number;

    const a = await hub(...post("/pins", pinInput("first pin")));
    const b = await hub(...post("/pins", pinInput("second pin")));
    const bId = b.body.data?.id as string;
    const aId = a.body.data?.id as string;
    await hub(...post(`/pins/${bId}/thread`, { role: "human", text: "note" }));
    await hub(...post(`/pins/${aId}/resolve`, { by: "agent" }));

    const cursor = base + 2; // skip the two creates; replay the thread + resolve events
    const rest = await hub(`/events?after=${cursor}`, { headers: AUTH });
    expect(rest.status).toBe(200);
    const restEvents = rest.body.data as unknown as Array<{
      seq: number;
      type: string;
      at: string;
      payload: unknown;
    }>;
    expect(restEvents.map((e) => e.seq)).toEqual([base + 3, base + 4]);
    expect(restEvents.map((e) => e.type)).toEqual(["thread.message", "pin.resolved"]);

    const ws = await openWs(selfFetch, `${MOUNT}/ws?token=${TOKEN}`);
    const frames = collect(ws);
    const catchUp = await helloCatchUp(ws, frames, "parity-consumer", cursor);
    expect(catchUp.lastSeq).toBe(base + 4);
    // The continuity guarantee, cross-checked between the two transports: same events,
    // same order, same payload bytes.
    const restAsFrames: WsEventFrame[] = restEvents.map((e) => ({
      type: "event",
      seq: e.seq,
      eventType: e.type,
      at: e.at,
      payload: e.payload,
    }));
    expect(catchUp.events).toEqual(restAsFrames);
    ws.close(1000, "done");
  });

  test("hello with protocol: 0 gets an E_WS_PROTOCOL error frame then close 4400", async () => {
    // The update-guardrails handshake: a client below WS_MIN_PROTOCOL
    // is told to upgrade, through the template mount like everything else.
    const ws = await openWs(selfFetch, `${MOUNT}/ws?token=${TOKEN}`);
    await expectProtocolViolation(
      ws,
      JSON.stringify({ type: "hello", protocol: 0, consumerId: "stale-client", lastSeq: 0 }),
    );
  });

  // routes-toolbar.ts, through the mount. The store halves are proven directly on
  // workerd in do-store.worker-test.ts (searchPins FTS5 unicode61, verifyPin
  // 409-unless-resolved); these are the HTTP parity rows over the same code.
  test("GET /pins?search= FTS5 round-trip through the mount", async () => {
    const created = await hub(...post("/pins", pinInput("kerning wobbles in the masthead")));
    expect(created.status).toBe(201);
    const id = created.body.data?.id as string;

    const found = await hub("/pins?search=wobbles", { headers: AUTH });
    expect(found.status).toBe(200);
    expect((found.body.data as unknown as Array<{ id: string }>).map((p) => p.id)).toEqual([id]);

    const empty = await hub("/pins?search=zebra", { headers: AUTH });
    expect(empty.body.data as unknown as unknown[]).toEqual([]);
  });

  test("POST /pins/:id/verify is 409 while open and 200 once resolved", async () => {
    const created = await hub(...post("/pins", pinInput("verify through the mount")));
    const id = created.body.data?.id as string;

    const early = await hub(...post(`/pins/${id}/verify`, { outcome: "accepted" }));
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe("E_CONFLICT");

    await hub(...post(`/pins/${id}/resolve`, { by: "agent" }));
    const verified = await hub(...post(`/pins/${id}/verify`, { outcome: "accepted" }));
    expect(verified.status).toBe(200);
    expect(verified.body.data?.["verification"]).toMatchObject({ outcome: "accepted" });
    expect(verified.body.data?.["status"]).toBe("resolved"); // resolution kept as history
  });
});

describe.skipIf(!templateMode)("auth matrix — token, through the template mount", () => {
  test("happy path: the exact bearer passes", async () => {
    const { status, body } = await hub("/summary", { headers: AUTH });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("fails closed: wrong and missing bearer are both 401 E_AUTH", async () => {
    const wrong = await hub("/summary", { headers: { authorization: "Bearer wrong" } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe("E_AUTH");

    const missing = await hub("/summary");
    expect(missing.status).toBe(401);
    expect(missing.body.error?.code).toBe("E_AUTH");
  });
});

// ---- do-mode: strategies that need their own namespace env ----

async function stubFetch(
  stub: { fetch: (url: never, init?: never) => unknown },
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Envelope }> {
  const res = (await stub.fetch(`http://hub${path}` as never, init as never)) as Response;
  return { status: res.status, body: (await res.json()) as Envelope };
}

describe.skipIf(templateMode)("auth matrix — none", () => {
  test("with ALLOW_UNAUTHENTICATED=1: tokenless REST passes end to end", async () => {
    const stub = env.HUB_DO_NONE.get(env.HUB_DO_NONE.idFromName(crypto.randomUUID()));
    const created = await stubFetch(stub, "/pins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pinInput()),
    });
    expect(created.status).toBe(201);
    const summary = await stubFetch(stub, "/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.data?.["open"]).toBe(1);
  });

  test("fails closed: without ALLOW_UNAUTHENTICATED=1 every request is refused", async () => {
    // "No unauthenticated writes in any configuration" — the misconfigured strategy is
    // a loud 500 on every request, credential or not, never a silent open hub.
    const stub = env.HUB_DO_NONE_REFUSED.get(
      env.HUB_DO_NONE_REFUSED.idFromName(crypto.randomUUID()),
    );
    const { status, body } = await stubFetch(stub, "/summary", { headers: AUTH });
    expect(status).toBe(500);
    expect(body.error?.code).toBe("E_INTERNAL");
    expect(body.error?.hint).toContain("ALLOW_UNAUTHENTICATED");
  });
});

describe.skipIf(templateMode)("auth matrix — jwt (JWKS served via a stubbed fetch)", () => {
  // Must match the PinboxHubDOJwt env in fixtures/test-worker.ts.
  const ISSUER = "https://issuer.test";
  const JWKS_URL = "https://issuer.test/.well-known/jwks.json";
  const AUDIENCE = "tool:pinbox";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Generate an RS256 pair, serve its public JWKS from the stubbed global fetch (the DO
  // runs in this isolate, so jose's remote JWKS fetch resolves against the stub — same
  // mechanism as the template suite's origin stubbing), return the signing key.
  async function issuerOnline(): Promise<CryptoKey> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "k1" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === JWKS_URL) return Response.json({ keys: [jwk] });
      throw new Error(`unexpected fetch during jwt test: ${url}`);
    });
    return privateKey as CryptoKey;
  }

  function jwtHub() {
    return env.HUB_DO_JWT.get(env.HUB_DO_JWT.idFromName(crypto.randomUUID()));
  }

  async function sign(key: CryptoKey, audience: string): Promise<string> {
    return new SignJWT({ tenant: "acme" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }

  test("happy path: a signed token passes the write path", async () => {
    const key = await issuerOnline();
    const token = await sign(key, AUDIENCE);
    const stub = jwtHub();
    const created = await stubFetch(stub, "/pins", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(pinInput()),
    });
    expect(created.status).toBe(201);
  });

  test("fails closed: garbage, missing, and wrong-audience tokens are all 401 E_AUTH", async () => {
    const key = await issuerOnline();
    const stub = jwtHub();

    const garbage = await stubFetch(stub, "/summary", {
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error?.code).toBe("E_AUTH");

    const missing = await stubFetch(stub, "/summary");
    expect(missing.status).toBe(401);
    expect(missing.body.error?.code).toBe("E_AUTH");

    const wrongAudience = await sign(key, "tool:not-pinbox");
    const rejected = await stubFetch(stub, "/summary", {
      headers: { authorization: `Bearer ${wrongAudience}` },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error?.code).toBe("E_AUTH");
  });
});
