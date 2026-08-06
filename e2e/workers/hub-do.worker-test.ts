// PinboxHubDO on workerd — the hub handler + hibernating WS broadcaster + cloud
// attachments, driven through the DO stub exactly as the Worker template will.
// No alarm/drainDue coverage here: alarm() is still a no-op because the DO has no
// delivery adapter set, so nothing enqueues a row to drain. See do.ts alarm().
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { DoBroadcaster, type PinboxHubDO } from "../../packages/core/src/do.ts";
import { type Envelope, makePost, pinInput } from "./fixtures/pin-fixtures.ts";
import {
  closeCode,
  collect,
  expectProtocolViolation,
  helloCatchUp as hello,
  openWs as openWsAt,
  type UpgradeFetch,
} from "./fixtures/ws-helpers.ts";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function hub(name: string = crypto.randomUUID()) {
  return { stub: env.HUB_DO.get(env.HUB_DO.idFromName(name)), name };
}

async function call(
  stub: ReturnType<typeof hub>["stub"],
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Envelope }> {
  const res = await stub.fetch(`http://hub${path}`, init as never);
  return { status: res.status, body: (await res.json()) as Envelope };
}

const post = makePost(AUTH);

// A body that arrives in 1 MB chunks with no content-length — the shape a `fetch` with a
// ReadableStream body produces, and the shape the old header-only cap could not see.
function megabyteStream(count: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
}

// Upgrade/collect/hello live in fixtures/ws-helpers.ts (shared with loop-parity);
// this adapter binds them to a DO stub's fetch.
function openWs(stub: ReturnType<typeof hub>["stub"], query = `?token=${TOKEN}`) {
  const upgrade: UpgradeFetch = (url, init) => stub.fetch(url as never, init as never);
  return openWsAt(upgrade, `http://hub/ws${query}`);
}

describe("REST through the DO", () => {
  test("health is tokenless", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("a misconfigured strategy still answers /health — 503 with the reason, not a blanket 500", async () => {
    // A misconfigured hub is live, not dead, and §1 pins /health as the one tokenless
    // route. Blanket-500ing it made those two states indistinguishable to a monitor.
    const stub = env.HUB_DO_NONE_REFUSED.get(env.HUB_DO_NONE_REFUSED.idFromName("health-refused"));
    const { status, body } = await call(stub, "/health");
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("E_INTERNAL");
    expect(body.error?.message).toContain("AUTH_STRATEGY");
    expect(body.error?.hint).toContain("ALLOW_UNAUTHENTICATED");

    // The loud failure survives everywhere else — misconfiguration never opens a route.
    const summary = await call(stub, "/summary", { headers: AUTH });
    expect(summary.status).toBe(500);
    expect(summary.body.error?.code).toBe("E_INTERNAL");
  });

  test("wrong bearer under the token strategy is 401 E_AUTH", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/summary", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("E_AUTH");
  });

  test("missing bearer is 401 E_AUTH", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/summary");
    expect(status).toBe(401);
    expect(body.error?.code).toBe("E_AUTH");
  });

  test("product loop: create → list → thread → resolve → events", async () => {
    const { stub } = hub();
    const created = await call(stub, ...post("/pins", pinInput()));
    expect(created.status).toBe(201);
    const id = created.body.data?.id as string;
    expect(id).toMatch(/^pin_[a-z0-9]{10}$/);

    const listed = await call(stub, "/pins", { headers: AUTH });
    expect(listed.status).toBe(200);
    expect((listed.body.data as unknown as unknown[]).length).toBe(1);

    const replied = await call(stub, ...post(`/pins/${id}/thread`, { role: "human", text: "fix" }));
    expect(replied.status).toBe(201);

    const resolved = await call(stub, ...post(`/pins/${id}/resolve`, { by: "agent" }));
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.["status"]).toBe("resolved");

    const events = await call(stub, "/events?after=0", { headers: AUTH });
    const types = (events.body.data as unknown as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["pin.created", "thread.message", "pin.resolved"]);
  });
});

