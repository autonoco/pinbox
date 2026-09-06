// GitHub webhook receiver against a real in-memory store: signature gate, repository and
// link matching, comment and status mirroring through the §7 sinks, own-mirror skipping,
// and idempotence against the replay filter (a redelivered comment mirrors once).
import { describe, expect, test } from "bun:test";
import type { Pin } from "../schema.ts";
import { openStore, type PinStore } from "../store.ts";
import { handleGithubWebhook, signatureValid } from "./github-webhook.ts";

const input = {
  text: "button is cut off",
  kind: "note",
  author: { userId: "bobak" },
} as const;

const OPTS = { secret: "s3cret", repo: "autonoco/pinbox" };

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `sha256=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function deliver(
  store: PinStore,
  event: string,
  payload: unknown,
  secret = OPTS.secret,
): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: { code: string } } }> {
  const raw = JSON.stringify(payload);
  const req = new Request("https://hub.example/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": await sign(secret, raw),
    },
    body: raw,
  });
  const res = await handleGithubWebhook(req, store, OPTS);
  return { status: res.status, body: (await res.json()) as never };
}

function linked(store: PinStore, number = 58): Pin {
  const pin = store.createPin(structuredClone(input), {});
  return store.addLink(pin.id, {
    connector: "github",
    ref: String(number),
    url: `https://github.com/autonoco/pinbox/issues/${number}`,
  });
}

const repo = { full_name: "autonoco/pinbox" };
const comment = (body: string, login = "benji", type = "User") => ({
  action: "created",
  repository: repo,
  issue: { number: 58 },
  comment: { body, created_at: "2026-09-05T12:00:00.000Z", user: { login, type } },
});

describe("signature gate", () => {
  test("a bad or missing signature is 401 E_AUTH before the body is read", async () => {
    const store = openStore(":memory:");
    linked(store);
    const wrong = await deliver(store, "issue_comment", comment("hi"), "other");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe("E_AUTH");
    const res = await handleGithubWebhook(
      new Request("https://hub.example/webhooks/github", { method: "POST", body: "{}" }),
      store,
      OPTS,
    );
    expect(res.status).toBe(401);
    expect(store.getThread(store.listPins()[0]?.id ?? "")).toEqual([]);
    store.close();
  });

  test("signatureValid: hex hmac over the raw body, sha256= prefix required", async () => {
    expect(await signatureValid("k", "body", await sign("k", "body"))).toBe(true);
    expect(await signatureValid("k", "body", (await sign("k", "body")).slice(7))).toBe(false);
    expect(await signatureValid("k", "body!", await sign("k", "body"))).toBe(false);
  });
});

describe("mirroring", () => {
  test("a new issue comment mirrors into the linked pin's thread as role mirror, origin github:<login>", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    const res = await deliver(store, "issue_comment", comment("looks off on mobile too"));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ applied: 1, ignored: null });
    const thread = store.getThread(pin.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      role: "mirror",
      origin: "github:benji",
      text: "looks off on mobile too",
    });
    store.close();
  });

  test("a redelivered comment mirrors once — the replay filter matches the durable thread", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    await deliver(store, "issue_comment", comment("same words"));
    const again = await deliver(store, "issue_comment", comment("same words"));
    expect(again.body.data).toEqual({ applied: 1, ignored: null }); // the sink ran…
    expect(store.getThread(pin.id)).toHaveLength(1); // …and the filter dropped the duplicate
    store.close();
  });

  test("our own mirrors never come back: the pinbox trailer and the App's bot are skipped", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    const trailer = await deliver(store, "issue_comment", comment("fixed\n\n— pinbox msg_abc"));
    expect(trailer.body.data).toEqual({ applied: 0, ignored: "own mirror" });
    const bot = await deliver(store, "issue_comment", comment("hello", "pinbox[bot]", "Bot"));
    expect(bot.body.data).toEqual({ applied: 0, ignored: "own mirror" });
    expect(store.getThread(pin.id)).toEqual([]);
    store.close();
  });

  test("issues closed resolves the pin by the agent; reopened flips a resolved pin back", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    const closed = await deliver(store, "issues", {
      action: "closed",
      repository: repo,
      issue: { number: 58 },
    });
    expect(closed.body.data).toEqual({ applied: 1, ignored: null });
    expect(store.getPin(pin.id)?.status).toBe("resolved");
    expect(store.getPin(pin.id)?.resolution?.by).toBe("agent");
    // §7 anti-echo: the cursor moves over the remote-caused transition, so the next poll's
    // pendingStatus does not read it as a local close and push it back to GitHub.
    expect(store.links.all()[0]?.lastSyncedAt).toBe(store.getPin(pin.id)?.resolution?.at);
    const reopened = await deliver(store, "issues", {
      action: "reopened",
      repository: repo,
      issue: { number: 58 },
    });
    expect(reopened.body.data).toEqual({ applied: 1, ignored: null });
    expect(store.getPin(pin.id)?.status).toBe("open");
    expect(store.links.all()[0]?.lastSyncedAt).toBe(store.getPin(pin.id)?.verification?.at);
    // Other issue actions are acknowledged, not applied.
    const labeled = await deliver(store, "issues", {
      action: "labeled",
      repository: repo,
      issue: { number: 58 },
    });
    expect(labeled.body.data).toEqual({ applied: 0, ignored: "issues labeled" });
    store.close();
  });

  test("the cursor holds when an unposted outbound comment sits below the transition", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    // A reply the poll has not mirrored out yet: moving the cursor past it would drop it.
    store.addThreadMessage(pin.id, "agent", "on it");
    await deliver(store, "issues", { action: "closed", repository: repo, issue: { number: 58 } });
    expect(store.getPin(pin.id)?.status).toBe("resolved");
    expect(store.links.all()[0]?.lastSyncedAt).toBeNull();
    store.close();
  });
});

describe("what is ignored", () => {
  test("ping, other events, other repos, unlinked issues — all 200 with a reason, nothing written", async () => {
    const store = openStore(":memory:");
    const pin = linked(store);
    expect((await deliver(store, "ping", { zen: "x" })).body.data).toEqual({
      applied: 0,
      ignored: "ping",
    });
    expect((await deliver(store, "push", {})).body.data).toEqual({
      applied: 0,
      ignored: "event push",
    });
    expect(
      (
        await deliver(store, "issue_comment", {
          ...comment("x"),
          repository: { full_name: "other/repo" },
        })
      ).body.data,
    ).toEqual({ applied: 0, ignored: "repository other/repo" });
    expect(
      (await deliver(store, "issue_comment", { ...comment("x"), issue: { number: 99 } })).body.data,
    ).toEqual({
      applied: 0,
      ignored: "issue #99 is not linked",
    });
    expect(store.getThread(pin.id)).toEqual([]);
    expect(store.getPin(pin.id)?.status).toBe("open");
    store.close();
  });

  test("a non-JSON or non-object body with a valid signature is 400 E_INVALID_INPUT", async () => {
    const store = openStore(":memory:");
    for (const raw of ["not json", "null", "[]", '"str"']) {
      const res = await handleGithubWebhook(
        new Request("https://hub.example/webhooks/github", {
          method: "POST",
          headers: {
            "x-github-event": "issues",
            "x-hub-signature-256": await sign(OPTS.secret, raw),
          },
          body: raw,
        }),
        store,
        OPTS,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "E_INVALID_INPUT",
      );
    }
    store.close();
  });
});
