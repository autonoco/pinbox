// routes-toolbar — exercised through createHubHandler so the bearer gate, error
// mapping, and route-array mounting are all covered by the same requests.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, registerAttachmentSink } from "./attachments.ts";
import { localDirSink } from "./attachments-local.ts";
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
  const handler = createHubHandler({ store, token: TOKEN });
  return { handler, store };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function createResolvedPin(handler: (req: Request) => Promise<Response>) {
  const pin = (await (await handler(post("/pins", validInput))).json()).data;
  await handler(post(`/pins/${pin.id}/resolve`, { by: "agent", note: "done" }));
  return pin as { id: string };
}

describe("POST /pins/:id/verify", () => {
  test("200 on a resolved pin with verification set", async () => {
    const { handler } = makeHandler();
    const pin = await createResolvedPin(handler);
    const res = await handler(post(`/pins/${pin.id}/verify`, { outcome: "accepted" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("resolved");
    expect(body.data.verification.outcome).toBe("accepted");
  });

  test("reopened flips the pin back to open", async () => {
    const { handler } = makeHandler();
    const pin = await createResolvedPin(handler);
    const res = await handler(post(`/pins/${pin.id}/verify`, { outcome: "reopened" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("open");
    expect(body.data.resolution.note).toBe("done");
  });

  test("409 E_CONFLICT on an open pin", async () => {
    const { handler } = makeHandler();
    const pin = (await (await handler(post("/pins", validInput))).json()).data;
    const res = await handler(post(`/pins/${pin.id}/verify`, { outcome: "accepted" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("E_CONFLICT");
  });

  test("404 for an unknown id", async () => {
    const { handler } = makeHandler();
    const res = await handler(post("/pins/pin_zzzzzzzzzz/verify", { outcome: "accepted" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("E_NOT_FOUND");
  });

  test("400 E_INVALID_INPUT on a bad outcome", async () => {
    const { handler } = makeHandler();
    const pin = await createResolvedPin(handler);
    const res = await handler(post(`/pins/${pin.id}/verify`, { outcome: "maybe" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });
});

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00]);

function makeAttachmentHandler() {
  const dir = mkdtempSync(join(tmpdir(), "pinbox-att-route-"));
  const { handler, store } = makeHandler();
  registerAttachmentSink(store, localDirSink(dir));
  return { handler, dir };
}

function postBytes(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = { "content-type": "image/webp" },
): Request {
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body: bytes,
  });
}

describe("POST /attachments", () => {
  test("201 with a path-carrying attachment, no uploadUrl", async () => {
    const { handler, dir } = makeAttachmentHandler();
    const res = await handler(postBytes("/attachments?kind=screenshot", WEBP_BYTES));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.uploadUrl).toBeUndefined();
    const { attachment } = body.data;
    expect(attachment.id).toMatch(/^att_[a-z0-9]{10}$/);
    expect(attachment.kind).toBe("screenshot");
    expect(attachment.path.startsWith(dir)).toBe(true);
    expect(attachment.path.endsWith(".webp")).toBe(true);
    const written = new Uint8Array(await Bun.file(attachment.path).arrayBuffer());
    expect(written).toEqual(WEBP_BYTES);
  });

  test("413 E_ATTACHMENT over the byte cap", async () => {
    const { handler } = makeAttachmentHandler();
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const res = await handler(postBytes("/attachments?kind=screenshot", big));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("E_ATTACHMENT");
  });

  test("400 E_INVALID_INPUT on a missing kind", async () => {
    const { handler } = makeAttachmentHandler();
    const res = await handler(postBytes("/attachments", WEBP_BYTES));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });

  test("400 E_INVALID_INPUT on an invalid kind", async () => {
    const { handler } = makeAttachmentHandler();
    const res = await handler(postBytes("/attachments?kind=video", WEBP_BYTES));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });

  test("400 E_INVALID_INPUT on a missing content-type header", async () => {
    const { handler } = makeAttachmentHandler();
    const res = await handler(postBytes("/attachments?kind=screenshot", WEBP_BYTES, {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("E_INVALID_INPUT");
  });

  test("500 E_INTERNAL with a hint when no sink is registered", async () => {
    const { handler } = makeHandler();
    const res = await handler(postBytes("/attachments?kind=screenshot", WEBP_BYTES));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("E_INTERNAL");
    expect(body.error.hint).toContain("registerAttachmentSink");
  });

  test("401 without a bearer token — the route sits behind the pure handler", async () => {
    const { handler } = makeAttachmentHandler();
    const res = await handler(
      new Request("http://hub/attachments?kind=screenshot", {
        method: "POST",
        headers: { "content-type": "image/webp" },
        body: WEBP_BYTES,
      }),
    );
    expect(res.status).toBe(401);
  });
});