describe("WS upgrade + protocol", () => {
  test("?token= upgrade succeeds; wrong token closes 4401", async () => {
    const { stub } = hub();
    const good = await openWs(stub);
    good.close(1000, "done");

    const res = await stub.fetch("http://hub/ws?token=wrong", {
      headers: { upgrade: "websocket" },
    } as never);
    expect(res.status).toBe(101);
    const bad = res.webSocket;
    if (!bad) throw new Error("no webSocket on 101 response");
    const closed = closeCode(bad as unknown as WebSocket);
    bad.accept();
    expect(await closed).toBe(4401);
  });

  test("Sec-WebSocket-Protocol token upgrade succeeds", async () => {
    const { stub } = hub();
    const res = await stub.fetch("http://hub/ws", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `pinbox.token.${TOKEN}` },
    } as never);
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000, "done");
  });

  test("tokenless upgrade under the none strategy connects and completes hello", async () => {
    // Strategy parity: REST accepts tokenless requests under none/ALLOW_UNAUTHENTICATED=1,
    // so the WS transport must too — the configured VerifyFn decides, not the transport.
    const stub = env.HUB_DO_NONE.get(env.HUB_DO_NONE.idFromName(crypto.randomUUID()));
    const ws = await openWs(stub, "");
    const frames = collect(ws as unknown as WebSocket);
    const catchUp = await hello(ws as unknown as WebSocket, frames, "c-none", 0);
    expect(catchUp.protocol).toBe(1);
    ws.close(1000, "done");
  });

  test("malformed hello gets one E_WS_PROTOCOL error frame then close 4400", async () => {
    const { stub } = hub();
    const ws = await openWs(stub);
    await expectProtocolViolation(ws as unknown as WebSocket, "not json");
  });

  test("hello replays from the cursor and snapshots consumerId → lastSeq", async () => {
    const { stub, name } = hub();
    await call(stub, ...post("/pins", pinInput("first")));
    await call(stub, ...post("/pins", pinInput("second")));

    const ws = await openWs(stub);
    const frames = collect(ws as unknown as WebSocket);
    const catchUp = await hello(ws as unknown as WebSocket, frames, "c1", 1);
    expect(catchUp.protocol).toBe(1);
    expect(catchUp.minProtocol).toBe(1);
    expect(catchUp.lastSeq).toBe(2);
    expect(catchUp.events.map((e) => e.seq)).toEqual([2]);

    const full = await openWs(stub);
    const fullFrames = collect(full as unknown as WebSocket);
    const fullCatchUp = await hello(full as unknown as WebSocket, fullFrames, "c2", 0);
    expect(fullCatchUp.events.map((e) => e.seq)).toEqual([1, 2]);

    const stub2 = env.HUB_DO.get(env.HUB_DO.idFromName(name));
    const cursor = await runInDurableObject(stub2, (instance: PinboxHubDO) =>
      instance.store.cursors.get("c1"),
    );
    expect(cursor).toBe(1);
    ws.close(1000, "done");
    full.close(1000, "done");
  });

  test("publish reaches every socket on the topic and cannot exclude one", async () => {
    // Scope, stated precisely because the earlier name overstated it: this proves
    // full-topic fan-out — every accepted socket gets identical bytes — and that no
    // socket can be carved out of it.
    //
    // It does NOT stage "the socket that caused the mutation receives its own frame",
    // and no test can: protocol 1 has exactly one client message (hello), so a socket is
    // never a mutation's origin. Origin-inclusion (the cursor-echo rule) is
    // therefore not a behaviour but a property of the API — DoBroadcaster.publish takes
    // (topic, data) and sends to every socket in state.getWebSockets(topic); there is no
    // parameter an exclusion could ride in on. That arity is asserted below so the rule
    // cannot be repealed by quietly growing a third argument.
    expect(DoBroadcaster.prototype.publish.length).toBe(2);

    const { stub, name } = hub();
    const first = await openWs(stub);
    const firstFrames = collect(first as unknown as WebSocket);
    await hello(first as unknown as WebSocket, firstFrames, "consumer-a");

    const second = await openWs(stub);
    const secondFrames = collect(second as unknown as WebSocket);
    await hello(second as unknown as WebSocket, secondFrames, "consumer-b");

    const stub2 = env.HUB_DO.get(env.HUB_DO.idFromName(name));
    const count = await runInDurableObject(stub2, (instance: PinboxHubDO) =>
      instance.broadcaster.subscriberCount(instance.topic),
    );
    expect(count).toBe(2);

    await call(stub, ...post("/pins", pinInput("realtime")));
    const onFirst = await firstFrames.next();
    const onSecond = await secondFrames.next();
    expect((JSON.parse(onFirst) as { eventType: string }).eventType).toBe("pin.created");
    // Byte-identical, not merely equivalent: one encode, fanned out verbatim.
    expect(onSecond).toBe(onFirst);

    first.close(1000, "done");
    second.close(1000, "done");
  });

  test("per-connection state rides serializeAttachment (hibernation-safe)", async () => {
    const { stub, name } = hub();
    const ws = await openWs(stub);
    const frames = collect(ws as unknown as WebSocket);
    await hello(ws as unknown as WebSocket, frames, "c-hib", 0);

    const stub2 = env.HUB_DO.get(env.HUB_DO.idFromName(name));
    const attachment = await runInDurableObject(stub2, (_: PinboxHubDO, state) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBe(1);
      return sockets[0]?.deserializeAttachment() as { consumerId: string };
    });
    expect(attachment).toEqual({ consumerId: "c-hib" });
    ws.close(1000, "done");
  });
});

