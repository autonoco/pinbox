// @autono/pinbox-toolbar — offline mirror coverage for thread messages: the plan
// promises "offline mode: mirror renders read-only threads", so a thread fetched
// while live must survive a reload and render without the hub.
import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@autono/pinbox-core/schema";
import { HubError } from "../transport.ts";
import { harness, KEY, makeFetch, makeStorage } from "./test-harness.ts";

function message(id: string, text: string): ThreadMessage {
  return {
    id,
    pinId: "pin_a",
    role: "human",
    text,
    at: "2026-08-04T00:00:00.000Z",
  };
}

const thread = [message("msg_1", "please tighten this"), message("msg_2", "on it")];

/** GET /pins/pin_a/thread succeeds while `online`, throws once flipped. */
function threadFetch(online: () => boolean) {
  return makeFetch((_method, path) => {
    if (!online()) throw new TypeError("network down");
    if (path === "/pins/pin_a/thread") return { status: 200, body: { ok: true, data: thread } };
    if (path === "/pins") return { status: 200, body: { ok: true, data: [] } };
    return { status: 404, body: { ok: false, error: { code: "E_NOT_FOUND", message: "?" } } };
  });
}

describe("offline thread mirror", () => {
  test("a fetched thread is persisted under the endpoint-namespaced mirror", async () => {
    let online = true;
    const { fetchFn } = threadFetch(() => online);
    const h = harness({ fetchFn });

    expect(await h.transport.getThread("pin_a")).toEqual(thread);
    const stored = JSON.parse(h.storage.getItem(KEY("threads")) ?? "null");
    expect(stored).toEqual({ pin_a: thread });
    online = false;
  });

  test("getThread serves the mirror when the hub is unreachable", async () => {
    let online = true;
    const { calls, fetchFn } = threadFetch(() => online);
    const h = harness({ fetchFn });
    await h.transport.getThread("pin_a");

    online = false;
    expect(await h.transport.getThread("pin_a")).toEqual(thread);
    expect(calls).toHaveLength(2); // it tried the hub first, then fell back
  });

  test("a reload renders the mirrored thread read-only with no hub at all", async () => {
    const storage = makeStorage();
    let online = true;
    const { fetchFn } = threadFetch(() => online);
    await harness({ fetchFn }, storage).transport.getThread("pin_a");

    online = false;
    const reloaded = harness({ fetchFn }, storage);
    expect(reloaded.transport.mirrorThread("pin_a")).toEqual(thread);
    expect(await reloaded.transport.getThread("pin_a")).toEqual(thread);
  });

  test("an unmirrored pin offline still surfaces E_HUB_UNREACHABLE", async () => {
    const h = harness();
    expect(h.transport.mirrorThread("pin_missing")).toEqual([]);
    expect.assertions(2);
    try {
      await h.transport.getThread("pin_missing");
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
      expect(err.code).toBe("E_HUB_UNREACHABLE");
    }
  });

  test("a hub error that is not unreachability is never masked by the mirror", async () => {
    const { fetchFn } = makeFetch(() => ({
      status: 403,
      body: { ok: false, error: { code: "E_UNAUTHORIZED", message: "nope" } },
    }));
    const h = harness({ fetchFn });
    expect.assertions(1);
    try {
      await h.transport.getThread("pin_a");
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
      expect(err.code).toBe("E_UNAUTHORIZED");
    }
  });

  test("a reply keeps the mirrored thread current", async () => {
    const reply = message("msg_3", "done");
    const { fetchFn } = makeFetch((method, path) => {
      if (path !== "/pins/pin_a/thread") throw new TypeError("network down");
      if (method === "GET") return { status: 200, body: { ok: true, data: thread } };
      return { status: 201, body: { ok: true, data: reply } };
    });
    const h = harness({ fetchFn });
    await h.transport.getThread("pin_a");
    await h.transport.reply("pin_a", "done");
    expect(h.transport.mirrorThread("pin_a")).toEqual([...thread, reply]);
  });
});