describe("cloud attachments", () => {
  test("POST /attachments mints att id and returns a presigned uploadUrl", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/attachments?kind=screenshot", {
      method: "POST",
      headers: { ...AUTH, "content-type": "image/png" },
      body: new Uint8Array(64),
    });
    expect(status).toBe(201);
    const attachment = body.data?.["attachment"] as {
      id: string;
      kind: string;
      url: string;
      contentType: string;
    };
    expect(attachment.id).toMatch(/^att_[a-z0-9]{10}$/);
    expect(attachment.kind).toBe("screenshot");
    expect(attachment.contentType).toBe("image/png");
    expect(attachment.url).toBe(`/media/${attachment.id}`);

    const uploadUrl = new URL(body.data?.["uploadUrl"] as string);
    expect(uploadUrl.host).toBe("acct1234.r2.cloudflarestorage.com");
    expect(uploadUrl.pathname).toBe(`/pinbox-media/${attachment.id}`);
    expect(uploadUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(uploadUrl.searchParams.get("response-content-type")).toBe("image/png");
  });

  test("attachments respect the auth gate", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/attachments", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(8),
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("E_AUTH");
  });

  test("a 6 MB body is 413 E_ATTACHMENT", async () => {
    const { stub } = hub();
    const { status, body } = await call(stub, "/attachments", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/octet-stream" },
      body: new Uint8Array(6 * 1024 * 1024),
    });
    expect(status).toBe(413);
    expect(body.error?.code).toBe("E_ATTACHMENT");
  });

  test("a chunked 6 MB body that declares no content-length is 413 too", async () => {
    // The cap used to trust the declared content-length alone, so a streamed request
    // with no such header read as `Number(null ?? "0") === 0` and sailed through. The
    // bytes are counted as they arrive now, and the read is aborted the moment the
    // running total crosses the cap.
    const { stub } = hub();
    const res = (await stub.fetch("http://hub/attachments", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/octet-stream" },
      body: megabyteStream(6),
      duplex: "half",
    } as never)) as unknown as Response;
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(413);
    expect(body.error?.code).toBe("E_ATTACHMENT");
  });

  test("a chunked body under the cap is admitted and its measured length is signed", async () => {
    const { stub } = hub();
    const res = (await stub.fetch("http://hub/attachments?kind=file", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/octet-stream" },
      body: megabyteStream(2),
      duplex: "half",
    } as never)) as unknown as Response;
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(201);
    // Second mechanism: `content-length` joins the signed headers, so R2 refuses any PUT
    // whose body length differs from the one the DO measured — the DO never sees that
    // leg, but the signature constrains it. (r2.test.ts pins that the signature actually
    // varies with the length; here we only check the header made it into the scope.)
    const uploadUrl = new URL(body.data?.["uploadUrl"] as string);
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
  });

  test("GET /media/:key streams the MEDIA object back", async () => {
    const { stub } = hub();
    await env.MEDIA.put("att_mediaroundt", "hello media", {
      httpMetadata: { contentType: "text/plain" },
    });
    const res = await stub.fetch("http://hub/media/att_mediaroundt", {
      headers: AUTH,
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("hello media");

    const missing = await call(stub, "/media/att_missing000", { headers: AUTH });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe("E_NOT_FOUND");
  });
});
